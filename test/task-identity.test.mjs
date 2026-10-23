import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BackendStore } from '../src/backend-store.mjs';
import { startBackend } from '../src/backend-service.mjs';
import { digest } from '../src/protocol.mjs';
import { parseTaskReference, resolveTaskIdentity } from '../src/task-identity.mjs';
import { migrateTaskIdentity, planTaskIdentityMigration } from '../src/task-identity-migration.mjs';
import { serviceLock } from '../src/service-lock.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { nativeTasksProvider } from '../src/tasks-provider.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { call } from '../src/client.mjs';

function fixture(t, path = ':memory:') {
  const store = new BackendStore(path), token = store.bootstrap().token, owner = store.authenticate(token);
  t.after(() => store.close());
  const command = (action, payload, key = crypto.randomUUID(), actor = owner) => store.command(actor, { action, payload, key });
  return { store, owner, token, command };
}
function directory(t) {
  const root = mkdtempSync('/tmp/opencode/task-identity-');
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function legacyDatabase(path, tasks = []) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE credentials(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
    CREATE TABLE entities(kind TEXT,id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(kind,id));
    CREATE TABLE receipts(actor TEXT,key TEXT,hash TEXT,data TEXT,PRIMARY KEY(actor,key));
    CREATE TABLE changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,at TEXT,data TEXT);
    PRAGMA user_version=1;`);
  db.prepare('INSERT INTO settings VALUES (?,?)').run('owner', 'owner');
  db.prepare('INSERT INTO settings VALUES (?,?)').run('instance', 'original-instance');
  for (const task of tasks) db.prepare('INSERT INTO entities VALUES (?,?,?,?)').run('task', task.id, task.revision, JSON.stringify(task));
  return db;
}

test('automatic references and generated IDs share atomic creation receipts, including later human edits', t => {
  const f = fixture(t), input = { title: 'Capture once' }, first = f.command('task.create', input, 'create');
  assert.match(first.id, /^task_/); assert.equal(first.reference, 'REL-1');
  f.command('task.update', { id: first.id, expectedRevision: 1, changes: { title: 'Human edit' } });
  assert.deepEqual(f.command('task.create', input, 'create'), first);
  assert.throws(() => f.command('task.create', { ...input, reference: 'REL-1' }, 'create'), { code: 'operation_conflict' });
  assert.equal(f.command('task.create', { id: 'second', title: 'Second' }).reference, 'REL-2');
  assert.equal(f.store.get('task', first.id).title, 'Human edit');
});

test('reference grammar rejects malformed numbers, precision loss and non-canonical claims', () => {
  for (const value of ['rel-1', 'REL-0', 'REL-01', 'REL--1', 'REL-1.5', 'A'.repeat(17) + '-1', 'REL-9007199254740992', null, 1]) assert.throws(() => parseTaskReference(value), { code: 'invalid_task_reference' });
  assert.deepEqual(parseTaskReference('TWD-456'), { prefix: 'TWD', number: 456 });
});

test('permanent claims, high-water marks, source reuse and failed transactions never duplicate or leak allocations', t => {
  const f = fixture(t), source = { namespace: 'consumer', externalId: 'record' };
  const claimed = f.command('task.create', { id: 'first', title: 'First', reference: 'REL-50', externalReference: source });
  assert.equal(f.command('task.create', { title: 'New title is not an edit', externalReference: source }).reference, claimed.reference);
  assert.throws(() => f.command('task.create', { title: 'Conflict', reference: 'REL-52', externalReference: source }), { code: 'task_reference_conflict' });
  assert.equal(f.command('task.create', { title: 'Next' }).reference, 'REL-51');
  assert.throws(() => f.command('task.create', { title: 'Taken', reference: 'REL-50' }), { code: 'task_reference_conflict' });
  assert.throws(() => f.command('task.create', { id: 'first', title: 'Duplicate ID', reference: 'REL-99' }), { code: 'identity_conflict' });
  const event = f.store.event.bind(f.store);
  f.store.event = () => { throw Error('crash before receipt/commit'); };
  assert.throws(() => f.command('task.create', { title: 'Crash' }, 'crash'), /crash/);
  f.store.event = event;
  assert.equal(f.command('task.create', { title: 'Crash' }, 'crash').reference, 'REL-52');
  f.store.db.prepare("DELETE FROM entities WHERE kind='task' AND id=?").run(claimed.id);
  assert.throws(() => f.command('task.create', { title: 'Reuse deleted', reference: 'REL-50' }), { code: 'task_reference_conflict' });
  assert.throws(() => f.store.db.exec('DELETE FROM task_reference_claims'), /task_claim_immutable/);
  assert.throws(() => f.store.db.exec("UPDATE task_reference_counters SET high_water=0 WHERE prefix='REL'"), /task_counter_regression/);
});

test('custom namespaces require explicit principal grants, bounded claims and revocation', t => {
  const f = fixture(t);
  f.command('node.enrol', { id: 'node', name: 'Node' });
  const operator = { ...f.owner, scope: { kind: 'node_operator', nodeId: 'node', mode: 'localUser' } };
  const create = (reference, key = crypto.randomUUID()) => f.command('task.create', { title: 'Consumer', reference }, key, operator);
  assert.throws(() => create('TWD-1'), { code: 'task_reference_forbidden' });
  assert.equal(f.command('task.create', { title: 'No knowledge of numbering' }, 'auto', operator).reference, 'REL-1');
  const grant = { principal: { type: 'node_operator', id: 'node' }, prefix: 'TWD', maxNumber: 100 };
  f.command('task.reference_namespace.grant', grant);
  const task = create('TWD-32', 'custom'); assert.equal(task.reference, 'TWD-32');
  assert.throws(() => create('TWD-101'), { code: 'task_reference_forbidden' });
  assert.throws(() => create('REL-99999'), { code: 'task_reference_forbidden' });
  f.command('task.reference_namespace.revoke', { principal: grant.principal, prefix: grant.prefix, expectedRevision: 1 });
  assert.deepEqual(create('TWD-32', 'custom'), task);
  assert.throws(() => create('TWD-33'), { code: 'task_reference_forbidden' });
  assert.throws(() => f.command('task.reference_namespace.grant', grant), { code: 'stale_revision' });
  f.command('task.reference_namespace.grant', { ...grant, expectedRevision: 2 });
  assert.equal(create('TWD-33').reference, 'TWD-33');
  assert.throws(() => f.command('task.reference_namespace.grant', { ...grant, prefix: 'OTHER' }, 'self', operator), { code: 'forbidden' });
});

test('SQL guards fence identity-unaware writers and primary references cannot be edited', t => {
  const f = fixture(t), task = f.command('task.create', { id: 'task', title: 'Original' });
  assert.throws(() => f.command('task.update', { id: task.id, expectedRevision: 1, changes: { reference: 'REL-10' } }), { code: 'invalid_request' });
  assert.throws(() => f.store.save('task', { ...task, reference: 'REL-10' }), { code: 'task_reference_immutable' });
  assert.throws(() => f.store.db.prepare('INSERT INTO entities VALUES (?,?,?,?)').run('task', 'old-writer', 1, JSON.stringify({ id: 'old-writer', revision: 1 })), /task_reference_required/);
  assert.throws(() => f.store.db.prepare("UPDATE entities SET data=? WHERE kind='task' AND id=?").run(JSON.stringify({ ...task, reference: undefined }), task.id), /task_reference_immutable/);
});

test('alias resolution preserves explicit scope and reports ambiguity including primary/native-ID collisions', t => {
  const f = fixture(t), a = f.command('task.create', { id: 'a', title: 'A' }), b = f.command('task.create', { id: 'b', title: 'B' });
  for (const [task, scope] of [[a, 'one'], [b, 'two']]) f.store.save('task', { ...task, source: { provider: 'paperclip', scope, metadata: { identifier: 'DEF-32' } } });
  assert.equal(resolveTaskIdentity(f.store, { value: 'DEF-32' }).state, 'ambiguous');
  assert.equal(resolveTaskIdentity(f.store, { value: 'DEF-32', scope: 'paperclip:one' }).matches[0].task.id, a.id);
  f.store.save('task', { ...f.store.get('task', b.id), identifier: a.reference });
  assert.equal(resolveTaskIdentity(f.store, { value: a.reference }).state, 'ambiguous');
  assert.equal(resolveTaskIdentity(f.store, { reference: a.reference.toLowerCase() }).matches[0].task.id, a.id);
  assert.equal(resolveTaskIdentity(f.store, { value: 'unknown' }).state, 'not_found');
});

test('safe integer exhaustion fails closed without wrapping or corrupting a claim', t => {
  const f = fixture(t);
  f.command('task.create', { title: 'Last', reference: `REL-${Number.MAX_SAFE_INTEGER}` });
  assert.throws(() => f.command('task.create', { title: 'Overflow' }), { code: 'task_reference_exhausted' });
  assert.equal(f.store.all('task').length, 1);
});

test('explicit backup-backed migration is deterministic, idempotent and preserves old receipts and identities', t => {
  const root = directory(t), path = join(root, 'backend.sqlite'), backup = join(root, 'before.sqlite');
  const tasks = [{ id: 'z', title: 'Z', revision: 2, createdAt: '2020-01-01', source: { provider: 'paperclip', scope: 'old', metadata: { identifier: 'DEF-32' } } },
    { id: 'a', title: 'A', revision: 1, createdAt: '2020-01-01', parentId: 'z' }];
  const db = legacyDatabase(path, tasks), payload = { id: 'a', title: 'A' }, receipt = JSON.stringify(tasks[1]);
  const credential = { id: 'old-credential', type: 'user', actorId: 'owner', revoked: false };
  db.prepare('INSERT INTO credentials VALUES (?,?,?)').run(credential.id, digest('legacy-fixture-token'), JSON.stringify(credential));
  const comment = JSON.stringify({ id: 'comment', taskId: 'z', revision: 1, body: 'Original comment', author: { type: 'user', id: 'owner' } });
  db.prepare('INSERT INTO entities VALUES (?,?,?,?)').run('comment', 'comment', 1, comment);
  db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run('user:owner', 'old-create', digest({ action: 'task.create', payload }), receipt);
  db.close();
  const before = readFileSync(path);
  assert.equal(planTaskIdentityMigration(path).pending, 2);
  assert.deepEqual(readFileSync(path), before, 'planning must not mutate the database');
  assert.throws(() => new BackendStore(path), { code: 'task_identity_migration_required' });
  const result = migrateTaskIdentity(path, { backup }); assert.equal(result.backfilled, 2);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  const old = new DatabaseSync(backup, { readOnly: true });
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 1); old.close();
  const store = new BackendStore(path); t.after(() => store.close());
  assert.equal(store.instance, 'original-instance');
  assert.equal(store.authenticate('legacy-fixture-token').credentialId, credential.id);
  assert.equal(store.db.prepare("SELECT data FROM entities WHERE kind='comment'").get().data, comment);
  assert.equal(store.get('task', 'a').reference, 'REL-1'); assert.equal(store.get('task', 'z').reference, 'REL-2');
  assert.equal(store.get('task', 'a').parentId, 'z'); assert.equal(store.get('task', 'z').revision, 3);
  assert.equal(store.db.prepare('SELECT data FROM receipts WHERE key=?').get('old-create').data, receipt);
  assert.deepEqual(store.command({ type: 'user', id: 'owner' }, { key: 'old-create', action: 'task.create', payload }), { ...tasks[1], reference: 'REL-1' });
  assert.equal(resolveTaskIdentity(store, { value: 'DEF-32' }).matches[0].task.id, 'z');
  assert.equal(migrateTaskIdentity(path, { backup: join(root, 'unused.sqlite') }).alreadyApplied, true);
  const legacy = new DatabaseSync(path, { readOnly: true });
  assert.ok(legacy.prepare('PRAGMA user_version').get().user_version > 1, 'old backend startup rejects the bumped schema'); legacy.close();
});

test('migration CLI refuses an active backend lock and needs a new backup path', t => {
  const root = directory(t), path = join(root, 'backend.sqlite'); legacyDatabase(path).close();
  const unlock = serviceLock(root);
  try { assert.throws(() => execFileSync(process.execPath, ['scripts/migrate-task-references.mjs', '--state-dir', root, '--apply', '--backup', join(root, 'backup.sqlite')], { stdio: 'pipe' }), error => /already_running/.test(error.stderr)); }
  finally { unlock(); }
  assert.throws(() => migrateTaskIdentity(path), { code: 'migration_backup_required' });
});

test('HTTP create and exact identity lookup expose canonical references without changing ID-addressed routes', async t => {
  const backend = await startBackend({ database: ':memory:' }); t.after(() => backend.close());
  const token = backend.store.bootstrap().token;
  const api = async (path, body) => { const response = await fetch(`${backend.origin}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; };
  const { data: task } = await api('/v1/commands', { key: 'http', action: 'task.create', payload: { title: 'HTTP' } });
  assert.equal(task.reference, 'REL-1');
  assert.equal((await api('/v1/task-identity?value=rel-1')).data.matches[0].task.id, task.id);
  assert.equal((await api(`/v1/tasks/${task.id}`)).data.reference, task.reference);
  assert.equal((await api('/v1/task-identity?value=REL-1&reference=REL-1')).status, 400);
});

