import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { retireAccepted, reconcileRetirements } from '../src/lifecycle.mjs';
import { digest } from '../src/protocol.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('task-scoped acceptance retires only the authorised binding and preserves persistent peers', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const binding = id => ({ id, companyId: 'company', agentId: id, harness: 'opencode', instanceId: 'instance', conversationId: id });
  store.register(binding('controller'));
  store.register({ ...binding('worker'), lifetime: 'task', taskId: 'task', controllerBindingId: 'controller' });
  const request = { bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'worker', taskId: 'task', runId: 'backend' };
  assert.throws(() => store.dispatch({ ...request, taskId: 'another' }), { code: 'task_scope_mismatch' });
  let run = store.dispatch(request);
  store.acknowledge(run.id);
  store.submit(run.id, { key: 'one', candidate: 'sha256:one', summary: 'done' });
  store.publication(run.id, { state: 'recorded', commentId: 'receipt' });
  run = store.settle(run.id, { outcome: 'completed', evidence: 'Native fixture stopped' });
  assert.throws(() => store.dispatch({ ...request, runId: 'another' }), { code: 'candidate_reserved' });
  const interaction = { id: 'review', status: 'accepted', idempotencyKey: `relay-review:${run.id}:${digest(run.result)}`,
    payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: run.result.candidate, label: run.id } } };
  const api = async () => [interaction];
  const caller = { id: 'controller-run', request: { bindingId: 'controller', agentId: 'controller', companyId: 'company' } };
  await assert.rejects(retireAccepted(store, { ...caller, request: { ...caller.request, bindingId: 'other' } }, run, 'token', api), { code: 'lifecycle_forbidden' });
  assert.equal((await retireAccepted(store, caller, run, 'token', api)).state, 'recorded');
  assert.equal((await retireAccepted(store, caller, run, 'token', api)).state, 'recorded');
  assert.equal(store.binding('worker').lifecycleState, 'retired');
  assert.equal(store.binding('controller').lifecycleState, undefined);
  assert.equal(store.dispatch(request).id, run.id);
  assert.throws(() => store.dispatch({ ...request, runId: 'another' }), { code: 'binding_retired' });
});

test('retirement intent blocks new work even if cleanup has not completed', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.register({ id: 'worker', companyId: 'company', agentId: 'worker', harness: 'opencode', instanceId: 'instance', conversationId: 'worker' });
  store.beginRetirement('worker');
  assert.throws(() => store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'worker',
    taskId: 'task', runId: 'new' }), { code: 'binding_retired' });
});

test('verified rebinding preserves stored conversation, credentials and revision history', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = { id: 'worker', companyId: 'company', agentId: 'worker', harness: 'hermes', instanceId: 'old', conversationId: 'stored',
    delivery: 'hermes', hermes: { url: 'ws://127.0.0.1:17402/api/ws', directory: '/work', authFile: '/private/token',
      runtimeId: 'runtime-old', epoch: 'epoch-old', exclusive: true } };
  const registered = store.register(config);
  const next = { id: 'worker', revision: 1, harness: 'hermes', instanceId: 'new', conversationId: 'stored',
    hermes: { ...config.hermes, runtimeId: 'runtime-new', epoch: 'epoch-new' } };
  assert.throws(() => store.rebind('worker', { ...next, conversationId: 'unrelated' }), { code: 'continuation_mismatch' });
  const rebound = store.rebind('worker', next);
  assert.equal(rebound.revision, 2);
  assert.equal(rebound.history[0].config.hermes.runtimeId, 'runtime-old');
  assert.equal(store.authenticate(registered.token), 'worker');
  assert.throws(() => store.rebind('worker', next), { code: 'stale_binding' });
});

test('acceptance recorded while Relay is offline triggers the same retirement on restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-retirement-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(join(directory, 'state.sqlite'));
  const binding = id => ({ id, companyId: 'company', agentId: id, harness: 'opencode', instanceId: 'instance', conversationId: id });
  store.register(binding('controller'));
  store.register({ ...binding('worker'), lifetime: 'task', taskId: 'task', controllerBindingId: 'controller' });
  const run = store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'worker', taskId: 'task', runId: 'backend' });
  store.acknowledge(run.id);
  store.submit(run.id, { key: 'one', candidate: 'sha256:one', summary: 'done' });
  store.publication(run.id, { state: 'recorded', commentId: 'receipt' });
  store.settle(run.id, { outcome: 'completed', evidence: 'Native fixture stopped' });
  store.recordReview(run.id, { interactionId: 'review', candidate: 'sha256:one', status: 'pending' });
  const result = store.run(run.id).result;
  store.close();
  store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  const api = async () => [{ id: 'review', status: 'accepted', idempotencyKey: `relay-review:${run.id}:${digest(result)}`,
    payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: result.candidate, label: run.id } } }];
  await reconcileRetirements(store, api);
  assert.equal(store.binding('worker').lifecycleState, 'retired');
  assert.equal(store.operation(`retirement:${run.id}`).state, 'recorded');
  await reconcileRetirements(store, api);
  assert.equal(store.binding('controller').lifecycleState, undefined);
});
