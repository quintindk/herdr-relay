import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { reconcileBridgeEnrolment } from '../src/bridge-enrolment.mjs';
import { enrolAgent, enrolmentDirectories } from '../src/enrolment.mjs';
import { armBridge, bridgeForToken, bridgeRequest, configureBridge, disarmBridge } from '../src/opencode-bridge.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-enrolment-'));
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(join(directory, 'admin-token'), 'test-operator');
  const scope = { companyId: 'company', machineId: 'machine', session: 'default' };
  const options = { directories: ['/work'], ...scope };
  const backends = new Map(), calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    assert.ok(['GET', 'PATCH'].includes(method), 'Enrolment never creates a backend agent');
    const backend = backends.get(path.split('/').at(-1));
    assert.ok(backend, `Unknown backend ${path}`);
    if (method === 'PATCH') Object.assign(backend, body);
    return structuredClone(backend);
  };
  const observe = (conversationId, fields = {}) => {
    const identity = { ...scope, harness: 'opencode', sessionKind: 'id', conversationId, ...fields.identity };
    const id = `herdr-agent:${digest(identity)}`;
    const agentId = `agent-${digest(identity).slice(0, 16)}`;
    const marker = `marker-${id}`;
    if (!backends.has(agentId)) backends.set(agentId, { id: agentId, companyId: identity.companyId, status: 'paused',
      adapterType: 'herdr_relay', adapterConfig: { observationOnly: true, relayObservationMarker: marker } });
    return store.saveOperation({ id, runId: '', marker, agentId, identity, availability: 'present',
      placement: { directory: '/work', terminalId: `terminal-${conversationId}` }, observation: { display: { name: conversationId } },
      ...fields, identity });
  };
  const bindingId = observed => `observed-${digest(observed.id).slice(0, 24)}`;
  const bridge = observed => store.operation(`opencode-bridge:${bindingId(observed)}`);
  const poll = observed => bridgeRequest(store, bridge(observed).id, 'poll', {
    epoch: `epoch-${observed.placement.terminalId}`, conversationId: observed.identity.conversationId,
    terminalId: observed.placement.terminalId, sessionCreatedAt: 123, idle: true,
  }, () => true);
  const dispatch = (observed, runId = 'backend-run') => store.dispatch({ bindingId: bindingId(observed), bindingRevision: 1,
    agentId: observed.agentId, companyId: observed.identity.companyId, taskId: 'task', runId });
  const reconcile = (overrides = {}, client = api) => reconcileBridgeEnrolment(store, directory, client, { ...options, ...overrides });
  const offline = observed => store.saveOperation({ ...store.operation(observed.id), availability: 'offline' });
  const ready = async observed => { poll(observed); await armBridge(store, directory, api, { bindingId: bindingId(observed) }); };
  return { directory, store, options, backends, calls, api, observe, bindingId, bridge, poll, dispatch, reconcile, offline, ready };
}

test('only exact allowlisted directories and scope enrol existing observed registrations', async t => {
  const f = fixture(t);
  const observed = f.observe('current');
  f.observe('different-company', { identity: { companyId: 'other' } });
  f.observe('different-machine', { identity: { machineId: 'other' } });
  f.observe('different-session', { identity: { session: 'other' } });
  f.observe('not-allowed', { placement: { directory: '/work/child', terminalId: 'other' } });
  assert.deepEqual(await f.reconcile({ directories: [] }), []);
  assert.equal(f.calls.length, 0);
  const [result] = await f.reconcile();
  assert.equal(result.state, 'configured');
  assert.equal(result.bindingId, f.bindingId(observed));
  assert.equal(f.store.bindings().length, 1);
  assert.equal(f.store.binding(result.bindingId).config.agentId, observed.agentId);
  assert.equal(f.backends.get(observed.agentId).status, 'paused');
  assert.throws(() => f.dispatch(observed), { code: 'bridge_unavailable' });
});