test('independent concurrent processes share one allocator and lost committed replies survive restart', async t => {
  const root = directory(t), path = join(root, 'backend.sqlite');
  const initial = new BackendStore(path); initial.bootstrap(); initial.close();
  const run = promisify(execFile), script = 'test/fixtures/task-reference-writer.mjs';
  const results = await Promise.all(Array.from({ length: 6 }, (_, lane) => run(process.execPath, [script, path, String(lane)])));
  const values = results.map(result => JSON.parse(result.stdout));
  assert.equal(new Set(values.map(result => result.shared.id)).size, 1);
  assert.equal(new Set(values.map(result => result.unique.reference)).size, 6);
  await assert.rejects(run(process.execPath, [script, path, 'crash', 'crash']), error => error.code === 93);
  const replay = JSON.parse((await run(process.execPath, [script, path, 'crash'])).stdout);
  const store = new BackendStore(path); t.after(() => store.close());
  assert.equal(store.all('task').length, 8);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM task_reference_claims').get().count, 8);
  assert.equal(store.get('task', replay.unique.id).reference, replay.unique.reference);
});

test('migration failure preserves schema/tasks and backup, without leaking partially assigned references', t => {
  const root = directory(t), path = join(root, 'backend.sqlite'), backup = join(root, 'backup.sqlite');
  const task = { id: 'a', title: 'A', revision: 1 }, db = legacyDatabase(path, [task]);
  db.exec("CREATE TRIGGER fail_backfill BEFORE UPDATE ON entities BEGIN SELECT RAISE(ABORT,'simulated migration crash'); END;"); db.close();
  assert.throws(() => migrateTaskIdentity(path, { backup }), /simulated migration crash/);
  const inspect = new DatabaseSync(path);
  assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 1);
  assert.deepEqual(JSON.parse(inspect.prepare("SELECT data FROM entities WHERE kind='task'").get().data), task);
  assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE name='task_reference_claims'").get(), undefined);
  inspect.exec('DROP TRIGGER fail_backfill'); inspect.close();
  assert.equal(migrateTaskIdentity(path, { backup: join(root, 'retry.sqlite') }).backfilled, 1);
});

