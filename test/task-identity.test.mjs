import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BackendStore } from '../src/backend-store.mjs';
import { startBackend } from '../src/backend-service.mjs';
import { parseTaskReference, resolveTaskIdentity } from '../src/task-identity.mjs';
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

test('unsupported backend schemas are refused without migrating or changing existing bytes', t => {
  const root = directory(t), path = join(root, 'backend.sqlite');
  for (const schema of [1, 3]) {
    const db = new DatabaseSync(path); db.exec(`PRAGMA user_version=${schema}`); db.close();
    const before = readFileSync(path);
    assert.throws(() => new BackendStore(path), { code: 'unsupported_schema' });
    assert.deepEqual(readFileSync(path), before);
  }
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

test('startup refuses missing claim coverage instead of repairing state by guessing', t => {
  const root = directory(t), path = join(root, 'backend.sqlite'), store = new BackendStore(path);
  store.db.exec('DROP TRIGGER task_reference_required_insert');
  store.db.prepare('INSERT INTO entities VALUES (?,?,?,?)').run('task', 'corrupt', 1, JSON.stringify({ id: 'corrupt', revision: 1 })); store.close();
  assert.throws(() => new BackendStore(path), { code: 'task_identity_recovery_required' });
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
