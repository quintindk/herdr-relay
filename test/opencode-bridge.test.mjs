import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { configureBridge, armBridge, disarmBridge, refreshBridge, bridgeRequest, bridgeForToken } from '../src/opencode-bridge.mjs';
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

for (const lookup of ['bindingId', 'observedId']) {
  test(`pending worker revocation by ${lookup} blocks new dispatch and queued begin but preserves replay`, async t => {
    const f = await fixture(t);
    f.invoke('poll'); await armBridge(f.store, f.directory, f.api, { bindingId: f.configured.bindingId });
    const target = { ...f.store.operation(f.id).identity };
    if (lookup === 'bindingId') target.observedId = 'herdr-agent:previous';
    const grant = f.store.saveOperation({ id: 'herdr-worker:test', runId: '', state: 'armed', target,
      ...(lookup === 'bindingId' ? { bindingId: f.configured.bindingId } : {}) });
    const run = f.dispatch();
    f.store.saveOperation({ ...grant, state: 'blocked', blocker: 'disarm_pending', disarmed: false });
    assert.equal(f.store.operation(f.id).state, 'armed', 'The bridge stays armed until existing work settles');
    assert.throws(() => f.store.dispatch({ ...run.request, runId: 'next' }), { code: 'worker_grant_inactive' });
    assert.deepEqual(f.dispatch(), run, 'An exact dispatch replay must bypass admission');
    assert.throws(() => f.invoke('begin', { runId: run.id, priorUserIds: [] }), { code: 'worker_grant_inactive' });
    assert.deepEqual(f.store.run(run.id), run, 'Refused begin must not persist a native invocation');
    assert.equal(f.store.runs().length, 1);
    assert.throws(() => f.store.dispatch({ ...run.request, taskId: 'changed' }), { code: 'dispatch_conflict' });
  });
}

test('explicit armed replacement admits dispatch and begin while retaining the superseded grant', async t => {
  const f = await fixture(t);
  f.invoke('poll'); await armBridge(f.store, f.directory, f.api, { bindingId: f.configured.bindingId });
  const old = f.store.saveOperation({ id: 'herdr-worker:old', runId: '', state: 'blocked', blocker: 'grant_revoked',
    disarmed: true, bindingId: f.configured.bindingId, target: { ...f.store.operation(f.id).identity } });
  assert.throws(f.dispatch, { code: 'worker_grant_inactive' });
  f.store.saveOperation({ id: 'herdr-worker:replacement', runId: '', state: 'armed',
    bindingId: f.configured.bindingId, target: { ...old.target }, supersedes: [old.id] });
  assert.doesNotThrow(() => f.store.assertWorkerAdmission(f.configured.bindingId));
  const run = f.dispatch();
  assert.equal(run.nativeState, 'unclaimed');
  assert.equal(f.invoke('begin', { runId: run.id, priorUserIds: [] }).dispatch, true);
  assert.deepEqual(f.store.operation(old.id), old);
});

for (const scenario of ['old-only', 'no-supersedes', 'wrong-id', 'disarm_pending', 'old-not-blocked',
  'replacement-prepared', 'replacement-configured', 'replacement-blocked', 'conflicting-armed', 'conflicting-blocked',
  ...['observedId', 'conversationId', 'terminalId', 'directory', 'paneId', 'workspaceId', 'tabId'].map(field => `wrong-${field}`)]) {
  test(`worker supersession rejects ${scenario} for admission, dispatch and queued begin`, async t => {
    const f = await fixture(t);
    f.invoke('poll'); await armBridge(f.store, f.directory, f.api, { bindingId: f.configured.bindingId });
    const run = f.dispatch(), target = { ...f.store.operation(f.id).identity };
    const old = { id: 'herdr-worker:old', runId: '', state: 'blocked', blocker: 'grant_revoked', disarmed: true,
      bindingId: f.configured.bindingId, target: { ...target } };
    const replacement = { id: 'herdr-worker:replacement', runId: '', state: 'armed',
      bindingId: f.configured.bindingId, target, supersedes: [old.id] };
    if (scenario === 'no-supersedes') delete replacement.supersedes;
    if (scenario === 'wrong-id') replacement.supersedes = ['herdr-worker:unrelated'];
    if (scenario === 'disarm_pending') { old.disarmed = false; old.blocker = 'disarm_pending'; }
    if (scenario === 'old-not-blocked') old.state = 'armed';
    if (scenario.startsWith('replacement-')) replacement.state = scenario.slice('replacement-'.length);
    if (scenario.startsWith('wrong-') && scenario !== 'wrong-id') old.target[scenario.slice('wrong-'.length)] = 'previous';
    f.store.saveOperation(old);
    if (scenario !== 'old-only') f.store.saveOperation(replacement);
    if (scenario.startsWith('conflicting-')) f.store.saveOperation({ ...replacement, id: 'herdr-worker:conflict',
      state: scenario.slice('conflicting-'.length) });
    const records = f.store.db.prepare("SELECT data FROM operations WHERE id LIKE 'herdr-worker:%' ORDER BY id").all();
    assert.throws(() => f.store.assertWorkerAdmission(f.configured.bindingId), { code: 'worker_grant_inactive' });
    assert.throws(() => f.store.dispatch({ ...run.request, runId: 'next' }), { code: 'worker_grant_inactive' });
    assert.throws(() => f.invoke('begin', { runId: run.id, priorUserIds: [] }), { code: 'worker_grant_inactive' });
    assert.deepEqual(f.store.run(run.id), run);
    assert.equal(f.store.runs().length, 1);
    assert.deepEqual(f.store.db.prepare("SELECT data FROM operations WHERE id LIKE 'herdr-worker:%' ORDER BY id").all(), records);
  });
}

