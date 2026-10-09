import './git-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { bridgeRequest } from '../src/opencode-bridge.mjs';
import { prepareHerdrWorker, inspectHerdrWorkers, reconcileHerdrWorkers } from '../src/herdr-workers.mjs';

function fixture(t, real = false) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-workers-'));
  let store = new Store(join(directory, 'relay.db'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const repository = join(directory, 'repository'), root = join(directory, 'workers'), adopted = join(root, 'existing');
  mkdirSync(repository); mkdirSync(root);
  writeFileSync(join(directory, 'admin-token'), 'secret-admin');
  const runGit = (path, args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (real) {
    runGit(repository, ['init', '-b', 'main']);
    writeFileSync(join(repository, 'tracked.txt'), 'original\n');
    runGit(repository, ['add', 'tracked.txt']); runGit(repository, ['commit', '-m', 'fixture']);
    runGit(repository, ['worktree', 'add', '-b', 'adopted', adopted]);
    writeFileSync(join(adopted, 'tracked.txt'), 'uncommitted human changes\n');
    writeFileSync(join(adopted, 'untracked.txt'), 'keep this too\n');
  }
  const config = { socketPath: join(directory, 'herdr.sock'), companyId: 'company', machineId: 'machine', session: 'session',
    workerRepositories: [{ repository, worktreeRoot: root }] };
  const backends = new Map(), apiCalls = [], rpcCalls = [];
  const observe = (conversationId, path, prefix) => {
    const identity = { companyId: config.companyId, machineId: config.machineId, session: config.session,
      harness: 'opencode', sessionKind: 'id', conversationId };
    const id = `herdr-agent:${digest(identity)}`, agentId = `backend-${prefix}`, marker = `marker-${prefix}`;
    backends.set(agentId, { id: agentId, companyId: config.companyId, status: 'paused', adapterType: 'herdr_relay',
      adapterConfig: { observationOnly: true, relayObservationMarker: marker } });
    return store.saveOperation({ id, runId: '', identity, agentId, marker, state: 'recorded', availability: 'present',
      placement: { directory: path, paneId: `${prefix}:p`, terminalId: `${prefix}:terminal`, workspaceId: prefix, tabId: `${prefix}:tab` },
      observation: { display: { name: prefix } } });
  };
  const native = observed => ({ agent: 'opencode', agent_session: { agent: 'opencode', kind: 'id', value: observed.identity.conversationId },
    cwd: observed.placement.directory, foreground_cwd: observed.placement.directory, pane_id: observed.placement.paneId,
    terminal_id: observed.placement.terminalId, workspace_id: observed.placement.workspaceId, tab_id: observed.placement.tabId,
    agent_status: 'idle', name: 'existing' });
  const origin = observe('origin-chat', repository, 'origin'), worker = observe('worker-chat', adopted, 'worker');
  const binding = store.register({ id: 'origin-binding', companyId: config.companyId, agentId: origin.agentId, harness: 'opencode',
    instanceId: digest([config.machineId, config.session]), conversationId: origin.identity.conversationId, delivery: 'pull' }).binding;
  const bridge = store.saveOperation({ id: `opencode-bridge:${binding.id}`, runId: '', state: 'armed', tokenHash: digest('secret-origin'),
    epoch: 'epoch-origin', sessionCreatedAt: 123, lastSeen: new Date().toISOString(), ready: false,
    identity: { bindingId: binding.id, observedId: origin.id, conversationId: origin.identity.conversationId,
      directory: repository, terminalId: origin.placement.terminalId } });
  let createdPath, createdBranch, started = false, snapshotAgents = [native(origin), native(worker)];
  const commit = real ? runGit(repository, ['rev-parse', 'HEAD']).trim() : 'a'.repeat(40);
  const shell = () => ({ pane_id: 'new:p', terminal_id: 'new:terminal', workspace_id: 'new', tab_id: 'new:tab', cwd: createdPath, agent: null });
  const rpc = async (socket, method, params) => {
    assert.equal(socket, config.socketPath);
    rpcCalls.push({ method, params });
    if (method === 'session.snapshot') return { snapshot: { protocol: 22, version: 'test', tabs: [], workspaces: [], layouts: [],
      agents: snapshotAgents, panes: createdPath ? [shell()] : [] } };
    if (method === 'worktree.create') {
      assert.equal(store.db.prepare("SELECT data FROM operations WHERE id LIKE 'herdr-worker:%'").all().map(row => JSON.parse(row.data))
        .find(item => item.request.directory === params.path).state, 'uncertain');
      createdPath = params.path; createdBranch = params.branch;
      if (real) runGit(params.cwd, ['worktree', 'add', '-b', params.branch, params.path, params.base]);
      return { type: 'worktree_created', root_pane: shell(), workspace: { workspace_id: 'new' }, tab: { tab_id: 'new:tab' },
        worktree: { path: createdPath, branch: createdBranch, is_linked_worktree: true, is_bare: false, is_prunable: false, is_detached: false } };
    }
    if (method === 'workspace.create') {
      createdPath = params.cwd;
      return { type: 'workspace_created', workspace: { workspace_id: 'new', active_tab_id: 'new:tab' } };
    }
    assert.equal(method, 'agent.start');
    const op = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'herdr-worker:%'").all().map(row => JSON.parse(row.data))
      .find(item => item.request.directory === createdPath);
    assert.equal(op.state, 'uncertain'); assert.equal(op.step, 'agent.start');
    started = true;
    const agent = { ...shell(), name: params.name, agent: 'opencode', agent_session: { agent: 'opencode', kind: 'id', value: 'created-chat' } };
    snapshotAgents.push(agent);
    return { type: 'agent_started', agent: { ...agent, agent: null, agent_session: null, launch_pending: true },
      argv: ['secret-never-persist-this'] };
  };
  const mockGit = async (path, args) => {
    if (args[0] === 'check-ref-format') { assert.match(args[1], /^refs\/heads\//); return ''; }
    if (args[0] === 'for-each-ref') return 'refs/heads/main\n';
    if (args[0] === 'worktree') return `worktree ${createdPath ?? adopted}\0HEAD ${commit}\0branch refs/heads/${createdBranch ?? 'adopted'}\0\0`;
    if (args.includes('--show-toplevel')) return path;
    if (args.includes('--git-common-dir')) return join(repository, '.git');
    if (args.includes('--absolute-git-dir')) return join(repository, '.git/worktrees', path === adopted ? 'adopted' : 'created');
    assert.equal(args[0], 'rev-parse'); return commit;
  };
  const deps = real ? { rpc } : { rpc, git: mockGit, realpath: async path => path,
    lstat: async path => {
      if (path === root) return { isDirectory: () => true };
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    } };
  const input = { key: 'one', mode: 'create', repository, branch: 'feature/worker', base: 'main',
    source: { id: 'human-1', text: 'Prepare a worker in this repository.', createdAt: 456 } };
  const adoptInput = { ...input, mode: 'adopt', branch: 'adopted', base: undefined, directory: adopted, observedId: worker.id };
  const api = async (method, path, body) => {
    apiCalls.push({ method, path, body });
    assert.ok(['GET', 'PATCH'].includes(method));
    const backend = backends.get(path.split('/').at(-1));
    assert.ok(backend);
    if (method === 'PATCH') Object.assign(backend, body);
    return structuredClone(backend);
  };
  return { directory, repository, root, adopted, config, bridge, binding, origin, worker, deps, input, adoptInput, api, apiCalls,
    rpcCalls, observe, native, commit, runGit, get started() { return started; }, get store() { return store; },
    reopen() { store.close(); store = new Store(join(directory, 'relay.db')); },
    prepare(inputOverride = {}, depsOverride = {}) { return prepareHerdrWorker(store, store.operation(bridge.id), { ...input, ...inputOverride }, config, { ...deps, ...depsOverride }); },
    reconcile(depsOverride = {}, locks = new Map()) { return reconcileHerdrWorkers(store, directory, api, config, locks, { ...deps, ...depsOverride }); },
    inspect() { return inspectHerdrWorkers(store, store.operation(bridge.id), config, deps); },
    async create(inputOverride = {}, depsOverride = {}) {
      await this.prepare(inputOverride);
      return (await this.reconcile(depsOverride))[0];
    },
    setAgents(agents) { snapshotAgents = agents; } };
}

test('create journals before each RPC, pins the base, launches only fixed interactive build standby and returns no secrets', async t => {
  const f = fixture(t);
  const intent = await f.prepare();
  assert.equal(intent.state, 'intent'); assert.equal(f.started, false);
  assert.deepEqual(f.rpcCalls.map(call => call.method), ['session.snapshot']);
  const [result] = await f.reconcile();
  assert.equal(result.state, 'awaiting_native'); assert.equal(f.started, true);
  const create = f.rpcCalls.find(call => call.method === 'worktree.create').params;
  assert.equal(create.base, f.commit); assert.equal(create.cwd, f.repository); assert.equal(create.focus, false);
  assert.equal(create.trust_repository, false); assert.ok(create.path.startsWith(`${f.root}/relay-worker-`));
  const start = f.rpcCalls.find(call => call.method === 'agent.start').params;
  assert.equal(start.kind, 'opencode'); assert.equal(start.pane_id, 'new:p');
  assert.deepEqual(start.args.slice(0, 3), ['--agent', 'build', '--prompt']);
  assert.match(start.args[3], /Stand by/); assert.equal(start.args.length, 4);
  assert.equal(f.apiCalls.length, 0); assert.equal(f.store.bindings().length, 1);
  const before = f.store.operation(result.id), calls = f.rpcCalls.length;
  assert.deepEqual(await f.prepare(), result); assert.equal(f.rpcCalls.length, calls);
  assert.deepEqual(f.store.operation(result.id), before);
  assert.ok(!JSON.stringify(before).includes('secret-'));
  const visible = await f.inspect();
  assert.equal(visible.workers.length, 1); assert.ok(!JSON.stringify(visible).includes('sourceDigest'));
  assert.deepEqual(f.store.operation(result.id), before);
  assert.ok(f.rpcCalls.slice(calls).every(call => call.method === 'session.snapshot'));
});

test('absent, unknown and duplicate exact repository allowlists refuse without RPC or journal', async t => {
  const f = fixture(t);
  for (const list of [undefined, [], [{ repository: `${f.repository}/child`, worktreeRoot: f.root }],
    [f.config.workerRepositories[0], f.config.workerRepositories[0]]]) {
    f.config.workerRepositories = list;
    await assert.rejects(f.prepare(), { code: 'worker_repository_forbidden' });
  }
  assert.equal(f.rpcCalls.length, 0);
  assert.deepEqual(await f.inspect(), { workers: [], candidates: [] });
});

test('localUser creates a plain workspace in an exact local directory and launches through Herdr', async t => {
  const f = fixture(t, true), directory = join(f.directory, 'lab-1');
  f.config.workerProvisioning = { mode: 'localUser', maxActiveWorkers: 10 };
  delete f.config.workerRepositories;
  const input = { repository: undefined, branch: undefined, base: undefined, directory };
  const intent = await f.prepare(input);
  assert.equal(intent.state, 'intent'); assert.equal(intent.repository, null); assert.equal(intent.directory, directory);
  const [result] = await f.reconcile();
  assert.deepEqual(f.rpcCalls.map(call => call.method), [
    'session.snapshot', 'session.snapshot', 'workspace.create', 'session.snapshot', 'session.snapshot', 'agent.start'
  ]);
  assert.equal(result.blocker, null); assert.equal(result.state, 'awaiting_native'); assert.equal(f.started, true);
  assert.deepEqual(f.rpcCalls.find(call => call.method === 'workspace.create').params,
    { cwd: directory, label: 'Relay lab-1', focus: false });
  assert.equal(f.rpcCalls.some(call => call.method === 'worktree.create'), false);
  assert.equal(f.runGit(f.repository, ['status', '--short']).trim(), '');
});

test('localUser creates and verifies a linked worktree without a configured root', async t => {
  const f = fixture(t, true), directory = join(f.directory, 'local-worktree');
  f.config.workerProvisioning = { mode: 'localUser' }; delete f.config.workerRepositories;
  const result = await f.create({ directory });
  assert.equal(result.state, 'awaiting_native'); assert.equal(result.directory, directory);
  assert.equal(f.runGit(directory, ['rev-parse', '--show-toplevel']).trim(), directory);
  assert.equal(f.rpcCalls.filter(call => call.method === 'worktree.create').length, 1);
  assert.equal(f.rpcCalls.filter(call => call.method === 'agent.start').length, 1);
});

test('uncertain worktree creation recovers from exact Git and Herdr state without replay', async t => {
  const f = fixture(t, true), directory = join(f.directory, 'recovered-worktree');
  f.config.workerProvisioning = { mode: 'localUser' }; delete f.config.workerRepositories;
  const intent = await f.prepare({ directory });
  const operation = f.store.operation(intent.id);
  f.runGit(f.repository, ['worktree', 'add', '-b', operation.request.branch, directory, operation.request.baseCommit]);
  f.store.saveOperation({ ...operation, state: 'uncertain', step: 'worktree.create', blocker: 'manual_recovery_required' });
  const pane = { pane_id: 'recovered:p', terminal_id: 'recovered:terminal', workspace_id: 'recovered',
    tab_id: 'recovered:tab', cwd: directory, agent: null };
  const snapshot = { protocol: 22, version: 'test', layouts: [], agents: [f.native(f.origin)], panes: [pane],
    tabs: [{ tab_id: pane.tab_id, workspace_id: pane.workspace_id }], workspaces: [{ workspace_id: pane.workspace_id,
      active_tab_id: pane.tab_id, label: `Relay ${operation.request.branch}`,
      worktree: { checkout_path: directory, is_linked_worktree: true, repo_root: f.repository } }] };
  const calls = f.rpcCalls.length;
  const [recovered] = await f.reconcile({ rpc: async () => ({ snapshot }) });
  assert.equal(recovered.state, 'created'); assert.equal(recovered.step, null); assert.equal(recovered.blocker, null);
  assert.deepEqual(f.store.operation(intent.id).createReceipt, { directory, paneId: pane.pane_id,
    terminalId: pane.terminal_id, workspaceId: pane.workspace_id, tabId: pane.tab_id });
  assert.equal(f.rpcCalls.length, calls, 'Recovery must not replay worktree.create');
});

test('successful worktree receipt remains durable when its mutation outlasts origin freshness', async t => {
  const f = fixture(t);
  const result = await f.create({}, { rpc: async (...args) => {
    const response = await f.deps.rpc(...args);
    if (args[1] === 'worktree.create') f.store.saveOperation({ ...f.bridge, lastSeen: '2000-01-01T00:00:00Z' });
    return response;
  } });
  assert.equal(result.state, 'created'); assert.equal(result.step, null); assert.equal(result.blocker, 'enrolment_blocked');
  assert.equal(f.rpcCalls.filter(call => call.method === 'worktree.create').length, 1);
  assert.equal(f.rpcCalls.filter(call => call.method === 'agent.start').length, 0);
});

test('localUser allows cross-repository worktrees and generic adoption without repository authority', async t => {
  const f = fixture(t, true), foreign = join(f.directory, 'foreign'), directory = join(f.directory, 'foreign-worker');
  mkdirSync(foreign); f.runGit(foreign, ['init', '-b', 'main']);
  f.runGit(foreign, ['commit', '--allow-empty', '-m', 'foreign']);
  f.config.workerProvisioning = { mode: 'localUser' }; delete f.config.workerRepositories;
  const created = await f.prepare({ repository: foreign, directory, branch: 'review/lab', base: 'main' });
  assert.equal(created.state, 'intent'); assert.equal(created.repository, foreign); assert.equal(created.directory, directory);
  const adopted = await f.prepare({ ...f.adoptInput, key: 'adopt-local', repository: undefined, branch: undefined });
  assert.equal(adopted.state, 'prepared'); assert.equal(adopted.repository, null); assert.equal(adopted.directory, f.adopted);
});

test('localUser requires explicit destinations, canonical unused create paths and honours the active limit', async t => {
  const f = fixture(t, true), first = join(f.directory, 'first'), second = join(f.directory, 'second');
  f.config.workerProvisioning = { mode: 'localUser', maxActiveWorkers: 1 }; delete f.config.workerRepositories;
  await assert.rejects(f.prepare({ repository: undefined, branch: undefined, base: undefined, directory: undefined }), { code: 'invalid_request' });
  mkdirSync(first);
  await assert.rejects(f.prepare({ repository: undefined, branch: undefined, base: undefined, directory: first }), { code: 'worker_path_occupied' });
  rmSync(first, { recursive: true });
  await f.prepare({ repository: undefined, branch: undefined, base: undefined, directory: first });
  await assert.rejects(f.prepare({ key: 'second', repository: undefined, branch: undefined, base: undefined, directory: second }),
    { code: 'worker_limit_reached' });
});

test('localUser journals directory and workspace uncertainty before mutation and never replays it', async t => {
  for (const step of ['directory.create', 'workspace.create']) {
    const f = fixture(t, true), directory = join(f.directory, step.replace('.', '-'));
    f.config.workerProvisioning = { mode: 'localUser' }; delete f.config.workerRepositories;
    const input = { repository: undefined, branch: undefined, base: undefined, directory };
    await f.prepare(input);
    const [result] = await f.reconcile(step === 'directory.create' ? { mkdir: async () => { throw new Error('mkdir failed'); } } :
      { rpc: async (...args) => {
        if (args[1] === 'workspace.create') throw new Error('workspace failed');
        return f.deps.rpc(...args);
      } });
    assert.equal(result.state, 'uncertain'); assert.equal(result.step, step);
    assert.equal(result.blocker, 'manual_recovery_required');
    const calls = f.rpcCalls.length;
    assert.deepEqual(await f.prepare(input), result); assert.equal(f.rpcCalls.length, calls);
    assert.deepEqual(await f.reconcile(), []);
  }
});

test('input rejects executable fields, unsafe refs, fabricated sources and conflicting key retries', async t => {
  const f = fixture(t);
  for (const field of ['command', 'args', 'shell', 'env', 'socketPath', 'origin', 'companyId']) {
    await assert.rejects(f.prepare({ [field]: 'untrusted' }), { code: 'invalid_request' });
  }
  await assert.rejects(f.prepare({ branch: '--bad' }), { code: 'invalid_git_ref' });
  await assert.rejects(f.prepare({ base: '--bad' }), { code: 'invalid_git_ref' });
  for (const source of [null, { ...f.input.source, role: 'assistant' }, { ...f.input.source, synthetic: true }, { ...f.input.source, ignored: true },
    { ...f.input.source, createdAt: 1 }, { ...f.input.source, createdAt: Date.now() + 10000 }]) {
    await assert.rejects(f.prepare({ source }), { code: 'invalid_worker_source' });
  }
  const first = await f.prepare();
  await assert.rejects(f.prepare({ branch: 'changed' }), { code: 'worker_conflict' });
  await assert.rejects(f.prepare({ source: { ...f.input.source, text: 'Different instruction.' } }), { code: 'worker_conflict' });
  assert.equal(f.store.operation(first.id).request.branch, 'feature/worker');
});

test('notifications and even settled Relay invocation sources cannot authorise preparation', async t => {
  const f = fixture(t);
  f.store.saveOperation({ id: 'completion-notification:one', runId: '', messageId: f.input.source.id,
    origin: { bindingId: f.binding.id, conversationId: f.bridge.identity.conversationId, sessionCreatedAt: f.bridge.sessionCreatedAt } });
  await assert.rejects(f.prepare(), { code: 'invalid_worker_source' });
  const runs = f.store.runs.bind(f.store);
  f.store.runs = () => [{ nativeState: 'settled', invocation: { messageId: 'invocation' } }];
  await assert.rejects(f.prepare({ source: { ...f.input.source, id: 'invocation' } }), { code: 'invalid_worker_source' });
  f.store.runs = () => [{ nativeState: 'running' }];
  await assert.rejects(f.prepare(), { code: 'conversation_busy' });
  f.store.runs = runs;
});

test('origin disarm or session recreation during validation prevents any mutation', async t => {
  for (const change of [{ state: 'configured' }, { sessionCreatedAt: 999 }, { epoch: 'replacement' }]) {
    const f = fixture(t);
    await assert.rejects(f.prepare({}, { rpc: async (...args) => {
      const response = await f.deps.rpc(...args);
      f.store.saveOperation({ ...f.bridge, ...change });
      return response;
    } }), { code: 'bridge_identity_mismatch' });
    assert.deepEqual(f.rpcCalls.map(call => call.method), ['session.snapshot']);
  }
});

test('uncertain create or start survives database reopen and is never replayed or enrolled', async t => {
  for (const step of ['worktree.create', 'agent.start']) {
    const f = fixture(t);
    const result = await f.create({}, { rpc: async (...args) => {
      const receipt = await f.deps.rpc(...args);
      if (args[1] === step) throw new Error('secret remote error');
      return receipt;
    } });
    assert.equal(result.state, 'uncertain'); assert.equal(result.step, step);
    assert.equal(result.blocker, 'manual_recovery_required');
    const count = f.rpcCalls.length;
    f.reopen();
    assert.deepEqual(await f.prepare(), result); assert.equal(f.rpcCalls.length, count);
    assert.deepEqual(await f.reconcile(), []);
    assert.equal(f.apiCalls.length, 0);
  }
});

test('invalid worktree receipt remains uncertain and never starts an agent', async t => {
  const f = fixture(t);
  const result = await f.create({}, { rpc: async (...args) => {
    const receipt = await f.deps.rpc(...args);
    if (args[1] === 'worktree.create') receipt.root_pane.cwd = '/elsewhere';
    return receipt;
  } });
  assert.equal(result.state, 'uncertain'); assert.equal(result.step, 'worktree.create'); assert.equal(f.started, false);
});

test('start receipt with a different native terminal remains uncertain', async t => {
  const f = fixture(t);
  const result = await f.create({}, { rpc: async (...args) => {
    const receipt = await f.deps.rpc(...args);
    if (args[1] === 'agent.start') receipt.agent.terminal_id = 'replacement';
    return receipt;
  } });
  assert.equal(result.state, 'uncertain'); assert.equal(result.step, 'agent.start');
  assert.equal(result.observedId, null);
  assert.deepEqual(await f.prepare(), result);
});

test('real Git creation uses pinned commit and explicit trust without editing Git configuration', async t => {
  const f = fixture(t, true);
  const configBefore = readFileSync(join(f.repository, '.git/config'), 'utf8');
  const result = await f.create({ trustRepository: true }, { rpc: async (...args) => {
    if (args[1] === 'worktree.create') {
      // Moving the symbolic base after resolution must not change the new tree.
      f.runGit(f.repository, ['commit', '--allow-empty', '-m', 'move base']);
    }
    return f.deps.rpc(...args);
  } });
  assert.equal(result.state, 'awaiting_native');
  assert.notEqual(f.runGit(f.repository, ['rev-parse', 'HEAD']).trim(), f.commit);
  assert.equal(f.runGit(result.directory, ['rev-parse', 'HEAD']).trim(), f.commit);
  assert.equal(f.rpcCalls.find(call => call.method === 'worktree.create').params.trust_repository, true);
  assert.equal(readFileSync(join(f.repository, '.git/config'), 'utf8'), configBefore);
});

test('changing a created shell placement prevents agent.start without replay on retry', async t => {
  const f = fixture(t);
  let snapshots = 0;
  const result = await f.create({}, { rpc: async (...args) => {
    const receipt = await f.deps.rpc(...args);
    if (args[1] === 'session.snapshot' && ++snapshots === 2) receipt.snapshot.panes[0].terminal_id = 'replacement';
    return receipt;
  } });
  assert.equal(result.state, 'blocked'); assert.equal(result.blocker, 'grant_revoked'); assert.equal(f.started, false);
  const calls = f.rpcCalls.length;
  assert.deepEqual(await f.prepare(), result); assert.equal(f.rpcCalls.length, calls);
});

test('concurrent prepares serialize the same key and reserve branches across distinct keys', async t => {
  const f = fixture(t);
  let release, arrived;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { arrived = resolve; });
  const pending = f.prepare({}, { rpc: async (...args) => {
    if (args[1] === 'session.snapshot') { arrived(); await gate; }
    return f.deps.rpc(...args);
  } });
  await entered;
  await assert.rejects(f.prepare(), { code: 'operation_busy' });
  release(); assert.equal((await pending).state, 'intent');
  await assert.rejects(f.prepare({ key: 'second' }), { code: 'worker_conflict' });
});

test('real Git adoption preserves dirty files, never launches, and enrols only after exact plugin readiness', async t => {
  const f = fixture(t, true);
  const result = await f.prepare(f.adoptInput);
  assert.equal(result.state, 'prepared'); assert.deepEqual(f.rpcCalls.map(call => call.method), ['session.snapshot']);
  const locks = new Map();
  let [configured] = await f.reconcile({}, locks);
  assert.equal(configured.state, 'configured'); assert.equal(configured.blocker, 'plugin_unavailable');
  const targetBridge = f.store.operation(`opencode-bridge:${configured.bindingId}`);
  const credentials = readFileSync(join(f.directory, 'bridges', `${configured.bindingId}.json`), 'utf8');
  assert.equal(f.apiCalls.filter(call => call.method === 'PATCH').length, 0);
  bridgeRequest(f.store, targetBridge.id, 'poll', { conversationId: f.worker.identity.conversationId,
    terminalId: f.worker.placement.terminalId, epoch: 'worker-epoch', sessionCreatedAt: 789, idle: true });
  const [armed] = await f.reconcile({}, locks);
  assert.equal(armed.state, 'armed'); assert.equal(armed.blocker, null);
  const calls = f.apiCalls.length;
  await f.reconcile({}, locks);
  assert.equal(f.apiCalls.length, calls);
  assert.equal(readFileSync(join(f.directory, 'bridges', `${configured.bindingId}.json`), 'utf8'), credentials);
  assert.equal(readFileSync(join(f.adopted, 'tracked.txt'), 'utf8'), 'uncommitted human changes\n');
  assert.equal(readFileSync(join(f.adopted, 'untracked.txt'), 'utf8'), 'keep this too\n');
  assert.equal(f.started, false); assert.deepEqual(f.config.workerRepositories, [{ repository: f.repository, worktreeRoot: f.root }]);
  assert.equal(f.config.bridgeDirectories, undefined);
});

test('real Git adoption refuses subdirectories, another repository and symlink escape', async t => {
  const f = fixture(t, true);
  const child = join(f.adopted, 'child'); mkdirSync(child);
  await assert.rejects(f.prepare({ ...f.adoptInput, directory: child }), { code: 'worker_repository_forbidden' });
  const outside = join(f.directory, 'outside'); mkdirSync(outside);
  const link = join(f.root, 'escape'); symlinkSync(outside, link);
  await assert.rejects(f.prepare({ ...f.adoptInput, directory: link }), { code: 'worker_directory_mismatch' });
  const other = join(f.root, 'other'); mkdirSync(other);
  f.runGit(other, ['init', '-b', 'main']);
  await assert.rejects(f.prepare({ ...f.adoptInput, directory: other }), { code: 'worker_repository_mismatch' });
  assert.equal(f.rpcCalls.length, 0);
});

test('adoption rejects wrong live terminal, duplicate chat and changed scope before enrolment', async t => {
  const f = fixture(t, true);
  f.setAgents([f.native(f.origin), { ...f.native(f.worker), terminal_id: 'replacement' }]);
  await assert.rejects(f.prepare(f.adoptInput), { code: 'worker_observation_mismatch' });
  f.setAgents([f.native(f.origin), f.native(f.worker)]);
  await f.prepare(f.adoptInput);
  f.observe('duplicate', f.adopted, 'duplicate');
  const [blocked] = await f.reconcile();
  assert.equal(blocked.blocker, 'enrolment_blocked'); assert.equal(f.apiCalls.length, 0);
  f.config.workerRepositories = [];
  assert.equal((await f.reconcile())[0].blocker, 'grant_revoked');
  assert.equal(f.apiCalls.length, 0);
});

test('driver shares observed-delivery lock and read-only inspection never drives enrolment', async t => {
  const f = fixture(t, true);
  const prepared = await f.prepare(f.adoptInput), before = f.store.operation(prepared.id);
  const locks = new Map([['observed-delivery', Promise.resolve()]]);
  assert.deepEqual(await f.reconcile({}, locks), []);
  assert.equal((await f.inspect()).workers[0].state, 'prepared');
  assert.deepEqual(f.store.operation(prepared.id), before); assert.equal(f.apiCalls.length, 0);
  assert.deepEqual(await inspectHerdrWorkers(f.store, f.bridge, { ...f.config, socketPath: '/other.sock' }, f.deps), { workers: [], candidates: [] });
});

test('background enrolment refuses a recreated origin or moved target rather than refreshing it', async t => {
  for (const changedOrigin of [true, false]) {
    const f = fixture(t, true);
    await f.prepare(f.adoptInput);
    if (changedOrigin) f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 999 });
    else f.store.saveOperation({ ...f.worker, placement: { ...f.worker.placement, terminalId: 'replacement' } });
    const [result] = await f.reconcile();
    assert.equal(result.blocker, changedOrigin ? 'grant_revoked' : 'enrolment_blocked');
    assert.equal(f.apiCalls.length, 0); assert.equal(f.store.bindings().length, 1);
  }
});

test('durable intent retries and background creation survive origin plugin restart and control revision changes', async t => {
  const f = fixture(t);
  const intent = await f.prepare(), original = f.store.operation(intent.id).origin;
  assert.equal(original.bridgeProof, undefined);
  f.reopen();
  f.store.saveOperation({ ...f.store.operation(f.bridge.id), epoch: 'restarted', controlRevision: 12,
    tokenHash: digest('rotated'), lastSeen: new Date().toISOString() });
  assert.deepEqual(await f.prepare(), intent);
  const [prepared] = await f.reconcile();
  assert.equal(prepared.state, 'awaiting_native');
  assert.deepEqual(f.store.operation(intent.id).origin, original);
  assert.equal(f.rpcCalls.filter(call => call.method === 'agent.start').length, 1);
});

test('verified created stage resumes only its untouched start after restart', async t => {
  const f = fixture(t);
  await f.create();
  const record = (await f.inspect()).workers[0];
  const op = f.store.operation(record.id);
  f.store.saveOperation({ ...op, state: 'created', target: null, startReceipt: null });
  f.setAgents([f.native(f.origin), f.native(f.worker)]);
  f.reopen();
  const creates = f.rpcCalls.filter(call => call.method === 'worktree.create').length;
  assert.equal((await f.reconcile())[0].state, 'awaiting_native');
  assert.equal(f.rpcCalls.filter(call => call.method === 'worktree.create').length, creates);
});

test('actual protocol22 snapshot required before background mutation and candidate exposure', async t => {
  for (const transform of [snapshot => { snapshot.protocol = 21; }, snapshot => { delete snapshot.layouts; }]) {
    const f = fixture(t);
    await f.prepare();
    const [blocked] = await f.reconcile({ rpc: async (...args) => {
      const response = await f.deps.rpc(...args);
      transform(response.snapshot); return response;
    } });
    assert.equal(blocked.state, 'blocked'); assert.equal(f.started, false);
    assert.ok(f.rpcCalls.every(call => call.method === 'session.snapshot'));
  }
});

test('read-only inspection exposes exact dirty adoption candidates but not unrelated allowlisted repositories', async t => {
  const f = fixture(t, true);
  const other = join(f.directory, 'foreign'); mkdirSync(other);
  f.runGit(other, ['init', '-b', 'main']);
  f.runGit(other, ['commit', '--allow-empty', '-m', 'foreign']);
  f.config.workerRepositories.push({ repository: other, worktreeRoot: f.root });
  const foreignTree = join(f.root, 'foreign-worker');
  f.runGit(other, ['worktree', 'add', '-b', 'worker', foreignTree]);
  const foreign = f.observe('foreign-chat', foreignTree, 'foreign');
  f.setAgents([f.native(f.origin), f.native(f.worker), f.native(foreign)]);
  const before = f.store.db.prepare('SELECT data FROM operations ORDER BY id').all();
  const inspected = await f.inspect();
  assert.deepEqual(inspected.candidates, [{ observedId: f.worker.id, repository: f.repository, directory: f.adopted,
    branch: 'adopted', eligible: true, linkedWorktree: true, preservesFiles: true, launchesAgent: false, reserved: false }]);
  assert.deepEqual(f.store.db.prepare('SELECT data FROM operations ORDER BY id').all(), before);
  assert.equal(f.apiCalls.length, 0);
  await assert.rejects(f.prepare({ repository: other }), { code: 'worker_repository_forbidden' });
  await assert.rejects(f.prepare({ ...f.adoptInput, repository: other, directory: foreignTree, observedId: foreign.id }),
    { code: 'worker_repository_forbidden' });
});

async function armedFixture(t) {
  const f = fixture(t, true);
  await f.prepare(f.adoptInput);
  const [configured] = await f.reconcile();
  const bridgeId = `opencode-bridge:${configured.bindingId}`;
  bridgeRequest(f.store, bridgeId, 'poll', { conversationId: f.worker.identity.conversationId,
    terminalId: f.worker.placement.terminalId, epoch: 'target-epoch', sessionCreatedAt: 789, idle: true });
  const [armed] = await f.reconcile();
  assert.equal(armed.state, 'armed');
  return { ...f, bridgeId, armed };
}

test('armed worker is disarmed on grant revocation or replaced target and never automatically rearmed', async t => {
  for (const change of ['allowlist', 'scope', 'origin', 'target', 'createdAt', 'disarmed']) {
    const f = await armedFixture(t);
    const allowed = structuredClone(f.config.workerRepositories);
    if (change === 'allowlist') f.config.workerRepositories = [];
    if (change === 'scope') f.config.session = 'other';
    if (change === 'origin') f.store.saveOperation({ ...f.store.operation(f.bridge.id), state: 'configured' });
    if (change === 'target') f.store.saveOperation({ ...f.worker, placement: { ...f.worker.placement, terminalId: 'replaced' } });
    if (change === 'createdAt') f.store.saveOperation({ ...f.store.operation(f.bridgeId), sessionCreatedAt: 999 });
    if (change === 'disarmed') f.store.saveOperation({ ...f.store.operation(f.bridgeId), state: 'configured' });
    const [blocked] = await f.reconcile();
    assert.equal(blocked.state, 'blocked', change); assert.equal(blocked.blocker, 'grant_revoked', change);
    assert.equal(f.store.operation(f.bridgeId).state, 'configured', change);
    assert.equal(f.store.operation(f.bridgeId).backendPaused, true, change);
    assert.equal(f.store.operation(blocked.id).disarmed, true, change);
    f.config.workerRepositories = allowed; f.config.session = 'session';
    f.store.saveOperation({ ...f.bridge }); f.store.saveOperation({ ...f.worker });
    const count = f.apiCalls.length;
    assert.deepEqual(await f.reconcile(), []);
    assert.equal(f.apiCalls.length, count); assert.equal(f.store.operation(f.bridgeId).state, 'configured');
  }
});

test('fresh adoption supersedes every fully disarmed grant and restores admission without deleting history', async t => {
  const f = await armedFixture(t), allowed = structuredClone(f.config.workerRepositories), history = [];
  let current = f.armed;
  for (const key of ['second', 'third']) {
    f.config.workerRepositories = [];
    const [blocked] = await f.reconcile();
    assert.equal(blocked.id, current.id); assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.blocker, 'grant_revoked');
    const old = f.store.operation(blocked.id);
    assert.equal(old.disarmed, true); history.push(old);
    assert.throws(() => f.store.assertWorkerAdmission(f.armed.bindingId), { code: 'worker_grant_inactive' });

    f.config.workerRepositories = allowed;
    assert.deepEqual(await f.reconcile(), []);
    assert.equal(f.store.operation(f.bridgeId).state, 'configured');
    assert.throws(() => f.store.assertWorkerAdmission(f.armed.bindingId), { code: 'worker_grant_inactive' });
    const prepared = await f.prepare({ ...f.adoptInput, key });
    assert.notEqual(prepared.id, old.id); assert.equal(prepared.state, 'prepared');
    assert.deepEqual(f.store.operation(prepared.id).supersedes, history.map(item => item.id));
    assert.deepEqual(f.store.operation(prepared.id).target, old.target);
    assert.throws(() => f.store.assertWorkerAdmission(f.armed.bindingId), { code: 'worker_grant_inactive' });
    const [configured] = await f.reconcile();
    assert.equal(configured.state, 'configured'); assert.equal(configured.bindingId, f.armed.bindingId);
    assert.throws(() => f.store.assertWorkerAdmission(configured.bindingId), { code: 'worker_grant_inactive' });
    bridgeRequest(f.store, f.bridgeId, 'poll', { conversationId: f.worker.identity.conversationId,
      terminalId: f.worker.placement.terminalId, epoch: 'target-epoch', sessionCreatedAt: 789, idle: true });
    [current] = await f.reconcile();
    assert.equal(current.id, prepared.id); assert.equal(current.state, 'armed');
    assert.doesNotThrow(() => f.store.assertWorkerAdmission(current.bindingId));
    for (const item of history) assert.deepEqual(f.store.operation(item.id), item);
  }
  const binding = f.store.binding(current.bindingId);
  assert.equal(f.store.dispatch({ bindingId: binding.id, bindingRevision: binding.revision,
    companyId: binding.config.companyId, agentId: binding.config.agentId, taskId: 'task', runId: 'readopted' }).nativeState, 'unclaimed');
  assert.ok(f.rpcCalls.every(call => call.method === 'session.snapshot'));
  assert.equal(readFileSync(join(f.adopted, 'tracked.txt'), 'utf8'), 'uncommitted human changes\n');
  assert.equal(readFileSync(join(f.adopted, 'untracked.txt'), 'utf8'), 'keep this too\n');
});