test('configuration and arming are idempotent and require exact live plugin readiness', async t => {
  const f = fixture(t);
  const observed = f.observe('current');
  const [configured] = await f.reconcile();
  const credential = readFileSync(configured.bridgeConfigFile, 'utf8');
  const original = f.bridge(observed);
  await f.reconcile();
  assert.deepEqual(f.bridge(observed), original);
  assert.equal(readFileSync(configured.bridgeConfigFile, 'utf8'), credential);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  assert.throws(() => bridgeRequest(f.store, original.id, 'poll', { epoch: 'wrong', conversationId: 'another',
    terminalId: observed.placement.terminalId, sessionCreatedAt: 123, idle: true }), { code: 'bridge_identity_mismatch' });
  assert.equal((await f.reconcile())[0].state, 'configured');
  f.poll(observed);
  f.store.saveOperation({ ...f.bridge(observed), ready: false });
  assert.equal((await f.reconcile())[0].state, 'configured');
  f.poll(observed);
  f.store.saveOperation({ ...f.bridge(observed), lastSeen: '2000-01-01T00:00:00Z' });
  assert.equal((await f.reconcile())[0].state, 'configured');
  f.poll(observed);
  assert.equal((await f.reconcile())[0].state, 'armed');
  const armed = f.bridge(observed);
  const patches = f.calls.filter(call => call.method === 'PATCH').length;
  await f.reconcile();
  assert.deepEqual(f.bridge(observed), armed);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, patches);
  f.backends.get(observed.agentId).status = 'paused';
  assert.equal((await f.reconcile())[0].state, 'armed');
  assert.equal(f.backends.get(observed.agentId).status, 'idle');
});

test('a directory grant cannot enrol a replacement conversation after a blocked worker reserves it', async t => {
  const f = fixture(t), old = f.observe('old');
  const config = { ...f.options, socketPath: join(f.directory, 'herdr.sock'), bridgeDirectories: ['/work'] };
  const grant = await enrolAgent(f.store, config, { key: 'standing', directory: '/work', reserved: true },
    { inspectDirectory: async path => ({ canonical: path, linked: false }) });
  await f.reconcile(); await f.ready(old);
  const worker = f.store.saveOperation({ id: 'herdr-worker:later', runId: '', state: 'blocked',
    request: { directory: '/work' }, target: { directory: '/work', observedId: old.id, conversationId: 'old' } });
  f.offline(old);
  const next = f.observe('replacement');
  const previous = f.bridge(old), calls = f.calls.length;
  assert.deepEqual(enrolmentDirectories(f.store, config), []);
  assert.deepEqual(await f.reconcile({ directories: enrolmentDirectories(f.store, config) }), []);
  // A stale caller-supplied allowlist must also fail without relying on the directory helper.
  assert.deepEqual(await f.reconcile(), [{ directory: '/work', state: 'blocked', error: 'worker_directory_reserved' }]);
  assert.equal(f.bridge(next), null);
  assert.equal(f.store.binding(f.bindingId(next), false), null);
  assert.equal(existsSync(join(f.directory, 'bridges', `${f.bindingId(next)}.json`)), false);
  assert.deepEqual(f.bridge(old), previous);
  assert.deepEqual(f.store.operation(worker.id), worker);
  assert.equal(f.store.operation(grant.enrolmentId).state, 'recorded');
  assert.equal(f.calls.length, calls);
});

test('generic enrolment guards worker directories before configuration, arm, refresh and either disarm path', async t => {
  for (const action of ['configure', 'arm', 'refresh', 'replace', 'ambiguous']) {
    for (const field of ['request', 'target']) {
      await t.test(`${action}: ${field}`, async t => {
        const f = fixture(t), old = f.observe('old');
        if (action !== 'configure') {
          await f.reconcile();
          if (action === 'arm') f.poll(old);
          else await f.ready(old);
        }
        if (action === 'refresh') f.observe('old', { placement: { directory: '/work', terminalId: 'replacement' } });
        if (action === 'replace') f.offline(old);
        if (['replace', 'ambiguous'].includes(action)) f.observe('new');
        for (const state of ['intent', 'prepared', 'armed', 'blocked']) {
          const worker = f.store.saveOperation({ id: 'herdr-worker:reserved', runId: '', state, disarmed: true,
            scope: { companyId: 'foreign' }, [field]: { directory: '/work' } });
          const before = f.store.db.prepare('SELECT * FROM operations ORDER BY id').all();
          const bindings = f.store.bindings(), calls = f.calls.length;
          assert.deepEqual(await f.reconcile(), [{ directory: '/work', state: 'blocked', error: 'worker_directory_reserved' }]);
          assert.deepEqual(f.store.db.prepare('SELECT * FROM operations ORDER BY id').all(), before);
          assert.deepEqual(f.store.bindings(), bindings);
          assert.deepEqual(f.store.operation(worker.id), worker);
          assert.equal(f.calls.length, calls);
        }
      });
    }
  }
});

