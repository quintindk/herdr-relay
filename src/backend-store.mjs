import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonical, digest, now, requireValue } from './protocol.mjs';
import { previewCron } from './cron-schedule.mjs';
import { isAbsolute, normalize } from 'node:path';

export const backendProtocol = 'relay/0.2';
export const taskStatuses = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
const terminal = value => ['done', 'cancelled'].includes(value.status);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f]/.test(value);
const same = (a, b) => canonical(a) === canonical(b);
const forbidden = message => requireValue(false, 'forbidden', message, 403);
const fields = (input, allowed, required = []) => {
  requireValue(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(input, key)),
  'invalid_request', 'Missing or unsupported fields');
};
const string = (value, name, max = 16000) => requireValue(typeof value === 'string' && value.trim() && value.length <= max,
  'invalid_request', `${name} must be a non-empty string of at most ${max} characters`);

// Native shared store. All public mutations include actor-bound idempotency and
// append events in the same SQLite transaction. Never share this file over NFS.
export class BackendStore {
  constructor(path, { userId = 'owner' } = {}) {
    requireValue(validId(userId), 'invalid_user', 'Explicit user identity required');
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    requireValue(version <= 1, 'unsupported_schema', 'Native backend schema is newer than this build');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS receipts (actor TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(actor,key));
      CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS changes_at ON changes(at,seq);
      PRAGMA user_version=1;`);
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('owner', userId);
    this.owner = this.db.prepare('SELECT value FROM settings WHERE key=?').get('owner').value;
    requireValue(this.owner === userId, 'backend_identity_mismatch', 'Backend belongs to another user');
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('instance', randomUUID());
    this.instance = this.db.prepare('SELECT value FROM settings WHERE key=?').get('instance').value;
  }

  close() { this.db.close(); }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  get(kind, id, required = true) {
    const row = this.db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get(kind, id);
    requireValue(row || !required, 'not_found', `Unknown ${kind}`, 404);
    return row ? JSON.parse(row.data) : null;
  }
  all(kind) { return this.db.prepare('SELECT data FROM entities WHERE kind=? ORDER BY id').all(kind).map(row => JSON.parse(row.data)); }
  snapshot() {
    return this.transaction(() => ({ instanceId: this.instance, protocol: backendProtocol,
      collections: Object.fromEntries(['task', 'comment', 'execution', 'question', 'agent', 'node', 'schedule', 'occurrence', 'notification', 'artifact']
        .map(kind => [kind, this.all(kind)])),
      cursor: Buffer.from(JSON.stringify({ instance: this.instance,
        after: Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM changes').get().seq) })).toString('base64url'), fetchedAt: now() }));
  }
  scheduleRevision(id, revision) {
    const row = this.db.prepare(`SELECT data FROM changes WHERE json_extract(data,'$.entityId')=? AND
      json_extract(data,'$.revision')=? AND json_extract(data,'$.type') IN ('schedule.install','schedule.transfer_activate','schedule.pause','schedule.resume') ORDER BY seq LIMIT 1`)
      .get(id, revision);
    return row ? JSON.parse(row.data).data : null;
  }
  save(kind, value) {
    this.db.prepare('INSERT INTO entities VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,data=excluded.data')
      .run(kind, value.id, value.revision, JSON.stringify(value));
    return value;
  }
  event(type, entity, actor, requestKey) {
    const event = { id: randomUUID(), type, entityId: entity.id, revision: entity.revision, at: now(),
      actor: { type: actor.type, id: actor.id }, causation: requestKey, data: entity };
    this.db.prepare('INSERT INTO changes(id,at,data) VALUES (?,?,?)').run(event.id, event.at, JSON.stringify(event));
  }
  issueCredential(actor) {
    const token = randomBytes(32).toString('hex');
    const credential = { id: randomUUID(), type: actor.type, actorId: actor.id, revoked: false, createdAt: now() };
    this.db.prepare('INSERT INTO credentials VALUES (?,?,?)').run(credential.id, digest(token), JSON.stringify(credential));
    return { token, credential };
  }
  bootstrap() {
    return this.transaction(() => {
      requireValue(!this.db.prepare('SELECT 1 FROM credentials LIMIT 1').get(), 'already_bootstrapped', 'Backend already has credentials');
      return this.issueCredential({ type: 'user', id: this.owner });
    });
  }
  enrolCredential(actor, nodeId, key) {
    this.ownerOnly(actor); const node = this.get('node', nodeId);
    return this.transaction(() => {
      requireValue(validId(key), 'invalid_key', 'Credential issuance key required');
      const receiptKey = `credential:${key}`;
      const previous = this.db.prepare('SELECT hash,data FROM receipts WHERE actor=? AND key=?').get(`credential-owner:${actor.id}`, receiptKey);
      if (previous) {
        requireValue(previous.hash === digest(nodeId), 'operation_conflict', 'Credential issuance key changed');
        const receipt = JSON.parse(previous.data);
        const current = this.db.prepare('SELECT data FROM credentials WHERE id=?').get(receipt.credential.id);
        requireValue(current && !JSON.parse(current.data).revoked, 'credential_superseded', 'Credential issuance was revoked or superseded', 409);
        return receipt;
      }
      const result = this.issueCredential({ type: 'node', id: nodeId });
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(`credential-owner:${actor.id}`, receiptKey, digest(nodeId), JSON.stringify(result));
      this.event('node.credential_issued', node, actor, key);
      return result;
    });
  }
  rotateCredential(actor, nodeId, key) {
    this.ownerOnly(actor);
    return this.transaction(() => {
      const result = this.enrolCredential(actor, nodeId, key);
      for (const row of this.db.prepare('SELECT id,data FROM credentials WHERE id<>?').all(result.credential.id)) {
        const credential = JSON.parse(row.data);
        if (credential.type === 'node' && credential.actorId === nodeId && !credential.revoked) {
          this.db.prepare('UPDATE credentials SET data=? WHERE id=?').run(JSON.stringify({ ...credential, revoked: true }), row.id);
        }
      }
      return result;
    });
  }
  authenticate(token) {
    const hash = digest(token);
    const row = this.db.prepare('SELECT hash,data FROM credentials WHERE hash=?').get(hash);
    requireValue(row && timingSafeEqual(Buffer.from(hash), Buffer.from(row.hash)), 'unauthorised', 'Valid node or user credential required', 401);
    const actor = JSON.parse(row.data);
    requireValue(!actor.revoked, 'unauthorised', 'Credential revoked', 401);
    return { ...actor, credentialId: actor.id, id: actor.actorId ?? actor.id };
  }
  ownerOnly(actor) { if (actor.type !== 'user' || actor.id !== this.owner) forbidden('Human owner credential required'); }
  nodeOnly(actor, nodeId) { if (actor.type !== 'node' || actor.id !== nodeId) forbidden('Owning node credential required'); }
  agent(actor, agentId) {
    const agent = this.get('agent', agentId);
    if (actor.type !== 'user') this.nodeOnly(actor, agent.nodeId);
    return agent;
  }
  revision(entity, expected) { requireValue(Number.isSafeInteger(expected) && expected === entity.revision, 'stale_revision', 'Inspect the current revision', 409); }
  mutate(actor, key, action, payload, fn) {
    requireValue(validId(key), 'invalid_key', 'Bounded idempotency key required');
    return this.transaction(() => {
      const identity = `${actor.type}:${actor.id}`;
      const hash = digest({ action, payload });
      const previous = this.db.prepare('SELECT hash,data FROM receipts WHERE actor=? AND key=?').get(identity, key);
      if (previous) {
        requireValue(previous.hash === hash, 'operation_conflict', 'Idempotency key payload changed', 409);
        return JSON.parse(previous.data);
      }
      const value = fn();
      const eventType = action === 'task.create' && value.id !== payload.id ? 'task.reference_reused' : action;
      this.event(eventType, value, actor, key);
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(identity, key, hash, JSON.stringify(value));
      return value;
    });
  }

  command(actor, { key, action, payload }) {
    string(action, 'action', 100);
    requireValue(payload && typeof payload === 'object' && !Array.isArray(payload), 'invalid_request', 'Payload required');
    return this.mutate(actor, key, action, payload, () => this.apply(actor, action, structuredClone(payload)));
  }
  apply(actor, action, p) {
    const created = (kind, input) => {
      requireValue(validId(input.id) && !this.get(kind, input.id, false), 'identity_conflict', `Unique ${kind} identity required`, 409);
      return this.save(kind, { ...input, revision: 1, createdAt: now(), updatedAt: now() });
    };
    const changed = (kind, entity, patch) => this.save(kind, { ...entity, ...patch, revision: entity.revision + 1, updatedAt: now() });
    const taskDisposition = (taskId, status, causation) => {
      const task = this.get('task', taskId);
      if (terminal(task)) return task;
      const updated = changed('task', task, { status });
      this.event('task.execution_disposition', updated, actor, causation);
      return updated;
    };

    if (action === 'node.enrol') {
      this.ownerOnly(actor);
      fields(p, ['id', 'name'], ['id', 'name']); string(p.name, 'name', 256);
      const node = created('node', { ...p, lastSeenAt: null });
      return node;
    }
    if (action === 'node.heartbeat') {
      fields(p, ['id'], ['id']); this.nodeOnly(actor, p.id);
      return changed('node', this.get('node', p.id), { lastSeenAt: now() });
    }
    if (action === 'credential.revoke') {
      this.ownerOnly(actor); fields(p, ['id'], ['id']);
      const row = this.db.prepare('SELECT data FROM credentials WHERE id=?').get(p.id);
      requireValue(row, 'not_found', 'Credential not found', 404);
      const credential = { ...JSON.parse(row.data), revoked: true };
      this.db.prepare('UPDATE credentials SET data=? WHERE id=?').run(JSON.stringify(credential), p.id);
      return { id: p.id, revision: 1, revoked: true };
    }
    if (action === 'agent.register') {
      fields(p, ['id', 'nodeId', 'name', 'capabilities', 'mode', 'directory'], ['id', 'nodeId', 'name', 'mode']);
      if (p.directory !== undefined) requireValue(typeof p.directory === 'string' && isAbsolute(p.directory) &&
        normalize(p.directory) === p.directory && p.directory.length <= 4096, 'invalid_directory', 'Canonical absolute enrolled directory required');
      this.nodeOnly(actor, p.nodeId); this.get('node', p.nodeId);
      string(p.name, 'name', 256);
      requireValue(['interactive', 'headless'].includes(p.mode) && (!p.capabilities || Array.isArray(p.capabilities) &&
        p.capabilities.length <= 64 && p.capabilities.every(validId)), 'invalid_request', 'Invalid agent mode/capabilities');
      return created('agent', { ...p, capabilities: p.capabilities ?? [], ownerId: this.owner });
    }
    if (action === 'agent.advertise') {
      fields(p, ['id', 'expectedRevision', 'availability', 'bindingRevision', 'conversationId'], ['id', 'expectedRevision', 'availability']);
      const agent = this.agent(actor, p.id); this.revision(agent, p.expectedRevision);
      requireValue(['available', 'busy', 'offline', 'unknown'].includes(p.availability) &&
        (p.bindingRevision === undefined || Number.isSafeInteger(p.bindingRevision) && p.bindingRevision > 0) &&
        (p.conversationId === undefined || typeof p.conversationId === 'string' && p.conversationId.length <= 512),
        'invalid_advertisement', 'Invalid agent availability or identity');
      requireValue(!agent.conversationId || p.conversationId === undefined || p.conversationId === agent.conversationId,
        'conversation_adoption_required', 'Explicit human adoption required to replace an advertised conversation');
      return changed('agent', agent, { availability: p.availability, bindingRevision: p.bindingRevision ?? null,
        conversationId: p.conversationId ?? null, lastSeenAt: now() });
    }
    if (action === 'agent.adopt') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision', 'conversationId', 'bindingRevision'], ['id', 'expectedRevision', 'conversationId', 'bindingRevision']);
      const agent = this.get('agent', p.id); this.revision(agent, p.expectedRevision);
      string(p.conversationId, 'conversationId', 512);
      requireValue(Number.isSafeInteger(p.bindingRevision) && p.bindingRevision > (agent.bindingRevision ?? 0), 'stale_binding', 'Newer binding revision required');
      requireValue(!this.all('execution').some(e => (e.targetAgentId === agent.id || e.originAgentId === agent.id) && !['completed', 'cancelled', 'failed', 'rejected'].includes(e.state)) &&
        !this.all('question').some(q => q.status === 'open' && q.addressedTo.type === 'agent' && q.addressedTo.id === agent.id),
        'agent_busy', 'Resolve original executions and reviews before adopting a replacement conversation');
      return changed('agent', agent, { conversationId: p.conversationId, bindingRevision: p.bindingRevision,
        capabilities: agent.capabilities.filter(capability => capability !== 'observation_only'),
        adoption: { userId: actor.id, previousConversationId: agent.conversationId ?? null, at: now() } });
    }
    if (action === 'agent.enrol_folder') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision', 'directory'], ['id', 'expectedRevision', 'directory']);
      const agent = this.get('agent', p.id); this.revision(agent, p.expectedRevision);
      requireValue(!agent.capabilities.includes('observation_only') && typeof p.directory === 'string' &&
        isAbsolute(p.directory) && normalize(p.directory) === p.directory && p.directory.length <= 4096,
      'invalid_directory', 'Explicit enrolled agent and canonical absolute directory required');
      requireValue(!agent.directory || agent.directory === p.directory, 'directory_migration_required', 'Enrolled directory cannot be changed in place');
      return changed('agent', agent, { directory: p.directory });
    }
    if (action === 'schedule.install') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision', 'definition'], ['id', 'definition']);
      fields(p.definition, ['nodeId', 'targetAgentId', 'targetFolder', 'targetConversationId', 'instructions', 'cron', 'timezone', 'at', 'enabled', 'reviewPolicy', 'expiresAt', 'intent'],
        ['nodeId', 'instructions', 'enabled']);
      this.get('node', p.definition.nodeId);
      const reminder = p.definition.intent === 'reminder';
      const folder = p.definition.targetFolder;
      if (folder !== undefined) requireValue(!reminder && !p.definition.targetAgentId && !p.definition.targetConversationId &&
        typeof folder === 'string' && isAbsolute(folder) && normalize(folder) === folder && folder.length <= 4096,
      'invalid_schedule', 'Folder target requires an explicit absolute directory and no agent/exact target');
      const target = reminder || folder ? null : this.get('agent', p.definition.targetAgentId);
      if (p.definition.targetConversationId !== undefined) {
        string(p.definition.targetConversationId, 'targetConversationId', 512);
        requireValue(!reminder && target.conversationId === p.definition.targetConversationId,
          'target_conversation_mismatch', 'Exact schedule target must match the advertised conversation');
      }
      requireValue(reminder || folder || !target.capabilities.includes('observation_only'), 'target_not_enrolled', 'Schedule requires an enrolled execution target');
      requireValue(!folder || this.all('agent').some(agent => agent.nodeId === p.definition.nodeId && agent.directory === folder &&
        !agent.capabilities.includes('observation_only')), 'target_not_enrolled', 'Folder requires an explicitly enrolled local agent');
      requireValue((reminder || folder || target.nodeId === p.definition.nodeId) && typeof p.definition.enabled === 'boolean' &&
        ['job', 'reminder'].includes(p.definition.intent ?? 'job') &&
        Boolean(p.definition.cron) !== Boolean(p.definition.at) && ['none', 'human'].includes(p.definition.reviewPolicy ?? 'none'),
      'invalid_schedule', 'Invalid schedule scope');
      string(p.definition.instructions, 'instructions');
      if (p.definition.cron) previewCron(p.definition.cron, p.definition.timezone ?? 'Africa/Johannesburg');
      else requireValue(typeof p.definition.at === 'string' && Number.isFinite(Date.parse(p.definition.at)), 'invalid_schedule', 'Valid one-shot instant required');
      if (p.definition.expiresAt !== undefined) requireValue(Number.isFinite(Date.parse(p.definition.expiresAt)), 'invalid_schedule', 'Valid expiry required');
      requireValue(!reminder || !p.definition.targetAgentId && (p.definition.reviewPolicy ?? 'none') === 'none',
        'invalid_schedule', 'Human reminders have no execution target or candidate review');
      const previous = this.get('schedule', p.id, false);
      if (previous) {
        requireValue(!previous.cancelled, 'schedule_cancelled', 'Cancelled schedule cannot be reactivated');
        this.revision(previous, p.expectedRevision);
        requireValue(!previous.transfer || previous.transfer.state === 'completed', 'schedule_transfer_pending', 'Resolve transfer before editing definition');
        requireValue(previous.definition.nodeId === p.definition.nodeId && previous.definition.targetAgentId === p.definition.targetAgentId &&
          previous.definition.targetFolder === p.definition.targetFolder &&
          previous.definition.targetConversationId === p.definition.targetConversationId,
          'schedule_transfer_required', 'Schedule owner and target cannot change in place');
        requireValue((previous.definition.intent ?? 'job') === (p.definition.intent ?? 'job'), 'schedule_mode_locked', 'Schedule intent cannot change in place');
        return changed('schedule', previous, { definition: p.definition, appliedRevision: previous.appliedRevision ?? 0 });
      }
      return created('schedule', { id: p.id, definition: p.definition, appliedRevision: 0 });
    }
    if (action === 'schedule.cancel') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision', 'reason'], ['id', 'expectedRevision', 'reason']);
      const schedule = this.get('schedule', p.id); this.revision(schedule, p.expectedRevision);
      string(p.reason, 'reason', 2000);
      requireValue(!schedule.transfer || schedule.transfer.state === 'completed', 'schedule_transfer_pending', 'Resolve pending transfer before cancellation');
      return changed('schedule', schedule, { cancelled: true, cancellationReason: p.reason,
        definition: { ...schedule.definition, enabled: false } });
    }
    if (['schedule.pause', 'schedule.resume'].includes(action)) {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
      const schedule = this.get('schedule', p.id); this.revision(schedule, p.expectedRevision);
      requireValue(!schedule.cancelled && (!schedule.transfer || schedule.transfer.state === 'completed'),
        'schedule_unavailable', 'Cancelled/transferring schedule cannot change activation');
      return changed('schedule', schedule, { definition: { ...schedule.definition, enabled: action === 'schedule.resume' } });
    }
    if (action === 'schedule.transfer_request') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision', 'targetNodeId', 'targetAgentId'], ['id', 'expectedRevision', 'targetNodeId']);
      const schedule = this.get('schedule', p.id); this.revision(schedule, p.expectedRevision);
      requireValue(!schedule.transfer || schedule.transfer.state === 'completed', 'schedule_transfer_pending', 'Another transfer is pending');
      requireValue(!schedule.cancelled, 'schedule_cancelled', 'Cancelled schedule cannot transfer');
      this.get('node', p.targetNodeId);
      requireValue(p.targetNodeId !== schedule.definition.nodeId, 'invalid_transfer', 'Choose another node');
      if (schedule.definition.intent !== 'reminder') {
        requireValue(!schedule.definition.targetFolder, 'folder_schedule_transfer_forbidden', 'Folder schedules require separate destination authorisation');
        const target = this.get('agent', p.targetAgentId);
        requireValue(target.nodeId === p.targetNodeId && !target.capabilities.includes('observation_only'), 'invalid_transfer', 'Enrolled destination required');
        requireValue(!schedule.definition.targetConversationId, 'exact_schedule_transfer_forbidden',
          'Exact-conversation schedules cannot transfer. Create a separately authorised schedule for the destination');
      }
      return changed('schedule', schedule, { transfer: { state: 'requested', sourceNodeId: schedule.definition.nodeId,
        sourceRevision: schedule.revision, targetNodeId: p.targetNodeId, targetAgentId: p.targetAgentId ?? null } });
    }
    if (action === 'schedule.transfer_fenced') {
      fields(p, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
      const schedule = this.get('schedule', p.id); this.revision(schedule, p.expectedRevision);
      this.nodeOnly(actor, schedule.transfer?.sourceNodeId);
      requireValue(schedule.transfer?.state === 'requested', 'invalid_transfer', 'Pending source transfer required');
      return changed('schedule', schedule, { transfer: { ...schedule.transfer, state: 'fenced', fencedAt: now() } });
    }
    if (action === 'schedule.transfer_activate') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
      const schedule = this.get('schedule', p.id); this.revision(schedule, p.expectedRevision);
      requireValue(schedule.transfer?.state === 'fenced', 'source_not_fenced', 'Old node must acknowledge no active occurrences before transfer');
      return changed('schedule', schedule, { definition: { ...schedule.definition, nodeId: schedule.transfer.targetNodeId,
        ...(schedule.definition.intent === 'reminder' ? {} : { targetAgentId: schedule.transfer.targetAgentId }) },
      appliedRevision: 0, transfer: { ...schedule.transfer, state: 'completed', activatedAt: now() } });
    }
    if (action === 'schedule.remind') {
      fields(p, ['id', 'scheduleId', 'definitionRevision', 'intendedAt', 'message'], ['id', 'scheduleId', 'definitionRevision', 'intendedAt', 'message']);
      const installation = this.scheduleRevision(p.scheduleId, p.definitionRevision);
      requireValue(installation, 'invalid_reminder', 'Installed reminder revision not found');
      this.nodeOnly(actor, installation?.definition.nodeId);
      requireValue(installation.definition.intent === 'reminder' && p.id === `occurrence_${digest([p.scheduleId, p.intendedAt])}` &&
        installation.definition.instructions === p.message, 'invalid_reminder', 'Reminder must match installed definition');
      return created('notification', { ...p, userId: this.owner, nodeId: actor.id, kind: 'human_reminder', state: 'pending' });
    }
    if (action === 'notification.acknowledge') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
      const notification = this.get('notification', p.id); this.revision(notification, p.expectedRevision);
      return changed('notification', notification, { state: 'acknowledged', acknowledgedAt: now() });
    }
    if (action === 'schedule.acknowledge') {
      fields(p, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
      const schedule = this.get('schedule', p.id); this.nodeOnly(actor, schedule.definition.nodeId); this.revision(schedule, p.expectedRevision);
      return this.save('schedule', { ...schedule, appliedRevision: schedule.revision, appliedAt: now() });
    }
    if (['schedule.publish', 'schedule.fail'].includes(action)) {
      const failed = action === 'schedule.fail';
      const required = ['id', 'scheduleId', 'definitionRevision', 'intendedAt', 'evidence',
        ...(failed ? ['reason'] : ['candidate', 'summary'])];
      fields(p, required, required);
      const schedule = this.get('schedule', p.scheduleId);
      requireValue(p.definitionRevision <= schedule.revision && p.definitionRevision > 0 && Number.isFinite(Date.parse(p.intendedAt)),
        'invalid_occurrence', 'Recorded schedule revision and instant required');
      const installation = this.scheduleRevision(schedule.id, p.definitionRevision);
      this.nodeOnly(actor, installation?.definition.nodeId);
      requireValue(installation?.definition.nodeId === actor.id, 'invalid_occurrence', 'Installed definition evidence required');
      requireValue(p.id === `occurrence_${digest([p.scheduleId, p.intendedAt])}`, 'invalid_occurrence', 'Occurrence identity does not match schedule/instant');
      if (failed) string(p.reason, 'reason', 2000);
      else { string(p.summary, 'summary'); string(p.candidate, 'candidate', 512); }
      string(p.evidence, 'evidence', 4000);
      const occurrence = created('occurrence', { ...p, nodeId: actor.id, definition: installation.definition,
        state: failed ? 'failed' : installation.definition.reviewPolicy === 'human' ? 'in_review' : 'completed' });
      const execution = this.get('execution', p.id, false);
      if (execution) {
        requireValue(execution.localOccurrence && execution.targetNodeId === actor.id && execution.state === 'accepted' && !execution.cancellationRequested,
          'occurrence_ineligible', 'Materialised scheduled work is no longer active');
        const settled = changed('execution', execution, { state: occurrence.state,
          ...(failed ? { failure: { reason: p.reason, evidence: p.evidence } } : {
            result: { candidate: p.candidate, summary: p.summary, evidence: p.evidence, digest: digest({ candidate: p.candidate, summary: p.summary }),
              sequence: Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM changes').get().seq) } }) });
        this.event(failed ? 'execution.scheduled_failure' : 'execution.scheduled_result', settled, actor, occurrence.id);
        taskDisposition(execution.taskId, failed ? 'blocked' : occurrence.state === 'in_review' ? 'in_review' : 'done', occurrence.id);
        occurrence.executionId = execution.id;
        this.save('occurrence', occurrence);
      }
      return occurrence;
    }
    if (action === 'artifact.attach') {
      fields(p, ['id', 'executionId', 'expectedRevision', 'runId', 'resultDigest', 'candidate', 'url', 'sha256', 'kind'],
        ['id', 'executionId', 'expectedRevision', 'runId', 'resultDigest', 'candidate', 'url', 'sha256', 'kind']);
      const e = this.get('execution', p.executionId); this.nodeOnly(actor, e.targetNodeId); this.revision(e, p.expectedRevision);
      requireValue(e.result?.candidate === p.candidate && e.result.digest === p.resultDigest && e.runId === p.runId &&
        ['in_review', 'completed'].includes(e.state), 'stale_candidate', 'Artifact must bind exact published run and result');
      let url;
      try { url = new URL(p.url); } catch {}
      requireValue(typeof p.url === 'string' && p.url.length <= 4096 && url && url.protocol === 'https:' && url.hostname &&
        !url.username && !url.password && typeof p.sha256 === 'string' && /^[0-9a-f]{64}$/.test(p.sha256) &&
        ['git_commit', 'file', 'report'].includes(p.kind), 'invalid_artifact', 'HTTPS artifact and explicit content digest required');
      return created('artifact', { ...p, taskId: e.taskId, authorNodeId: actor.id, resultDigest: e.result.digest });
    }
    if (action === 'schedule.ask') {
      fields(p, ['id', 'occurrenceId', 'scheduleId', 'definitionRevision', 'intendedAt', 'bindingId', 'runId', 'prompt', 'humanRequired', 'targetAgentId'],
        ['id', 'occurrenceId', 'scheduleId', 'definitionRevision', 'intendedAt', 'bindingId', 'runId', 'prompt']);
      const installation = this.scheduleRevision(p.scheduleId, p.definitionRevision);
      requireValue(installation && installation.definition.intent !== 'reminder' &&
        p.occurrenceId === `occurrence_${digest([p.scheduleId, p.intendedAt])}` && validId(p.bindingId) && validId(p.runId),
        'invalid_occurrence', 'Exact installed execution occurrence required');
      this.nodeOnly(actor, installation.definition.nodeId);
      const selectedAgentId = installation.definition.targetFolder ? p.targetAgentId : installation.definition.targetAgentId;
      const selectedAgent = this.get('agent', selectedAgentId);
      requireValue(selectedAgent.nodeId === actor.id && !selectedAgent.capabilities.includes('observation_only') &&
        (!installation.definition.targetFolder || selectedAgent.directory === installation.definition.targetFolder),
      'target_not_enrolled', 'Scheduled occurrence must use an enrolled target inside its authorised scope');
      let execution = this.get('execution', p.occurrenceId, false);
      if (!execution) {
        const task = created('task', { id: `task_${p.occurrenceId}`, title: `Scheduled: ${p.scheduleId}`, description: installation.definition.instructions,
          status: 'in_progress', priority: 'medium', labels: [], dependencies: [], parentId: null, responsibleUserId: this.owner });
        this.event('task.create', task, actor, p.occurrenceId);
        execution = created('execution', { id: p.occurrenceId, taskId: task.id, targetNodeId: actor.id,
          targetAgentId: selectedAgentId, instructions: installation.definition.instructions,
          bindingId: p.bindingId, runId: p.runId, state: 'accepted', localOccurrence: true,
          reviewPolicy: installation.definition.reviewPolicy ?? 'none', responsibleUserId: this.owner, cancellationRequested: false });
        this.event('execution.schedule_materialised', execution, actor, p.occurrenceId);
      }
      requireValue(execution.runId === p.runId && execution.bindingId === p.bindingId && execution.targetAgentId === selectedAgentId,
        'occurrence_identity_changed', 'Scheduled run identity changed');
      const question = this.apply(actor, 'question.ask', { id: p.id, executionId: execution.id, expectedRevision: execution.revision,
        prompt: p.prompt, blocking: true, humanRequired: p.humanRequired ?? true });
      this.event('question.ask', question, actor, p.id);
      return question;
    }
    if (action === 'task.create') {
      // Node-originated capture needs an explicit scoped grant, not operator powers.
      this.ownerOnly(actor);
      fields(p, ['id', 'title', 'description', 'status', 'priority', 'parentId', 'dependencies', 'labels', 'externalReference'], ['id', 'title']);
      if (p.externalReference) {
        const identity = this.referenceIdentity(p.externalReference);
        const previous = this.get('reference', identity, false);
        if (previous) {
          requireValue(same(previous.reference, p.externalReference), 'reference_conflict', 'External reference metadata changed');
          return this.get('task', previous.taskId);
        }
      }
      string(p.title, 'title', 512);
      const task = { ...p, description: p.description ?? '', status: p.status ?? 'todo', priority: p.priority ?? 'medium',
        parentId: p.parentId ?? null, dependencies: p.dependencies ?? [], labels: p.labels ?? [], responsibleUserId: this.owner };
      this.validateTask(task);
      const receipt = created('task', task);
      if (p.externalReference) {
        this.save('reference', { id: this.referenceIdentity(p.externalReference), taskId: receipt.id,
          revision: 1, reference: p.externalReference });
        receipt.references = [p.externalReference];
        this.save('task', receipt);
      }
      return receipt;
    }
    if (action === 'task.update') {
      fields(p, ['id', 'expectedRevision', 'changes', 'comment'], ['id', 'expectedRevision', 'changes']);
      fields(p.changes, ['title', 'description', 'status', 'priority', 'parentId', 'dependencies', 'labels']);
      const task = this.get('task', p.id); this.revision(task, p.expectedRevision);
      if (actor.type !== 'user') {
        requireValue(this.all('execution').some(e => e.taskId === task.id && e.targetNodeId === actor.id && e.state === 'accepted' && !e.cancellationRequested),
          'forbidden', 'Node needs an accepted execution for task mutation', 403);
      }
      const next = { ...task, ...p.changes };
      this.validateTask(next);
      if (next.status === 'done') {
        requireValue(next.dependencies.every(id => this.get('task', id).status === 'done') &&
          !this.all('task').some(child => child.parentId === task.id && !terminal(child)) &&
          !this.all('question').some(q => q.taskId === task.id && q.status === 'open' && q.blocking),
        'task_blocked', 'Dependencies, children or questions remain open', 409);
        requireValue(!this.all('execution').some(e => e.taskId === task.id && !['completed', 'cancelled', 'rejected', 'failed'].includes(e.state)),
          'execution_unsettled', 'Execution must settle before task completion', 409);
        const latest = this.all('execution').filter(e => e.taskId === task.id && e.result)
          .sort((a, b) => (b.result.sequence ?? 0) - (a.result.sequence ?? 0))[0];
        requireValue(!latest || latest.state === 'completed' && (latest.reviewPolicy === 'none' || latest.review?.decision === 'accept'),
          'acceptance_required', 'Latest submitted result must complete its recorded review policy', 409);
      }
      const updated = changed('task', task, p.changes);
      if (updated.status === 'cancelled' && task.status !== 'cancelled') {
        for (const execution of this.all('execution').filter(e => e.taskId === task.id &&
          !['completed', 'cancelled', 'failed', 'rejected'].includes(e.state))) {
          const cancelled = changed('execution', execution, { cancellationRequested: true,
            cancellationReason: 'Task cancelled by its responsible owner', ...(execution.state === 'requested' ? { state: 'cancelled' } : {}) });
          this.event('execution.cancel', cancelled, actor, task.id);
        }
      }
      if (p.comment !== undefined) {
        string(p.comment, 'comment', 16000);
        const comment = created('comment', { id: `comment_${randomUUID()}`, taskId: task.id, body: p.comment,
          author: { type: actor.type, id: actor.id } });
        this.event('comment.create', comment, actor, task.id);
      }
      return updated;
    }
    if (action === 'comment.create') {
      fields(p, ['id', 'taskId', 'body'], ['id', 'taskId', 'body']); this.get('task', p.taskId); string(p.body, 'body');
      if (actor.type !== 'user') requireValue(this.all('execution').some(e => e.taskId === p.taskId && e.targetNodeId === actor.id &&
        e.state === 'accepted' && !e.cancellationRequested), 'forbidden', 'Comments require current in-scope execution', 403);
      return created('comment', { ...p, author: { type: actor.type, id: actor.id } });
    }
    if (action === 'reference.attach') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision', 'reference'], ['id', 'expectedRevision', 'reference']);
      const task = this.get('task', p.id); this.revision(task, p.expectedRevision);
      const id = this.referenceIdentity(p.reference);
      const previous = this.get('reference', id, false);
      requireValue(!previous || previous.taskId === task.id && same(previous.reference, p.reference),
        'reference_conflict', 'External identity already attached or metadata changed');
      if (previous) return task;
      this.save('reference', { id, revision: 1, taskId: task.id, reference: p.reference });
      return changed('task', task, { references: [...(task.references ?? []), p.reference] });
    }
    if (action === 'execution.request') {
      fields(p, ['id', 'taskId', 'taskRevision', 'originAgentId', 'originConversation', 'targetAgentId', 'instructions', 'reviewPolicy', 'allowDelegation', 'monitor'],
        ['id', 'taskId', 'taskRevision', 'targetAgentId', 'instructions']);
      const task = this.get('task', p.taskId); this.revision(task, p.taskRevision);
      requireValue(!terminal(task), 'task_terminal', 'Cannot execute terminal task', 409);
      requireValue(task.status !== 'in_review' && !this.all('question').some(q => q.taskId === task.id && q.status === 'open' && q.blocking),
        'task_waiting', 'Resolve pending review/questions before a fresh execution');
      this.ownerOnly(actor);
      if (p.originAgentId) this.get('agent', p.originAgentId);
      if (p.originConversation !== undefined) string(p.originConversation, 'originConversation', 512);
      const target = this.get('agent', p.targetAgentId);
      requireValue(!target.capabilities.includes('observation_only'), 'target_not_enrolled', 'Observed conversation has no execution binding');
      requireValue(p.allowDelegation === undefined || typeof p.allowDelegation === 'boolean', 'invalid_request', 'Delegation grant must be boolean');
      requireValue(actor.type === 'user' || !p.allowDelegation, 'forbidden', 'Only human may grant fresh delegation scope', 403);
      string(p.instructions, 'instructions');
      requireValue(['none', 'human'].includes(p.reviewPolicy ?? 'none'), 'unsupported_policy', 'Use none or human review');
      if (p.monitor) {
        fields(p.monitor, ['startsAt', 'endsAt', 'intervalSec'], ['startsAt', 'endsAt', 'intervalSec']);
        requireValue(Number.isFinite(Date.parse(p.monitor.startsAt)) && Date.parse(p.monitor.endsAt) > Date.parse(p.monitor.startsAt) &&
          Number.isSafeInteger(p.monitor.intervalSec) && p.monitor.intervalSec > 0, 'invalid_monitor', 'Explicit bounded monitoring window required');
      }
      requireValue(!this.all('execution').some(e => e.taskId === task.id && !['completed', 'cancelled', 'rejected', 'failed'].includes(e.state)),
        'task_busy', 'Task already has an outstanding execution', 409);
      return created('execution', { ...p, targetNodeId: target.nodeId, reviewPolicy: p.reviewPolicy ?? 'none',
        targetConversationId: target.conversationId ?? null, targetBindingRevision: target.bindingRevision ?? null,
        responsibleUserId: this.owner, state: 'requested', originNodeId: p.originAgentId ? this.get('agent', p.originAgentId).nodeId : null,
        cancellationRequested: false });
    }
    if (action === 'review.grant') {
      this.ownerOnly(actor);
      fields(p, ['id', 'parentExecutionId', 'reviewerAgentId'], ['id', 'parentExecutionId', 'reviewerAgentId']);
      const parent = this.get('execution', p.parentExecutionId);
      requireValue(parent.targetAgentId === p.reviewerAgentId && parent.reviewPolicy === 'human' && !parent.parentExecutionId &&
        !parent.cancellationRequested && !['completed', 'cancelled', 'failed', 'rejected'].includes(parent.state),
        'invalid_review_grant', 'Human-reviewed root must belong to the named reviewer');
      return created('review_grant', { ...p, state: 'active', ownerId: this.owner });
    }
    if (action === 'review.revoke') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
      const grant = this.get('review_grant', p.id); this.revision(grant, p.expectedRevision);
      const revoked = changed('review_grant', grant, { state: 'revoked' });
      for (const child of this.all('execution').filter(e => e.reviewGrantId === grant.id && e.state === 'in_review')) {
        const recovery = changed('execution', child, { reviewerMode: 'human_recovery' });
        this.event('execution.review_recovery', recovery, actor, grant.id);
      }
      return revoked;
    }
    if (action === 'execution.delegate') {
      fields(p, ['id', 'parentExecutionId', 'expectedRevision', 'taskId', 'title', 'instructions', 'targetAgentId', 'reviewPolicy', 'reviewGrantId'],
        ['id', 'parentExecutionId', 'expectedRevision', 'taskId', 'title', 'instructions', 'targetAgentId']);
      const parent = this.get('execution', p.parentExecutionId); this.nodeOnly(actor, parent.targetNodeId); this.revision(parent, p.expectedRevision);
      requireValue(parent.state === 'accepted' && parent.allowDelegation && !parent.cancellationRequested && !terminal(this.get('task', parent.taskId)),
        'delegation_not_authorised', 'Current parent execution needs an explicit delegation grant', 403);
      string(p.title, 'title', 512); string(p.instructions, 'instructions');
      const target = this.get('agent', p.targetAgentId);
      requireValue(!target.capabilities.includes('observation_only'), 'target_not_enrolled', 'Observed conversation has no execution binding');
      requireValue(target.id !== parent.targetAgentId && ['none', 'human', 'agent'].includes(p.reviewPolicy ?? parent.reviewPolicy),
        'invalid_delegation', 'Independent target and supported review policy required');
      if (p.reviewPolicy === 'agent') {
        const grant = this.get('review_grant', p.reviewGrantId);
        requireValue(grant.state === 'active' && grant.parentExecutionId === parent.id && grant.reviewerAgentId === parent.targetAgentId,
          'review_grant_inactive', 'Explicit active parent review grant required', 403);
      } else requireValue(!p.reviewGrantId, 'invalid_review_grant', 'Only agent review may reference a grant');
      const task = { id: p.taskId, title: p.title, description: p.instructions, status: 'todo', priority: 'medium',
        parentId: parent.taskId, dependencies: [], labels: [], responsibleUserId: this.owner };
      this.validateTask(task);
      const child = created('task', task);
      this.event('task.create', child, actor, p.id);
      return created('execution', { id: p.id, taskId: child.id, taskRevision: child.revision, originAgentId: parent.targetAgentId,
        originNodeId: actor.id, parentExecutionId: parent.id, targetAgentId: target.id, targetNodeId: target.nodeId,
        targetConversationId: target.conversationId ?? null, targetBindingRevision: target.bindingRevision ?? null,
        instructions: p.instructions, reviewPolicy: p.reviewPolicy ?? parent.reviewPolicy,
        ...(p.reviewGrantId ? { reviewGrantId: p.reviewGrantId } : {}), allowDelegation: false,
        responsibleUserId: this.owner, state: 'requested', cancellationRequested: false });
    }
    if (action === 'execution.wait_children') {
      fields(p, ['id', 'expectedRevision', 'childExecutionIds'], ['id', 'expectedRevision', 'childExecutionIds']);
      const parent = this.get('execution', p.id); this.nodeOnly(actor, parent.targetNodeId); this.revision(parent, p.expectedRevision);
      requireValue(parent.state === 'accepted' && !parent.cancellationRequested && Array.isArray(p.childExecutionIds) &&
        p.childExecutionIds.length > 0 && p.childExecutionIds.length <= 64 && new Set(p.childExecutionIds).size === p.childExecutionIds.length,
        'invalid_child_wait', 'Current parent and bounded child set required');
      for (const id of p.childExecutionIds) requireValue(this.get('execution', id).parentExecutionId === parent.id,
        'invalid_child_wait', 'Wait references unrelated execution');
      return changed('execution', parent, { state: 'waiting_children', childExecutionIds: [...p.childExecutionIds].sort() });
    }
    if (action === 'execution.delay') {
      fields(p, ['id', 'expectedRevision', 'until', 'reason'], ['id', 'expectedRevision', 'until', 'reason']);
      const e = this.get('execution', p.id); this.nodeOnly(actor, e.targetNodeId); this.revision(e, p.expectedRevision);
      requireValue(e.state === 'accepted' && !e.cancellationRequested && Number.isFinite(Date.parse(p.until)) && Date.parse(p.until) > Date.now(),
        'invalid_delay', 'Future continuation time and current execution required');
      string(p.reason, 'reason', 2000);
      return changed('execution', e, { state: 'waiting_time', nextCheckAt: new Date(p.until).toISOString(), delayReason: p.reason });
    }
    if (action === 'execution.monitor_result') {
      fields(p, ['id', 'expectedRevision', 'candidate', 'summary', 'evidence'], ['id', 'expectedRevision', 'candidate', 'summary', 'evidence']);
      const e = this.get('execution', p.id); this.nodeOnly(actor, e.targetNodeId); this.revision(e, p.expectedRevision);
      requireValue(e.monitor && e.state === 'accepted' && !e.cancellationRequested && Date.now() < Date.parse(e.monitor.endsAt),
        'monitor_expired', 'Current in-window standing monitor required');
      string(p.candidate, 'candidate', 512); string(p.summary, 'summary'); string(p.evidence, 'evidence', 4000);
      const result = { id: `monitor_result_${digest([e.id, e.runId])}`, revision: 1, executionId: e.id, taskId: e.taskId,
        candidate: p.candidate, summary: p.summary, evidence: p.evidence, runId: e.runId, at: now(),
        reviewPolicy: e.reviewPolicy, state: e.reviewPolicy === 'human' ? 'in_review' : 'completed' };
      this.save('monitor_result', result);
      this.event('monitor.result', result, actor, e.id);
      return changed('execution', e, { state: e.reviewPolicy === 'human' ? 'monitor_review' : 'waiting_time',
        monitorResultId: result.id, nextCheckAt: new Date(Math.min(Date.now() + e.monitor.intervalSec * 1000, Date.parse(e.monitor.endsAt))).toISOString() });
    }
    if (action === 'execution.monitor_review') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision', 'candidate', 'decision', 'reason'], ['id', 'expectedRevision', 'candidate', 'decision', 'reason']);
      const e = this.get('execution', p.id); this.revision(e, p.expectedRevision);
      requireValue(e.state === 'monitor_review' && !e.cancellationRequested && !terminal(this.get('task', e.taskId)), 'review_ineligible', 'Pending monitor review required');
      const result = this.get('monitor_result', e.monitorResultId);
      requireValue(result.candidate === p.candidate && ['accept', 'reject'].includes(p.decision), 'stale_candidate', 'Exact monitor candidate required');
      string(p.reason, 'reason', 4000);
      const reviewed = changed('monitor_result', result, { state: p.decision === 'accept' ? 'completed' : 'rejected',
        review: { decision: p.decision, reason: p.reason, userId: actor.id, at: now() } });
      this.event('monitor.review', reviewed, actor, e.id);
      return changed('execution', e, { state: p.decision === 'accept' ? 'waiting_time' : 'monitor_blocked' });
    }
    if (action === 'execution.check_time') {
      fields(p, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
      const e = this.get('execution', p.id); this.nodeOnly(actor, e.targetNodeId); this.revision(e, p.expectedRevision);
      requireValue(e.state === 'waiting_time' && !e.cancellationRequested && Date.now() >= Date.parse(e.nextCheckAt),
        'continuation_not_due', 'Delayed continuation is not due');
      const continuationId = digest([e.id, e.nextCheckAt, e.revision]);
      return changed('execution', e, { state: 'continuation_ready', timeContinuationId: continuationId, continuationId });
    }
    if (action === 'execution.review_children') {
      fields(p, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
      const parent = this.get('execution', p.id); this.nodeOnly(actor, parent.targetNodeId); this.revision(parent, p.expectedRevision);
      requireValue(parent.state === 'waiting_children' && !parent.cancellationRequested, 'invalid_child_wait', 'Waiting parent required');
      const children = parent.childExecutionIds.map(id => this.get('execution', id));
      const ready = children.filter(child => child.state === 'in_review' && child.reviewPolicy === 'agent');
      requireValue(ready.length > 0, 'review_not_ready', 'No opted-in candidates ready');
      for (const child of ready) {
        const grant = this.get('review_grant', child.reviewGrantId);
        requireValue(grant.state === 'active' && grant.parentExecutionId === parent.id, 'review_grant_inactive', 'Review grant inactive');
      }
      const fingerprint = digest(ready.map(child => [child.id, child.revision, child.result.digest]));
      requireValue(parent.reviewWakeFingerprint !== fingerprint, 'review_already_notified', 'These candidates were already offered for review');
      return changed('execution', parent, { state: 'continuation_ready', reviewWakeFingerprint: fingerprint,
        childContinuationId: fingerprint, continuationId: fingerprint });
    }
    if (action === 'execution.check_children') {
      fields(p, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
      const parent = this.get('execution', p.id); this.nodeOnly(actor, parent.targetNodeId); this.revision(parent, p.expectedRevision);
      requireValue(parent.state === 'waiting_children' && !parent.cancellationRequested, 'invalid_child_wait', 'Waiting parent required');
      const children = parent.childExecutionIds.map(id => this.get('execution', id));
      requireValue(children.every(child => child.state === 'completed' && child.result), 'children_pending', 'All required children must complete successfully', 409);
      const continuationId = digest(children.map(child => [child.id, child.revision, child.result.digest]));
      return changed('execution', parent, { state: 'continuation_ready', childContinuationId: continuationId, continuationId });
    }
    if (action === 'execution.admit') {
      fields(p, ['id', 'expectedRevision', 'bindingId', 'runId'], ['id', 'expectedRevision', 'bindingId', 'runId']);
      const e = this.get('execution', p.id); this.nodeOnly(actor, e.targetNodeId); this.revision(e, p.expectedRevision);
      const target = this.get('agent', e.targetAgentId);
      requireValue(!e.targetConversationId || target.conversationId === e.targetConversationId, 'target_conversation_replaced', 'Advertised execution target changed');
      requireValue(e.state === 'requested' && !e.cancellationRequested && !terminal(this.get('task', e.taskId)), 'execution_ineligible', 'Execution no longer eligible', 409);
      if (e.monitor) requireValue(Date.now() >= Date.parse(e.monitor.startsAt) && Date.now() < Date.parse(e.monitor.endsAt),
        'monitor_expired', 'Standing monitor is outside its admission window');
      this.revision(this.get('task', e.taskId), e.taskRevision);
      requireValue(this.get('task', e.taskId).dependencies.every(id => this.get('task', id).status === 'done'),
        'dependencies_pending', 'Dependencies are not complete', 409);
      requireValue(validId(p.bindingId) && validId(p.runId), 'invalid_request', 'Exact binding and run required');
      taskDisposition(e.taskId, 'in_progress', e.id);
      return changed('execution', e, { state: 'accepted', bindingId: p.bindingId, runId: p.runId });
    }
    if (action === 'execution.monitor_end') {
      fields(p, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
      const e = this.get('execution', p.id); this.nodeOnly(actor, e.targetNodeId);
      // Ending the immutable installed window is monotonic. A concurrent progress
      // receipt must not defeat its expiry cancellation request.
      requireValue(Number.isSafeInteger(p.expectedRevision) && p.expectedRevision <= e.revision, 'stale_revision', 'Valid observed monitor revision required');
      requireValue(e.monitor && Date.now() >= Date.parse(e.monitor.endsAt), 'monitor_not_expired', 'Monitor window has not ended');
      requireValue(!['completed', 'cancelled', 'failed', 'rejected'].includes(e.state), 'execution_terminal', 'Monitor already ended');
      return changed('execution', e, { cancellationRequested: true, cancellationReason: 'Standing monitoring window ended',
        ...(e.state === 'requested' ? { state: 'cancelled' } : {}) });
    }
    if (action === 'execution.cancel') {
      fields(p, ['id', 'expectedRevision', 'reason'], ['id', 'expectedRevision', 'reason']);
      const e = this.get('execution', p.id); this.revision(e, p.expectedRevision); string(p.reason, 'reason', 2000);
      if (actor.type !== 'user' && actor.id !== e.originNodeId) forbidden('Only requester or human may request cancellation');
      requireValue(!['completed', 'rejected', 'failed', 'cancelled'].includes(e.state), 'execution_terminal', 'Execution has already ended');
      return changed('execution', e, { cancellationRequested: true, cancellationReason: p.reason,
        ...(e.state === 'requested' ? { state: 'cancelled' } : {}) });
    }
    if (action === 'execution.progress') {
      fields(p, ['id', 'expectedRevision', 'summary'], ['id', 'expectedRevision', 'summary']);
      const e = this.get('execution', p.id); this.nodeOnly(actor, e.targetNodeId); this.revision(e, p.expectedRevision);
      requireValue(e.state === 'accepted', 'execution_inactive', 'Accepted execution required'); string(p.summary, 'summary', 4000);
      return changed('execution', e, { progress: p.summary });
    }
    if (action === 'execution.settle') {
      fields(p, ['id', 'expectedRevision', 'outcome', 'evidence'], ['id', 'expectedRevision', 'outcome', 'evidence']);
      const e = this.get('execution', p.id); this.nodeOnly(actor, e.targetNodeId); this.revision(e, p.expectedRevision);
      requireValue(['accepted', 'waiting', 'waiting_children', 'waiting_time', 'monitor_review', 'monitor_blocked', 'continuation_ready'].includes(e.state) && ['failed', 'cancelled'].includes(p.outcome),
        'invalid_settlement', 'Only outstanding work can settle as failed or cancelled');
      requireValue(p.outcome !== 'cancelled' || e.cancellationRequested, 'cancellation_not_requested', 'Cancellation request required');
      string(p.evidence, 'evidence', 4000);
      return changed('execution', e, { state: p.outcome, settlement: { outcome: p.outcome, evidence: p.evidence, at: now() } });
    }
    if (action === 'question.ask') {
      fields(p, ['id', 'executionId', 'expectedRevision', 'prompt', 'blocking', 'humanRequired'], ['id', 'executionId', 'expectedRevision', 'prompt']);
      const e = this.get('execution', p.executionId); this.nodeOnly(actor, e.targetNodeId); this.revision(e, p.expectedRevision);
      requireValue(e.state === 'accepted' && !e.cancellationRequested, 'execution_inactive', 'Current execution required');
      string(p.prompt, 'prompt', 4000);
      requireValue((p.blocking === undefined || typeof p.blocking === 'boolean') &&
        (p.humanRequired === undefined || typeof p.humanRequired === 'boolean'), 'invalid_request', 'Question flags must be boolean');
      const q = created('question', { id: p.id, executionId: e.id, taskId: e.taskId, requestingAgentId: e.targetAgentId,
        requestingRunId: e.runId, prompt: p.prompt, blocking: p.blocking ?? true, status: 'open',
        addressedTo: !p.humanRequired && e.originAgentId ? { type: 'agent', id: e.originAgentId } : { type: 'user', id: this.owner },
        allowedResponders: [...(!p.humanRequired && e.originAgentId ? [{ type: 'agent', id: e.originAgentId }] : []), { type: 'user', id: this.owner }], routing: [] });
      if (q.blocking) {
        requireValue(!e.waitingQuestionId, 'already_waiting', 'Execution already waiting on a blocking question');
        const waiting = changed('execution', e, { waitingQuestionId: q.id, state: 'waiting' });
        this.event('execution.waiting', waiting, actor, p.id);
      }
      return q;
    }
    if (action === 'question.close') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision', 'status', 'reason'], ['id', 'expectedRevision', 'status', 'reason']);
      const question = this.get('question', p.id); this.revision(question, p.expectedRevision);
      requireValue(question.status === 'open' && ['cancelled', 'superseded'].includes(p.status), 'question_closed', 'Open question and terminal closure required');
      string(p.reason, 'reason', 2000);
      // Closure is not an answer and does not make a worker eligible to resume.
      return changed('question', question, { status: p.status, closedByUserId: actor.id, closeReason: p.reason });
    }
    if (['question.forward', 'question.answer'].includes(action)) {
      fields(p, action === 'question.forward' ? ['id', 'expectedRevision', 'reason', 'agentId'] : ['id', 'expectedRevision', 'body', 'agentId', 'source'],
        ['id', 'expectedRevision', action === 'question.forward' ? 'reason' : 'body']);
      const q = this.get('question', p.id); this.revision(q, p.expectedRevision);
      requireValue(q.status === 'open', 'question_closed', 'Question is no longer open', 409);
      const responder = actor.type === 'user' ? { type: 'user', id: actor.id } : { type: 'agent', id: p.agentId };
      if (actor.type === 'node') this.agent(actor, p.agentId);
      requireValue(q.allowedResponders.some(value => same(value, responder)), 'forbidden', 'Actor may not resolve this question', 403);
      if (action === 'question.forward') {
        string(p.reason, 'reason', 2000);
        requireValue(q.addressedTo.type !== 'user', 'already_escalated', 'Already addressed to human');
        return changed('question', q, { addressedTo: { type: 'user', id: this.owner },
          routing: [...q.routing, { from: q.addressedTo, to: { type: 'user', id: this.owner }, reason: p.reason, at: now(), actor: responder }] });
      }
      string(p.body, 'body', 4000);
      if (p.source !== undefined) {
        fields(p.source, ['conversationId', 'messageId', 'digest'], ['conversationId', 'messageId', 'digest']);
        for (const [key, value] of Object.entries(p.source)) string(value, `source.${key}`, 512);
      }
      // Human answers require the owner's credential until a trusted TUI proof
      // connector exists. A node cannot claim source.type=user to self-elevate.
      const answered = changed('question', q, { status: 'answered', answer: { body: p.body, author: responder, at: now(),
        ...(p.source ? { source: p.source } : {}) } });
      const e = this.get('execution', q.executionId);
      if (q.blocking && e.state === 'waiting' && e.waitingQuestionId === q.id && e.cancellationRequested) {
        this.event('question.answered_after_cancel', answered, actor, q.id);
      }
      if (q.blocking && e.state === 'waiting' && e.waitingQuestionId === q.id && !e.cancellationRequested && !terminal(this.get('task', e.taskId))) {
        const ready = changed('execution', e, { state: 'continuation_ready', answerQuestionId: q.id, continuationId: q.id });
        this.event('execution.continuation_ready', ready, actor, q.id);
      }
      return answered;
    }
    if (action === 'execution.continue') {
      fields(p, ['id', 'expectedRevision', 'runId'], ['id', 'expectedRevision', 'runId']);
      const e = this.get('execution', p.id); this.nodeOnly(actor, e.targetNodeId); this.revision(e, p.expectedRevision);
      requireValue(e.state === 'continuation_ready' && !e.cancellationRequested && !terminal(this.get('task', e.taskId)) && validId(p.runId),
        'continuation_ineligible', 'Continuation is no longer eligible', 409);
      requireValue(p.runId !== e.runId, 'run_identity_reused', 'Continuation requires a new run identity');
      if (e.monitor) requireValue(Date.now() >= Date.parse(e.monitor.startsAt) && Date.now() < Date.parse(e.monitor.endsAt),
        'monitor_expired', 'Standing monitor is outside its continuation window');
      requireValue(this.get('task', e.taskId).dependencies.every(id => this.get('task', id).status === 'done'),
        'dependencies_pending', 'Dependencies must remain complete before continuation');
      return changed('execution', e, { state: 'accepted', runId: p.runId, waitingQuestionId: null });
    }
    if (action === 'execution.submit') {
      fields(p, ['id', 'expectedRevision', 'candidate', 'summary', 'evidence'], ['id', 'expectedRevision', 'candidate', 'summary', 'evidence']);
      const e = this.get('execution', p.id); this.nodeOnly(actor, e.targetNodeId); this.revision(e, p.expectedRevision);
      requireValue(e.state === 'accepted' && !e.cancellationRequested && !terminal(this.get('task', e.taskId)), 'execution_inactive', 'Current execution required');
      string(p.summary, 'summary'); string(p.candidate, 'candidate', 512); string(p.evidence, 'evidence', 4000);
      requireValue(!this.all('question').some(q => q.executionId === e.id && q.blocking && q.status === 'open') &&
        !this.all('execution').some(child => child.parentExecutionId === e.id && child.state !== 'completed'),
        'execution_blocked', 'Open questions or unsuccessful child work prevents submission');
      requireValue(this.get('task', e.taskId).dependencies.every(id => this.get('task', id).status === 'done') &&
        !this.all('task').some(child => child.parentId === e.taskId && !terminal(child)),
        'execution_blocked', 'Task dependencies or open child tasks prevent completion');
      taskDisposition(e.taskId, e.reviewPolicy !== 'none' ? 'in_review' : 'done', e.id);
      const revokedReview = e.reviewPolicy === 'agent' && this.get('review_grant', e.reviewGrantId).state !== 'active';
      return changed('execution', e, { state: e.reviewPolicy !== 'none' ? 'in_review' : 'completed',
        ...(revokedReview ? { reviewerMode: 'human_recovery' } : {}),
        result: { candidate: p.candidate, summary: p.summary, evidence: p.evidence,
          sequence: Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM changes').get().seq),
          digest: digest({ candidate: p.candidate, summary: p.summary }) } });
    }
    if (action === 'occurrence.review') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision', 'candidate', 'decision', 'reason', 'source'], ['id', 'expectedRevision', 'candidate', 'decision', 'reason']);
      const occurrence = this.get('occurrence', p.id); this.revision(occurrence, p.expectedRevision);
      requireValue(occurrence.state === 'in_review' && occurrence.candidate === p.candidate && ['accept', 'reject'].includes(p.decision),
        'stale_candidate', 'Exact pending occurrence candidate required');
      string(p.reason, 'reason', 4000);
      if (p.source !== undefined) {
        fields(p.source, ['conversationId', 'messageId', 'digest'], ['conversationId', 'messageId', 'digest']);
        for (const [key, value] of Object.entries(p.source)) string(value, `source.${key}`, 512);
      }
      if (occurrence.executionId) {
        const execution = this.get('execution', occurrence.executionId);
        requireValue(execution.state === 'in_review' && execution.result.candidate === p.candidate && !execution.cancellationRequested,
          'stale_candidate', 'Materialised occurrence review state changed');
        const reviewed = this.apply(actor, 'execution.review', { ...p, id: execution.id, expectedRevision: execution.revision });
        this.event('execution.review', reviewed, actor, occurrence.id);
        return this.get('occurrence', occurrence.id);
      }
      return changed('occurrence', occurrence, { state: p.decision === 'accept' ? 'completed' : 'rejected',
        review: { decision: p.decision, userId: actor.id, reason: p.reason, at: now(), candidate: p.candidate,
          ...(p.source ? { source: p.source } : {}) } });
    }
    if (action === 'execution.review') {
      this.ownerOnly(actor);
      fields(p, ['id', 'expectedRevision', 'candidate', 'decision', 'reason', 'source'], ['id', 'expectedRevision', 'candidate', 'decision', 'reason']);
      const e = this.get('execution', p.id); this.revision(e, p.expectedRevision);
      requireValue(e.state === 'in_review' && e.result.candidate === p.candidate && ['accept', 'reject'].includes(p.decision), 'stale_candidate', 'Exact pending candidate required');
      requireValue(!e.cancellationRequested && !terminal(this.get('task', e.taskId)), 'review_ineligible', 'Cancelled/terminal work cannot be reviewed');
      string(p.reason, 'reason', 4000);
      if (p.source !== undefined) {
        fields(p.source, ['conversationId', 'messageId', 'digest'], ['conversationId', 'messageId', 'digest']);
        for (const [key, value] of Object.entries(p.source)) string(value, `source.${key}`, 512);
      }
      taskDisposition(e.taskId, p.decision === 'accept' ? 'done' : 'todo', e.id);
      const occurrence = this.get('occurrence', e.id, false);
      if (occurrence?.executionId === e.id && occurrence.state === 'in_review') {
        const reviewed = changed('occurrence', occurrence, { state: p.decision === 'accept' ? 'completed' : 'rejected',
          review: { decision: p.decision, candidate: p.candidate, reason: p.reason, userId: actor.id, at: now(),
            ...(p.source ? { source: p.source } : {}) } });
        this.event('occurrence.review', reviewed, actor, e.id);
      }
      return changed('execution', e, { state: p.decision === 'accept' ? 'completed' : 'rejected',
        review: { decision: p.decision, candidate: p.candidate, resultDigest: e.result.digest, reason: p.reason, userId: actor.id, at: now(),
          ...(p.source ? { source: p.source } : {}) } });
    }
    if (action === 'execution.agent_review') {
      fields(p, ['id', 'expectedRevision', 'candidate', 'decision', 'reason', 'reviewerExecutionId', 'reviewerRunId'],
        ['id', 'expectedRevision', 'candidate', 'decision', 'reason', 'reviewerExecutionId', 'reviewerRunId']);
      const child = this.get('execution', p.id); this.revision(child, p.expectedRevision);
      const parent = this.get('execution', p.reviewerExecutionId); this.nodeOnly(actor, parent.targetNodeId);
      const grant = this.get('review_grant', child.reviewGrantId);
      requireValue(child.reviewPolicy === 'agent' && child.state === 'in_review' && !child.cancellationRequested &&
        grant.state === 'active' && grant.parentExecutionId === parent.id && grant.reviewerAgentId === parent.targetAgentId &&
        child.parentExecutionId === parent.id && parent.targetAgentId !== child.targetAgentId &&
        parent.state === 'accepted' && parent.runId === p.reviewerRunId && !parent.cancellationRequested &&
        child.result.candidate === p.candidate && ['accept', 'reject'].includes(p.decision),
        'review_not_authorised', 'Current independent parent reviewer and exact granted candidate required', 403);
      requireValue(!terminal(this.get('task', child.taskId)) && !terminal(this.get('task', parent.taskId)),
        'review_ineligible', 'Task disposition changed');
      string(p.reason, 'reason', 4000);
      taskDisposition(child.taskId, p.decision === 'accept' ? 'done' : 'todo', child.id);
      return changed('execution', child, { state: p.decision === 'accept' ? 'completed' : 'rejected', review: {
        decision: p.decision, candidate: p.candidate, resultDigest: child.result.digest, reason: p.reason,
        reviewerAgentId: parent.targetAgentId, reviewerRunId: parent.runId, grantId: grant.id, at: now(),
      } });
    }
    requireValue(false, 'unsupported_operation', 'Unknown native backend command');
  }

  validateTask(task) {
    string(task.title, 'title', 512);
    requireValue(typeof task.description === 'string' && task.description.length <= 65536 && taskStatuses.includes(task.status) &&
      ['critical', 'high', 'medium', 'low'].includes(task.priority) && Array.isArray(task.labels) && task.labels.length <= 64 && task.labels.every(validId),
    'invalid_request', 'Invalid task fields');
    requireValue(Array.isArray(task.dependencies) && task.dependencies.length <= 100 && new Set(task.dependencies).size === task.dependencies.length &&
      task.dependencies.every(validId) && (task.parentId === null || validId(task.parentId)), 'invalid_request', 'Invalid relationships');
    const traverse = (id, links, seen = new Set()) => {
      requireValue(id !== task.id && seen.size < 100, 'invalid_graph', 'Cyclic or oversized task graph');
      if (seen.has(id)) return;
      seen.add(id);
      const current = this.get('task', id);
      for (const next of links(current)) traverse(next, links, seen);
    };
    if (task.parentId) traverse(task.parentId, t => t.parentId ? [t.parentId] : []);
    for (const id of task.dependencies) traverse(id, t => t.dependencies);
  }

  referenceIdentity(reference) {
    fields(reference, ['namespace', 'externalId', 'url'], ['namespace', 'externalId']);
    string(reference.namespace, 'namespace', 256); string(reference.externalId, 'externalId', 1024);
    if (reference.url !== undefined) {
      let url;
      try { url = new URL(reference.url); } catch {}
      requireValue(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
        'invalid_reference', 'Reference URL must be HTTP(S) without credentials');
    }
    return `reference_${digest([reference.namespace, reference.externalId])}`;
  }

  activity({ from, to, taskId, cursor, limit = 100 }) {
    requireValue(typeof from === 'string' && typeof to === 'string' && Number.isFinite(Date.parse(from)) &&
      Date.parse(from) < Date.parse(to) && Number.isInteger(limit) && limit > 0 && limit <= 500,
    'invalid_query', 'Explicit from/to interval and bounded limit required');
    const scope = digest({ from, to, taskId: taskId ?? null, limit });
    let after = 0;
    if (cursor) {
      let value;
      try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch {}
      requireValue(value?.scope === scope && value.instance === this.instance && Number.isSafeInteger(value.after),
        'invalid_cursor', 'Activity cursor scope changed');
      after = value.after;
    }
    const rows = this.db.prepare(`SELECT seq,data FROM changes WHERE seq>? AND at>=? AND at<?
      ${taskId ? "AND (json_extract(data,'$.entityId')=? OR json_extract(data,'$.data.taskId')=?)" : ''} ORDER BY seq LIMIT ?`)
      .all(after, new Date(from).toISOString(), new Date(to).toISOString(), ...(taskId ? [taskId, taskId] : []), limit + 1);
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({ instance: this.instance, scope, after: items.at(-1).seq })).toString('base64url') : null;
    return { items: items.map(row => JSON.parse(row.data)), nextCursor, complete: !nextCursor, fetchedAt: now(), interval: '[from,to)' };
  }

  events({ cursor, limit = 100 } = {}) {
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, 'invalid_request', 'Limit must be 1..500');
    let after = 0;
    if (cursor) {
      let value;
      try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch {}
      requireValue(value?.instance === this.instance && Number.isSafeInteger(value.after) && value.after >= 0,
        'invalid_cursor', 'Cursor belongs to another backend or is malformed');
      after = value.after;
      requireValue(after <= Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM changes').get().seq),
        'invalid_cursor', 'Event cursor is ahead of this backend');
    }
    const rows = this.db.prepare('SELECT seq,data FROM changes WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(row => JSON.parse(row.data)), cursor: Buffer.from(JSON.stringify({ instance: this.instance,
      after: page.at(-1)?.seq ?? after })).toString('base64url'), hasMore: rows.length > limit,
    fetchedAt: now(), retention: 'all_events_since_backend_creation' };
  }

  query(kind, { cursor, limit = 100, taskId, status } = {}) {
    requireValue(['task', 'comment', 'execution', 'question', 'agent', 'node', 'schedule', 'occurrence', 'notification', 'monitor_result', 'artifact'].includes(kind), 'invalid_query', 'Unknown collection');
    requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= 500 &&
      (!taskId || validId(taskId)) && (!status || typeof status === 'string' && status.length <= 100), 'invalid_query', 'Invalid collection scope');
    const scope = digest({ kind, limit, taskId: taskId ?? null, status: status ?? null });
    let after = '';
    if (cursor) {
      let value;
      try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch {}
      requireValue(value?.instance === this.instance && value.scope === scope && typeof value.after === 'string',
        'invalid_cursor', 'Collection cursor scope changed');
      after = value.after;
    }
    const items = this.db.prepare(`SELECT data FROM entities WHERE kind=? AND id>?
      ${taskId ? "AND json_extract(data,'$.taskId')=?" : ''}
      ${status ? "AND COALESCE(json_extract(data,'$.status'),json_extract(data,'$.state'))=?" : ''} ORDER BY id LIMIT ?`)
      .all(kind, after, ...(taskId ? [taskId] : []), ...(status ? [status] : []), limit + 1).map(row => JSON.parse(row.data));
    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    return { items: page, nextCursor: hasMore ? Buffer.from(JSON.stringify({ instance: this.instance, scope, after: page.at(-1).id })).toString('base64url') : null,
      complete: !hasMore, fetchedAt: now(), scope: { kind, taskId: taskId ?? null, status: status ?? null, limit },
      warnings: ['Traversal is not a transactional snapshot.'] };
  }
}
