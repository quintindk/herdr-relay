import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { digest, RelayError } from '../src/protocol.mjs';
import { humanTask } from '../src/human-tasks.mjs';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';

function absent() {
  const error = new RelayError('paperclip_error', 'Backend 404', 502);
  error.backendStatus = 404; return error;
}

function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const state = { task: { id: 'task', companyId: 'company', identifier: 'TEST-1', title: 'Delete me', description: 'Full text',
    status: 'todo', priority: 'medium', assigneeAgentId: 'agent', assigneeUserId: null }, calls: [], before: null, after: null, reject: null };
  const api = async (method, path) => {
    state.calls.push({ method, path }); await state.before?.(method, path);
    if (path === '/api/companies/company') return { id: 'company' };
    if (path === '/api/issues/task/interactions') return [{ id: 'review', status: 'pending' }];
    assert.equal(path, '/api/issues/task');
    if (method === 'DELETE') {
      assert.ok(store.db.prepare("SELECT data FROM operations WHERE id LIKE 'human-task:%'").all()
        .some(row => JSON.parse(row.data).state === 'uncertain'));
      if (state.reject) {
        const error = new RelayError('paperclip_error', 'Refused', 502); error.backendStatus = state.reject; throw error;
      }
      const task = state.task; state.task = null; await state.after?.(method); return task;
    }
    assert.equal(method, 'GET'); if (!state.task) throw absent(); return structuredClone(state.task);
  };
  const inspect = () => humanTask(store, api, { action: 'inspect', companyId: 'company', taskId: 'task' });
  const input = async () => ({ action: 'delete', companyId: 'company', taskId: 'task', key: 'delete-once', expectedRevision: (await inspect()).revision });
  return { store, state, api, inspect, input, deletes: () => state.calls.filter(call => call.method === 'DELETE').length };
}

test('delete is permanent, owner-independent and confirmed by backend absence without changing review decisions', async t => {
  const f = fixture(t); const input = await f.input();
  const result = await humanTask(f.store, f.api, input);
  assert.equal(result.deleted, true); assert.equal(result.outcome.confirmed, true);
  assert.equal(result.task.identifier, 'TEST-1'); assert.equal(result.task.assigneeAgentId, 'agent');
  assert.equal(f.state.task, null); assert.equal(f.deletes(), 1);
  assert.deepEqual(await humanTask(f.store, f.api, input), result); assert.equal(f.deletes(), 1);
});

test('lost committed DELETE replies reconcile without sending DELETE again', async t => {
  const f = fixture(t); const input = await f.input();
  f.state.after = () => { throw Error('lost reply'); };
  await assert.rejects(humanTask(f.store, f.api, input), /lost reply/);
  const result = await humanTask(f.store, f.api, input);
  assert.equal(result.reconciled, true); assert.equal(result.deleted, true); assert.equal(f.deletes(), 1);
});

test('unconfirmed deletion is never resent and fences a new key', async t => {
  const f = fixture(t); const input = await f.input();
  f.state.before = method => { if (method === 'DELETE') throw Error('transport unavailable'); };
  await assert.rejects(humanTask(f.store, f.api, input), /transport unavailable/);
  f.state.before = null;
  await assert.rejects(humanTask(f.store, f.api, input), { code: 'operation_uncertain' });
  await assert.rejects(humanTask(f.store, f.api, { ...input, key: 'another-key' }), { code: 'operation_uncertain' });
  assert.equal(f.deletes(), 1); assert.ok(f.state.task);
});

test('definitive foreign-key refusal keeps the task and does not create an uncertain-write fence', async t => {
  const f = fixture(t); const input = await f.input(); f.state.reject = 409;
  await assert.rejects(humanTask(f.store, f.api, input), { code: 'task_delete_rejected' });
  await assert.rejects(humanTask(f.store, f.api, input), { code: 'task_delete_rejected' });
  assert.equal(f.deletes(), 1); assert.ok(f.state.task);
  f.state.reject = null;
  assert.equal((await humanTask(f.store, f.api, { ...input, key: 'after-links-removed' })).deleted, true);
});

