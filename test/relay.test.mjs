import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store.mjs';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { execute } from '../src/adapter.mjs';
import { publish } from '../src/paperclip.mjs';

const binding = (id = 'driver', harness = 'opencode') => ({
  id, companyId: 'company', agentId: `agent-${id}`, harness, instanceId: 'native-server', conversationId: `session-${id}`,
});
const request = (runId = 'backend-run', id = 'driver') => ({
  bindingId: id, bindingRevision: 1, companyId: 'company', agentId: `agent-${id}`, runId, taskId: 'issue',
});
const submission = { key: 'candidate-1', summary: 'Implemented and checked', candidate: 'sha256:fixture' };
const errorCode = code => error => error.code === code;

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-relay-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('registration retries preserve credentials and refuse identity/conversation aliases', t => {
  const store = new Store(join(temporary(t), 'relay.sqlite'));
  t.after(() => store.close());
  const original = store.register(binding());
  assert.equal(store.register(binding()).token, original.token);
  assert.throws(() => store.register({ ...binding(), conversationId: 'replacement' }), errorCode('binding_conflict'));
  assert.throws(() => store.register({ ...binding('other'), conversationId: 'session-driver' }), errorCode('identity_conflict'));
  assert.equal(store.authenticate(original.token), 'driver');
  assert.equal(store.authenticate('wrong'), null);
});

test('dispatch survives reopening and refuses stale, changed and overlapping work', t => {
  const path = join(temporary(t), 'relay.sqlite');
  let store = new Store(path);
  store.register(binding());
  const run = store.dispatch(request());
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.equal(store.dispatch(request()).id, run.id);
  assert.throws(() => store.dispatch({ ...request(), taskId: 'different' }), errorCode('dispatch_conflict'));
  assert.throws(() => store.dispatch({ ...request(), bindingRevision: 2 }), errorCode('stale_binding'));
  assert.throws(() => store.dispatch(request('next')), errorCode('conversation_busy'));
  store.cancel(run.id);
  assert.equal(store.run(run.id).nativeState, 'settled');
  assert.notEqual(store.dispatch(request('next')).id, run.id);
});

test('submission does not release a conversation, acceptance is not inferred', t => {
  const store = new Store(join(temporary(t), 'relay.sqlite'));
  t.after(() => store.close());
  store.register(binding());
  const { id } = store.dispatch(request());
  assert.throws(() => store.submit(id, submission), errorCode('invalid_submission'));
  store.acknowledge(id);
  const result = store.submit(id, submission);
  assert.equal(result.nativeState, 'claimed');
  assert.deepEqual(store.submit(id, submission).result, submission);
  assert.throws(() => store.submit(id, { ...submission, candidate: 'changed' }), errorCode('submission_conflict'));
  assert.throws(() => store.dispatch(request('next')), errorCode('conversation_busy'));
  store.settle(id, { outcome: 'completed', evidence: 'Observed native turn ended' });
  assert.equal(store.dispatch(request('next')).nativeState, 'unclaimed');
});

test('cancelling claimed work preserves reports without clearing cancellation or inferring completion', t => {
  const store = new Store(join(temporary(t), 'relay.sqlite'));
  t.after(() => store.close());
  store.register(binding());
  const { id } = store.dispatch(request());
  store.acknowledge(id);
  assert.equal(store.cancel(id).nativeState, 'claimed');
  assert.deepEqual(store.submit(id, submission).result, submission);
  assert.equal(store.run(id).cancellationRequested, true);
  assert.throws(() => store.settle(id, { outcome: 'completed', evidence: 'Report submitted' }), errorCode('invalid_completion'));
  assert.throws(() => store.dispatch(request('next')), errorCode('conversation_busy'));
  store.settle(id, { outcome: 'cancelled', evidence: 'Operator observed interrupted turn' });
  assert.equal(store.dispatch(request('next')).nativeState, 'unclaimed');
});

test('an acknowledged cancelled turn may record a report after native settlement without reopening work', t => {
  const store = new Store(join(temporary(t), 'relay.sqlite'));
  t.after(() => store.close());
  store.register(binding());
  const { id } = store.dispatch(request());
  store.acknowledge(id); store.cancel(id);
  store.settle(id, { outcome: 'cancelled', evidence: 'Observed native turn ended' });
  const result = store.submit(id, submission);
  assert.deepEqual(result.result, submission);
  assert.equal(result.cancellationRequested, true);
  assert.equal(result.nativeState, 'settled');
  assert.equal(result.settlement.outcome, 'cancelled');
  assert.equal(result.publication.state, 'pending');
  assert.deepEqual(store.submit(id, submission).result, submission);
  assert.throws(() => store.submit(id, { ...submission, candidate: 'different' }), errorCode('submission_conflict'));
});