test('prepare supersedes only fully disarmed blocked records with the same target and request directory', async t => {
  const f = fixture(t), prepared = await f.prepare(f.adoptInput), original = f.store.operation(prepared.id);
  const old = f.store.saveOperation({ ...original, state: 'blocked', blocker: 'grant_revoked', disarmed: true });
  for (const field of ['observedId', 'conversationId', 'terminalId', 'paneId', 'workspaceId', 'tabId', 'directory']) {
    f.store.saveOperation({ ...old, id: `herdr-worker:wrong-${field}`, target: { ...old.target, [field]: 'replacement' } });
  }
  f.store.saveOperation({ ...old, id: 'herdr-worker:wrong-request-directory', request: { ...old.request, directory: '/other' } });
  const pending = f.store.saveOperation({ ...old, id: 'herdr-worker:pending', blocker: 'disarm_pending', disarmed: false });
  await assert.rejects(f.prepare({ ...f.adoptInput, key: 'second' }), { code: 'worker_conflict' });
  assert.deepEqual(f.store.operation(old.id), old);
  const disarmed = f.store.saveOperation({ ...pending, blocker: 'grant_revoked', disarmed: true });
  const replacement = await f.prepare({ ...f.adoptInput, key: 'second' });
  assert.deepEqual(f.store.operation(replacement.id).supersedes, [old.id, disarmed.id]);
  assert.deepEqual(f.store.operation(old.id), old);
  assert.deepEqual(f.store.operation(disarmed.id), disarmed);
});