test('pending worker revocation allows existing invocation replay, observation and settlement', async t => {
  const f = await fixture(t);
  f.invoke('poll'); await armBridge(f.store, f.directory, f.api, { bindingId: f.configured.bindingId });
  const grant = f.store.saveOperation({ id: 'herdr-worker:test', runId: '', state: 'armed',
    bindingId: f.configured.bindingId, target: { ...f.store.operation(f.id).identity } });
  const run = f.dispatch();
  const started = f.invoke('begin', { runId: run.id, priorUserIds: [] });
  assert.equal(started.dispatch, true);
  f.store.saveOperation({ ...grant, state: 'blocked', blocker: 'disarm_pending', disarmed: false });
  const replay = f.invoke('begin', { runId: run.id, priorUserIds: [] });
  assert.equal(replay.dispatch, false);
  assert.deepEqual(replay.run.invocation, started.run.invocation);
  assert.deepEqual(f.dispatch(), f.store.run(run.id));
  const { messageId, prompt } = started.run.invocation;
  const messages = [{ info: { id: messageId, role: 'user', sessionID: 'conversation' }, parts: [{ type: 'text', text: prompt }] },
    { info: { id: 'assistant', role: 'assistant', sessionID: 'conversation', parentID: messageId,
      time: { created: 1, completed: 2 }, finish: 'stop' }, parts: [] }];
  f.invoke('observe', { runId: run.id, snapshot: { messages, idle: true } });
  assert.notEqual(f.store.run(run.id).nativeState, 'settled');
  f.store.acknowledge(run.id);
  f.store.submit(run.id, { key: 'one', candidate: 'result', summary: 'Answer' });
  const settled = f.invoke('observe', { runId: run.id, snapshot: { messages, idle: true } }).run;
  assert.equal(settled.nativeState, 'settled');
  assert.equal(settled.settlement.outcome, 'completed');
  assert.deepEqual(f.dispatch(), settled, 'Settled dispatch replay must also bypass admission');
  assert.throws(() => f.store.dispatch({ ...run.request, runId: 'next' }), { code: 'worker_grant_inactive' });
});

test('pending worker revocation does not turn cancellation into a fresh begin', async t => {
  const f = await fixture(t);
  f.invoke('poll'); await armBridge(f.store, f.directory, f.api, { bindingId: f.configured.bindingId });
  const run = f.dispatch();
  f.store.acknowledge(run.id);
  f.store.cancel(run.id);
  f.store.saveOperation({ id: 'herdr-worker:test', runId: '', bindingId: f.configured.bindingId,
    target: { ...f.store.operation(f.id).identity }, state: 'blocked', blocker: 'disarm_pending', disarmed: false });
  const cancelled = f.store.run(run.id);
  assert.equal(cancelled.cancellationRequested, true);
  assert.equal(cancelled.invocation, undefined);
  assert.deepEqual(f.invoke('begin', { runId: run.id, priorUserIds: [] }), { run: cancelled, dispatch: false });
  assert.deepEqual(f.store.run(run.id), cancelled);
});

for (const field of ['conversationId', 'terminalId', 'directory']) {
  test(`armed worker grant rejects changed ${field} for dispatch and queued begin`, async t => {
    const f = await fixture(t);
    f.invoke('poll'); await armBridge(f.store, f.directory, f.api, { bindingId: f.configured.bindingId });
    const grant = f.store.saveOperation({ id: 'herdr-worker:test', runId: '', state: 'armed',
      bindingId: f.configured.bindingId, target: { ...f.store.operation(f.id).identity } });
    const run = f.dispatch();
    f.store.saveOperation({ ...grant, target: { ...grant.target, [field]: 'replacement' } });
    assert.throws(() => f.store.dispatch({ ...run.request, runId: 'next' }), { code: 'worker_grant_inactive' });
    assert.throws(() => f.invoke('begin', { runId: run.id, priorUserIds: [] }), { code: 'worker_grant_inactive' });
    assert.deepEqual(f.store.run(run.id), run);
  });
}

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