test('worker reservations appearing during backend I/O stop subsequent generic bridge mutations', async t => {
  for (const action of ['configure', 'arm', 'refresh', 'replace', 'ambiguous']) {
    for (const method of action === 'configure' ? ['GET'] : ['GET', 'PATCH']) {
      await t.test(`${action}: ${method}`, async t => {
        const f = fixture(t), old = f.observe('old');
        if (action !== 'configure') {
          await f.reconcile();
          if (action === 'arm') f.poll(old);
          else await f.ready(old);
        }
        if (action === 'refresh') f.observe('old', { placement: { directory: '/work', terminalId: 'replacement' } });
        if (action === 'replace') f.offline(old);
        const next = ['replace', 'ambiguous'].includes(action) ? f.observe('new') : old;
        const path = join(f.directory, 'bridges', `${f.bindingId(old)}.json`);
        const credential = existsSync(path) ? readFileSync(path, 'utf8') : null;
        let before, bindings, calls;
        const client = async (...args) => {
          const response = await f.api(...args);
          if (args[0] === method) {
            f.store.saveOperation({ id: 'herdr-worker:race', runId: '', state: 'blocked', target: { directory: '/work' } });
            before = f.store.db.prepare('SELECT * FROM operations ORDER BY id').all();
            bindings = f.store.bindings();
            calls = f.calls.length;
          }
          return response;
        };
        assert.deepEqual(await f.reconcile({}, client), [{ directory: '/work', state: 'blocked', error: 'worker_directory_reserved' }]);
        assert.ok(before, 'The reservation must appear during backend I/O');
        assert.deepEqual(f.store.db.prepare('SELECT * FROM operations ORDER BY id').all(), before);
        assert.deepEqual(f.store.bindings(), bindings);
        assert.equal(f.calls.length, calls);
        assert.equal(existsSync(path) ? readFileSync(path, 'utf8') : null, credential);
        if (action === 'arm') assert.equal(f.bridge(old).state, 'configured');
        if (['configure', 'replace', 'ambiguous'].includes(action)) assert.equal(f.bridge(next), null);
      });
    }
  }
});

test('fresh chat gets a new binding, disarms old bridges and preserves settled runs without replay', async t => {
  const f = fixture(t);
  const old = f.observe('old');
  await f.reconcile(); await f.ready(old);
  const run = f.dispatch(old);
  f.store.cancel(run.id);
  const history = f.store.run(run.id);
  const binding = f.store.binding(f.bindingId(old));
  f.offline(old);
  const next = f.observe('next');
  const [result] = await f.reconcile();
  assert.equal(result.state, 'configured');
  assert.notEqual(result.bindingId, binding.id);
  assert.equal(f.bridge(old).state, 'configured');
  assert.equal(f.backends.get(old.agentId).status, 'paused');
  assert.equal(f.backends.get(old.agentId).adapterConfig.observationOnly, true);
  assert.deepEqual(f.store.binding(binding.id), binding);
  assert.deepEqual(f.store.run(run.id), history);
  assert.equal(f.store.runs(result.bindingId).length, 0);
  f.poll(next);
  await f.reconcile();
  assert.throws(() => f.dispatch(next), { code: 'dispatch_conflict' }, 'Old backend run cannot be replayed into new chat');
  assert.equal(f.dispatch(next, 'new-backend-run').conversationId, 'next');
});

test('any historical bridge with unsettled work blocks switching, even when configured', async t => {
  const f = fixture(t);
  const old = f.observe('old');
  await f.reconcile(); await f.ready(old);
  const run = f.dispatch(old);
  f.store.saveOperation({ ...f.bridge(old), state: 'configured' });
  f.offline(old);
  const middle = f.observe('middle');
  await configureBridge(f.store, f.directory, f.api, { observedId: middle.id, reserved: true });
  f.offline(middle);
  const next = f.observe('next');
  const before = f.store.run(run.id), calls = f.calls.length;
  assert.equal((await f.reconcile())[0].error, 'work_unsettled');
  assert.equal(f.bridge(next), null);
  assert.equal(f.calls.length, calls);
  assert.deepEqual(f.store.run(run.id), before);
});

test('duplicate live chats and ambiguous, stale or erroneous observations fail closed', async t => {
  const f = fixture(t);
  const first = f.observe('one');
  const second = f.observe('two');
  assert.equal((await f.reconcile())[0].error, 'bridge_candidates_ambiguous');
  assert.equal(f.store.bindings().length, 0);
  f.offline(second);
  f.store.saveOperation({ ...first, availability: 'unknown' });
  assert.equal((await f.reconcile())[0].error, 'agent_not_ready');
  f.store.saveOperation({ ...first, error: 'agent_identity_ambiguous' });
  assert.equal((await f.reconcile())[0].error, 'agent_not_ready');
  f.store.db.prepare('UPDATE operations SET data = ? WHERE id = ?').run(JSON.stringify({ ...first, updatedAt: '2000-01-01T00:00:00Z' }), first.id);
  assert.equal((await f.reconcile())[0].error, 'agent_not_ready');
  assert.equal(f.calls.length, 0);
});

