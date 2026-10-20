import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { canonical, digest, now, requireValue } from './protocol.mjs';

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
        if (event.data?.targetNodeId === this.nodeId && event.type.startsWith('execution.')) {
          const old = this.work(event.entityId);
          if (!old || event.revision > (old.execution.revision ?? 0)) {
            const work = { ...old, id: event.entityId, execution: event.data, state: old?.state ?? 'pending', updatedAt: now() };
            this.save(work);
          }
        }
        if (event.type === 'schedule.publish' && event.data?.nodeId === this.nodeId) {
          const local = this.work(event.entityId);
          if (local?.execution.localOccurrence) this.save({ ...local, state: 'settled', execution: { ...local.execution,
            state: event.data.state, result: { candidate: event.data.candidate, summary: event.data.summary } } });
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
  works() { return this.db.prepare('SELECT data FROM work ORDER BY id').all().map(row => JSON.parse(row.data)); }
  save(work) {
    this.db.prepare('INSERT INTO work VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data')
      .run(work.id, work.state, JSON.stringify(work));
    return work;
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
  queue(command) {
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT hash,data FROM outbox WHERE key=?').get(command.key);
      if (previous) {
        requireValue(previous.hash === digest(command), 'operation_conflict', 'Queued command payload changed');
        return JSON.parse(previous.data);
      }
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state IN ('pending','conflict')").get().n;
      requireValue(count < this.maxPending, 'outbox_full', 'Publication outbox is full. Resolve pending/conflicting operations before admitting more work', 503);
      const item = { command, state: 'pending', createdAt: now() };
      this.db.prepare('INSERT INTO outbox VALUES (?,?,?,?)').run(command.key, digest(command), item.state, JSON.stringify(item));
      return item;
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
      // Native backend commands compare payloads and persist idempotency receipts.
      // The same immutable command can therefore be retried after a lost reply.
      try {
        const receipt = await api('POST', '/v1/commands', item.command);
        const recorded = { ...item, state: 'recorded', receipt };
        this.db.prepare('UPDATE outbox SET state=?,data=? WHERE key=?').run(recorded.state, JSON.stringify(recorded), item.command.key);
      } catch (error) {
        if (['execution.monitor_result', 'execution.submit'].includes(item.command.action) && error.code === 'monitor_expired') {
          const skipped = { ...item, state: 'superseded', error: error.code };
          this.db.prepare('UPDATE outbox SET state=?,data=? WHERE key=?').run(skipped.state, JSON.stringify(skipped), item.command.key);
          continue;
        }
        if ([400, 403, 404, 409].includes(error.status)) {
          const conflict = { ...item, state: 'conflict', error: error.code };
          this.db.prepare('UPDATE outbox SET state=?,data=? WHERE key=?').run(conflict.state, JSON.stringify(conflict), item.command.key);
        }
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