test('parallel custom claims have one winner and explicit conflicts, never fallback references', async t => {
  const root = directory(t), path = join(root, 'backend.sqlite'), initial = new BackendStore(path); initial.close();
  const run = promisify(execFile);
  const results = (await Promise.all(Array.from({ length: 4 }, (_, lane) => run(process.execPath, ['test/fixtures/task-reference-writer.mjs', path, String(lane), 'claim'])))).map(result => JSON.parse(result.stdout));
  assert.equal(results.filter(result => result.task?.reference === 'TWD-32').length, 1);
  assert.equal(results.filter(result => result.code === 'task_reference_conflict').length, 3);
  const store = new BackendStore(path); t.after(() => store.close());
  assert.equal(store.all('task').length, 1);
  assert.equal(store.db.prepare("SELECT high_water FROM task_reference_counters WHERE prefix='REL'").get(), undefined);
});

test('new schema planning refuses missing claim coverage instead of repairing state by guessing', t => {
  const root = directory(t), path = join(root, 'backend.sqlite'), store = new BackendStore(path);
  store.db.exec('DROP TRIGGER task_reference_required_insert');
  store.db.prepare('INSERT INTO entities VALUES (?,?,?,?)').run('task', 'corrupt', 1, JSON.stringify({ id: 'corrupt', revision: 1 })); store.close();
  assert.throws(() => planTaskIdentityMigration(path), { code: 'task_identity_recovery_required' });
  assert.throws(() => new BackendStore(path), { code: 'task_identity_recovery_required' });
});