test('explicit configure still refuses terminal replacement and refresh cannot change conversation directory', async t => {
  const f = await fixture(t);
  const observed = f.store.operation('herdr-agent:test');
  f.store.saveOperation({ ...observed, placement: { ...observed.placement, terminalId: 'replacement' } });
  await assert.rejects(configureBridge(f.store, f.directory, f.api, { observedId: observed.id, reserved: true }), { code: 'bridge_conflict' });
  await assert.rejects(refreshBridge(f.store, f.directory, f.api, { observedId: observed.id }), { code: 'reservation_required' });
  f.store.saveOperation({ ...observed, placement: { directory: '/another', terminalId: 'replacement' } });
  await assert.rejects(refreshBridge(f.store, f.directory, f.api, { observedId: observed.id, reserved: true }), { code: 'bridge_conflict' });
});

test('arm rechecks exact placement and plugin readiness after backend lookup', async t => {
  const f = await fixture(t);
  f.invoke('poll');
  const api = async (...args) => {
    assert.equal(args[0], 'GET', 'Changed readiness must prevent PATCH');
    const response = await f.api(...args);
    f.invoke('poll', { idle: false });
    return response;
  };
  await assert.rejects(armBridge(f.store, f.directory, api, { bindingId: f.configured.bindingId }), { code: 'bridge_unavailable' });
  assert.equal(f.store.operation(f.id).state, 'configured');
  f.invoke('poll');
  const observed = f.store.operation('herdr-agent:test');
  f.store.saveOperation({ ...observed, placement: { ...observed.placement, directory: '/another' } });
  await assert.rejects(armBridge(f.store, f.directory, f.api, { bindingId: f.configured.bindingId }), { code: 'bridge_identity_mismatch' });
});

test('refresh retains native session creation identity and refuses an intervening observation change', async t => {
  const f = await fixture(t);
  f.invoke('poll');
  const observed = f.store.operation('herdr-agent:test');
  f.store.saveOperation({ ...observed, placement: { ...observed.placement, terminalId: 'replacement' } });
  const input = { observedId: observed.id, reserved: true };
  await refreshBridge(f.store, f.directory, f.api, input);
  assert.throws(() => f.invoke('poll', { terminalId: 'replacement', sessionCreatedAt: 124 }), { code: 'bridge_identity_mismatch' });
  f.invoke('poll', { terminalId: 'replacement' });
  const tokenHash = f.store.operation(f.id).tokenHash;
  f.store.saveOperation({ ...observed, placement: { ...observed.placement, terminalId: 'third' } });
  const api = async (...args) => {
    const result = await f.api(...args);
    f.store.saveOperation({ ...observed, availability: 'offline' });
    return result;
  };
  await assert.rejects(refreshBridge(f.store, f.directory, api, input), { code: 'agent_not_ready' });
  assert.equal(f.store.operation(f.id).tokenHash, tokenHash);
  assert.equal(f.store.operation(f.id).identity.terminalId, 'replacement');
});

test('explicit configure rechecks unsettled work after backend lookup', async t => {
  const f = await fixture(t);
  f.invoke('poll'); await armBridge(f.store, f.directory, f.api, { bindingId: f.configured.bindingId });
  const before = f.store.operation(f.id);
  const api = async (...args) => { const response = await f.api(...args); f.dispatch(); return response; };
  await assert.rejects(configureBridge(f.store, f.directory, api, { observedId: 'herdr-agent:test', reserved: true }), { code: 'work_unsettled' });
  assert.deepEqual(f.store.operation(f.id), before);
});

for (const [name, drift] of [
  ['missing relayContextFile', backend => { delete backend.adapterConfig.relayContextFile; }],
  ['requireReviewDisposition false', backend => { backend.adapterConfig.requireReviewDisposition = false; }],
  ['heartbeat enabled false', backend => { backend.runtimeConfig.heartbeat.enabled = false; }],
  ['heartbeat wakeOnDemand false', backend => { backend.runtimeConfig.heartbeat.wakeOnDemand = false; }],
]) {
  test(`arming repairs ${name} on an already armed bridge`, async t => {
    const f = await fixture(t);
    const input = { bindingId: f.configured.bindingId };
    f.invoke('poll'); await armBridge(f.store, f.directory, f.api, input);
    const expected = structuredClone(f.backend);
    drift(f.backend);
    let patches = 0;
    const api = async (...args) => {
      if (args[0] === 'PATCH') patches++;
      return f.api(...args);
    };
    assert.deepEqual(await armBridge(f.store, f.directory, api, input), { ...input, state: 'armed' });
    assert.equal(patches, 1, 'Backend drift must bypass the armed fast path');
    assert.deepEqual(f.backend, expected);
    assert.equal(f.store.operation(f.id).state, 'armed');
    await armBridge(f.store, f.directory, api, input);
    assert.equal(patches, 1, 'Repaired configuration must not trigger another PATCH');
  });
}
