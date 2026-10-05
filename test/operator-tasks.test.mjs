import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store.mjs';
import { createOperatorTask, mutate } from '../src/operations.mjs';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';

const input = { companyId: 'company', key: 'human-check', payload: { title: 'Review result', assigneeUserId: 'human', status: 'todo' } };

test('operator creation persists exact human assignment and reconciles a lost reply after restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-operator-task-'));
  let store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const tasks = new Map(); let posts = 0;
  const api = async (method, path, body) => {
    if (method === 'GET') return { id: 'company' };
    posts++;
    assert.equal(body.assigneeUserId, 'human');
    assert.equal(body.assigneeAgentId, undefined);
    if (!tasks.has(body.idempotencyKey)) tasks.set(body.idempotencyKey, { id: 'issue', companyId: 'company', ...body });
    if (posts === 1) throw new Error('Lost committed reply');
    return tasks.get(body.idempotencyKey);
  };
  await assert.rejects(createOperatorTask(store, api, input));
  store.close(); store = new Store(join(root, 'state.sqlite'));
  const receipt = await createOperatorTask(store, api, input);
  assert.equal(receipt.state, 'recorded');
  assert.equal(receipt.receipt.assigneeUserId, 'human');
  assert.deepEqual(await createOperatorTask(store, api, input), receipt);
  assert.equal(posts, 2); assert.equal(tasks.size, 1);
  await assert.rejects(createOperatorTask(store, api, { ...input, payload: { ...input.payload, title: 'Changed' } }), { code: 'operation_conflict' });
});

test('operator task creation refuses ambiguous ownership, unknown fields and foreign resource scope', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let posts = 0;
  const api = async (method, path) => { if (method === 'POST') posts++; return path.includes('/companies/') ? { id: 'company' } : { id: 'foreign', companyId: 'other' }; };
  for (const payload of [
    { ...input.payload, assigneeAgentId: 'agent' }, { ...input.payload, idempotencyKey: 'override' },
    { ...input.payload, status: 'invalid' }, { ...input.payload, blockedByIssueIds: 'foreign' },
  ]) await assert.rejects(createOperatorTask(store, api, { ...input, payload }));
  await assert.rejects(createOperatorTask(store, api, { ...input, payload: { ...input.payload, parentId: 'foreign' } }), { code: 'forbidden' });
  assert.equal(posts, 0);
});

test('real CLI creates without a run; worker credentials cannot use the operator endpoint', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-task-cli-'));
  const backend = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { id: 'company' } : { id: 'issue', companyId: 'company', ...JSON.parse(body) }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const auth = join(root, 'backend.json'); writeFileSync(auth, '{"localTrusted":true}');
  const service = await startService({ directory: join(root, 'state'), paperclipUrl: `http://127.0.0.1:${backend.address().port}`, backendContextFile: auth });
  t.after(async () => { await service.close(); await new Promise(resolve => backend.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const context = join(root, 'operator.json'); writeFileSync(context, JSON.stringify({ socketPath: service.socketPath, token: service.token }));
  const payload = join(root, 'task.json'); writeFileSync(payload, JSON.stringify(input.payload));
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const args = [cli, '--context', context, 'task', 'create', '--company', 'company', '--key', 'human-check', '--file', payload];
  const first = JSON.parse((await promisify(execFile)(process.execPath, args)).stdout);
  const second = JSON.parse((await promisify(execFile)(process.execPath, args)).stdout);
  assert.equal(first.receipt.id, 'issue'); assert.deepEqual(second, first);
  await assert.rejects(promisify(execFile)(process.execPath, [...args, 'run-id']));
  const worker = service.store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'i', conversationId: 'c' });
  await assert.rejects(call({ socketPath: service.socketPath, token: worker.token }, 'POST', '/tasks', input), { code: 'forbidden' });
});

test('worker human follow-up uses its own credential and separate idempotency namespace', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const run = { id: 'run', request: { companyId: 'company', bindingId: 'worker', taskId: 'parent' } };
  let body;
  const api = async (actualRun, token, method, path, payload) => {
    assert.equal(actualRun, run); assert.equal(token, 'worker-token'); assert.equal(method, 'POST');
    assert.equal(path, '/api/companies/company/issues'); body = payload;
    return { id: 'child', ...payload };
  };
  const op = await mutate(store, run, 'worker-token', api, { key: input.key, kind: 'task.create', payload: { ...input.payload, parentId: 'parent' } });
  assert.equal(op.receipt.assigneeUserId, 'human'); assert.equal(body.parentId, 'parent');
  assert.ok(body.idempotencyKey.startsWith('relay:worker:'));
});
