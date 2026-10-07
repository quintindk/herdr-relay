import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { mutate } from '../src/operations.mjs';
import { taskOrigins } from '../src/task-origin.mjs';

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const origin = { bindingId: 'origin', conversationId: 'chat', sessionCreatedAt: 123,
    sourceMessageId: 'message', sourceDigest: 'digest' };
  const root = store.saveOperation({ id: 'operator-task:root', runId: '', state: 'recorded',
    request: { companyId: 'company', origin, body: { title: 'Root', assigneeAgentId: 'agent-root' } },
    receipt: { id: 'root', companyId: 'company', title: 'Root', identifier: 'TEST-1', assigneeAgentId: 'agent-root' } });
  const run = (taskId, companyId = 'company') => {
    const id = `${companyId}-${taskId}`;
    const { binding } = store.register({ id, companyId, agentId: `agent-${taskId}`, harness: 'opencode',
      conversationId: id, instanceId: id });
    return store.dispatch({ bindingId: id, companyId, agentId: binding.config.agentId,
      bindingRevision: 1, taskId, runId: `backend-${id}` });
  };
  const child = async (parentRun, id, payload = {}) => mutate(store, parentRun, 'worker-token',
    async (actualRun, token, method, path, body) => {
      assert.equal(actualRun, parentRun);
      assert.equal(token, 'worker-token');
      assert.equal(method, 'POST');
      return { ...body, id, companyId: parentRun.request.companyId, identifier: `TEST-${id}` };
    }, { key: id, kind: 'task.create', payload: { title: id, parentId: parentRun.request.taskId,
      assigneeAgentId: `agent-${id}`, ...payload } });
  return { store, origin, root, run, child };
}

test('children and grandchildren inherit durable root origin with their own assignment and metadata', async t => {
  const f = fixture(t);
  const child = await f.child(f.run('root'), 'child');
  const grandchild = await f.child(f.run('child'), 'grandchild');
  const entries = taskOrigins(f.store);
  assert.equal(entries.length, 3);
  for (const operation of [f.root, child, grandchild]) {
    const entry = entries.find(item => item.id === operation.id);
    assert.deepEqual(entry.request.origin, f.origin);
    assert.equal(entry.request.companyId, 'company');
    assert.deepEqual(entry.request.body, operation.request.body);
    assert.deepEqual(entry.receipt, operation.receipt);
    assert.equal(entry.state, 'recorded');
  }
  assert.equal(f.store.operation(child.id).request.origin, undefined);
  assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM operations WHERE id LIKE 'operator-task:%'").get().count, 1);
});

for (const [name, change] of [
  ['receipt company', op => { op.receipt.companyId = 'other'; }],
  ['missing receipt company', op => { delete op.receipt.companyId; }],
  ['receipt parent', op => { op.receipt.parentId = 'other'; }],
  ['missing receipt parent', op => { delete op.receipt.parentId; }],
  ['receipt assignment', op => { op.receipt.assigneeAgentId = 'other'; }],
  ['receipt human assignment', op => { op.receipt.assigneeUserId = 'human'; }],
  ['request parent', op => { op.request.body.parentId = op.receipt.parentId = 'other'; }],
  ['request path', op => { op.request.path = '/api/companies/other/issues'; }],
  ['request method', op => { op.request.method = 'PATCH'; }],
  ['missing run', op => { op.runId = 'missing'; }],
  ['uncertain state', op => { op.state = 'uncertain'; }],
]) {
  test(`invalid child ${name} prevents inheritance through descendants`, async t => {
    const f = fixture(t);
    const child = await f.child(f.run('root'), 'child');
    await f.child(f.run('child'), 'grandchild');
    change(child);
    f.store.saveOperation(child);
    assert.deepEqual(taskOrigins(f.store).map(item => item.receipt.id), ['root']);
  });
}

test('same task ID in another company cannot inherit the root origin', async t => {
  const f = fixture(t);
  await f.child(f.run('root', 'other'), 'child');
  assert.deepEqual(taskOrigins(f.store).map(item => item.receipt.id), ['root']);
});

