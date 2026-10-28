import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { canonical, digest, now, requireValue } from './protocol.mjs';
import { refusedDispatchErrors } from './interactive-dispatch-reconciliation.mjs';
import { publicationOutcome, definitivePublicationRefusal } from './publication-outcomes.mjs';

export const abandonedWork = work => work?.state === 'administratively_abandoned';
export const commandWorkId = command => command.payload?.executionId ?? command.payload?.parentExecutionId ??
  (command.action === 'schedule.ask' ? command.payload?.occurrenceId :
    command.action.startsWith('execution.') || ['schedule.publish', 'schedule.fail'].includes(command.action) ? command.payload?.id : undefined);

// Local node transport journal, separate from shared task storage and legacy runs.
export class NodeJournal {
  constructor(path, { nodeId, instanceId, maxPending = 10000 }) {
    requireValue(Number.isSafeInteger(maxPending) && maxPending > 0, 'invalid_capacity', 'Positive outbox capacity required');
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    requireValue(this.db.prepare('PRAGMA user_version').get().user_version <= 1,
      'unsupported_schema', 'Node journal schema is newer than this build');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(key TEXT PRIMARY KEY,hash TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY,state TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS occurrences(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,state TEXT NOT NULL,data TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS local_notifications(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS execution_history(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS cached_entities(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id))');
    this.db.exec('PRAGMA user_version=1');
    const identity = canonical({ nodeId, instanceId });
    const existing = this.db.prepare('SELECT value FROM settings WHERE key=?').get('identity');
    requireValue(!existing || existing.value === identity, 'node_identity_mismatch', 'Journal belongs to another node/backend');
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('identity', identity);
    this.nodeId = nodeId;
    this.instanceId = instanceId;
    this.maxPending = maxPending;
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
  cursor() { return this.db.prepare('SELECT value FROM settings WHERE key=?').get('cursor')?.value; }
  reconcileSnapshot(snapshot) {
    requireValue(snapshot.instanceId === this.instanceId && snapshot.protocol === 'relay/0.2' && snapshot.collections &&
      typeof snapshot.cursor === 'string', 'snapshot_identity_mismatch', 'Snapshot must belong to the pinned native backend');
    const events = [];
    for (const kind of ['task', 'comment', 'agent', 'node']) for (const entity of snapshot.collections[kind] ?? []) events.push({
      id: `snapshot:${kind}:${entity.id}:${entity.revision}`, type: `${kind}.snapshot`, entityId: entity.id, revision: entity.revision, data: entity });
    for (const execution of snapshot.collections.execution ?? []) events.push({ id: `snapshot:execution:${execution.id}:${execution.revision}`,
      type: 'execution.snapshot', entityId: execution.id, revision: execution.revision, data: execution });
    for (const question of snapshot.collections.question ?? []) if (question.status === 'open') events.push({
      id: `snapshot:question:${question.id}:${question.revision}`, type: 'question.ask', entityId: question.id, revision: question.revision, data: question });
    for (const schedule of snapshot.collections.schedule ?? []) events.push({ id: `snapshot:schedule:${schedule.id}:${schedule.revision}`,
      type: schedule.transfer?.state === 'requested' ? 'schedule.transfer_request' : schedule.cancelled ? 'schedule.cancel' : 'schedule.install',
      entityId: schedule.id, revision: schedule.revision, data: schedule });
    for (const request of snapshot.collections.provision_request ?? []) events.push({ id: `snapshot:provision:${request.id}:${request.revision}`,
      type: 'interactive.request', entityId: request.id, revision: request.revision, data: request });
    for (const request of snapshot.collections.grant_request ?? []) if (request.state === 'rejected') events.push({
      id: `snapshot:grant-request:${request.id}:${request.revision}`, type: 'grant.request_decide', entityId: request.id, revision: request.revision, data: request });
    for (const setup of snapshot.collections.headless_setup ?? []) events.push({ id: `snapshot:headless:${setup.id}:${setup.revision}`,
      type: 'headless.request', entityId: setup.id, revision: setup.revision, data: setup });
    for (const message of snapshot.collections.message ?? []) events.push({ id: `snapshot:message:${message.id}:${message.revision}`,
      type: 'message.snapshot', entityId: message.id, revision: message.revision, data: message });
    // Native delivery intent/history is never replaced from a shared snapshot.
    // Only newer backend projections and new addressed work are merged.
    this.consume({ items: events, cursor: snapshot.cursor });
  }
  consume(page) {
    requireValue(Array.isArray(page.items) && typeof page.cursor === 'string' &&
      page.items.every(event => event && typeof event.id === 'string' && event.id && typeof event.type === 'string' &&
        typeof event.entityId === 'string' && Number.isSafeInteger(event.revision) && event.revision > 0 && event.data && event.data.id === event.entityId),
      'invalid_events', 'Valid event page required');
    return this.transaction(() => {
      for (const event of page.items) {
        const previous = this.db.prepare('SELECT data FROM inbox WHERE id=?').get(event.id);
        if (previous) { requireValue(previous.data === JSON.stringify(event), 'event_conflict', 'Event identity payload changed'); continue; }
        this.db.prepare('INSERT INTO inbox VALUES (?,?)').run(event.id, JSON.stringify(event));
        if (['headless.request', 'headless.activate', 'headless.block', 'headless.contract_approved', 'headless.contract_applied'].includes(event.type) && event.data.nodeId === this.nodeId) {
          const key = `headless-setup:${event.entityId}`;
          const old = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
          if (!old || JSON.parse(old.value).revision < event.revision) this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(key, JSON.stringify(event.data));
        }
        if (['interactive.request', 'interactive.progress', 'interactive.cancel'].includes(event.type) && !event.data.permissionRequest && event.data.nodeId === this.nodeId) {
          const key = `interactive-request:${event.entityId}`;
          const old = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
          if (!old || JSON.parse(old.value).revision < event.revision) this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
              .run(key, JSON.stringify(event.data));
        }
        const permissionOutcome = event.type === 'grant.request_decide' && event.data.state === 'rejected' ||
          ['interactive.progress', 'interactive.request'].includes(event.type) && event.data.approvalRequestId && ['ready', 'blocked', 'cancelled'].includes(event.data.state);
        if (permissionOutcome && event.data.requesterNodeId === this.nodeId) {
          const requestId = event.data.approvalRequestId ?? event.data.id;
          const notice = { id: `permission:${requestId}:${event.data.state}`, kind: 'permission', permissionRequestId: requestId,
            agentId: event.data.requesterAgentId, state: 'pending' };
          this.db.prepare('INSERT OR IGNORE INTO notices VALUES (?,?,?)').run(notice.id, notice.state, JSON.stringify(notice));
        }
        const cacheKind = event.type.startsWith('task.') ? 'task' : event.type.startsWith('comment.') ? 'comment' :
          event.type.startsWith('agent.') ? 'agent' : event.type.startsWith('node.') ? 'node' :
          event.type.startsWith('question.') ? 'question' : null;
        if (cacheKind) {
          const old = this.db.prepare('SELECT data FROM cached_entities WHERE kind=? AND id=?').get(cacheKind, event.entityId);
          if (!old || JSON.parse(old.data).entity.revision <= event.revision) this.db.prepare(`INSERT INTO cached_entities VALUES (?,?,?)
            ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data`).run(cacheKind, event.entityId, JSON.stringify({ entity: event.data, fetchedAt: now() }));
        }
        if (['schedule.install', 'schedule.transfer_activate', 'schedule.cancel', 'schedule.pause', 'schedule.resume'].includes(event.type) && event.data?.definition?.nodeId === this.nodeId) {
          const schedule = event.data;
          const key = `schedule-pending:${schedule.id}`;
          const pending = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
          const installed = this.db.prepare('SELECT data FROM schedules WHERE id=?').get(schedule.id);
          const revision = Math.max(pending ? JSON.parse(pending.value).revision : 0,
            installed ? JSON.parse(installed.data).definition.revision : 0);
          if (schedule.revision > revision) this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(key, JSON.stringify(schedule));
        }
        if (event.type === 'schedule.transfer_request' && event.data?.transfer?.sourceNodeId === this.nodeId) {
          this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(`schedule-transfer:${event.entityId}`, JSON.stringify(event.data));
        }
        if (event.type === 'schedule.transfer_activate' && event.data?.transfer?.sourceNodeId === this.nodeId) {
          const local = this.db.prepare('SELECT data FROM schedules WHERE id=?').get(event.entityId);
          if (local) this.db.prepare('UPDATE schedules SET data=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(local.data), state: 'transferred' }), event.entityId);
        }
        if (['question.ask', 'question.forward'].includes(event.type) && event.data?.addressedTo?.type === 'agent') {
          const notice = { id: event.id, questionId: event.data.id, agentId: event.data.addressedTo.id,
            revision: event.data.revision, prompt: event.data.prompt, state: 'pending' };
          this.db.prepare('INSERT OR IGNORE INTO notices VALUES (?,?,?)').run(notice.id, notice.state, JSON.stringify(notice));
        }
        if (event.type.startsWith('message.') && event.data.recipient?.nodeId === this.nodeId &&
          ['queued', 'delivering', 'uncertain'].includes(event.data.state)) {
          const message = event.data, id = `message:${message.id}`;
          // Replays/snapshots merge by message identity, never by change-event ID.
          const notice = { id, messageId: message.id, agentId: message.recipient.agentId, state: 'pending', kind: 'message' };
          this.db.prepare('INSERT OR IGNORE INTO notices VALUES (?,?,?)').run(id, notice.state, JSON.stringify(notice));
        }
        if (event.data?.targetNodeId === this.nodeId && event.type.startsWith('execution.')) {
          const old = this.work(event.entityId);
          if (!old || event.revision > (old.execution.revision ?? 0)) {
            const work = { ...old, id: event.entityId, execution: event.data, state: old?.state ?? 'pending', updatedAt: now() };
            this.save(work);
          }
        }
        if (['schedule.publish', 'schedule.fail'].includes(event.type) && event.data?.nodeId === this.nodeId) {
          const local = this.work(event.entityId);
          if (local?.execution.localOccurrence) this.save({ ...local, state: 'settled', execution: { ...local.execution,
            state: event.data.state, ...(event.type === 'schedule.fail' ? { failure: { reason: event.data.reason, evidence: event.data.evidence } } :
              { result: { candidate: event.data.candidate, summary: event.data.summary } }) } });
        }
      }
      this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('cursor', page.cursor);
    });
  }
  work(id) { const row = this.db.prepare('SELECT data FROM work WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; }
  cached(kind) { return this.db.prepare('SELECT data FROM cached_entities WHERE kind=? ORDER BY id').all(kind).map(row => JSON.parse(row.data)); }
  receipt(key) {
    const row = this.db.prepare('SELECT data FROM outbox WHERE key=?').get(key);
    return row ? JSON.parse(row.data) : null;
  }
  recordPublication(item) {
    return this.transaction(() => {
      const current = this.receipt(item.command.key);
      if (current?.state === 'administratively_abandoned' || current?.state === 'recorded' && item.state !== 'recorded') return current;
      if (['refused', 'superseded'].includes(current?.state) && item.state !== 'recorded') return current;
      requireValue(!current || canonical(current.command) === canonical(item.command), 'operation_conflict', 'Publication command changed during reconciliation');
      this.db.prepare('UPDATE outbox SET state=?,data=? WHERE key=?').run(item.state, JSON.stringify(item), item.command.key);
      return item;
    });
  }
  works() { return this.db.prepare('SELECT data FROM work ORDER BY id').all().map(row => JSON.parse(row.data)); }
  assertReceiver(binding) {
    if (!binding.receiverGeneration) return;
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(`receiver:${binding.agentId}`);
    const receiver = row && JSON.parse(row.value);
    requireValue(receiver?.state === 'active' && receiver.bindingId === binding.id && receiver.generation === binding.receiverGeneration,
      'receiver_replaced', 'Receiving conversation changed before admission', 409);
  }
  save(work) {
    return this.transaction(() => {
      const current = this.work(work.id);
      if (abandonedWork(current)) {
        // A stale observer/admission callback cannot resurrect withdrawn work.
        if ((work.execution?.revision ?? 0) > (current.execution?.revision ?? 0)) {
          const next = { ...current, execution: work.execution };
          this.db.prepare('UPDATE work SET data=? WHERE id=?').run(JSON.stringify(next), current.id); return next;
        }
        return current;
      }
      this.db.prepare('INSERT INTO work VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data')
        .run(work.id, work.state, JSON.stringify(work));
      return work;
    });
  }
  abandonWork(id, { key, reason, expectedDigest, proof, backup, actor = 'local_operator' }) {
    return this.transaction(() => {
      const request = { operation: 'work.abandon', id, key, reason, expectedDigest }, auditKey = `recovery:${digest(key)}`;
      const previous = this.db.prepare('SELECT value FROM settings WHERE key=?').get(auditKey);
      if (previous) { const saved = JSON.parse(previous.value); requireValue(saved.requestHash === digest(request), 'operation_conflict', 'Recovery key changed'); return saved.receipt; }
      const work = this.work(id);
      requireValue(work && digest(work) === expectedDigest, 'stale_recovery_preview', 'Local work changed; inspect it again');
      requireValue(proof && proof.executionId === id && proof.nodeId === this.nodeId && (proof.terminalBackend || proof.cancelledLocalSchedule),
        'recovery_ineligible', 'Current terminal backend execution or cancelled local-only schedule proof required');
      requireValue(typeof reason === 'string' && reason.trim() && reason.length <= 2000, 'invalid_request', 'Explicit bounded abandonment reason required');
      const linked = this.db.prepare("SELECT data FROM outbox WHERE state IN ('pending','conflict')").all().map(row => JSON.parse(row.data))
        .filter(item => commandWorkId(item.command) === id);
      requireValue(linked.length === 0, 'recovery_publication_pending', 'Inspect and reconcile or abandon associated publications first');
      this.archive(work);
      const disposition = { kind: 'abandonment', key, reason, actor, at: now(), proof, backup,
        originalDigest: expectedDigest, invocationDigest: digest(work.invocation ?? null), observationDigest: digest(work.observation ?? null),
        assignmentWithdrawn: true, promptReplayAllowed: false, nativeSettlementClaimed: false, successfulCompletionClaimed: false, nativeProcessTerminationClaimed: false };
      const projection = proof.terminalBackend ? { ...work.execution, state: proof.backendState, revision: proof.backendRevision,
        cancellationRequested: proof.cancellationRequested ?? work.execution.cancellationRequested } :
        { ...work.execution, state: 'cancelled', cancellationRequested: true, administrativeDisposition: disposition };
      requireValue(!proof.terminalBackend || ['completed', 'cancelled', 'failed', 'rejected'].includes(proof.backendState) &&
        Number.isSafeInteger(proof.backendRevision) && proof.backendRevision >= work.execution.revision, 'recovery_ineligible', 'Fresh terminal execution proof required');
      this.save({ ...work, execution: projection, state: 'administratively_abandoned', administrativeDisposition: disposition });
      if (work.execution.localOccurrence) {
        const row = this.db.prepare('SELECT data FROM occurrences WHERE id=?').get(id);
        if (row) this.db.prepare('UPDATE occurrences SET state=?,data=? WHERE id=?').run('administratively_abandoned',
          JSON.stringify({ ...JSON.parse(row.data), state: 'administratively_abandoned', administrativeDisposition: disposition }), id);
      }
      const receipt = { state: 'administratively_abandoned', kind: 'work', id, key, nativeSettlementClaimed: false,
        nativeProcessTerminationClaimed: false, successfulCompletionClaimed: false, promptReplayed: false, backup };
      this.db.prepare('INSERT INTO settings VALUES (?,?)').run(auditKey, JSON.stringify({ requestHash: digest(request), before: work, disposition, receipt }));
      return receipt;
    });
  }
  abandonPublication(id, { key, reason, expectedDigest, proof: inspectedProof, backup, actor = 'local_operator' }) {
    return this.transaction(() => {
      const request = { operation: 'publication.abandon', id, key, reason, expectedDigest }, auditKey = `recovery:${digest(key)}`;
      const previous = this.db.prepare('SELECT value FROM settings WHERE key=?').get(auditKey);
      if (previous) { const saved = JSON.parse(previous.value); requireValue(saved.requestHash === digest(request), 'operation_conflict', 'Recovery key changed'); return saved.receipt; }
      const row = this.db.prepare('SELECT key,hash,state,data FROM outbox WHERE key=?').get(id);
      requireValue(row && digest(JSON.parse(row.data)) === expectedDigest, 'stale_recovery_preview', 'Publication changed; inspect it again');
      const item = JSON.parse(row.data);
      const fence = inspectedProof?.kind === 'backend_revision_fence' && inspectedProof.nodeId === this.nodeId && inspectedProof.commandHash === row.hash &&
        inspectedProof.receiptAbsent === true && Number.isSafeInteger(inspectedProof.currentRevision) &&
        inspectedProof.expectedRevision === item.command?.payload?.expectedRevision && inspectedProof.currentRevision !== inspectedProof.expectedRevision;
      const proof = definitivePublicationRefusal(row) ?? (fence && row.hash === digest(item.command) && !item.receipt && item.applied !== true ? inspectedProof : null);
      requireValue(proof, 'publication_ineligible', 'Only a verified transactional validation refusal or inspected backend revision fence may be abandoned. Unresolved uncertainty requires reconciliation');
      requireValue(typeof reason === 'string' && reason.trim() && reason.length <= 2000, 'invalid_request', 'Explicit bounded abandonment reason required');
      const before = JSON.parse(row.data), disposition = { kind: 'abandonment', key, reason, actor, at: now(), backup, proof,
        originalDigest: expectedDigest, commandHash: row.hash, replayAllowed: false, applied: false };
      const next = { ...before, state: 'administratively_abandoned', outcome: 'administratively_abandoned', applied: false, effectsUncertain: false, administrativeDisposition: disposition };
      this.db.prepare('UPDATE outbox SET state=?,data=? WHERE key=?').run(next.state, JSON.stringify(next), id);
      const receipt = { state: next.state, kind: 'publication', id, key, applied: false, replayed: false, backup };
      this.db.prepare('INSERT INTO settings VALUES (?,?)').run(auditKey, JSON.stringify({ requestHash: digest(request), before, disposition, receipt }));
      return receipt;
    });
  }
  archive(work) {
    if (!work.invocation || !work.execution?.runId) return;
    const id = digest([work.id, work.invocation.runId ?? work.execution.runId]);
    const previous = this.db.prepare('SELECT data FROM execution_history WHERE id=?').get(id);
    if (previous) {
      requireValue(canonical(JSON.parse(previous.data).invocation) === canonical(work.invocation), 'history_conflict', 'Original native invocation changed');
      return;
    }
    this.db.prepare('INSERT INTO execution_history VALUES (?,?)').run(id, JSON.stringify(work));
  }
  queue(command, { inputRevision } = {}) {
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT hash,data FROM outbox WHERE key=?').get(command.key);
      if (previous) {
        requireValue(previous.hash === digest(command), 'operation_conflict', 'Queued command payload changed');
        return JSON.parse(previous.data);
      }
      const ownerId = commandWorkId(command);
      const owner = typeof ownerId === 'string' ? this.work(ownerId) : null;
      requireValue(!abandonedWork(owner), 'work_abandoned', 'Administrative abandonment forbids new dispatch/publication for the original invocation');
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state IN ('pending','conflict')").get().n;
      requireValue(count < this.maxPending, 'outbox_full', 'Publication outbox is full. Resolve pending/conflicting operations before admitting more work', 503);
      const item = { command, state: 'pending', createdAt: now(), ...(inputRevision ? { inputRevision } : {}) };
      this.db.prepare('INSERT INTO outbox VALUES (?,?,?,?)').run(command.key, digest(command), item.state, JSON.stringify(item));
      return item;
    });
  }
  reconcileRefusedDispatch(command, { retry = false, reason } = {}) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT hash,state,data FROM outbox WHERE key=?').get(command.key);
      requireValue(row && row.hash === digest(command) && command.action === 'interactive.dispatch', 'operation_conflict', 'Exact original interactive dispatch required');
      const item = JSON.parse(row.data);
      requireValue(digest(item.command) === row.hash, 'operation_conflict', 'Stored dispatch command hash differs; inspect before reconciliation');
      requireValue(item.state === row.state && !item.receipt && item.applied !== true, 'publication_ineligible', 'Inconsistent or previously applied dispatch requires inspection');
      requireValue(['conflict', 'superseded'].includes(row.state) && refusedDispatchErrors.has(item.error),
        'publication_ineligible', 'A known transaction-refused dispatch is required; uncertain outcomes cannot be retired');
      requireValue(!retry || item.error === 'identity_conflict' && !item.dispatchReconciliation?.retried,
        'publication_ineligible', 'Only one existing-task identity correction may retry this original dispatch');
      if (!retry && row.state === 'superseded') return item;
      const next = { ...item, state: retry ? 'pending' : 'superseded', outcome: retry ? 'reconciling' : 'refused', applied: retry ? undefined : false,
        dispatchReconciliation: { ...item.dispatchReconciliation, retried: retry || item.dispatchReconciliation?.retried === true,
          previousError: item.error, reason, at: now(), refusals: [...(item.dispatchReconciliation?.refusals ?? []),
            ...(row.state === 'conflict' ? [{ error: item.error, observedAt: now() }] : [])] } };
      this.db.prepare('UPDATE outbox SET state=?,data=? WHERE key=?').run(next.state, JSON.stringify(next), command.key);
      return next;
    });
  }
  async flush(api) {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushPending(api).finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async flushPending(api) {
    for (const row of this.db.prepare("SELECT data FROM outbox WHERE state='pending' ORDER BY rowid").all()) {
      const item = JSON.parse(row.data);
      const ownerId = commandWorkId(item.command);
      if (typeof ownerId === 'string' && abandonedWork(this.work(ownerId))) continue;
      let requestStarted = false, backendReplied = false;
      // Native backend commands compare payloads and persist idempotency receipts.
      // The same immutable command can therefore be retried after a lost reply.
      try {
        const admission = await this.beforePublish?.(item);
        if (admission === false) continue;
        if (admission === 'supersede' || admission?.refused) {
          this.recordPublication({ ...item, state: 'superseded', outcome: 'refused', applied: false,
            error: admission.reason ?? 'stale_input_revision', ...(admission.executionRevision ? { fencedExecutionRevision: admission.executionRevision } : {}) });
          continue;
        }
        if (admission?.recordedReceipt) {
          this.recordPublication({ ...item, state: 'recorded', receipt: admission.recordedReceipt, reconciledWithoutReplay: true });
          continue;
        }
        item.attemptedAt ??= now();
        if (this.receipt(item.command.key)?.state !== 'pending' || this.recordPublication(item).state !== 'pending') continue;
        requestStarted = true;
        const receipt = await api('POST', '/v1/commands', item.command); backendReplied = true;
        if (item.command.action === 'interactive.dispatch') requireValue(receipt?.id === item.command.payload.executionId && receipt.taskId === item.command.payload.taskId,
          'invalid_backend_response', 'Interactive dispatch receipt differs from the original task/execution', 502);
        const recorded = { ...item, state: 'recorded', receipt, ...(item.command.action === 'interactive.dispatch' ? { outcome: 'applied', applied: true, error: undefined } : {}) };
        this.recordPublication(recorded);
      } catch (error) {
        if (['execution.monitor_result', 'execution.submit'].includes(item.command.action) && error.code === 'monitor_expired') {
          const skipped = { ...item, state: 'superseded', error: error.code };
          this.recordPublication(skipped);
          continue;
        }
        const outcome = requestStarted && !backendReplied ? publicationOutcome(item.command, error) : { state: 'pending', outcome: 'uncertain', effectsUncertain: true };
        const next = { ...item, ...outcome, error: error.code ?? 'transport_uncertain' };
        this.recordPublication(next);
        throw error;
      }
    }
  }
  async poll(api) {
    let page;
    const cursors = new Set();
    do {
      const cursor = this.cursor();
      try { page = await api('GET', `/v1/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`); }
      catch (error) {
        if (error.code !== 'cursor_expired') throw error;
        this.reconcileSnapshot(await api('GET', '/v1/snapshot'));
        page = null;
        continue;
      }
      requireValue(!page.hasMore || page.cursor !== cursor && !cursors.has(page.cursor), 'invalid_cursor', 'Event cursor did not advance');
      cursors.add(page.cursor);
      this.consume(page);
    } while (!page || page.hasMore);
  }
}