test('revocation waits for target work settlement without authorising fresh work or using an invalid origin', async t => {
  const f = await armedFixture(t);
  const runs = f.store.runs.bind(f.store);
  f.store.runs = bindingId => bindingId === f.armed.bindingId ? [{ nativeState: 'running' }] : runs(bindingId);
  f.config.workerRepositories = [];
  assert.equal((await f.reconcile())[0].blocker, 'disarm_pending');
  assert.equal(f.store.operation(f.bridgeId).state, 'armed');
  f.store.runs = runs;
  f.store.saveOperation({ ...f.bridge, state: 'configured' });
  assert.equal((await f.reconcile())[0].blocker, 'grant_revoked');
  assert.equal(f.store.operation(f.bridgeId).state, 'configured');
});

test('configured and armed workers tolerate ordinary origin and target plugin restart', async t => {
  const f = await armedFixture(t);
  f.store.saveOperation({ ...f.store.operation(f.bridge.id), epoch: 'new-origin', controlRevision: 8 });
  f.store.saveOperation({ ...f.store.operation(f.bridgeId), epoch: 'new-target', controlRevision: 8 });
  const count = f.apiCalls.length;
  assert.equal((await f.reconcile())[0].state, 'armed');
  assert.equal(f.apiCalls.length, count);
});