test('legacy root without a company receipt remains visible but cannot authorise worker inheritance', async t => {
  const f = fixture(t);
  delete f.root.receipt.companyId;
  f.store.saveOperation(f.root);
  await f.child(f.run('root'), 'child');
  assert.deepEqual(taskOrigins(f.store).map(item => item.receipt.id), ['root']);
});

test('legacy root without a verified assignment cannot authorise worker inheritance', async t => {
  const f = fixture(t);
  delete f.root.receipt.assigneeAgentId;
  f.store.saveOperation(f.root);
  await f.child(f.run('root'), 'child');
  await f.child(f.run('child'), 'grandchild');
  assert.deepEqual(taskOrigins(f.store).map(item => item.receipt.id), ['root']);
});

test('unknown origins, unrelated parent tasks and unparented generic creation remain usable without inheritance', async t => {
  const f = fixture(t);
  const run = f.run('unknown');
  for (const [id, parentId] of [['unknown-child', 'unknown'], ['unrelated', 'root'], ['unparented', null]]) {
    const operation = await f.child(run, id, { parentId });
    assert.equal(operation.state, 'recorded');
  }
  assert.deepEqual(taskOrigins(f.store).map(item => item.receipt.id), ['root']);
});

test('a coordinator not assigned the recorded parent cannot propagate its origin', async t => {
  const f = fixture(t);
  const run = f.run('root');
  f.store.save({ ...run, request: { ...run.request, agentId: 'other' } }, 'test.changed');
  await f.child(run, 'child');
  assert.deepEqual(taskOrigins(f.store).map(item => item.receipt.id), ['root']);
});

test('conflicting root origins grant neither origin scope, including descendants', async t => {
  const f = fixture(t);
  await f.child(f.run('root'), 'child');
  await f.child(f.run('child'), 'grandchild');
  f.store.saveOperation({ ...f.root, id: 'operator-task:conflict',
    request: { ...f.root.request, origin: { ...f.origin, conversationId: 'other' } } });
  assert.deepEqual(taskOrigins(f.store), []);
});

test('conflicting assignments reject the task and its descendants even with the same origin', async t => {
  const f = fixture(t);
  await f.child(f.run('root'), 'child');
  await f.child(f.run('child'), 'grandchild');
  f.store.saveOperation({ ...f.root, id: 'operator-task:conflict',
    request: { ...f.root.request, body: { ...f.root.request.body, assigneeAgentId: 'other' } },
    receipt: { ...f.root.receipt, assigneeAgentId: 'other' } });
  assert.deepEqual(taskOrigins(f.store), []);
});

test('uncertain root claims do not grant or displace a recorded origin', t => {
  const f = fixture(t);
  f.store.saveOperation({ ...f.root, id: 'operator-task:uncertain', state: 'uncertain',
    request: { ...f.root.request, origin: { ...f.origin, bindingId: 'other' } } });
  assert.deepEqual(taskOrigins(f.store).map(item => item.request.origin), [f.origin]);
});

test('duplicate matching evidence resolves once and does not mutate the original root assignment', t => {
  const f = fixture(t);
  f.store.saveOperation({ ...f.root, id: 'operator-task:duplicate' });
  const [entry] = taskOrigins(f.store);
  assert.equal(taskOrigins(f.store).length, 1);
  assert.deepEqual(entry.request.body, f.root.request.body);
});

test('cycles fail closed without unbounded recursion, even with a root claimant', async t => {
  const f = fixture(t);
  await f.child(f.run('root'), 'child');
  await f.child(f.run('child'), 'root');
  assert.deepEqual(taskOrigins(f.store), []);
});

test('lineage depth is bounded', async t => {
  const f = fixture(t);
  let parent = 'root';
  for (let i = 0; i < 70; i++) {
    const id = `child-${i}`;
    await f.child(f.run(parent), id);
    parent = id;
  }
  assert.equal(taskOrigins(f.store).some(item => item.receipt.id === parent), false);
});
