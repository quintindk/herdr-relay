import { digest, now, requireValue } from './protocol.mjs';

const prefix = 'run-result-delivery:';
const keyFor = id => `${prefix}${digest(id)}`;
const errorCode = error => /^[a-z][a-z0-9_]{0,95}$/.test(error?.code ?? '') ? error.code : 'delivery_transport_error';

export function localRunResultDeliveries(journal) {
  return journal.db.prepare("SELECT value FROM settings WHERE key LIKE 'run-result-delivery:%'").all().map(row => JSON.parse(row.value));
}

// Diagnostic intents/observations are retained, but unsent records are never
// reloaded into the online queue. Recovery may read the original message only.
export class NodeRunResultDeliveries {
  constructor({ consumerId, observationTimeoutMs = 60000, clock = Date.now, limit = 100 }) {
    this.consumerId = consumerId; this.observationTimeoutMs = observationTimeoutMs; this.clock = clock; this.limit = limit;
  }
  save(journal, record) {
    record.updatedAt = now();
    journal.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(keyFor(record.id), JSON.stringify(record));
    return record;
  }
  receive(journal, report) {
    requireValue(report?.id && report.resultDigest && report.recipient?.agentId && report.recipient.bindingId && report.recipient.conversationId,
      'invalid_run_result_delivery', 'Exact report and requester identities required');
    const previous = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(keyFor(report.id));
    const identity = digest([report.id, report.resultDigest, report.recipient]);
    if (previous) {
      const record = JSON.parse(previous.value);
      requireValue(record.identity === identity, 'run_result_delivery_identity_conflict', 'An existing delivery identity cannot change');
      return null;
    }
    return this.save(journal, { id: report.id, identity, occurrenceId: report.occurrenceId, scheduleId: report.scheduleId,
      resultDigest: report.resultDigest, recipient: report.recipient, consumerId: this.consumerId,
      backendOutcomes: report.deliveryId === report.id, nativeMessageId: `msg_${digest(report.id)}`,
      state: 'claimed', reason: 'taken_by_online_node', sendAttempted: false, replayAllowed: false,
      publications: [], createdAt: now() });
  }
  mark(journal, record, state, reason, terminal = {}) {
    if (record.state === state && record.reason === reason) { this.save(journal, record); return; }
    Object.assign(record, { state, reason }, terminal);
    if (record.backendOutcomes) {
      const payload = { id: record.id, consumerId: record.consumerId, resultDigest: record.resultDigest,
        nativeMessageId: record.nativeMessageId, state, reason, ...terminal };
      const key = `run-result-outcome:${digest(payload)}`;
      if (!record.publications.some(command => command.key === key)) record.publications.push({ key, action: 'run_result.delivery', payload });
    }
    this.save(journal, record);
  }
  async publish(journal, api, record) {
    while (record.publications.length) {
      try {
        // Only idempotent diagnostic writes are retried. Never the native send.
        const receipt = await api('POST', '/v1/commands', record.publications[0]);
        requireValue(receipt?.id === record.id && receipt.resultDigest === record.resultDigest && receipt.nativeMessageId === record.nativeMessageId &&
          receipt.consumerId === record.consumerId && digest(receipt.recipient) === digest(record.recipient) && receipt.replayAllowed === false,
          'invalid_delivery_receipt', 'Delivery observation receipt differs from the original result');
        record.publications.shift(); delete record.publicationError;
        this.save(journal, record);
      } catch (error) {
        record.publicationError = errorCode(error); this.save(journal, record); return false;
      }
    }
    return true;
  }
  async observe(journal, api, resolveBinding) {
    const records = journal.db.prepare("SELECT value FROM settings WHERE key LIKE 'run-result-delivery:%' AND (json_extract(value,'$.observationComplete') IS NOT 1 OR json_array_length(json_extract(value,'$.publications'))>0) ORDER BY json_extract(value,'$.updatedAt'),key LIMIT ?").all(this.limit);
    for (const row of records) {
      const record = JSON.parse(row.value);
      if (!record.sendAttempted && !record.observationComplete && record.consumerId !== this.consumerId) {
        record.observationComplete = true;
        this.mark(journal, record, record.invocation ? 'uncertain' : 'dropped', 'node_restarted_without_replay');
      }
      if (record.sendAttempted && !record.observationComplete) {
        try {
          const binding = await resolveBinding(record.recipient.agentId, { bindingId: record.recipient.bindingId });
          requireValue(binding?.id === record.recipient.bindingId && binding.identity?.sessionId === record.recipient.conversationId &&
            binding.receiverGeneration === record.recipient.bindingRevision && typeof binding.observe === 'function',
          'native_observer_unavailable', 'Only the original native binding may be observed');
          const observation = binding.observe(await binding.native.snapshot(), record.invocation);
          if (observation.state === 'finished') {
            record.observationComplete = true;
            this.mark(journal, record, observation.outcome === 'succeeded' ? 'delivered' : 'failed', 'correlated_native_terminal',
              { nativeTerminalId: observation.messageId, nativeOutcome: observation.outcome });
          } else if (observation.state === 'conflict') {
            record.observationComplete = true;
            this.mark(journal, record, 'uncertain', 'native_observation_conflict');
          } else if (this.clock() >= record.observeUntil) {
            record.observationComplete = true;
            this.mark(journal, record, 'uncertain', 'native_observation_timeout');
          } else if (observation.state === 'observed') this.mark(journal, record, 'observed', 'native_message_observed');
        } catch (error) {
          if (this.clock() >= record.observeUntil) record.observationComplete = true;
          this.mark(journal, record, 'uncertain', errorCode(error));
        }
        this.save(journal, record);
      }
      await this.publish(journal, api, record);
    }
  }
}