test('readiness loss during arm backend GET preserves configured grant and recovers', async t => {
  for (const change of ['ready', 'lastSeen', 'epoch', 'sessionCreatedAt']) {
    const f = fixture(t);
    await f.prepare(f.adoptInput);
    const [configured] = await f.reconcile(), bridgeId = `opencode-bridge:${configured.bindingId}`;
    bridgeRequest(f.store, bridgeId, 'poll', { conversationId: 'worker-chat', terminalId: f.worker.placement.terminalId,
      epoch: 'target-epoch', sessionCreatedAt: 789, idle: true });
    const original = f.store.operation(bridgeId);
    const api = async (...args) => {
      const response = await f.api(...args);
      if (args[0] === 'GET') f.store.saveOperation({ ...f.store.operation(bridgeId),
        [change]: { ready: false, lastSeen: '2000-01-01T00:00:00Z', epoch: 'restarted', sessionCreatedAt: 999 }[change] });
      return response;
    };
    const [waiting] = await reconcileHerdrWorkers(f.store, f.directory, api, f.config, new Map(), f.deps);
    if (change === 'sessionCreatedAt') {
      assert.equal(waiting.state, 'blocked'); assert.equal(waiting.blocker, 'grant_revoked');
      continue;
    }
    assert.equal(waiting.state, 'configured', change); assert.equal(waiting.blocker, 'plugin_unavailable', change);
    assert.equal(f.store.operation(bridgeId).state, 'configured');
    assert.equal(f.apiCalls.filter(call => call.method === 'PATCH').length, 0);
    f.store.saveOperation({ ...original, lastSeen: new Date().toISOString() });
    assert.equal((await f.reconcile())[0].state, 'armed');
    assert.ok(f.rpcCalls.every(call => call.method === 'session.snapshot'));
  }
});

