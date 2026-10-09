import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-worker-inspect-'));
  const requests = [];
  const tasks = {
    root: { id: 'root', companyId: 'company', parentId: null, assigneeUserId: 'human', status: 'done', description: 'Full deduplication evidence' },
    unrelated: { id: 'unrelated', companyId: 'company', parentId: 'other-parent', assigneeAgentId: 'other-agent', status: 'blocked' },
    child: { id: 'child', companyId: 'company', parentId: 'parent', assigneeAgentId: 'other-agent', status: 'todo' },
    parent: { id: 'parent', companyId: 'company', assigneeAgentId: 'worker', status: 'in_progress' },
    foreign: { id: 'foreign', companyId: 'another-company', parentId: 'parent' },
    wrong: { id: 'returned-wrong-id', companyId: 'company' },
  };
  const comments = [{ id: 'comment', body: 'Previously handled source evidence' }];
  const service = await startService({ directory, paperclipUrl: 'http://127.0.0.1:1',
    api: async (run, token, method, path) => {
      requests.push({ runId: run.id, token, method, path });
      assert.equal(method, 'GET');
      const match = path.match(/^\/api\/issues\/([^/]+)(\/comments)?$/);
      assert.ok(match && tasks[match[1]], path);
      return structuredClone(match[2] ? comments : tasks[match[1]]);
    } });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const worker = service.store.register({ id: 'worker', companyId: 'company', agentId: 'worker', harness: 'opencode',
    instanceId: 'instance', conversationId: 'chat', delivery: 'pull' });
  const other = service.store.register({ id: 'other', companyId: 'company', agentId: 'other', harness: 'opencode',
    instanceId: 'instance', conversationId: 'other-chat', delivery: 'pull' });
  const run = service.store.dispatch({ bindingId: 'worker', bindingRevision: worker.binding.revision,
    companyId: 'company', agentId: 'worker', taskId: 'parent', runId: 'backend' });
  const connection = { socketPath: service.socketPath, token: worker.token };
  const inspect = taskId => call(connection, 'POST', `/runs/${run.id}/child`, { taskId });
  const attach = () => call(service, 'POST', `/runs/${run.id}/attach`, { runId: 'backend', token: 'backend-token' });
  return { service, directory, tasks, comments, requests, connection, other, run, inspect, attach };
}

test('worker CLI inspects full same-company backlog and comments regardless of parent, owner or status', async t => {
  const f = await fixture(t);
  await f.attach();
  await call(f.connection, 'POST', `/runs/${f.run.id}/acknowledge`, {});
  const before = f.service.store.run(f.run.id);
  for (const taskId of ['root', 'unrelated', 'child', 'parent']) {
    const result = await f.inspect(taskId);
    assert.deepEqual(result, { task: f.tasks[taskId], comments: f.comments, relayReview: null });
  }
  const context = join(f.directory, 'worker.json');
  writeFileSync(context, JSON.stringify(f.connection), { mode: 0o600 });
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)),
    '--context', context, 'task', 'inspect', f.run.id, '--task', 'root'], { timeout: 15000 });
  assert.deepEqual(JSON.parse(stdout), { task: f.tasks.root, comments: f.comments, relayReview: null });
  assert.deepEqual(f.service.store.run(f.run.id), before);
  assert.ok(f.requests.every(request => request.method === 'GET' && request.token === 'backend-token' && request.runId === f.run.id));
});

test('worker inspection preserves company and exact task identity without fetching denied comments', async t => {
  const f = await fixture(t);
  await f.attach();
  await assert.rejects(f.inspect('foreign'), { code: 'forbidden', status: 403 });
  await assert.rejects(f.inspect('wrong'), { code: 'identity_mismatch', status: 409 });
  assert.deepEqual(f.requests.map(request => request.path), ['/api/issues/foreign', '/api/issues/wrong']);
});

test('worker inspection still requires its own binding and attached backend credentials', async t => {
  const f = await fixture(t);
  await assert.rejects(f.inspect('root'), { code: 'adapter_unavailable', status: 503 });
  await f.attach();
  await assert.rejects(call({ ...f.connection, token: f.other.token }, 'POST', `/runs/${f.run.id}/child`, { taskId: 'root' }),
    { code: 'forbidden', status: 403 });
  assert.deepEqual(f.requests, []);
});
