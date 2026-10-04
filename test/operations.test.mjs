import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { mutate } from '../src/operations.mjs';

test('task creation survives lost receipt without creating another backend task', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const run = { id: 'relay', request: { companyId: 'company', bindingId: 'binding', taskId: 'parent' } };
  const input = { key: 'subnet-1', kind: 'task.create', payload: { title: 'Vend subnet', assigneeAgentId: 'peer', parentId: 'parent' } };
  const tasks = new Map();
  let calls = 0;
  const api = async (run, token, method, path, body) => {
    calls++;
    if (!tasks.has(body.idempotencyKey)) tasks.set(body.idempotencyKey, { id: 'child', ...body });
    if (calls === 1) throw new Error('Lost reply');
    return tasks.get(body.idempotencyKey);
  };
  await assert.rejects(mutate(store, run, 'token', api, input));
  const operation = await mutate(store, run, 'token', api, input);
  assert.equal(operation.receipt.id, 'child');
  assert.equal(tasks.size, 1);
  await mutate(store, run, 'token', api, input);
  assert.equal(calls, 2);
  await assert.rejects(mutate(store, run, 'token', api, { ...input, payload: { title: 'Changed' } }), { code: 'operation_conflict' });
});

test('uncertain assignment is not blindly reapplied over a newer assignment', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const run = { id: 'relay', request: { companyId: 'company', bindingId: 'binding', taskId: 'parent' } };
  const input = { key: 'assign', kind: 'task.assign', payload: { assigneeAgentId: 'peer' } };
  let calls = 0;
  const api = async () => { calls++; throw new Error('Lost reply'); };
  await assert.rejects(mutate(store, run, 'token', api, input));
  await assert.rejects(mutate(store, run, 'token', api, input), { code: 'operation_uncertain' });
  assert.equal(calls, 1);
});