test('configured and armed launches survive transient socket or missing observation without replay', async t => {
  for (const state of ['configured', 'armed']) {
    for (const failure of ['socket', 'absent', 'session']) {
      const f = fixture(t), result = await f.create();
      await f.reconcile();
      const worker = f.observe('created-chat', result.directory, 'new');
      const [configured] = await f.reconcile(), bridgeId = `opencode-bridge:${configured.bindingId}`;
      if (state === 'armed') {
        bridgeRequest(f.store, bridgeId, 'poll', { conversationId: 'created-chat', terminalId: worker.placement.terminalId,
          epoch: 'target-epoch', sessionCreatedAt: 789, idle: true });
        assert.equal((await f.reconcile())[0].state, 'armed');
      }
      const before = f.store.operation(result.id), bridge = f.store.operation(bridgeId), calls = f.apiCalls.length;
      const [waiting] = await f.reconcile({ rpc: async (...args) => {
        if (failure === 'socket') throw Object.assign(new Error('disconnected'), { code: 'herdr_rpc_failed' });
        const response = await f.deps.rpc(...args);
        response.snapshot.agents = failure === 'absent' ? [f.native(f.origin)] :
          [f.native(f.origin), { ...f.native(worker), agent_session: null }];
        return response;
      } });
      assert.equal(waiting.state, state, failure);
      assert.equal(waiting.blocker, failure === 'socket' ? 'native_snapshot_unavailable' : 'native_session_unavailable');
      assert.deepEqual(f.store.operation(bridgeId), bridge); assert.equal(f.apiCalls.length, calls);
      assert.deepEqual(f.store.operation(result.id).origin, before.origin);
      assert.deepEqual(f.store.operation(result.id).target, before.target);
      f.reopen();
      assert.equal((await f.reconcile())[0].state, state);
      assert.equal(f.rpcCalls.filter(call => call.method === 'agent.start').length, 1);
      assert.equal(f.rpcCalls.filter(call => call.method === 'worktree.create').length, 1);
    }
  }
});