test('terminal refresh rotates credentials and resets readiness without rewriting binding or runs', async t => {
  const f = fixture(t);
  const old = f.observe('current');
  const [configured] = await f.reconcile();
  await f.ready(old);
  const run = f.dispatch(old);
  f.store.cancel(run.id);
  const history = f.store.run(run.id), binding = f.store.binding(f.bindingId(old));
  const credential = JSON.parse(readFileSync(configured.bridgeConfigFile, 'utf8'));
  const next = f.observe('current', { placement: { directory: '/work', terminalId: 'replacement' } });
  const [result] = await f.reconcile();
  assert.equal(result.state, 'configured');
  assert.equal(result.bindingId, configured.bindingId);
  assert.equal(f.bridge(next).epoch, null);
  assert.equal(f.bridge(next).lastSeen, null);
  assert.equal(f.bridge(next).ready, false);
  assert.equal(bridgeForToken(f.store, credential.token), undefined);
  const replacement = JSON.parse(readFileSync(configured.bridgeConfigFile, 'utf8'));
  assert.notEqual(replacement.token, credential.token);
  assert.equal(replacement.terminalId, 'replacement');
  assert.deepEqual(f.store.binding(binding.id), binding);
  assert.deepEqual(f.store.run(run.id), history);
  assert.throws(() => f.poll(old), { code: 'bridge_identity_mismatch' });
  f.poll(next);
  assert.equal((await f.reconcile())[0].state, 'armed');
  assert.equal(f.store.runs(binding.id).length, 1);
});

test('unsettled work blocks terminal refresh before credentials or history change', async t => {
  const f = fixture(t);
  const old = f.observe('current');
  const [configured] = await f.reconcile(); await f.ready(old);
  const run = f.dispatch(old), original = f.bridge(old);
  const credential = readFileSync(configured.bridgeConfigFile, 'utf8');
  f.observe('current', { placement: { directory: '/work', terminalId: 'replacement' } });
  assert.equal((await f.reconcile())[0].error, 'work_unsettled');
  assert.deepEqual(f.bridge(old), original);
  assert.deepEqual(f.store.run(run.id), run);
  assert.equal(readFileSync(configured.bridgeConfigFile, 'utf8'), credential);
});

test('a changed candidate during backend lookup cannot configure an obsolete chat', async t => {
  const f = fixture(t);
  const old = f.observe('old');
  const client = async (...args) => {
    const response = await f.api(...args);
    f.offline(old); f.observe('new');
    return response;
  };
  assert.equal((await f.reconcile({}, client))[0].error, 'agent_not_ready');
  assert.equal(f.store.bindings().length, 0);
  assert.equal(f.bridge(old), null);
});

test('duplicates appearing during lookup prevent configuration, and invalidation prevents arming writes', async t => {
  const f = fixture(t);
  const observed = f.observe('current');
  let other;
  const client = async (...args) => {
    const response = await f.api(...args);
    other = f.observe('duplicate');
    return response;
  };
  assert.equal((await f.reconcile({}, client))[0].error, 'bridge_candidates_ambiguous');
  assert.equal(f.store.bindings().length, 0);
  f.offline(other);
  await f.reconcile(); f.poll(observed);
  let current = true;
  const invalidate = async (...args) => { const response = await f.api(...args); current = false; return response; };
  assert.equal((await f.reconcile({ current: () => current }, invalidate))[0].error, 'bridge_identity_mismatch');
  assert.equal(f.bridge(observed).state, 'configured');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
});

test('delayed arm completion cannot overwrite a concurrent disarm', async t => {
  const f = fixture(t);
  const observed = f.observe('current');
  await f.reconcile(); f.poll(observed);
  const client = async (...args) => {
    const response = await f.api(...args);
    if (args[0] === 'PATCH') await disarmBridge(f.store, f.api, { bindingId: f.bindingId(observed) });
    return response;
  };
  assert.equal((await f.reconcile({}, client))[0].error, 'bridge_conflict');
  assert.equal(f.bridge(observed).state, 'configured');
  assert.equal(f.backends.get(observed.agentId).status, 'paused');
});