for (const mode of ['foreign', 'stale', 'active-backend', 'active-relay', 'missing']) {
  test(`deletion refuses ${mode} without a DELETE`, async t => {
    const f = fixture(t); const input = await f.input();
    if (mode === 'foreign') f.state.task.companyId = 'foreign';
    if (mode === 'stale') f.state.task.title = 'Changed after preview';
    if (mode === 'active-backend') { f.state.task.executionRunId = 'running'; input.expectedRevision = (await f.inspect()).revision; }
    if (mode === 'active-relay') {
      f.store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'i', conversationId: 'chat' });
      f.store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
      input.expectedRevision = (await f.inspect()).revision;
    }
    if (mode === 'missing') f.state.task = null;
    await assert.rejects(humanTask(f.store, f.api, input), { code: mode === 'foreign' ? 'forbidden' : mode === 'stale' ? 'stale_revision'
      : mode === 'missing' ? 'task_not_found' : 'task_busy' });
    assert.equal(f.deletes(), 0);
  });
}

test('real Relay API and CLI delete only the selected task, reject worker credentials and retain its sibling', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-delete-service-'));
  const tasks = new Map(['first', 'auto', 'native', 'sibling'].map(id => [id, { id, companyId: 'company', title: id, description: 'Task',
    status: 'done', priority: 'medium', assigneeAgentId: 'agent' }]));
  const requests = [];
  const backend = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url }); res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/companies/company') { res.end(JSON.stringify({ id: 'company' })); return; }
    const match = req.url.match(/^\/api\/issues\/([^/]+)(\/interactions)?$/);
    if (!match || !tasks.has(match[1])) { res.writeHead(404); res.end('{}'); return; }
    if (match[2]) { res.end('[]'); return; }
    const task = tasks.get(match[1]); if (req.method === 'DELETE') tasks.delete(match[1]);
    res.end(JSON.stringify(task));
  });
  let service;
  t.after(async () => { await service?.close(); await new Promise(resolve => backend.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const auth = join(directory, 'backend.json'); writeFileSync(auth, '{"localTrusted":true}', { mode: 0o600 });
  service = await startService({ directory, paperclipUrl: `http://127.0.0.1:${backend.address().port}`, backendContextFile: auth });
  const worker = service.store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'i', conversationId: 'chat' });
  const inspected = await call(service, 'POST', '/tasks/manage', { action: 'inspect', companyId: 'company', taskId: 'first' });
  const input = { action: 'delete', companyId: 'company', taskId: 'first', key: 'cli-delete', expectedRevision: inspected.revision };
  await assert.rejects(call({ socketPath: service.socketPath, token: worker.token }, 'POST', '/tasks/manage', input), { code: 'forbidden' });
  const context = join(directory, 'operator.json'), mutation = join(directory, 'delete.json');
  writeFileSync(context, JSON.stringify({ socketPath: service.socketPath, token: service.token }), { mode: 0o600 });
  writeFileSync(mutation, JSON.stringify({ expectedRevision: inspected.revision, reason: 'Fixture cleanup' }));
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)),
    '--context', context, 'task', 'delete', '--company', 'company', '--task', 'first', '--key', 'cli-delete', '--file', mutation], { timeout: 15000 });
  assert.equal(JSON.parse(stdout).deleted, true); assert.equal(tasks.has('first'), false); assert.equal(tasks.has('sibling'), true);
  const second = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)),
    '--context', context, 'task', 'delete', '--company', 'company', '--task', 'auto', '--key', 'auto-delete'], { timeout: 15000 });
  assert.equal(JSON.parse(second.stdout).deleted, true); assert.equal(tasks.has('sibling'), true);
  assert.deepEqual(requests.filter(req => req.method === 'DELETE'), [{ method: 'DELETE', path: '/api/issues/first' }, { method: 'DELETE', path: '/api/issues/auto' }]);
  service.store.saveOperation({ id: 'herdr-agent:worker', runId: '', availability: 'present',
    identity: { conversationId: 'chat' }, placement: { directory: '/work', terminalId: 'terminal' } });
  service.store.saveOperation({ id: 'opencode-bridge:worker', runId: '', state: 'configured', tokenHash: digest('native-token'),
    identity: { bindingId: 'worker', observedId: 'herdr-agent:worker', conversationId: 'chat', directory: '/work', terminalId: 'terminal' } });
  const native = { socketPath: service.socketPath, token: 'native-token' };
  const snapshot = { epoch: 'epoch', conversationId: 'chat', terminalId: 'terminal', sessionCreatedAt: 123, idle: false };
  const preview = await call(native, 'POST', '/bridge/task-inspect', { ...snapshot, taskId: 'native' });
  const deleted = await call(native, 'POST', '/bridge/task-delete', { ...snapshot, taskId: 'native', key: 'native-delete',
    expectedRevision: preview.revision, source: { id: 'human', text: 'Delete native', createdAt: Date.now() } });
  assert.equal(deleted.deleted, true); assert.equal(tasks.has('native'), false); assert.equal(tasks.has('sibling'), true);
});
