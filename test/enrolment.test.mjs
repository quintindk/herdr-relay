import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { enrolAgent, enrolmentCandidates, enrolmentDirectories } from '../src/enrolment.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'relay-directory-enrolment-'));
  const directory = join(root, 'target');
  mkdirSync(directory);
  let store = new Store(join(root, 'relay.db'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const config = { socketPath: join(root, 'herdr.sock'), companyId: 'company', machineId: 'machine', session: 'session' };
  const observe = (conversationId = 'target-chat', overrides = {}) => {
    const identity = { companyId: config.companyId, machineId: config.machineId, session: config.session,
      harness: 'opencode', sessionKind: 'id', conversationId, ...overrides.identity };
    const id = `herdr-agent:${digest(identity)}`;
    return store.saveOperation({ id, runId: '', agentId: `agent-${conversationId}`, marker: `marker-${conversationId}`,
      state: 'recorded', availability: 'present', placement: { directory, terminalId: `terminal-${conversationId}` },
      observation: { state: 'busy', display: { name: 'Target' } }, ...overrides, identity });
  };
  const target = observe();
  const bindingId = observed => `observed-${digest(observed.id).slice(0, 24)}`;
  const native = (observed = target, overrides = {}) => {
    const binding = store.register({ id: bindingId(observed), companyId: observed.identity.companyId,
      agentId: observed.agentId, harness: 'opencode', instanceId: digest([observed.identity.machineId, observed.identity.session]),
      conversationId: observed.identity.conversationId, delivery: 'pull' }).binding;
    return store.saveOperation({ id: `opencode-bridge:${binding.id}`, runId: '', state: 'configured', tokenHash: digest('secret-token'),
      epoch: 'epoch', sessionCreatedAt: 123, lastSeen: new Date().toISOString(), ready: false,
      identity: { bindingId: binding.id, observedId: observed.id, conversationId: observed.identity.conversationId,
        directory: observed.placement.directory, terminalId: observed.placement.terminalId }, ...overrides });
  };
  const run = (observed = target, overrides = {}) => {
    const id = `run-${observed.identity.conversationId}`;
    const value = { id, request: { bindingId: bindingId(observed) }, nativeState: 'unclaimed', ...overrides };
    store.db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?)').run(id, id, bindingId(observed), value.nativeState === 'settled' ? 0 : 1, JSON.stringify(value));
    return value;
  };
  const snapshot = () => JSON.stringify(['operations', 'bindings', 'runs', 'events', 'settings']
    .map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const input = { key: 'enrol-one', directory, reserved: true };
  const source = { id: 'human-one', text: 'Reserve this exact directory for Relay.', createdAt: 456, role: 'user' };
  const deps = { inspectDirectory: async path => ({ canonical: path, linked: false }) };
  return { root, directory, config, input, source, deps, target, observe, native, run, bindingId, snapshot,
    get store() { return store; }, reopen() { store.close(); store = new Store(join(root, 'relay.db')); },
    enrol(overrides = {}, options = {}) { return enrolAgent(store, config, { ...input, ...overrides }, { ...deps, ...options }); },
    async refuses(overrides, code, options = {}) {
      const before = snapshot();
      await assert.rejects(this.enrol(overrides, options), code ? { code } : undefined);
      assert.equal(snapshot(), before, 'Rejected enrolment must not write any state');
    },
    stale(observed, at = '2000-01-01T00:00:00Z') {
      store.db.prepare('UPDATE operations SET data = ? WHERE id = ?').run(JSON.stringify({ ...observed, updatedAt: at }), observed.id);
    } };
}

test('operator exact-folder enrolment persists only a standing reservation without configuration mutation', async t => {
  const f = fixture(t), before = structuredClone(f.config);
  const result = await f.enrol();
  assert.equal(result.state, 'requested');
  assert.equal(result.ready, false);
  assert.equal(result.status, null);
  assert.equal(result.directory, f.directory);
  assert.equal(result.observedId, f.target.id);
  assert.equal(result.alreadyConfigured, false);
  assert.deepEqual(f.config, before);
  assert.deepEqual(enrolmentDirectories(f.store, f.config), [f.directory]);
  assert.equal(f.store.bindings().length, 0);
  assert.equal(f.store.runs().length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM operations').get().count, 2);
  const operation = f.store.operation(result.enrolmentId);
  assert.equal(operation.state, 'recorded');
  assert.deepEqual(operation.scope, f.config);
  assert.deepEqual(operation.request, f.input);
  assert.deepEqual(operation.origin, { kind: 'operator' });
});

test('effective directories are deduplicated exact paths and grants survive a store restart only in their full scope', async t => {
  const f = fixture(t);
  const grant = await f.enrol();
  f.config.bridgeDirectories = ['/explicit', '*', '/broad/*', '/not/../canonical', '/explicit'];
  const before = structuredClone(f.config);
  f.reopen();
  assert.deepEqual(enrolmentDirectories(f.store, f.config), ['/explicit', f.directory]);
  assert.deepEqual(f.config, before);
  for (const key of ['socketPath', 'companyId', 'machineId', 'session']) {
    const config = { ...f.config, [key]: key === 'socketPath' ? '/other.sock' : 'foreign' };
    assert.deepEqual(enrolmentDirectories(f.store, config), ['/explicit'], key);
  }
  f.store.saveOperation({ ...f.store.operation(grant.enrolmentId), state: 'blocked' });
  assert.deepEqual(enrolmentDirectories(f.store, f.config), ['/explicit']);
});

test('unchanged retries retain the original optional observed ID payload without inspection, reselection or writes', async t => {
  const f = fixture(t);
  const first = await f.enrol();
  f.store.saveOperation({ ...f.target, availability: 'offline' });
  f.observe('new-chat');
  f.reopen();
  const before = f.snapshot();
  const retry = await f.enrol({}, { inspectDirectory: async () => assert.fail('A recorded retry cannot inspect or reselect') });
  assert.deepEqual(retry, first);
  assert.equal(f.snapshot(), before);
  await f.refuses({ observedId: f.target.id }, 'enrolment_conflict');
  await f.refuses({ directory: '/different' }, 'enrolment_conflict');
  const pinned = await f.enrol({ key: 'pinned', observedId: f.observe('new-chat').id });
  await f.refuses({ key: 'pinned' }, 'enrolment_conflict');
  assert.equal(f.store.operation(pinned.enrolmentId).request.observedId, pinned.observedId);
});

test('later worker reservations exclude persisted and configured directory grants regardless of state or scope', async t => {
  for (const field of ['request', 'target']) {
    const f = fixture(t);
    const grant = await f.enrol();
    f.config.bridgeDirectories = [f.directory, '/unreserved', `${f.directory}/child`];
    for (const state of ['intent', 'prepared', 'armed', 'blocked']) {
      const worker = f.store.saveOperation({ id: 'herdr-worker:later', runId: '', state, disarmed: true,
        scope: { companyId: 'foreign', machineId: 'foreign', session: 'foreign' }, [field]: { directory: f.directory } });
      f.reopen();
      assert.deepEqual(enrolmentDirectories(f.store, f.config), ['/unreserved', `${f.directory}/child`]);
      assert.equal(enrolmentCandidates(f.store, f.config)[0].enrolled, false);
      assert.equal(f.store.operation(grant.enrolmentId).state, 'recorded');
      assert.deepEqual(f.store.operation(worker.id), worker);
      assert.deepEqual(f.config.bridgeDirectories, [f.directory, '/unreserved', `${f.directory}/child`]);
    }
  }
});

test('already configured directories still record explicit requests and never imply readiness', async t => {
  const f = fixture(t);
  f.config.bridgeDirectories = [f.directory];
  const result = await f.enrol();
  assert.equal(result.alreadyConfigured, true);
  assert.equal(result.state, 'requested');
  assert.equal(result.ready, false);
  assert.ok(f.store.operation(result.enrolmentId));
  assert.deepEqual(enrolmentDirectories(f.store, f.config), [f.directory]);
});

test('candidates are recent present same-scope OpenCode observations with sanitised fields and scoped status only', async t => {
  const f = fixture(t);
  f.observe('target-chat', { observation: { state: 'busy\nnow', display: { name: '\u001b[31mTarget\u001b[0m\nagent' } }, token: 'never-show' });
  for (const key of ['companyId', 'machineId', 'session', 'harness', 'sessionKind']) f.observe(`foreign-${key}`, { identity: { [key]: 'foreign' } });
  f.observe('offline', { availability: 'offline' });
  f.observe('unknown', { availability: 'unknown' });
  f.stale(f.observe('stale'));
  f.stale(f.observe('future'), new Date(Date.now() + 60000).toISOString());
  f.observe('invalid-path', { placement: { directory: '*', terminalId: 'invalid' } });
  f.config.bridgeDirectories = [f.directory];
  f.store.saveOperation({ id: 'bridge-enrolment', runId: '', results: [{ directory: f.directory, state: 'blocked', error: 'work_unsettled', token: 'never-show' }] });
  assert.deepEqual(enrolmentCandidates(f.store, f.config), [{ observedId: f.target.id, directory: f.directory,
    label: 'Target agent', availability: 'present', state: 'busy now', enrolled: true, status: 'blocked', blocker: 'work_unsettled', ready: false }]);
  f.store.saveOperation({ id: 'bridge-enrolment', runId: '', scope: { ...f.config, companyId: 'foreign' },
    results: [{ directory: f.directory, state: 'armed', ready: true }] });
  assert.equal(enrolmentCandidates(f.store, f.config)[0].status, null);
  assert.ok(!JSON.stringify(enrolmentCandidates(f.store, f.config)).includes('never-show'));
});

test('current bridge reconciliation status is reflected on retries without reservation writes', async t => {
  const f = fixture(t);
  const first = await f.enrol();
  const bridge = f.native(f.target, { state: 'armed', ready: true });
  f.store.saveOperation({ id: 'bridge-enrolment', runId: '', results: [{ directory: f.directory,
    bindingId: f.bindingId(f.target), state: 'armed', ready: true, blocker: null }] });
  const before = f.snapshot();
  const retry = await f.enrol();
  assert.equal(retry.enrolmentId, first.enrolmentId);
  assert.equal(retry.state, 'requested');
  assert.equal(retry.status, 'armed');
  assert.equal(retry.ready, true);
  assert.equal(f.snapshot(), before);
  f.store.saveOperation({ ...bridge, lastSeen: '2000-01-01T00:00:00Z' });
  assert.equal((await f.enrol()).ready, false);
  f.store.saveOperation(bridge);
  f.store.saveOperation({ ...f.target, availability: 'offline' });
  assert.equal((await f.enrol()).ready, false);
});

test('invalid payloads and company mismatches never write or inspect a directory', async t => {
  const f = fixture(t), options = { inspectDirectory: async () => assert.fail('Invalid input must fail before I/O') };
  for (const overrides of [{ reserved: false }, { reserved: undefined }, { key: '' }, { key: 'line\nbreak' },
    { directory: '*' }, { directory: '/work/*' }, { directory: 'relative' }, { directory: `${f.directory}/` },
    { directory: `${f.directory}/../target` }, { directory: '/work\nname' }, { observedId: '' },
    { companyId: 'other' }, { source: f.source }, { command: 'arbitrary' }, { origin: {} }]) {
    await f.refuses(overrides, undefined, options);
  }
  await assert.rejects(enrolAgent(f.store, null, f.input), { code: 'invalid_request' });
});

test('observation selection refuses duplicates including unknown, stale, foreign, erroneous and mismatched IDs', async t => {
  const f = fixture(t);
  const other = f.observe('other');
  await f.refuses({}, 'bridge_candidates_ambiguous');
  await f.refuses({ observedId: f.target.id }, 'bridge_candidates_ambiguous');
  f.store.saveOperation({ ...other, availability: 'unknown' });
  await f.refuses({}, 'bridge_candidates_ambiguous');
  f.store.saveOperation({ ...other, availability: 'offline' });
  await f.refuses({ observedId: other.id }, 'enrolment_observation_mismatch');
  const foreign = f.observe('foreign', { identity: { companyId: 'other' } });
  await f.refuses({ observedId: foreign.id }, 'enrolment_observation_mismatch');
  for (const overrides of [{ availability: 'unknown' }, { availability: 'offline' }, { error: 'agent_identity_ambiguous' }, { agentId: null }]) {
    f.store.saveOperation({ ...f.target, ...overrides });
    await f.refuses({}, 'agent_not_ready');
  }
  f.stale(f.target);
  await f.refuses({}, 'agent_not_ready');
  f.stale(f.target, new Date(Date.now() + 60000).toISOString());
  await f.refuses({}, 'agent_not_ready');
  f.store.saveOperation(f.target);
  assert.equal((await f.enrol()).observedId, f.target.id);
});

test('worker records reserve the directory regardless of scope, blocked state or disarm', async t => {
  const f = fixture(t);
  for (const state of ['intent', 'prepared', 'armed', 'blocked']) {
    f.store.saveOperation({ id: 'herdr-worker:existing', runId: '', scope: { companyId: 'foreign' }, state,
      disarmed: true, request: { directory: f.directory } });
    await f.refuses({}, 'worker_directory_reserved');
  }
});

test('linked worktrees and canonical aliases are refused without a grant', async t => {
  const f = fixture(t);
  await f.refuses({}, 'linked_worktree_forbidden', { inspectDirectory: async path => ({ canonical: path, linked: true }) });
  await f.refuses({}, 'invalid_directory', { inspectDirectory: async () => ({ canonical: '/other', linked: false }) });
  await f.refuses({}, 'invalid_directory', { inspectDirectory: async path => ({ canonical: path }) });
  const alias = join(f.root, 'alias');
  symlinkSync(f.directory, alias);
  f.store.saveOperation({ ...f.target, placement: { ...f.target.placement, directory: alias } });
  await f.refuses({ directory: alias }, 'invalid_directory', { inspectDirectory: undefined });
  const parentAlias = join(f.root, 'parent-alias');
  symlinkSync(f.root, parentAlias);
  const nestedAlias = join(parentAlias, 'target');
  f.store.saveOperation({ ...f.target, placement: { ...f.target.placement, directory: nestedAlias } });
  await f.refuses({ directory: nestedAlias }, 'invalid_directory', { inspectDirectory: undefined });
});

test('real inspection permits a non-Git folder and ordinary Git root, rejects broken Git metadata, files and missing paths', async t => {
  const f = fixture(t);
  assert.equal((await f.enrol({}, { inspectDirectory: undefined })).state, 'requested');
  execFileSync('git', ['init', '--quiet', f.directory], { stdio: 'pipe' });
  assert.equal((await f.enrol({ key: 'git-root' }, { inspectDirectory: undefined })).state, 'requested');
  const broken = join(f.root, 'broken');
  mkdirSync(broken);
  writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent/relay-test-git\n');
  for (const path of [broken, join(f.root, 'file'), join(f.root, 'missing')]) {
    if (path.endsWith('/file')) writeFileSync(path, 'not a directory');
    f.store.saveOperation({ ...f.target, placement: { ...f.target.placement, directory: path } });
    await f.refuses({ key: path, directory: path }, path === broken ? 'directory_inspection_failed' : undefined,
      { inspectDirectory: undefined });
  }
});

test('real Git common-dir identity rejects linked worktree metadata without executing any Git writes in enrolment', async t => {
  const f = fixture(t), main = join(f.root, 'main');
  execFileSync('git', ['init', '--quiet', main], { stdio: 'pipe' });
  const metadata = join(main, '.git', 'worktrees', 'linked');
  mkdirSync(metadata, { recursive: true });
  writeFileSync(join(metadata, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(metadata, 'commondir'), '../..\n');
  writeFileSync(join(metadata, 'gitdir'), `${join(f.directory, '.git')}\n`);
  writeFileSync(join(f.directory, '.git'), `gitdir: ${metadata}\n`);
  await f.refuses({}, 'linked_worktree_forbidden', { inspectDirectory: undefined });
});

test('unsettled current or historical bridges cannot be overridden, even if configured or no longer the newest bridge', async t => {
  const f = fixture(t);
  const old = f.observe('old'), middle = f.observe('middle');
  f.native(old); f.native(middle);
  f.store.saveOperation({ ...old, availability: 'offline' });
  f.store.saveOperation({ ...middle, availability: 'offline' });
  const oldRun = f.run(old);
  await f.refuses({}, 'work_unsettled');
  f.store.save({ ...oldRun, nativeState: 'settled' }, 'test.settle');
  f.run();
  await f.refuses({}, 'work_unsettled');
});

test('active manual pull reservations block new grants even when their nominal expiry passed', async t => {
  const f = fixture(t);
  f.store.saveOperation({ id: `observed-pull:${f.bindingId(f.target)}`, runId: '', state: 'active', expiresAt: '2000-01-01T00:00:00Z' });
  await f.refuses({}, 'reservation_conflict');
  f.store.saveOperation({ id: `observed-pull:${f.bindingId(f.target)}`, runId: '', state: 'closed' });
  assert.equal((await f.enrol()).state, 'requested');
});

test('a configured busy caller can enrol its own busy target using explicit native human input', async t => {
  const f = fixture(t), bridge = f.native();
  const result = await f.enrol({ source: f.source }, { bridge });
  assert.equal(result.state, 'requested');
  assert.equal(result.ready, false);
  assert.deepEqual(f.store.operation(bridge.id), bridge);
  const operation = f.store.operation(result.enrolmentId);
  assert.equal(operation.origin.sourceDigest, digest(f.source.text));
  assert.equal(operation.origin.sourceMessageId, f.source.id);
  assert.ok(!JSON.stringify(operation).includes(f.source.text));
  assert.ok(!JSON.stringify(operation).includes(bridge.tokenHash));
  f.reopen();
  const before = f.snapshot();
  assert.deepEqual(await f.enrol({ source: f.source }, { bridge }), result);
  assert.equal(f.snapshot(), before);
  await f.refuses({ source: { ...f.source, text: 'Different human request' } }, 'enrolment_conflict', { bridge });
  await f.refuses({ source: { ...f.source, id: 'another-message' } }, 'enrolment_conflict', { bridge });
});

test('native enrolment rejects missing, synthetic, ignored, non-user and out-of-conversation source messages', async t => {
  const f = fixture(t), bridge = f.native();
  for (const source of [undefined, null, {}, { ...f.source, id: '' }, { ...f.source, text: '' },
    { ...f.source, synthetic: true }, { ...f.source, ignored: true }, { ...f.source, role: 'assistant' },
    { ...f.source, createdAt: 122 }, { ...f.source, createdAt: Date.now() + 60000 }]) {
    await f.refuses({ source }, 'invalid_enrolment_source', { bridge });
  }
});

test('native authority rejects invocation IDs from any run, prior prompt history and notification sources', async t => {
  const f = fixture(t), bridge = f.native();
  const other = f.observe('elsewhere', { placement: { directory: '/elsewhere', terminalId: 'elsewhere' } });
  f.run(other, { nativeState: 'settled', invocation: { messageId: f.source.id } });
  await f.refuses({ source: f.source }, 'invalid_enrolment_source', { bridge });
  f.run(f.target, { nativeState: 'settled', invocation: { messageId: 'own-invocation', priorUserIds: ['prior-source'] } });
  await f.refuses({ source: { ...f.source, id: 'prior-source' } }, 'invalid_enrolment_source', { bridge });
  for (const prefix of ['completion-notification', 'review-notification']) {
    const messageId = `${prefix}-source`;
    f.store.saveOperation({ id: `${prefix}:one`, runId: '', state: 'uncertain', messageId,
      origin: { bindingId: bridge.identity.bindingId, conversationId: bridge.identity.conversationId, sessionCreatedAt: bridge.sessionCreatedAt } });
    await f.refuses({ source: { ...f.source, id: messageId } }, 'invalid_enrolment_source', { bridge });
  }
});

test('native caller scope, current epoch, conversation creation, placement, binding and poll must remain exact', async t => {
  const f = fixture(t), bridge = f.native();
  for (const overrides of [{ epoch: 'other' }, { tokenHash: 'other' }, { sessionCreatedAt: 124 },
    { controlRevision: 1 }, { identity: { ...bridge.identity, conversationId: 'other' } }]) {
    await f.refuses({ source: f.source }, 'bridge_identity_mismatch', { bridge: { ...bridge, ...overrides } });
  }
  for (const overrides of [{ lastSeen: '2000-01-01T00:00:00Z' }, { lastSeen: new Date(Date.now() + 60000).toISOString() },
    { state: 'blocked' }, { sessionCreatedAt: 0 }, { epoch: null }]) {
    const invalid = f.store.saveOperation({ ...bridge, ...overrides });
    await f.refuses({ source: f.source }, 'bridge_identity_mismatch', { bridge: invalid });
  }
  f.store.saveOperation(bridge);
  const binding = f.store.binding(bridge.identity.bindingId);
  for (const config of [{ ...binding.config, companyId: 'other' }, { ...binding.config, conversationId: 'other' },
    { ...binding.config, instanceId: 'other' }, { ...binding.config, agentId: 'other' }, { ...binding.config, delivery: 'opencode' }]) {
    f.store.db.prepare('UPDATE bindings SET data = ? WHERE id = ?').run(JSON.stringify({ ...binding, config }), binding.id);
    await f.refuses({ source: f.source }, 'bridge_identity_mismatch', { bridge });
  }
  f.store.db.prepare('UPDATE bindings SET data = ? WHERE id = ?').run(JSON.stringify(binding), binding.id);
  f.run();
  await f.refuses({ source: f.source }, 'conversation_busy', { bridge });
});

test('directory inspection races revalidate target, scope, workers, unsettled work and human source before writing', async t => {
  for (const kind of ['target', 'scope', 'worker', 'run', 'source']) {
    const f = fixture(t), bridge = f.native();
    let afterMutation;
    const source = { ...f.source };
    await assert.rejects(f.enrol({ source }, { bridge, inspectDirectory: async path => {
      if (kind === 'target') f.observe('another');
      if (kind === 'scope') f.config.socketPath = '/other.sock';
      if (kind === 'worker') f.store.saveOperation({ id: 'herdr-worker:race', runId: '', state: 'blocked', request: { directory: path } });
      if (kind === 'run') f.run();
      if (kind === 'source') source.text = 'Changed source';
      afterMutation = f.snapshot();
      return { canonical: path, linked: false };
    } }));
    assert.equal(f.snapshot(), afterMutation, kind);
    assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM operations WHERE id LIKE 'directory-enrolment:%'").get().count, 0);
  }
});

test('concurrent same-key requests record once and reject a changed payload rather than overwrite it', async t => {
  const f = fixture(t);
  const before = f.store.db.prepare('SELECT total_changes() AS count').get().count;
  const [first, second] = await Promise.all([f.enrol(), f.enrol()]);
  assert.deepEqual(second, first);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS count').get().count, before + 1);
  await f.refuses({ observedId: f.target.id }, 'enrolment_conflict');
});