test('missing session does not hide replacement pane, duplicate, scope or native identity evidence', async t => {
  for (const change of ['pane', 'terminal', 'session', 'duplicate', 'scope', 'invalid-snapshot']) {
    const f = await armedFixture(t);
    if (change === 'scope') f.config.session = 'replacement';
    const [blocked] = await f.reconcile({ rpc: async (...args) => {
      const response = await f.deps.rpc(...args), snapshot = response.snapshot;
      if (change === 'pane') {
        snapshot.agents = [f.native(f.origin)];
        snapshot.panes = [{ ...f.native(f.worker), terminal_id: 'replacement', agent_session: null }];
      }
      if (change === 'terminal') snapshot.agents = [f.native(f.origin), { ...f.native(f.worker), terminal_id: 'replacement', agent_session: null }];
      if (change === 'session') snapshot.agents = [f.native(f.origin), { ...f.native(f.worker), agent_session: { agent: 'opencode', kind: 'id', value: 'replacement' } }];
      if (change === 'duplicate') snapshot.agents = [f.native(f.origin), f.native(f.worker), { ...f.native(f.worker), agent_session: null }];
      if (change === 'invalid-snapshot') delete snapshot.agents;
      return response;
    } });
    assert.equal(blocked.state, 'blocked', change); assert.equal(blocked.blocker, 'grant_revoked', change);
    assert.equal(f.store.operation(f.bridgeId).state, 'configured', change);
  }
});

