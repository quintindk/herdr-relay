import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { publish, verifyRecovery } from '../src/paperclip.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { execute } from '../src/adapter.mjs';

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.register({ id: 'driver', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'session' });
  const request = { bindingId: 'driver', bindingRevision: 1, companyId: 'company', agentId: 'agent', runId: 'original', taskId: 'task' };
  const run = store.dispatch(request);
  store.acknowledge(run.id);
  store.submit(run.id, { key: 'one', summary: 'Original work', candidate: 'fixture' });
  return { store, run, request, replacement: { ...request, runId: 'replacement' } };
}

test('replacement backend run preserves native work and original dispatch history', t => {
  const { store, run, request, replacement } = fixture(t);
  const recovered = store.recover(run.id, replacement);
  assert.deepEqual(recovered.request, request);
  assert.equal(recovered.backendRunId, 'replacement');
  assert.equal(store.dispatch(replacement).id, run.id);
  assert.equal(store.dispatch(request).id, run.id);
  assert.equal(store.recover(run.id, replacement).recoveries.length, 1);
  assert.equal(store.runs().length, 1);
  assert.throws(() => store.recover(run.id, { ...replacement, taskId: 'different' }), { code: 'recovery_identity_mismatch' });
});

test('recovery verifies terminal prior run and live replacement identity', async t => {
  const { run, replacement } = fixture(t);
  const prior = { id: 'original', companyId: 'company', agentId: 'agent', status: 'failed' };
  const current = { id: 'replacement', companyId: 'company', agentId: 'agent', status: 'running', contextSnapshot: { taskId: 'task' } };
  const api = async (context, token, method, path) => path.endsWith('/original') ? prior : current;
  await verifyRecovery(run, replacement, 'token', api);
  prior.status = 'running';
  await assert.rejects(verifyRecovery(run, replacement, 'token', api), { code: 'recovery_not_authorised' });
  prior.status = 'failed';
  current.contextSnapshot.taskId = 'foreign';
  await assert.rejects(verifyRecovery(run, replacement, 'token', api), { code: 'recovery_not_authorised' });
});

test('uncertain original publication reconciles original attribution after backend recovery', async t => {
  const { store, run, replacement } = fixture(t);
  const comments = [];
  let posts = 0;
  const api = async (run, token, method, path, input) => {
    if (method === 'GET') return comments;
    posts++;
    comments.push({ id: 'receipt', body: input.body, authorAgentId: 'agent', createdByRunId: run.backendRunId ?? run.request.runId });
    throw new Error('Lost receipt');
  };
  await assert.rejects(publish(store, run.id, 'original-token', api));
  store.recover(run.id, replacement);
  const reconciled = await publish(store, run.id, 'new-token', api);
  assert.equal(reconciled.publication.backendRunId, 'original');
  assert.equal(reconciled.publication.commentId, 'receipt');
  assert.equal(posts, 1);
});

test('pending result publishes with replacement attribution', async t => {
  const { store, run, replacement } = fixture(t);
  store.recover(run.id, replacement);
  const published = await publish(store, run.id, 'replacement-token', async native => {
    assert.equal(native.backendRunId, 'replacement');
    return { id: 'replacement-receipt' };
  });
  assert.equal(published.publication.backendRunId, 'replacement');
});

test('replaced adapter cannot cancel the recovered invocation or keep its supervision authority', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-stale-adapter-'));
  const service = await startService({ directory, paperclipUrl: 'http://paperclip.test' });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  service.store.register({ id: 'driver', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'session' });
  const request = { bindingId: 'driver', bindingRevision: 1, companyId: 'company', agentId: 'agent', runId: 'original', taskId: 'task' };
  const run = service.store.dispatch(request);
  service.store.acknowledge(run.id);
  service.store.recover(run.id, { ...request, runId: 'replacement' });
  const admin = { socketPath: service.socketPath, token: service.token };
  await assert.rejects(call(admin, 'POST', `/runs/${run.id}/cancel`, { runId: 'original' }), { code: 'stale_backend_run' });
  assert.equal(service.store.run(run.id).cancellationRequested, false);
  const path = join(directory, 'operator.json');
  writeFileSync(path, JSON.stringify(admin), { mode: 0o600 });
  await assert.rejects(execute({ agent: { companyId: 'company', id: 'agent' }, runId: 'original', authToken: 'old-token',
    config: { relayContextFile: path, bindingId: 'driver' }, context: { taskId: 'task' }, onLog: async () => {} }), { code: 'stale_backend_run' });
});