test('operator attestation can settle requested native cancellation but cannot infer native success', t => {
  const store = new Store(join(temporary(t), 'relay.sqlite'));
  t.after(() => store.close());
  store.register(binding());
  const { id } = store.dispatch(request());
  store.acknowledge(id);
  store.save({ ...store.run(id), invocation: { messageId: 'native' },
    native: { state: 'conflict', reason: 'concurrent_native_input' } }, 'test.native');
  const cancelled = { outcome: 'cancelled', evidence: 'Exact original response exported as aborted with no active tools' };
  assert.throws(() => store.settle(id, cancelled), errorCode('native_observation_required'));
  store.cancel(id);
  for (const outcome of ['completed', 'failed', 'waiting']) {
    assert.throws(() => store.settle(id, { ...cancelled, outcome }), errorCode('native_observation_required'));
  }
  const result = store.settle(id, cancelled);
  assert.equal(result.nativeState, 'settled');
  assert.equal(result.cancellationRequested, true);
  assert.equal(result.native.state, 'conflict');
  assert.deepEqual(result.settlement, { outcome: 'cancelled', evidence: `Operator-attested native cancellation: ${cancelled.evidence}` });
  assert.deepEqual(store.settle(id, cancelled), result);
  assert.equal(store.dispatch(request('next')).nativeState, 'unclaimed');
});

test('lost Paperclip response reconciles attributed comment without another POST', async t => {
  const path = join(temporary(t), 'relay.sqlite');
  let store = new Store(path);
  store.register(binding());
  const { id } = store.dispatch(request());
  store.acknowledge(id);
  store.submit(id, submission);
  const comments = [];
  let posts = 0;
  const api = async (run, token, method, path, input) => {
    assert.equal(token, 'scoped-token');
    if (method === 'GET') return comments;
    posts++;
    comments.push({ id: 'receipt', body: input.body, authorAgentId: run.request.agentId, createdByRunId: run.request.runId });
    throw new Error('Connection lost after backend committed');
  };
  await assert.rejects(publish(store, id, 'scoped-token', api));
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.equal((await publish(store, id, 'scoped-token', api)).publication.commentId, 'receipt');
  assert.equal(posts, 1);
});

test('uncertain publication without matching attribution never blindly replays', async t => {
  const store = new Store(join(temporary(t), 'relay.sqlite'));
  t.after(() => store.close());
  store.register(binding());
  const { id } = store.dispatch(request());
  store.acknowledge(id);
  store.submit(id, submission);
  await assert.rejects(publish(store, id, 'token', async () => { throw new Error('offline'); }));
  const result = await publish(store, id, 'token', async (run, token, method) => {
    assert.equal(method, 'GET');
    return [];
  });
  assert.equal(result.publication.state, 'uncertain');
});

test('service scopes worker credentials and gates settlement behind operator identity', async t => {
  const directory = temporary(t);
  const service = await startService({ directory, paperclipUrl: 'http://paperclip.test', api: async () => ({ companyId: 'company', title: 'Actual backend task' }) });
  t.after(() => service.close());
  const admin = { socketPath: service.socketPath, token: service.token };
  const registered = await call(admin, 'POST', '/bindings', binding());
  await call(admin, 'POST', '/bindings', binding('peer', 'hermes'));
  const own = await call(admin, 'POST', '/runs', request());
  const peer = await call(admin, 'POST', '/runs', request('peer-run', 'peer'));
  const worker = { ...admin, token: registered.token };
  assert.equal((statSync(service.socketPath).mode & 0o777), 0o600);
  assert.equal((await call(worker, 'GET', '/runs')).length, 1);
  await assert.rejects(call(worker, 'GET', `/runs/${peer.id}`), errorCode('forbidden'));
  await assert.rejects(call(worker, 'GET', '/bindings'), errorCode('forbidden'));
  await assert.rejects(call(admin, 'POST', '/bindings', null), errorCode('invalid_request'));
  await assert.rejects(call(worker, 'POST', `/runs/${own.id}/settle`, {}), errorCode('forbidden'));
  await call(worker, 'POST', `/runs/${own.id}/acknowledge`, {});
  service.store.cancel(own.id);
  service.store.settle(own.id, { outcome: 'cancelled', evidence: 'Fixture stopped' });
  service.store.retireBinding('driver');
  await assert.rejects(call(worker, 'POST', '/events', { source: 'fixture', eventId: 'one', cursor: 'one', recipient: 'peer', summary: 'late', reference: 'fixture://one' }), errorCode('binding_inactive'));
  await assert.rejects(call(worker, 'GET', `/runs/${own.id}/task`), errorCode('adapter_unavailable'));
  await call(admin, 'POST', `/runs/${own.id}/attach`, { token: 'backend-token' });
  assert.equal((await call(worker, 'GET', `/runs/${own.id}/task`)).title, 'Actual backend task');
  await assert.rejects(startService({ directory, paperclipUrl: 'http://paperclip.test' }), errorCode('already_running'));
});

