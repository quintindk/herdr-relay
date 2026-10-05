import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { configureBridge, armBridge, disarmBridge, bridgeRequest, bridgeForToken } from '../src/opencode-bridge.mjs';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { digest } from '../src/protocol.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-bridge-'));
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(join(directory, 'admin-token'), 'operator-test-token');
  store.saveOperation({ id: 'herdr-agent:test', runId: '', marker: 'marker', agentId: 'agent', availability: 'present',
    identity: { harness: 'opencode', sessionKind: 'id', conversationId: 'conversation', machineId: 'machine', session: 'default', companyId: 'company' },
    placement: { directory: '/work', terminalId: 'terminal' }, observation: { display: { name: 'test' } } });
  const backend = { id: 'agent', companyId: 'company', adapterType: 'herdr_relay', adapterConfig: { observationOnly: true, relayObservationMarker: 'marker' } };
  const api = async (method, path, body) => { if (method === 'PATCH') Object.assign(backend, body); return structuredClone(backend); };
  const input = { observedId: 'herdr-agent:test', reserved: true };
  const configured = await configureBridge(store, directory, api, input);
  const config = JSON.parse(readFileSync(configured.bridgeConfigFile, 'utf8'));
  const id = `opencode-bridge:${configured.bindingId}`;
  const report = { epoch: 'epoch', conversationId: 'conversation', terminalId: 'terminal', sessionCreatedAt: 123, idle: true };
  const invoke = (action, input = {}) => bridgeRequest(store, id, action, { ...report, ...input }, () => true);
  const dispatch = () => store.dispatch({ bindingId: configured.bindingId, bindingRevision: 1,
    agentId: 'agent', companyId: 'company', taskId: 'task', runId: 'backend-run' });
  return { directory, store, backend, api, configured, config, id, report, invoke, dispatch };
}

test('bridge is explicitly configured and armed only after exact live plugin readiness', async t => {
  const f = await fixture(t);
  assert.equal(f.backend.adapterConfig.observationOnly, true);
  assert.equal(bridgeForToken(f.store, f.config.token).id, f.id);
  assert.equal(bridgeForToken(f.store, 'not-the-token'), undefined);
  await assert.rejects(armBridge(f.store, f.directory, f.api, { bindingId: f.configured.bindingId }), { code: 'bridge_unavailable' });
  assert.throws(f.dispatch, { code: 'bridge_unavailable' });
  f.invoke('poll');
  await armBridge(f.store, f.directory, f.api, { bindingId: f.configured.bindingId });
  assert.equal(f.backend.status, 'idle');
  assert.equal(f.backend.adapterConfig.requireReviewDisposition, true);
  assert.equal(f.backend.runtimeConfig.heartbeat.intervalSec, 0);
  assert.equal(f.dispatch().nativeState, 'unclaimed');
});

test('bridge persists one native message, verifies its terminal parent and settles without operator attestation', async t => {
  const f = await fixture(t);
  f.invoke('poll'); await armBridge(f.store, f.directory, f.api, { bindingId: f.configured.bindingId });
  const run = f.dispatch();
  assert.throws(() => f.invoke('begin', { runId: run.id, idle: false, priorUserIds: [] }), { code: 'native_busy' });
  const started = f.invoke('begin', { runId: run.id, priorUserIds: [] });
  assert.equal(started.dispatch, true);
  const messageId = started.run.invocation.messageId;
  assert.equal(f.invoke('begin', { runId: run.id, priorUserIds: [] }).dispatch, false, 'Lost begin reply never authorises another POST');
  assert.throws(() => f.invoke('poll', { epoch: 'another-process' }), { code: 'bridge_epoch_conflict' });
  const messages = [{ info: { id: messageId, role: 'user', sessionID: 'conversation' }, parts: [{ type: 'text', text: started.run.invocation.prompt }] },
    { info: { id: 'assistant', role: 'assistant', sessionID: 'conversation', parentID: messageId, time: { created: 1, completed: 2 }, finish: 'stop' }, parts: [] }];
  f.invoke('observe', { runId: run.id, snapshot: { messages, idle: true } });
  assert.notEqual(f.store.run(run.id).nativeState, 'settled', 'Terminal message alone is not a submitted result');
  f.store.acknowledge(run.id);
  f.store.submit(run.id, { key: 'one', candidate: 'result', summary: 'Answer' });
  f.invoke('observe', { runId: run.id, snapshot: { messages, idle: true } });
  assert.equal(f.store.run(run.id).settlement.outcome, 'completed');
  assert.match(f.store.run(run.id).settlement.evidence, /assistant.*msg_/);
  await disarmBridge(f.store, f.api, { bindingId: f.configured.bindingId });
  assert.equal(f.backend.status, 'paused');
  assert.equal(f.backend.adapterConfig.observationOnly, true);
  assert.throws(() => f.store.dispatch({ ...run.request, runId: 'next' }), { code: 'bridge_unavailable' });
});

test('concurrent user input and changed terminal identity fail closed', async t => {
  const f = await fixture(t);
  f.invoke('poll'); await armBridge(f.store, f.directory, f.api, { bindingId: f.configured.bindingId });
  const run = f.dispatch();
  f.invoke('begin', { runId: run.id, priorUserIds: [] });
  f.invoke('observe', { runId: run.id, conflict: true, snapshot: { messages: [], idle: true } });
  assert.equal(f.store.run(run.id).native.state, 'conflict');
  f.invoke('observe', { runId: run.id, snapshot: { messages: [], idle: true } });
  assert.equal(f.store.run(run.id).native.state, 'conflict');
  assert.throws(() => f.invoke('poll', { terminalId: 'replacement' }), { code: 'bridge_identity_mismatch' });
  assert.throws(() => f.invoke('poll', { sessionCreatedAt: 124 }), { code: 'bridge_identity_mismatch' });
});

test('bridge credentials cannot access worker results or operator routes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-bridge-auth-'));
  const service = await startService({ directory, paperclipUrl: 'http://127.0.0.1:3100' });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  service.store.saveOperation({ id: 'opencode-bridge:test', runId: '', tokenHash: digest('bridge-only'), identity: { observedId: 'herdr-agent:missing' }, state: 'configured' });
  const connection = { socketPath: service.socketPath, token: 'bridge-only' };
  await assert.rejects(call(connection, 'GET', '/bindings'), { code: 'forbidden' });
  await assert.rejects(call(connection, 'POST', '/runs/test/submit', {}), { code: 'forbidden' });
  await assert.rejects(call(connection, 'POST', '/herdr/arm-bridge', {}), { code: 'forbidden' });
  const large = { padding: 'x'.repeat(160 * 1024) };
  await assert.rejects(call(connection, 'POST', '/bridge/poll', large), { code: 'request_too_large' });
  await assert.rejects(call(connection, 'POST', '/bridge/observe', large), { code: 'bridge_identity_mismatch' });
  await assert.rejects(call(connection, 'POST', '/bridge/observe', { padding: 'x'.repeat(4 * 1024 * 1024) }), { code: 'request_too_large' });
});
