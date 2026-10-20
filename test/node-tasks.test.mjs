import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeJournal } from '../src/node-journal.mjs';
import { nodeTasks } from '../src/node-tasks.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';

test('node provider scope persists across restart and refuses repository/provider changes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-tasks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'node.sqlite');
  let journal = new NodeJournal(path, { nodeId: 'node', instanceId: 'backend' });
  const config = { type: 'github', owner: 'o', repo: 'r' };
  const connectors = { githubApi: async () => [] };
  const first = nodeTasks(journal, config, connectors);
  journal.close();
  journal = new NodeJournal(path, { nodeId: 'node', instanceId: 'backend' });
  t.after(() => journal.close());
  assert.equal(nodeTasks(journal, config, connectors).scope, first.scope);
  assert.throws(() => nodeTasks(journal, { ...config, repo: 'different' }, connectors), { code: 'provider_migration_required' });
  assert.throws(() => nodeTasks(journal, { type: 'native' }, { nativeApi: async () => [] }), { code: 'provider_migration_required' });
});

test('external selection cannot reinterpret existing native execution state', t => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  t.after(() => journal.close());
  journal.save({ id: 'execution', state: 'settled', execution: { taskId: '1' } });
  assert.throws(() => nodeTasks(journal, { type: 'github', owner: 'o', repo: 'r' }, { githubApi: async () => [] }),
    { code: 'provider_migration_required' });
});

test('unpublished native task intent prevents first-time external selection', t => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  t.after(() => journal.close());
  journal.queue({ key: 'create', action: 'task.create', payload: { id: '1', title: 'Native pending' } });
  assert.throws(() => nodeTasks(journal, { type: 'github', owner: 'o', repo: 'r' }, { githubApi: async () => [] }),
    { code: 'provider_migration_required' });
  assert.equal(journal.receipt('create').state, 'pending');
});

test('node task reads use selected provider and never substitute the native cache on external failure', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-tasks-service-'));
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  let fail = false;
  const tasks = nodeTasks(journal, { type: 'github', owner: 'o', repo: 'r' }, { githubApi: async (_method, path) => {
    if (fail) throw new Error('disconnected');
    if (path.includes('/sub_issues?') || path.includes('/dependencies/blocked_by?') || path.includes('/comments?')) return [];
    if (path.endsWith('/issues/1')) return { id: 10, number: 1, title: 'External', state: 'open', updated_at: 'r1' };
    return [{ id: 10, number: 1, title: 'External', state: 'open', updated_at: 'r1' }];
  } });
  journal.consume({ cursor: 'cursor', items: [{ id: 'native', type: 'task.create', entityId: '1', revision: 1,
    data: { id: '1', revision: 1, title: 'Wrong native task' } }] });
  const socketPath = join(directory, 'node.sock');
  const service = await startNodeService({ journal, socketPath, workers: [{ agentId: 'worker', token: 'token' }], tasks });
  t.after(async () => { await service.close(); journal.close(); rmSync(directory, { recursive: true, force: true }); });
  const connection = { socketPath, token: 'token' };
  assert.equal((await call(connection, 'POST', '/agent/tasks', {})).items[0].title, 'External');
  assert.equal((await call(connection, 'POST', '/agent/task', { taskId: '1' })).title, 'External');
  assert.equal((await call(connection, 'POST', '/agent/comments', { taskId: '1' })).complete, true);
  assert.deepEqual((await call(connection, 'POST', '/agent/relations', { taskId: '1' })).dependencies, []);
  await assert.rejects(call(connection, 'POST', '/agent/task', { taskId: '1', provider: 'native' }), { code: 'invalid_request' });
  fail = true;
  await assert.rejects(call(connection, 'POST', '/agent/tasks', {}), { code: 'node_error' });
});
