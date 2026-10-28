import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NodeJournal } from '../src/node-journal.mjs';
import { nodeTasks } from '../src/node-tasks.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';

test('native task scope survives restart without changing the existing pin', t => {
  const directory = mkdtempSync('/tmp/opencode/relay-tasks-'); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'node.sqlite'), connectors = { nativeApi: async () => ({ items: [] }) };
  let journal = new NodeJournal(path, { nodeId: 'node', instanceId: 'backend' });
  const first = nodeTasks(journal, { type: 'native' }, connectors); journal.close();
  journal = new NodeJournal(path, { nodeId: 'node', instanceId: 'backend' }); t.after(() => journal.close());
  assert.equal(nodeTasks(journal, { type: 'native' }, connectors).scope, first.scope);
  assert.equal(journal.db.prepare("SELECT value FROM settings WHERE key='tasks-provider'").get().value, '{"type":"native"}');
});

test('unsupported task sources are refused without changing historical pins or pending work', t => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' }); t.after(() => journal.close());
  journal.queue({ key: 'create', action: 'task.create', payload: { title: 'Native pending' } });
  for (const type of ['paperclip', 'github', 'unknown']) assert.throws(() => nodeTasks(journal, { type }, { nativeApi: async () => ({}) }), { code: 'invalid_provider' });
  assert.equal(journal.receipt('create').state, 'pending');
  assert.equal(journal.db.prepare("SELECT value FROM settings WHERE key='tasks-provider'").get(), undefined);
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('tasks-provider', '{"type":"historical"}');
  assert.throws(() => nodeTasks(journal, { type: 'native' }, { nativeApi: async () => ({}) }), { code: 'provider_migration_required' });
});

test('node reads use the native backend and explicitly label incomplete cached data during an outage', async t => {
  const directory = mkdtempSync('/tmp/opencode/relay-task-service-');
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  let fail = false;
  const tasks = nodeTasks(journal, { type: 'native' }, { nativeApi: async (_method, path) => {
    if (fail) throw Error('disconnected');
    if (path.includes('/comments?')) return { items: [], complete: true };
    if (path === '/v1/tasks/1') return { id: '1', title: 'Authoritative native task', parentId: null, dependencies: [] };
    return { items: [{ id: '1', title: 'Authoritative native task' }], complete: true };
  } });
  journal.consume({ cursor: 'cursor', items: [{ id: 'cached', type: 'task.create', entityId: '1', revision: 1, data: { id: '1', revision: 1, title: 'Stale cache' } }] });
  const socketPath = join(directory, 'node.sock');
  const service = await startNodeService({ journal, socketPath, workers: [{ agentId: 'worker', token: 'token' }], tasks });
  t.after(async () => { await service.close(); journal.close(); rmSync(directory, { recursive: true, force: true }); });
  const connection = { socketPath, token: 'token' };
  assert.equal((await call(connection, 'POST', '/agent/tasks', {})).items[0].title, 'Authoritative native task');
  assert.equal((await call(connection, 'POST', '/agent/task', { taskId: '1' })).title, 'Authoritative native task');
  assert.equal((await call(connection, 'POST', '/agent/comments', { taskId: '1' })).complete, true);
  assert.deepEqual((await call(connection, 'POST', '/agent/relations', { taskId: '1' })).dependencies, []);
  fail = true;
  const cached = await call(connection, 'POST', '/agent/tasks', {});
  assert.equal(cached.stale, true); assert.equal(cached.complete, false);
  assert.equal(cached.items[0].title, 'Stale cache'); assert.match(cached.warnings[0], /Backend unavailable/);
  await assert.rejects(call(connection, 'POST', '/agent/task', { taskId: '1' }));
});