test('real CLI registers idempotently and preserves context files', async t => {
  const directory = temporary(t);
  const service = await startService({ directory, paperclipUrl: 'http://paperclip.test' });
  t.after(() => service.close());
  const file = join(directory, 'binding.json'), context = join(directory, 'worker.json');
  writeFileSync(file, JSON.stringify(binding()));
  const args = ['src/cli.mjs', 'agent', 'register', '--state-dir', directory, '--file', file, '--context-out', context];
  const first = await promisify(execFile)(process.execPath, args);
  const second = await promisify(execFile)(process.execPath, args);
  assert.equal(JSON.parse(first.stdout).created, true);
  assert.equal(JSON.parse(second.stdout).created, false);
  assert.equal(statSync(context).mode & 0o777, 0o600);
});

async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    const result = await fn();
    if (result) return result;
    await delay(20);
  }
  assert.fail('Condition not reached');
}

test('external adapter waits for submission AND settlement, then preserves conversation', async t => {
  const directory = temporary(t), comments = [];
  let service = await startService({ directory, paperclipUrl: 'http://paperclip.test', api: async (run, token, method, path, input) => {
    if (method === 'GET') return comments;
    const receipt = { id: 'comment', ...input, authorAgentId: run.request.agentId, createdByRunId: run.request.runId };
    comments.push(receipt);
    return receipt;
  } });
  t.after(() => service.close());
  service.store.register(binding());
  const contextPath = join(directory, 'operator.json');
  writeFileSync(contextPath, JSON.stringify({ socketPath: service.socketPath, token: service.token }));
  let finished = false;
  const promise = execute({
    agent: { id: 'agent-driver', companyId: 'company' }, runId: 'backend-run', authToken: 'backend-token',
    config: { relayContextFile: contextPath, bindingId: 'driver' }, context: { taskId: 'issue' },
    onLog: async () => {},
  }).then(result => { finished = true; return result; });
  const run = await waitFor(() => service.store.runs()[0]);
  service.store.acknowledge(run.id);
  service.store.submit(run.id, submission);
  await waitFor(() => service.store.run(run.id).publication.state === 'recorded');
  assert.equal(finished, false);
  // Restart the actual socket service while the adapter is polling it.
  await service.close();
  service = await startService({ directory, paperclipUrl: 'http://paperclip.test' });
  service.store.settle(run.id, { outcome: 'completed', evidence: 'Observed completed native turn' });
  const result = await promise;
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionDisplayId, 'session-driver');
  assert.equal(comments.length, 1);
});

test('adapter cancellation does not finish while claimed native execution is unresolved', async t => {
  const directory = temporary(t);
  const service = await startService({ directory, paperclipUrl: 'http://paperclip.test' });
  t.after(() => service.close());
  service.store.register(binding());
  const contextPath = join(directory, 'operator.json');
  writeFileSync(contextPath, JSON.stringify({ socketPath: service.socketPath, token: service.token }));
  const controller = new AbortController();
  let finished = false;
  const promise = execute({
    agent: { id: 'agent-driver', companyId: 'company' }, runId: 'backend-run', authToken: 'backend-token',
    config: { relayContextFile: contextPath, bindingId: 'driver' }, context: { taskId: 'issue' },
    signal: controller.signal, onLog: async () => {},
  }).then(result => { finished = true; return result; });
  const run = await waitFor(() => service.store.runs()[0]);
  service.store.acknowledge(run.id);
  controller.abort();
  await waitFor(() => service.store.run(run.id).cancellationRequested);
  assert.equal(finished, false);
  service.store.settle(run.id, { outcome: 'cancelled', evidence: 'Operator observed interrupted invocation' });
  assert.equal((await promise).exitCode, 1);
});
