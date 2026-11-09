import { randomUUID } from 'node:crypto';
import { digest, now, requireValue } from './protocol.mjs';

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
  loadableBindings() {
    const operations = new Map();
    for (const operation of this.list('attachment')) {
      const id = operation.binding?.id;
      if (!operations.has(id)) operations.set(id, []);
      operations.get(id).push(operation);
    }
    return this.list('native-binding').filter(binding => {
      const linked = operations.get(binding.id);
      if (!linked?.length || linked.some(operation => operation.state !== 'refused')) return true;
      // A rejected preparation is retained evidence, not a historical receiver.
      // Validate its identity and absence of pins before excluding it from loading.
      const matching = linked.find(operation => digest(operation.binding) === digest(binding));
      requireValue(matching, 'attachment_recovery_ineligible', 'Retained binding has no matching refused attachment evidence');
      this.refusedAttachment(matching.key);
      return false;
    });
  }
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
      const originalId = `binding_${digest([agentId, generation, identity.sessionId])}`;
      // Recovery retires an attempt, not permission to confirm this chat later.
      // A new human-confirmed key must never reuse a retired binding identity.
      const id = this.get(`retired-binding:${originalId}`) ? `binding_${digest([agentId, generation, identity.sessionId, key])}` : originalId;
      const binding = { id, agentId,
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
  refusedAttachment(key) {
    const operation = this.get(`attachment:${key}`);
    requireValue(operation, 'not_found', 'Unknown local attachment');
    const binding = operation.binding;
    requireValue(operation.state === 'refused' && typeof operation.error === 'string' && operation.error && !operation.receipt &&
      binding?.receiverGeneration === operation.expectedGeneration + 1 && operation.key === key,
    'attachment_recovery_ineligible', 'Only a definitively refused attachment without a receipt may be retired');
    const request = { agentId: binding.agentId, identity: binding.identity, url: binding.url, authFile: binding.authFile,
      expectedGeneration: operation.expectedGeneration, ...(operation.relocation ? { relocation: operation.relocation } : {}) };
    const command = { key: `attach:${key}`, action: operation.relocation ? 'agent.relocate' : 'agent.attach', payload: {
      id: binding.agentId, expectedBindingRevision: operation.expectedGeneration, conversationId: binding.identity.sessionId,
      directory: binding.identity.directory, bindingId: binding.id, ...(operation.relocation ?? {}) } };
    requireValue(operation.digest === digest(request) && operation.command && digest(operation.command) === digest(command) &&
      digest(this.get(`native-binding:${binding.id}`)) === digest(binding),
    'attachment_recovery_ineligible', 'Refused attachment identity, command and retained binding must match');
    const linked = this.list('attachment').filter(item => item.binding?.id === binding.id);
    requireValue(linked.every(item => item.state === 'refused' && !item.receipt) &&
      !this.list('receiver').some(receiver => receiver.bindingId === binding.id) &&
      !this.list('headless-op').some(item => item.binding?.id === binding.id) &&
      !this.journal.db.prepare("SELECT 1 FROM work WHERE json_extract(data,'$.bindingId')=? OR json_extract(data,'$.execution.bindingId')=? LIMIT 1").get(binding.id, binding.id) &&
      !this.journal.db.prepare("SELECT 1 FROM notices WHERE json_extract(data,'$.bindingId')=? LIMIT 1").get(binding.id),
    'attachment_recovery_ineligible', 'A designated, confirmed, uncertain or work-pinned binding cannot be retired');
    return { operation, proof: { kind: 'definitive_attachment_refusal', attachmentKey: key, bindingId: binding.id,
      agentId: binding.agentId, error: operation.error, bindingDigest: digest(binding), linkedAttachmentsDigest: digest(linked),
      receiverDigest: digest(this.receiver(binding.agentId) ?? null), workPinned: false, noticePinned: false } };
  }
  retireRefusedAttachment(id, { key, reason, expectedDigest, proof, backup, actor = 'local_operator' }) {
    return this.journal.transaction(() => {
      const request = { operation: 'attachment.retire_refused', id, key, reason, expectedDigest }, auditKey = `recovery:${digest(key)}`;
      const previous = this.get(auditKey);
      if (previous) { requireValue(previous.requestHash === digest(request), 'operation_conflict', 'Recovery key changed'); return previous.receipt; }
      const { operation, proof: localProof } = this.refusedAttachment(id);
      requireValue(digest(operation) === expectedDigest && proof?.nodeId === this.journal.nodeId &&
        Object.entries(localProof).every(([field, value]) => proof[field] === value) &&
        Number.isSafeInteger(proof.backendBindingRevision) && proof.backendBindingRevision >= 0 &&
        (proof.backendBindingId === null || typeof proof.backendBindingId === 'string') && proof.backendBindingId !== operation.binding.id,
      'stale_recovery_preview', 'Refused attachment or inspected backend ownership changed; inspect it again');
      requireValue(typeof reason === 'string' && reason.trim() && reason.length <= 2000 && !this.get(`retired-binding:${operation.binding.id}`),
        'attachment_recovery_ineligible', 'Explicit retirement reason and an unretired refused binding required');
      const disposition = { state: 'retired', kind: 'refused_attachment', key, attachmentKey: id, reason, actor, at: now(),
        originalDigest: expectedDigest, proof, backup, backendChanged: false, receiverChanged: false,
        nativeSettlementClaimed: false, nativeProcessTerminationClaimed: false };
      const receipt = { state: 'refused_binding_retired', kind: 'attachment', id, key, bindingId: operation.binding.id,
        agentId: operation.binding.agentId, originalState: operation.state, backendChanged: false, receiverChanged: false,
        nativeSettlementClaimed: false, nativeProcessTerminationClaimed: false, successfulCompletionClaimed: false, backup };
      this.put(`retired-binding:${operation.binding.id}`, disposition);
      this.put(auditKey, { requestHash: digest(request), before: operation, disposition, receipt });
      return receipt;
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