test('duplicate candidates disarm an idle existing bridge rather than leaving dispatch enabled', async t => {
  const f = fixture(t);
  const observed = f.observe('current');
  await f.reconcile(); await f.ready(observed);
  f.observe('duplicate');
  assert.equal((await f.reconcile())[0].error, 'bridge_candidates_ambiguous');
  assert.equal(f.bridge(observed).state, 'configured');
  assert.equal(f.backends.get(observed.agentId).status, 'paused');
  assert.throws(() => f.dispatch(observed), { code: 'bridge_unavailable' });
});

test('manual-pull reservations are not implicitly taken over', async t => {
  const f = fixture(t);
  const observed = f.observe('current');
  f.store.saveOperation({ id: `observed-pull:${f.bindingId(observed)}`, runId: '', state: 'active' });
  assert.equal((await f.reconcile())[0].error, 'reservation_conflict');
  assert.equal(f.bridge(observed), null);
});

test('work appearing on a historical bridge during lookup blocks the new binding write', async t => {
  const f = fixture(t);
  const old = f.observe('old');
  await f.reconcile(); await f.ready(old);
  const run = f.dispatch(old);
  f.store.cancel(run.id);
  f.offline(old);
  const next = f.observe('next');
  const client = async (...args) => {
    const response = await f.api(...args);
    if (args[0] === 'GET' && args[1].endsWith(next.agentId)) f.store.save(run, 'test.restore_unsettled');
    return response;
  };
  assert.equal((await f.reconcile({}, client))[0].error, 'work_unsettled');
  assert.equal(f.bridge(next), null);
  assert.equal(f.store.binding(f.bindingId(next), false), null);
});

test('an observation changed during the arm PATCH cannot reopen local dispatch', async t => {
  const f = fixture(t);
  const observed = f.observe('current');
  await f.reconcile(); f.poll(observed);
  const client = async (...args) => {
    const response = await f.api(...args);
    if (args[0] === 'PATCH') {
      f.offline(observed);
      f.observe('replacement');
    }
    return response;
  };
  assert.equal((await f.reconcile({}, client))[0].error, 'agent_not_ready');
  assert.equal(f.bridge(observed).state, 'configured');
  assert.throws(() => f.dispatch(observed), { code: 'bridge_unavailable' });
  assert.equal((await f.reconcile())[0].state, 'configured');
  assert.equal(f.backends.get(observed.agentId).status, 'paused');
});

test('current active work is neither rearmed nor replayed by repeated reconciliation', async t => {
  const f = fixture(t);
  const observed = f.observe('current');
  await f.reconcile(); await f.ready(observed);
  const run = f.dispatch(observed), calls = f.calls.length;
  assert.equal((await f.reconcile())[0].state, 'armed');
  assert.equal(f.calls.length, calls);
  assert.deepEqual(f.store.runs(f.bindingId(observed)), [run]);
});

test('an armed bridge with a stale plugin reports not ready and plugin_unavailable', async t => {
  const f = fixture(t);
  const observed = f.observe('current');
  await f.reconcile(); await f.ready(observed);
  f.store.saveOperation({ ...f.bridge(observed), lastSeen: '2000-01-01T00:00:00Z' });
  assert.equal(f.bridge(observed).ready, true, 'Persisted readiness alone must not imply a live plugin');
  const calls = f.calls.length;
  const [result] = await f.reconcile();
  assert.equal(result.state, 'armed');
  assert.equal(result.ready, false);
  assert.equal(result.blocker, 'plugin_unavailable');
  assert.equal(f.calls.length, calls);
  f.poll(observed);
  const [recovered] = await f.reconcile();
  assert.equal(recovered.state, 'armed');
  assert.equal(recovered.ready, true);
  assert.equal(recovered.blocker, null);
});

test('an armed bridge with a live busy plugin reports not ready and native_busy', async t => {
  const f = fixture(t);
  const observed = f.observe('current');
  await f.reconcile(); await f.ready(observed);
  const bridge = f.bridge(observed);
  bridgeRequest(f.store, bridge.id, 'poll', { epoch: bridge.epoch, conversationId: observed.identity.conversationId,
    terminalId: observed.placement.terminalId, sessionCreatedAt: bridge.sessionCreatedAt, idle: false });
  const calls = f.calls.length;
  const [result] = await f.reconcile();
  assert.equal(result.state, 'armed');
  assert.equal(result.ready, false);
  assert.equal(result.blocker, 'native_busy');
  assert.equal(f.calls.length, calls);
  f.poll(observed);
  const [recovered] = await f.reconcile();
  assert.equal(recovered.state, 'armed');
  assert.equal(recovered.ready, true);
  assert.equal(recovered.blocker, null);
});
