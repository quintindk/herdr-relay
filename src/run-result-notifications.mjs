import { digest, requireValue } from './protocol.mjs';
import { randomUUID } from 'node:crypto';

export const runResultNotificationsSchema = Object.freeze({ type: 'object', properties: {
  inbox: { type: 'boolean' }, requester: { type: 'boolean' },
}, required: ['inbox', 'requester'], additionalProperties: false });

export function runResultNotifications(value) {
  if (value === undefined) return { inbox: false, requester: false };
  requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => ['inbox', 'requester'].includes(key)) &&
    typeof value.inbox === 'boolean' && typeof value.requester === 'boolean',
  'invalid_run_result_notifications', 'runResultNotifications requires explicit inbox and requester booleans');
  return { inbox: value.inbox, requester: value.requester };
}

// Recipients come from platform-owned relationships, never from worker text.
export function scheduleRequester(store, schedule) {
  if (schedule.requesterAgentId) return store.get('agent', schedule.requesterAgentId, false);
  const target = typeof schedule.definition.targetAgentId === 'string' ? store.get('agent', schedule.definition.targetAgentId, false) : null;
  const setup = target?.headlessSetupId && store.get('headless_setup', target.headlessSetupId, false);
  return setup ? store.get('agent', setup.requesterAgentId, false) : target?.standingGrant && target.mode === 'interactive' ? target : null;
}

export function runResultReport(occurrence, requesterAgentId) {
  const summary = occurrence.summary ?? occurrence.reason;
  const resultDigest = digest({ state: occurrence.state, candidate: occurrence.candidate ?? null,
    summary, failure: occurrence.failure ?? null });
  return { id: `run-result:${occurrence.id}`, kind: 'run_result', scheduleId: occurrence.scheduleId,
    occurrenceId: occurrence.id, definitionRevision: occurrence.definitionRevision, nodeId: occurrence.nodeId,
    requesterAgentId: requesterAgentId ?? null, intendedAt: occurrence.intendedAt, completedAt: occurrence.updatedAt,
    outcome: occurrence.state, summary, resultDigest, ...(occurrence.failure ? { failure: occurrence.failure } : {}),
    message: `Relay · ${occurrence.scheduleId} · ${occurrence.state}\nScheduled: ${occurrence.intendedAt}\n` +
      `Result recorded: ${occurrence.updatedAt}\nRun: ${occurrence.id}\n\nAgent's recorded report:\n${summary}` };
}

export function onlineRequester(store, recipient, clock = Date.now()) {
  const id = recipient?.agentId ?? recipient?.id;
  const agent = typeof id === 'string' ? store.get('agent', id, false) : null;
  const node = agent && store.get('node', agent.nodeId, false);
  const fresh = time => Number.isFinite(Date.parse(time)) && clock - Date.parse(time) >= 0 && clock - Date.parse(time) < 15000;
  return agent?.mode === 'interactive' && agent.ownerId === store.owner && agent.standingGrant && agent.bindingId &&
    agent.conversationId && ['available', 'busy'].includes(agent.availability) && fresh(agent.lastSeenAt) && fresh(node?.lastSeenAt) &&
    (!recipient.conversationId || recipient.conversationId === agent.conversationId && recipient.bindingId === agent.bindingId &&
      recipient.bindingRevision === agent.bindingRevision) ? agent : null;
}

// Best-effort transport only. No entities, receipts, journal rows or replay.
export class OnlineRunResultMessages {
  constructor({ limit = 100 } = {}) { this.pending = new Map(); this.consumers = new Map(); this.limit = limit; this.epoch = randomUUID(); }
  offer(store, report) {
    const agent = onlineRequester(store, { agentId: report.requesterAgentId });
    if (!agent || this.pending.size >= this.limit) return;
    const recipient = { agentId: agent.id, nodeId: agent.nodeId, bindingId: agent.bindingId,
      conversationId: agent.conversationId, bindingRevision: agent.bindingRevision };
    this.pending.set(report.id, { ...report, recipient });
  }
  take(store, actor, { consumerId } = {}) {
    store.nodeOnly(actor, actor.id);
    requireValue(typeof consumerId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(consumerId), 'invalid_request', 'Ephemeral node consumer identity required');
    if (this.consumers.get(actor.id) !== consumerId) {
      this.consumers.set(actor.id, consumerId);
      for (const [id, report] of this.pending) if (report.recipient.nodeId === actor.id) this.pending.delete(id);
    }
    const items = [];
    for (const [id, report] of this.pending) {
      if (!onlineRequester(store, report.recipient)) { this.pending.delete(id); continue; }
      if (report.recipient.nodeId === actor.id) { this.pending.delete(id); items.push(report); }
    }
    return { items, epoch: this.epoch };
  }
}