test('temporary origin disconnect preserves durable intent until the same origin reconnects', async t => {
  const f = fixture(t);
  const intent = await f.prepare();
  f.store.saveOperation({ ...f.bridge, lastSeen: '2000-01-01T00:00:00Z' });
  const [waiting] = await f.reconcile();
  assert.equal(waiting.state, 'intent'); assert.equal(waiting.blocker, 'enrolment_blocked');
  assert.ok(f.rpcCalls.every(call => call.method === 'session.snapshot'));
  f.store.saveOperation({ ...f.bridge, epoch: 'reconnected', lastSeen: new Date().toISOString() });
  assert.equal((await f.reconcile())[0].state, 'awaiting_native');
  assert.equal(f.store.operation(intent.id).origin.sessionCreatedAt, 123);
});

test('prepare returns while background start is pending and concurrent drivers cannot duplicate it', async t => {
  const f = fixture(t);
  const intent = await f.prepare();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { entered = resolve; });
  const locks = new Map();
  const pending = f.reconcile({ rpc: async (...args) => {
    if (args[1] === 'agent.start') { entered(); await gate; }
    return f.deps.rpc(...args);
  } }, locks);
  await arrived;
  assert.equal(f.store.operation(intent.id).state, 'uncertain');
  assert.equal(locks.has('observed-delivery'), false);
  assert.equal(locks.has('herdr-workers'), true);
  assert.equal((await f.prepare()).state, 'uncertain');
  assert.deepEqual(await f.reconcile({}, locks), []);
  assert.deepEqual(await f.reconcile(), []);
  const delivery = Promise.resolve();
  locks.set('observed-delivery', delivery);
  release(); assert.equal((await pending)[0].state, 'awaiting_native');
  assert.equal(locks.get('observed-delivery'), delivery);
  assert.equal(locks.has('herdr-workers'), false);
  assert.equal(f.rpcCalls.filter(call => call.method === 'agent.start').length, 1);
});