test('migration blocks active work and missing state without creating a backend or backup', t => {
  const root = directory(t), path = join(root, 'backend.sqlite'), db = legacyDatabase(path);
  db.prepare('INSERT INTO entities VALUES (?,?,?,?)').run('execution', 'active', 1, JSON.stringify({ id: 'active', state: 'accepted', revision: 1 })); db.close();
  assert.equal(planTaskIdentityMigration(path).ready, false);
  assert.throws(() => migrateTaskIdentity(path, { backup: join(root, 'backup.sqlite') }), { code: 'migration_busy' });
  assert.throws(() => migrateTaskIdentity(join(root, 'missing.sqlite'), { backup: join(root, 'backup.sqlite') }), { code: 'migration_state_missing' });
});

test('enrolled worker and native CLI resolve references through real scoped transports without dispatch or writes', async t => {
  const root = directory(t), backend = await startBackend({ database: ':memory:' });
  const token = backend.store.bootstrap().token, api = nativeBackendClient({ url: backend.origin, token });
  const task = await api('POST', '/v1/commands', { key: 'create', action: 'task.create', payload: { title: 'Transport check' } });
  const context = join(root, 'fixture-context.json'); writeFileSync(context, JSON.stringify({ url: backend.origin, token }), { mode: 0o600 });
  const journal = new NodeJournal(':memory:', { nodeId: 'fixture', instanceId: backend.store.instance });
  const socketPath = join(root, 'node.sock'), service = await startNodeService({ journal, socketPath, workers: [{ token: 'fixture-worker', agentId: 'fixture-agent' }], tasks: nativeTasksProvider(api) });
  try {
    const before = backend.store.db.prepare('SELECT COUNT(*) AS count FROM changes').get().count;
    const result = await call({ socketPath, token: 'fixture-worker' }, 'POST', '/agent/task-identity', { value: task.reference });
    assert.equal(result.state, 'resolved'); assert.equal(result.matches[0].task.id, task.id);
    const run = promisify(execFile);
    const output = await run(process.execPath, ['src/cli.mjs', 'native', 'task', 'resolve', task.reference, '--context', context]);
    assert.equal(JSON.parse(output.stdout).matches[0].task.id, task.id);
    assert.equal(backend.store.db.prepare('SELECT COUNT(*) AS count FROM changes').get().count, before);
    assert.equal(backend.store.all('execution').length, 0);
  } finally { await service.close(); journal.close(); await backend.close(); }
});
