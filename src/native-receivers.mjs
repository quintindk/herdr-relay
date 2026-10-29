import { randomUUID } from 'node:crypto';
import { digest, requireValue } from './protocol.mjs';

// These records share the node journal's transaction boundary with admission.
// An attachment fences new admissions before its backend mutation is attempted.
// Historical bindings and exact-session credentials remain for already admitted work.
export class NativeReceivers {
  constructor(journal) { this.journal = journal; }
  get(key) {
    const row = this.journal.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  put(key, value) {
    this.journal.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    return value;
  }
  list(prefix) {
    return this.journal.db.prepare('SELECT value FROM settings WHERE key LIKE ? ORDER BY key').all(`${prefix}:%`).map(row => JSON.parse(row.value));
  }
  enrol({ directory, name, transport, id }) {
    return this.journal.transaction(() => {
      const existing = this.list('enrolment').find(e => e.directory === directory && e.name === name);
      if (existing) {
        requireValue(!id || existing.id === id, 'enrolment_exists', 'Select the existing enrolled identity explicitly');
        requireValue(existing.transport === transport, 'configuration_conflict', 'Enrolment transport cannot change implicitly');
        return existing;
      }
      const enrolment = { id: id ?? `agent_${randomUUID()}`, directory, name, transport, autoAttach: true, scheduleManagement: true };
      return this.put(`enrolment:${enrolment.id}`, enrolment);
    });
  }
  receiver(agentId) { return this.get(`receiver:${agentId}`); }
  prepare({ agentId, identity, url, authFile, expectedGeneration, key, relocation }) {
    return this.journal.transaction(() => {
      const enrolment = this.get(`enrolment:${agentId}`);
      requireValue(enrolment && enrolment.directory === (relocation?.previousDirectory ?? identity.directory), 'enrolment_scope_mismatch', 'Select an enrolment for this exact workspace');
      const previous = this.get(`attachment:${key}`);
      const request = { agentId, identity, url, authFile, expectedGeneration, ...(relocation ? { relocation } : {}) };
      if (previous) {
        requireValue(previous.digest === digest(request), 'operation_conflict', 'Attachment key has a different scope');
        return previous;
      }
      const current = this.receiver(agentId);
      requireValue((current?.generation ?? 0) === expectedGeneration && current?.state !== 'pending',
        'stale_binding', 'Receiving chat changed or an attachment needs reconciliation', 409);
      const currentBinding = current && this.get(`native-binding:${current.bindingId}`);
      if (relocation) requireValue(current?.state === 'active' && currentBinding?.id === relocation.previousBindingId &&
        currentBinding.identity.sessionId === identity.sessionId && currentBinding.identity.createdAt === identity.createdAt && identity.directory !== enrolment.directory,
      'invalid_relocation', 'Only this agent\'s unchanged designated chat can relocate');
      if (current?.state === 'active' && currentBinding?.url === url && currentBinding.authFile === authFile &&
        digest(currentBinding.identity) === digest(identity)) {
        return this.put(`attachment:${key}`, { key, digest: digest(request), expectedGeneration, state: 'existing', binding: currentBinding });
      }
      requireValue(!this.journal.works().some(work => work.state !== 'administratively_abandoned' && work.nativeConversationId === identity.sessionId &&
        !['completed', 'cancelled', 'failed', 'rejected', 'in_review'].includes(work.execution.state)),
        'native_session_reserved', 'This historical chat still has pinned work. Resume it without claiming a new binding', 409);
      const generation = expectedGeneration + 1;
      const binding = { id: `binding_${digest([agentId, generation, identity.sessionId])}`, agentId,
        name: enrolment.name, mode: 'interactive', harness: 'opencode-v2', reserved: true,
        workerTransport: enrolment.transport, url, authFile, identity, receiverGeneration: generation };
      const operation = { key, digest: digest(request), expectedGeneration, state: 'pending', binding, previousBindingId: current?.bindingId ?? null,
        ...(relocation ? { relocation } : {}),
        previousReceiver: current ?? null,
        command: { key: `attach:${key}`, action: relocation ? 'agent.relocate' : 'agent.attach', payload: { id: agentId, expectedBindingRevision: expectedGeneration,
          conversationId: identity.sessionId, directory: identity.directory, bindingId: binding.id, ...(relocation ?? {}) } } };
      this.put(`native-binding:${binding.id}`, binding);
      this.put(`receiver:${agentId}`, { generation, bindingId: binding.id, state: 'pending', key });
      return this.put(`attachment:${key}`, operation);
    });
  }
  confirm(operation, receipt) {
    return this.journal.transaction(() => {
      const current = this.receiver(operation.binding.agentId);
      requireValue(current?.key === operation.key && receipt.bindingId === operation.binding.id &&
        receipt.bindingRevision === current.generation, 'attachment_conflict', 'Attachment receipt does not match local intent');
      if (operation.relocation) {
        const enrolment = this.get(`enrolment:${receipt.id}`);
        requireValue(enrolment?.directory === operation.relocation.previousDirectory && receipt.directory === operation.binding.identity.directory,
          'attachment_conflict', 'Relocation acknowledgement must match the original enrolment and destination');
        this.put(`enrolment:${receipt.id}`, { ...enrolment, directory: receipt.directory });
      }
      this.put(`receiver:${receipt.id}`, { ...current, state: 'active' });
      return this.put(`attachment:${operation.key}`, { ...operation, state: 'recorded', receipt });
    });
  }
  reject(operation, error, agent) {
    return this.journal.transaction(() => {
      const current = this.receiver(operation.binding.agentId);
      requireValue(current?.key === operation.key && current.state === 'pending', 'attachment_conflict', 'Only this pending attachment can be refused');
      const previous = operation.previousReceiver;
      const unchanged = agent.bindingRevision === (previous?.generation ?? 0) && (agent.bindingId ?? null) === operation.previousBindingId;
      this.put(`receiver:${agent.id}`, unchanged ? previous ?? { generation: 0, bindingId: null, state: 'detached' } :
        { generation: agent.bindingRevision, bindingId: agent.bindingId ?? null, state: 'blocked', error: 'backend_receiver_changed' });
      return this.put(`attachment:${operation.key}`, { ...operation, state: 'refused', error: error.code });
    });
  }
  resolve(agentId, pinned) {
    if (pinned?.bindingId) {
      const binding = this.get(`native-binding:${pinned.bindingId}`);
      return binding?.agentId === agentId ? binding : null;
    }
    const receiver = this.receiver(agentId);
    return receiver?.state === 'active' ? this.get(`native-binding:${receiver.bindingId}`) : null;
  }
}