test('raw launch receipt without a session survives restart and resolves readiness only on later ticks', async t => {
  for (const restart of [false, true]) {
    const f = fixture(t);
    const result = await f.create({}, { rpc: async (...args) => {
      const response = await f.deps.rpc(...args);
      if (restart && args[1] === 'agent.start') delete response.agent.agent_session;
      return response;
    } });
    assert.equal(result.state, 'awaiting_native'); assert.equal(result.observedId, null);
    const operation = f.store.operation(result.id), receipt = operation.startReceipt;
    assert.deepEqual(receipt, { ...operation.createReceipt, name: `relay-${digest(result.id).slice(0, 20)}`,
      kind: 'opencode', conversationId: null });
    assert.deepEqual(operation.scope, { socketPath: f.config.socketPath, companyId: 'company', machineId: 'machine', session: 'session' });
    const pendingAgent = { pane_id: receipt.paneId, terminal_id: receipt.terminalId, workspace_id: receipt.workspaceId,
      tab_id: receipt.tabId, cwd: receipt.directory, name: receipt.name, agent: 'opencode', agent_session: null };
    f.setAgents([f.native(f.origin), pendingAgent]);
    if (restart) f.reopen();
    const [waiting] = await f.reconcile();
    assert.equal(waiting.state, 'awaiting_native'); assert.equal(waiting.blocker, 'native_session_unavailable');
    assert.equal(f.apiCalls.length, 0);
    const worker = f.observe('created-chat', result.directory, 'new');
    f.setAgents([f.native(f.origin), { ...f.native(worker), name: receipt.name }]);
    const [prepared] = await f.reconcile();
    assert.equal(prepared.state, 'prepared'); assert.equal(prepared.blocker, null); assert.equal(prepared.observedId, worker.id);
    assert.equal(f.apiCalls.length, 0);
    const [configured] = await f.reconcile();
    assert.equal(configured.state, 'configured'); assert.equal(configured.blocker, 'plugin_unavailable');
    bridgeRequest(f.store, `opencode-bridge:${configured.bindingId}`, 'poll', { conversationId: 'created-chat',
      terminalId: receipt.terminalId, epoch: 'worker-ready', sessionCreatedAt: 789, idle: true });
    assert.equal((await f.reconcile())[0].state, 'armed');
    assert.deepEqual(f.store.operation(result.id).origin, operation.origin);
    assert.deepEqual(f.store.operation(result.id).startReceipt, receipt);
    assert.equal(f.rpcCalls.filter(call => call.method === 'agent.start').length, 1);
    assert.equal(f.rpcCalls.filter(call => call.method === 'worktree.create').length, 1);
  }
});

test('awaiting native observation rejects replacement placement, name, harness and duplicate sessions', async t => {
  for (const change of ['pane_id', 'terminal_id', 'workspace_id', 'tab_id', 'cwd', 'name', 'agent', 'duplicate', 'duplicate-name', 'duplicate-session', 'pane']) {
    const f = fixture(t);
    const result = await f.create(), receipt = f.store.operation(result.id).startReceipt;
    const worker = f.observe('created-chat', result.directory, 'new');
    const agent = { ...f.native(worker), name: receipt.name }, agents = [f.native(f.origin), agent];
    if (change === 'duplicate') agents.push({ ...agent });
    else if (change === 'duplicate-name') agents.push({ ...f.native(f.worker), name: receipt.name });
    else if (change === 'duplicate-session') agents.push({ ...f.native(f.worker), agent_session: agent.agent_session });
    else if (change !== 'pane') agent[change] = 'replacement';
    f.setAgents(agents);
    const [blocked] = await f.reconcile({ rpc: async (...args) => {
      const response = await f.deps.rpc(...args);
      if (change === 'pane') response.snapshot.panes[0].terminal_id = 'replacement';
      return response;
    } });
    assert.equal(blocked.state, 'blocked', change); assert.equal(blocked.observedId, null, change);
    assert.equal(f.apiCalls.length, 0, change);
    assert.deepEqual(await f.reconcile(), []);
    assert.equal(f.rpcCalls.filter(call => call.method === 'agent.start').length, 1, change);
  }
});

test('successful receipt is durable even when origin disconnects during launch', async t => {
  const f = fixture(t);
  const result = await f.create({}, { rpc: async (...args) => {
    const response = await f.deps.rpc(...args);
    if (args[1] === 'agent.start') f.store.saveOperation({ ...f.bridge, lastSeen: '2000-01-01T00:00:00Z' });
    return response;
  } });
  assert.equal(result.state, 'awaiting_native'); assert.equal(result.blocker, 'enrolment_blocked');
  assert.ok(f.store.operation(result.id).startReceipt);
  f.reopen();
  f.store.saveOperation({ ...f.bridge, lastSeen: new Date().toISOString() });
  assert.equal((await f.reconcile())[0].state, 'prepared');
  assert.equal(f.rpcCalls.filter(call => call.method === 'agent.start').length, 1);
});

test('native snapshot transport failure retries observation without replaying launch', async t => {
  const f = fixture(t), result = await f.create();
  const [waiting] = await f.reconcile({ rpc: async () => { throw Object.assign(new Error('lost snapshot'), { code: 'herdr_rpc_failed' }); } });
  assert.equal(waiting.state, 'awaiting_native'); assert.equal(waiting.blocker, 'native_snapshot_unavailable');
  f.reopen();
  assert.equal((await f.reconcile())[0].state, 'prepared');
  assert.equal(f.store.operation(result.id).target.conversationId, 'created-chat');
  assert.equal(f.rpcCalls.filter(call => call.method === 'agent.start').length, 1);
});

test('session included in start receipt pins later observation and rejects replacement session', async t => {
  const f = fixture(t);
  const result = await f.create({}, { rpc: async (...args) => {
    const response = await f.deps.rpc(...args);
    if (args[1] === 'agent.start') response.agent.agent_session = { agent: 'opencode', kind: 'id', value: 'receipt-chat' };
    return response;
  } });
  assert.equal(result.state, 'awaiting_native');
  assert.equal(f.store.operation(result.id).startReceipt.conversationId, 'receipt-chat');
  f.reopen();
  assert.equal((await f.reconcile())[0].state, 'blocked');
  assert.equal(f.apiCalls.length, 0);
  assert.equal(f.rpcCalls.filter(call => call.method === 'agent.start').length, 1);
});

test('awaiting native launch retains exact grant scope and origin across restart', async t => {
  for (const change of ['socketPath', 'companyId', 'machineId', 'session', 'allowlist', 'origin']) {
    const f = fixture(t), result = await f.create(), before = f.store.operation(result.id);
    f.reopen();
    if (change === 'origin') f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 999 });
    else if (change === 'allowlist') f.config.workerRepositories = [];
    else f.config[change] = change === 'socketPath' ? '/other.sock' : 'other';
    const calls = f.rpcCalls.length;
    assert.equal((await f.reconcile())[0].state, 'blocked', change);
    assert.equal(f.rpcCalls.length, calls, change); assert.equal(f.apiCalls.length, 0, change);
    assert.deepEqual(f.store.operation(result.id).scope, before.scope, change);
    assert.deepEqual(f.store.operation(result.id).origin, before.origin, change);
  }
});

test('creation progresses under an unrelated delivery lock but enrolment requires exclusive delivery', async t => {
  const f = fixture(t);
  const intent = await f.prepare(), delivery = Promise.resolve(), locks = new Map([['observed-delivery', delivery]]);
  assert.equal((await f.reconcile({}, locks))[0].state, 'awaiting_native');
  assert.equal((await f.reconcile({}, locks))[0].state, 'prepared');
  assert.deepEqual(await f.reconcile({}, locks), []);
  assert.equal(locks.get('observed-delivery'), delivery); assert.equal(f.apiCalls.length, 0);
  f.observe('created-chat', f.store.operation(intent.id).request.directory, 'new');
  locks.delete('observed-delivery');
  const api = async (...args) => {
    assert.equal(locks.has('observed-delivery'), true);
    assert.deepEqual(await f.reconcile({}, locks), []);
    return f.api(...args);
  };
  assert.equal((await reconcileHerdrWorkers(f.store, f.directory, api, f.config, locks, f.deps))[0].state, 'configured');
  assert.equal(locks.has('observed-delivery'), false); assert.equal(locks.has('herdr-workers'), false);
});
