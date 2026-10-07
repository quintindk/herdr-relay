import { execFile } from 'node:child_process';
import { realpath, lstat } from 'node:fs/promises';
import { connect } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { canonical, digest, RelayError, requireValue, text } from './protocol.mjs';
import { observedAgents } from './herdr-agents.mjs';
import { isNotificationSource } from './completion-notifications.mjs';
import { configureBridge, armBridge, disarmBridge } from './opencode-bridge.mjs';

// Integration: POST /bridge/prepare-worker must authenticate, validate the native
// poll and human source, then pass ONLY the worker fields below and the refreshed
// bridge. POST /bridge/workers awaits inspect only. Neither route grants directory
// permissions. Call reconcile on an independent background tick, sharing the
// service's publications Map, and await it on close. herdr-workers serialises the
// driver; observed-delivery covers enrolment/revocation, never launch or polling.
// Preserve workerRepositories when parsing Herdr config. Do not add these paths
// to bridgeDirectories. Prepare returns intent/prepared, never creates or starts.
// Inspection is async and returns {workers,candidates}. Reconcile's optional sixth
// deps argument (like prepare/inspect's deps) is a trusted test seam only.
const fields = new Set(['key', 'mode', 'repository', 'branch', 'base', 'label', 'directory', 'observedId', 'trustRepository', 'source']);
const standby = 'Relay worker bootstrap. Stand by for explicit work in this conversation. Do not inspect or modify files, run commands, delegate, or start any task. Reply only: Ready for Relay.';
const preparations = new WeakMap();
const reconciliations = new WeakSet();
const fresh = (value, limit) => Date.now() - Date.parse(value) >= 0 && Date.now() - Date.parse(value) < limit;
const records = store => store.db.prepare("SELECT data FROM operations WHERE id LIKE 'herdr-worker:%' ORDER BY rowid").all().map(row => JSON.parse(row.data));
const fail = (condition, code, message) => requireValue(condition, code, message, 409);
const singleLine = (value, name) => {
  value = text(value, name);
  requireValue(value.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(value), 'invalid_request', `${name} must be single-line text`);
  return value;
};
const absolute = (value, name) => {
  value = singleLine(value, name);
  requireValue(isAbsolute(value), 'invalid_request', `${name} must be absolute`);
  return value;
};
const beneath = (root, path) => {
  const part = relative(root, path);
  return part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const scopeOf = config => ({ socketPath: absolute(config?.socketPath, 'socketPath'),
  companyId: singleLine(config.companyId, 'companyId'), machineId: singleLine(config.machineId, 'machineId'),
  session: singleLine(config.session, 'session') });
const inScope = (observed, scope) => observed?.identity?.companyId === scope.companyId &&
  observed.identity.machineId === scope.machineId && observed.identity.session === scope.session;
const proof = bridge => digest([bridge.identity, bridge.tokenHash, bridge.epoch, bridge.sessionCreatedAt, bridge.controlRevision ?? 0]);
const originIdentity = (bridge, binding) => ({ bridgeId: bridge.id, identity: bridge.identity,
  bindingId: binding.id, bindingCreatedAt: binding.createdAt, bindingRevision: binding.revision,
  bindingConfig: digest(binding.config), conversationId: bridge.identity.conversationId, sessionCreatedAt: bridge.sessionCreatedAt });

function caller(store, bridge, scope, settled = false, requireFresh = true) {
  const live = store.operation(bridge?.id);
  fail(live?.state === 'armed' && proof(live) === proof(bridge) &&
    (!requireFresh || fresh(live.lastSeen, 10000)) && typeof live.epoch === 'string' && live.epoch &&
    Number.isSafeInteger(live.sessionCreatedAt) && live.sessionCreatedAt > 0,
  'bridge_identity_mismatch', 'Current armed native bridge required');
  const binding = store.binding(live.identity.bindingId);
  const observed = store.operation(live.identity.observedId);
  fail(!binding.lifecycleState && binding.config.companyId === scope.companyId &&
    binding.config.harness === 'opencode' && binding.config.delivery === 'pull' &&
    binding.config.conversationId === live.identity.conversationId && binding.config.agentId === observed?.agentId &&
    binding.config.instanceId === digest([scope.machineId, scope.session]) && inScope(observed, scope) &&
    observed.identity.harness === 'opencode' && observed.identity.sessionKind === 'id' &&
    observed.identity.conversationId === live.identity.conversationId &&
    observed.placement?.terminalId === live.identity.terminalId && observed.placement.directory === live.identity.directory &&
    (!requireFresh || (observed.availability === 'present' && !observed.error && fresh(observed.updatedAt, 15000))),
  'bridge_identity_mismatch', 'Origin binding or Herdr placement changed');
  if (settled) fail(store.runs(binding.id).every(run => run.nativeState === 'settled'),
    'conversation_busy', 'Relay work must settle before preparing workers');
  return binding;
}

async function git(directory, args, trust = false) {
  // Inherited GIT_DIR/WORK_TREE/config injection must not retarget validation.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const { stdout } = await promisify(execFile)('git', ['-c', 'safe.directory=',
    ...(trust ? ['-c', `safe.directory=${directory}`] : []), '-C', directory, ...args],
  { env, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

// Protocol 22, verified with `herdr api schema --json`. No inherited CLI context.
function rpc(socketPath, method, params) {
  return new Promise((resolveResult, reject) => {
    const id = randomUUID(), socket = connect(socketPath);
    let buffer = '', done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolveResult(result);
    };
    const invalid = () => finish(new RelayError('herdr_rpc_failed', 'Herdr response was not verified'));
    const timer = setTimeout(invalid, 40000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('error', invalid);
    socket.on('close', () => { if (!done) invalid(); });
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) return invalid();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, end));
        if (message.id !== id || message.error || !message.result) return invalid();
        finish(null, message.result);
      } catch { invalid(); }
    });
  });
}

async function repositoryScope(config, repository, deps) {
  fail(Array.isArray(config.workerRepositories) && config.workerRepositories.length > 0,
    'worker_repository_forbidden', 'An explicit worker repository allowlist is required');
  const matches = config.workerRepositories.filter(item => item?.repository === repository);
  fail(matches.length === 1, 'worker_repository_forbidden', 'Repository must exactly match one configured entry');
  const allowed = { repository: absolute(matches[0].repository, 'repository'),
    worktreeRoot: absolute(matches[0].worktreeRoot, 'worktreeRoot') };
  const repositoryPath = await deps.realpath(allowed.repository);
  const root = await deps.realpath(allowed.worktreeRoot);
  fail((await deps.lstat(root)).isDirectory(), 'worker_repository_forbidden', 'Worktree root must be an existing directory');
  return { allowed, repository: repositoryPath, worktreeRoot: root };
}

async function gitIdentity(repository, trust, deps) {
  fail(await deps.realpath((await deps.git(repository, ['rev-parse', '--show-toplevel'], trust)).trim()) === repository,
    'worker_repository_forbidden', 'Repository must identify its exact worktree root');
  return deps.realpath(resolve(repository, (await deps.git(repository, ['rev-parse', '--git-common-dir'], trust)).trim()));
}

async function originRepository(bridge, commonDirectory, trust, deps) {
  const path = await deps.realpath(bridge.identity.directory);
  const common = await deps.realpath(resolve(path, (await deps.git(path, ['rev-parse', '--git-common-dir'], trust)).trim()));
  fail(path === bridge.identity.directory && common === commonDirectory,
    'worker_repository_forbidden', 'Origin may prepare workers only in its own repository');
}

async function worktree(request, deps) {
  const path = await deps.realpath(request.directory);
  fail(path === request.directory && beneath(request.worktreeRoot, path), 'worker_directory_mismatch', 'Worktree escaped its authorised directory');
  const common = await gitIdentity(path, request.trustRepository, deps);
  fail(await gitIdentity(request.repository, request.trustRepository, deps) === request.commonDirectory,
    'worker_repository_mismatch', 'Authorised repository identity changed');
  const metadata = await deps.realpath((await deps.git(path, ['rev-parse', '--absolute-git-dir'], request.trustRepository)).trim());
  const entries = (await deps.git(request.repository, ['worktree', 'list', '--porcelain', '-z'], request.trustRepository)).split('\0\0');
  const entry = entries.map(item => item.split('\0')).find(lines => lines.includes(`worktree ${path}`));
  fail(common === request.commonDirectory && metadata !== common && entry && !entry.some(line => line.startsWith('prunable')),
    'worker_repository_mismatch', 'Directory is not a registered linked worktree of the authorised repository');
  const branch = entry.find(line => line.startsWith('branch '))?.slice('branch refs/heads/'.length) ?? null;
  fail(request.branch === null || branch === request.branch, 'worker_branch_mismatch', 'Worktree branch changed');
  return { directory: path, gitDirectory: metadata, branch };
}

function targetFrom(observed) {
  return { observedId: observed.id, conversationId: observed.identity.conversationId,
    terminalId: observed.placement.terminalId, paneId: observed.placement.paneId,
    workspaceId: observed.placement.workspaceId, tabId: observed.placement.tabId,
    directory: observed.placement.directory };
}

function exactObservation(store, scope, target) {
  const matches = observedAgents(store).filter(item => inScope(item, scope) && item.availability !== 'offline' &&
    (item.placement?.directory === target.directory || item.placement?.terminalId === target.terminalId));
  const observed = matches[0];
  fail(matches.length === 1 && observed.id === target.observedId &&
    canonical(targetFrom(observed)) === canonical(target) && observed.identity.harness === 'opencode' &&
    observed.identity.sessionKind === 'id' && observed.availability === 'present' && !observed.error &&
    observed.agentId && fresh(observed.updatedAt, 15000), 'worker_observation_mismatch', 'Exact recent unique worker session required');
  return observed;
}

function exactAgent(snapshot, target, allowUnavailable = false) {
  fail(snapshot?.protocol === 22 && typeof snapshot.version === 'string' &&
    ['agents', 'panes', 'tabs', 'workspaces', 'layouts'].every(key => Array.isArray(snapshot[key])),
    'invalid_herdr_snapshot', 'Expected Herdr protocol 22 snapshot');
  const overlaps = item => item.terminal_id === target.terminalId || item.pane_id === target.paneId || item.cwd === target.directory;
  const matches = snapshot.agents.filter(item => overlaps(item) || (item.agent_session?.agent === 'opencode' &&
    item.agent_session.kind === 'id' && item.agent_session.value === target.conversationId));
  const agent = matches[0];
  if (allowUnavailable) {
    const placement = item => item.pane_id === target.paneId && item.terminal_id === target.terminalId &&
      item.cwd === target.directory && item.workspace_id === target.workspaceId && item.tab_id === target.tabId &&
      (!item.foreground_cwd || item.foreground_cwd === target.directory);
    const compatible = item => placement(item) && (item.agent == null || item.agent === 'opencode') &&
      (item.agent_session == null || (item.agent_session.agent === 'opencode' && item.agent_session.kind === 'id' &&
        item.agent_session.value === target.conversationId));
    const panes = snapshot.panes.filter(overlaps);
    fail(panes.length <= 1 && panes.every(compatible), 'worker_observation_mismatch', 'Native pane was replaced or is ambiguous');
    // Absence is not replacement evidence. Contradictory IDs or placement are.
    fail(!(matches.length === 0 || (matches.length === 1 && compatible(agent) && agent.agent_session == null)),
      'worker_native_unavailable', 'Wait for the exact native session to be observed again');
  }
  fail(matches.length === 1 && agent.agent === 'opencode' && agent.agent_session?.agent === 'opencode' &&
    agent.agent_session.kind === 'id' && agent.agent_session.value === target.conversationId &&
    agent.pane_id === target.paneId && agent.terminal_id === target.terminalId && agent.cwd === target.directory &&
    agent.workspace_id === target.workspaceId && agent.tab_id === target.tabId &&
    (!agent.foreground_cwd || agent.foreground_cwd === target.directory),
  'worker_observation_mismatch', 'Socket inventory does not match the exact native session and terminal');
}

function summary(operation) {
  return { id: operation.id, key: operation.request.key, mode: operation.request.mode,
    state: operation.state, repository: operation.request.repository, directory: operation.request.directory,
    branch: operation.request.branch, baseCommit: operation.request.baseCommit,
    observedId: operation.target?.observedId ?? null, bindingId: operation.bindingId ?? null,
    step: operation.step ?? null, blocker: operation.blocker ?? null };
}

export async function inspectHerdrWorkers(store, bridge, config, deps = {}) {
  deps = { git, realpath, lstat, rpc, ...deps };
  const scope = scopeOf(config), binding = caller(store, bridge, scope);
  const candidates = [];
  let snapshot;
  for (const entry of config.workerRepositories ?? []) {
    try {
      const allowed = await repositoryScope(config, entry.repository, deps);
      const commonDirectory = await gitIdentity(allowed.repository, false, deps);
      await originRepository(bridge, commonDirectory, false, deps);
      snapshot ??= (await deps.rpc(scope.socketPath, 'session.snapshot', {})).snapshot;
      exactAgent(snapshot, targetFrom(store.operation(bridge.identity.observedId)));
      for (const observed of observedAgents(store).filter(item => inScope(item, scope) &&
        item.id !== bridge.identity.observedId && item.identity.harness === 'opencode' &&
        typeof item.placement?.directory === 'string' && beneath(allowed.worktreeRoot, item.placement.directory))) {
        try {
          const target = targetFrom(observed);
          exactObservation(store, scope, target); exactAgent(snapshot, target);
          const identity = await worktree({ ...allowed, directory: target.directory, commonDirectory, branch: null, trustRepository: false }, deps);
          fail(canonical(await repositoryScope(config, entry.repository, deps)) === canonical(allowed),
            'worker_repository_forbidden', 'Candidate scope changed during inspection');
          await originRepository(bridge, commonDirectory, false, deps);
          caller(store, bridge, scope);
          exactObservation(store, scope, target);
          const reserved = records(store).some(item => item.request.directory === target.directory && !(item.state === 'blocked' && item.disarmed));
          candidates.push({ observedId: observed.id, repository: entry.repository, directory: target.directory,
            branch: identity.branch, eligible: !reserved, linkedWorktree: true, preservesFiles: true, launchesAgent: false, reserved });
        } catch { /* Unverified directories are not adoption candidates. */ }
      }
    } catch { /* No repository authority means no candidate disclosure. */ }
  }
  caller(store, bridge, scope);
  fail(canonical(scopeOf(config)) === canonical(scope), 'worker_repository_forbidden', 'Inspection scope changed');
  return { candidates, workers: records(store).filter(item => canonical(item.scope) === canonical(scope) &&
    item.origin.bindingId === binding.id && item.origin.bindingCreatedAt === binding.createdAt &&
    item.origin.conversationId === bridge.identity.conversationId && item.origin.sessionCreatedAt === bridge.sessionCreatedAt).map(summary) };
}

export async function prepareHerdrWorker(store, bridge, input, config, deps = {}) {
  deps = { git, realpath, lstat, rpc, ...deps };
  const scope = scopeOf(config), binding = caller(store, bridge, scope, true);
  requireValue(input && typeof input === 'object' && Object.keys(input).every(key => fields.has(key)),
    'invalid_request', 'Only structured worker preparation fields are accepted');
  const source = input.source;
  fail(source && typeof source.id === 'string' && source.id.trim() && source.id.length <= 65536 &&
    typeof source.text === 'string' && source.text.trim() && source.text.length <= 16000 &&
    Number.isSafeInteger(source.createdAt) && source.createdAt >= bridge.sessionCreatedAt && source.createdAt <= Date.now() &&
    (source.role === undefined || source.role === 'user') && source.synthetic !== true && source.ignored !== true && !isNotificationSource(store, bridge, source.id) &&
    !store.runs(binding.id).some(run => run.invocation?.messageId === source.id),
  'invalid_worker_source', 'Worker preparation requires explicit native human text, not a notification or invocation');
  requireValue(['create', 'adopt'].includes(input.mode), 'invalid_request', 'Use create or adopt');
  requireValue(input.trustRepository === undefined || typeof input.trustRepository === 'boolean', 'invalid_request', 'trustRepository must be boolean');
  const selection = { key: singleLine(input.key, 'key'), mode: input.mode, repository: absolute(input.repository, 'repository'),
    branch: input.branch === undefined ? null : singleLine(input.branch, 'branch'),
    base: input.base === undefined ? null : singleLine(input.base, 'base'),
    label: input.label === undefined ? null : singleLine(input.label, 'label'),
    directory: input.directory === undefined ? null : absolute(input.directory, 'directory'),
    observedId: input.observedId === undefined ? null : singleLine(input.observedId, 'observedId'), trustRepository: input.trustRepository === true };
  requireValue(input.mode === 'adopt' ? selection.directory && selection.observedId && !selection.base : !selection.directory && !selection.observedId,
    'invalid_request', 'Adopt requires directory and observedId, without base; create chooses its own directory');
  const origin = { ...originIdentity(bridge, binding),
    sourceMessageId: source.id, sourceCreatedAt: source.createdAt, sourceDigest: digest(source.text) };
  const id = `herdr-worker:${digest([scope, binding.id, binding.createdAt, bridge.identity.conversationId, bridge.sessionCreatedAt, selection.key])}`;
  let active = preparations.get(store);
  if (!active) { active = new Set(); preparations.set(store, active); }
  fail(!active.has(id), 'operation_busy', 'Worker preparation already in progress');
  active.add(id);
  let operation;
  const check = () => {
    fail(canonical(scopeOf(config)) === canonical(scope) && canonical(caller(store, bridge, scope, true)) === canonical(binding),
      'bridge_identity_mismatch', 'Worker preparation origin changed');
    fail(!isNotificationSource(store, bridge, origin.sourceMessageId) &&
      !store.runs(binding.id).some(run => run.invocation?.messageId === origin.sourceMessageId),
    'invalid_worker_source', 'Worker source is no longer verified human input');
    return true;
  };
  try {
    const allowed = await repositoryScope(config, selection.repository, deps);
    const commonDirectory = await gitIdentity(allowed.repository, selection.trustRepository, deps);
    await originRepository(bridge, commonDirectory, selection.trustRepository, deps);
    check();
    operation = store.operation(id);
    if (operation) {
      fail(canonical(operation.selection) === canonical(selection) && canonical(operation.origin) === canonical(origin) &&
        canonical(operation.allowed) === canonical(allowed), 'worker_conflict', 'Worker key already has a different immutable request or origin');
      return summary(operation);
    }
    const branch = selection.branch ?? (selection.mode === 'create' ? `relay-worker-${digest(id).slice(0, 20)}` : null);
    fail(!branch?.startsWith('-') && !selection.base?.startsWith('-'), 'invalid_git_ref', 'Git refs cannot start with a dash');
    if (branch) await deps.git(allowed.repository, ['check-ref-format', `refs/heads/${branch}`], selection.trustRepository);
    const directory = selection.mode === 'create' ? join(allowed.worktreeRoot, `relay-worker-${digest(id).slice(0, 20)}`) : await deps.realpath(selection.directory);
    fail(beneath(allowed.worktreeRoot, directory), 'worker_directory_mismatch', 'Directory must be beneath the configured worktree root');
    const baseCommit = selection.mode === 'create' ? (await deps.git(allowed.repository,
      ['rev-parse', '--verify', '--end-of-options', `${selection.base ?? 'HEAD'}^{commit}`], selection.trustRepository)).trim() : null;
    fail(baseCommit === null || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit), 'invalid_git_ref', 'Base must resolve to a commit');
    const request = { ...selection, repository: allowed.repository, worktreeRoot: allowed.worktreeRoot,
      commonDirectory, directory, branch, baseCommit };
    let target, identity;
    if (selection.mode === 'adopt') {
      identity = await worktree(request, deps);
      const observed = store.operation(selection.observedId);
      fail(observed?.placement?.directory === directory, 'worker_observation_mismatch', 'Observed directory must be the exact worktree root');
      target = targetFrom(observed);
      fail(target.conversationId !== bridge.identity.conversationId && target.terminalId !== bridge.identity.terminalId,
        'worker_observation_mismatch', 'Choose a worker separate from the requesting conversation');
      exactObservation(store, scope, target);
    } else {
      let stat;
      try { stat = await deps.lstat(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fail(!stat, 'worker_path_occupied', 'Create never adopts an existing path');
      const refs = (await deps.git(allowed.repository, ['for-each-ref', '--format=%(refname)'], selection.trustRepository)).trim().split('\n');
      fail(!refs.includes(`refs/heads/${branch}`), 'worker_branch_occupied', 'Create requires a new branch');
    }
    const snapshot = (await deps.rpc(scope.socketPath, 'session.snapshot', {})).snapshot;
    check();
    exactAgent(snapshot, targetFrom(store.operation(bridge.identity.observedId)));
    if (target) { exactObservation(store, scope, target); exactAgent(snapshot, target); }
    fail(canonical(await repositoryScope(config, selection.repository, deps)) === canonical(allowed),
      'worker_repository_forbidden', 'Worker allowlist or realpaths changed');
    fail(await gitIdentity(allowed.repository, selection.trustRepository, deps) === commonDirectory,
      'worker_repository_mismatch', 'Repository identity changed before preparation');
    await originRepository(bridge, commonDirectory, selection.trustRepository, deps);
    check();
    operation = store.transaction(() => {
      fail(!store.operation(id), 'operation_busy', 'Worker preparation already recorded');
      fail(!records(store).some(item => !(item.state === 'blocked' && item.disarmed) && (item.request.directory === directory ||
        (branch && item.request.commonDirectory === commonDirectory && item.request.branch === branch))),
      'worker_conflict', 'Worktree or branch already reserved by a worker operation');
      return store.saveOperation({ id, runId: '', scope, allowed, selection, request, origin,
        supersedes: records(store).filter(item => item.state === 'blocked' && item.disarmed &&
          item.request.directory === directory && target && canonical(item.target) === canonical(target)).map(item => item.id),
        state: target ? 'prepared' : 'intent', target: target ?? null, worktreeIdentity: identity ?? null });
    });
    return summary(operation);
  } finally { active.delete(id); }
}

async function driveCreation(store, operation, config, deps, check, validate) {
  const { request, selection, scope, id } = operation;
  const { directory, branch, baseCommit } = request;
  if (operation.state === 'awaiting_native') {
    await validate();
    fail(canonical(await worktree(request, deps)) === canonical(operation.worktreeIdentity),
      'worker_repository_mismatch', 'Launched worktree identity changed');
    const snapshot = (await deps.rpc(scope.socketPath, 'session.snapshot', {})).snapshot;
    check(); exactAgent(snapshot, targetFrom(store.operation(operation.origin.identity.observedId)));
    const receipt = operation.startReceipt;
    const samePlacement = item => item.pane_id === receipt.paneId && item.terminal_id === receipt.terminalId &&
      item.workspace_id === receipt.workspaceId && item.tab_id === receipt.tabId && item.cwd === directory &&
      (!item.foreground_cwd || item.foreground_cwd === directory);
    const overlaps = item => item.pane_id === receipt.paneId || item.terminal_id === receipt.terminalId || item.cwd === directory;
    const panes = snapshot.panes.filter(overlaps);
    const agents = snapshot.agents.filter(item => overlaps(item) || item.name === receipt.name);
    const agent = agents[0];
    fail(panes.length === 1 && samePlacement(panes[0]) && agents.length === 1 && samePlacement(agent) &&
      agent.name === receipt.name && (agent.agent == null || agent.agent === receipt.kind) &&
      (panes[0].agent == null || panes[0].agent === receipt.kind),
    'worker_observation_mismatch', 'Launched worker placement or name was replaced or is ambiguous');
    const session = agent.agent_session;
    if (session == null) return store.saveOperation({ ...operation, blocker: 'native_session_unavailable' });
    fail(agent.agent === 'opencode' && session.agent === 'opencode' && session.kind === 'id' &&
      typeof session.value === 'string' && session.value && (!receipt.conversationId || receipt.conversationId === session.value) &&
      snapshot.agents.filter(item => item.agent_session?.agent === 'opencode' && item.agent_session.kind === 'id' &&
        item.agent_session.value === session.value).length === 1,
    'worker_observation_mismatch', 'Expected one exact native OpenCode session for the launch');
    const observedIdentity = { companyId: scope.companyId, machineId: scope.machineId, session: scope.session,
      harness: 'opencode', sessionKind: 'id', conversationId: session.value };
    const target = { ...operation.createReceipt, observedId: `herdr-agent:${digest(observedIdentity)}`, conversationId: session.value };
    exactAgent(snapshot, target);
    await validate(); check();
    return store.saveOperation({ ...operation, state: 'prepared', step: null, blocker: null, target });
  }
  if (operation.state === 'intent') {
    await validate();
    let stat;
    try { stat = await deps.lstat(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fail(!stat, 'worker_path_occupied', 'Create never adopts an existing path');
    const refs = (await deps.git(request.repository, ['for-each-ref', '--format=%(refname)'], request.trustRepository)).trim().split('\n');
    fail(!refs.includes(`refs/heads/${branch}`), 'worker_branch_occupied', 'Create requires a new branch');
    const snapshot = (await deps.rpc(scope.socketPath, 'session.snapshot', {})).snapshot;
    check(); exactAgent(snapshot, targetFrom(store.operation(operation.origin.identity.observedId)));
    await validate(); check();
    // Persist uncertainty BEFORE dispatch. Even a server error can follow a mutation.
    operation = store.saveOperation({ ...operation, state: 'uncertain', step: 'worktree.create' });
    const created = await deps.rpc(scope.socketPath, 'worktree.create', { cwd: request.repository, path: directory,
      branch, base: baseCommit, label: selection.label ?? `Relay ${branch}`, focus: false, trust_repository: selection.trustRepository });
    check();
    const pane = created.root_pane;
    fail(created.type === 'worktree_created' && created.worktree?.path === directory && created.worktree.is_linked_worktree === true &&
      created.worktree.is_bare === false && created.worktree.is_prunable === false && created.worktree.is_detached === false &&
      [branch, `refs/heads/${branch}`].includes(created.worktree.branch) &&
      pane && ['pane_id', 'terminal_id', 'workspace_id', 'tab_id'].every(key => typeof pane[key] === 'string' && pane[key]) &&
      pane.cwd === directory && pane.workspace_id === created.workspace?.workspace_id && pane.tab_id === created.tab?.tab_id,
    'invalid_worker_receipt', 'Herdr worktree receipt does not match the request');
    const identity = await worktree(request, deps);
    fail((await deps.git(directory, ['rev-parse', '--verify', 'HEAD'], selection.trustRepository)).trim() === baseCommit,
      'worker_base_mismatch', 'Created worktree does not match the pinned base commit');
    const receipt = { directory, paneId: pane.pane_id, terminalId: pane.terminal_id, workspaceId: pane.workspace_id, tabId: pane.tab_id };
    operation = store.saveOperation({ ...operation, state: 'created', step: null, createReceipt: receipt, worktreeIdentity: identity });
  }
  if (operation.state === 'created') {
    await validate();
    const receipt = operation.createReceipt;
    const beforeStart = (await deps.rpc(scope.socketPath, 'session.snapshot', {})).snapshot;
    check();
    exactAgent(beforeStart, targetFrom(store.operation(operation.origin.identity.observedId)));
    const shells = beforeStart.panes.filter(item => item.pane_id === receipt.paneId || item.terminal_id === receipt.terminalId);
    fail(shells.length === 1 && shells[0].pane_id === receipt.paneId && shells[0].terminal_id === receipt.terminalId &&
      shells[0].workspace_id === receipt.workspaceId && shells[0].tab_id === receipt.tabId && shells[0].cwd === directory &&
      !shells[0].agent && !beforeStart.agents.some(item => item.terminal_id === receipt.terminalId && item.agent),
    'worker_observation_mismatch', 'Created shell placement changed before launch');
    fail(canonical(await worktree(request, deps)) === canonical(operation.worktreeIdentity),
      'worker_repository_mismatch', 'Worktree identity changed before launch');
    fail((await deps.git(directory, ['rev-parse', '--verify', 'HEAD'], selection.trustRepository)).trim() === baseCommit,
      'worker_base_mismatch', 'Worktree HEAD changed before launch');
    await validate();
    check();
    operation = store.saveOperation({ ...operation, state: 'uncertain', step: 'agent.start' });
    const name = `relay-${digest(id).slice(0, 20)}`;
    const started = await deps.rpc(scope.socketPath, 'agent.start', { pane_id: receipt.paneId, name, kind: 'opencode',
      args: ['--agent', 'build', '--prompt', standby], timeout_ms: 30000 });
    const agent = started.agent;
    const session = agent?.agent_session;
    fail(started.type === 'agent_started' && agent?.name === name && (agent.agent == null || agent.agent === 'opencode') &&
      agent.pane_id === receipt.paneId && agent.terminal_id === receipt.terminalId && agent.cwd === directory &&
      agent.workspace_id === receipt.workspaceId && agent.tab_id === receipt.tabId &&
      (!agent.foreground_cwd || agent.foreground_cwd === directory) &&
      (session == null || (session.agent === 'opencode' && session.kind === 'id' && typeof session.value === 'string' && session.value)),
    'invalid_worker_receipt', 'Herdr start receipt does not match the exact requested launch');
    // Raw agent.start acknowledges submission, not native readiness. Journal the
    // receipt before live-origin checks or any further I/O, without persisting argv.
    operation = store.saveOperation({ ...operation, state: 'awaiting_native', step: 'session.snapshot', blocker: null,
      startReceipt: { ...receipt, name, kind: 'opencode', conversationId: session?.value ?? null } });
    check();
  }
  return operation;
}

export async function reconcileHerdrWorkers(store, directory, api, config, locks = new Map(), deps = {}) {
  deps = { git, realpath, lstat, rpc, ...deps };
  if (reconciliations.has(store) || locks.has('herdr-workers')) return [];
  reconciliations.add(store);
  const pending = Promise.resolve().then(async () => {
    const scope = scopeOf(config), results = [];
    for (let operation of records(store)) {
      if (operation.state === 'uncertain' || (operation.state === 'blocked' && operation.disarmed)) continue;
      const creating = ['intent', 'created', 'awaiting_native'].includes(operation.state);
      if (!creating && locks.has('observed-delivery')) continue;
      if (!creating) locks.set('observed-delivery', pending);
      const revoke = async () => {
        const bindingId = operation.bindingId ?? (operation.target && `observed-${digest(operation.target.observedId).slice(0, 24)}`);
        const bridge = bindingId && store.operation(`opencode-bridge:${bindingId}`);
        operation = store.saveOperation({ ...operation, state: 'blocked', blocker: 'grant_revoked', disarmed: false });
        if (!bridge) { operation = store.saveOperation({ ...operation, disarmed: true }); return; }
        // This is withdrawal of our exact grant, not a new action authorised by
        // the (possibly invalid) caller. Never transfer control to a new target.
        const safe = () => {
          const current = store.operation(bridge.id), binding = store.binding(bindingId);
          fail(current && canonical(current.identity) === canonical(bridge.identity) &&
            bridge.identity.observedId === operation.target.observedId && bridge.identity.directory === operation.target.directory &&
            bridge.identity.conversationId === operation.target.conversationId &&
            (!operation.targetBinding || canonical(operation.targetBinding) === canonical(binding)) &&
            store.runs(bindingId).every(run => run.nativeState === 'settled'),
          'worker_bridge_conflict', 'Unsettled or replaced target prevents disarm');
          return true;
        };
        safe();
        if (bridge.state !== 'configured' || !bridge.backendPaused) await disarmBridge(store, api, { bindingId }, safe);
        safe();
        operation = store.saveOperation({ ...operation, disarmed: true });
      };
      try {
        if (operation.state === 'blocked') { await revoke(); results.push(summary(operation)); continue; }
        const initialOrigin = store.operation(operation.origin.bridgeId);
        // Epoch is a live-call fence, never persisted as durable authority.
        const callProof = initialOrigin && proof(initialOrigin);
        const check = () => {
          fail(canonical(scopeOf(config)) === canonical(operation.scope) && config.workerRepositories?.filter(item =>
            item.repository === operation.selection.repository).length === 1 && config.workerRepositories.some(item =>
            canonical(item) === canonical(operation.allowed.allowed)), 'worker_repository_forbidden', 'Worker scope revoked');
          const origin = store.operation(operation.origin.bridgeId);
          fail(origin && proof(origin) === callProof, 'bridge_identity_mismatch', 'Origin changed during reconciliation');
          const binding = caller(store, origin, operation.scope, operation.state !== 'armed', false);
          const { sourceMessageId, sourceCreatedAt, sourceDigest, ...identity } = operation.origin;
          fail(canonical(originIdentity(origin, binding)) === canonical(identity),
            'bridge_identity_mismatch', 'Origin binding changed');
          const observedOrigin = store.operation(origin.identity.observedId);
          fail(fresh(origin.lastSeen, 10000) && observedOrigin.availability === 'present' &&
            !observedOrigin.error && fresh(observedOrigin.updatedAt, 15000),
          'worker_origin_unavailable', 'Wait for the exact origin to reconnect');
          fail(!isNotificationSource(store, origin, sourceMessageId) &&
            !store.runs(binding.id).some(run => run.invocation?.messageId === sourceMessageId),
          'invalid_worker_source', 'Worker grant source changed');
          return true;
        };
        const validate = async () => {
          check();
          const allowed = await repositoryScope(config, operation.selection.repository, deps);
          fail(canonical(allowed) === canonical(operation.allowed), 'worker_repository_forbidden', 'Worker scope changed');
          fail(await gitIdentity(operation.request.repository, operation.request.trustRepository, deps) === operation.request.commonDirectory,
            'worker_repository_mismatch', 'Repository identity changed');
          await originRepository(initialOrigin, operation.request.commonDirectory, operation.request.trustRepository, deps);
          check();
        };
        await validate();
        if (creating) {
          operation = await driveCreation(store, operation, config, deps, check, validate);
          results.push(summary(operation)); continue;
        }
        fail(canonical(await worktree(operation.request, deps)) === canonical(operation.worktreeIdentity),
          'worker_repository_mismatch', 'Worker worktree identity changed');
        const snapshot = (await deps.rpc(scope.socketPath, 'session.snapshot', {})).snapshot;
        exactAgent(snapshot, operation.target, true);
        exactAgent(snapshot, targetFrom(store.operation(operation.origin.identity.observedId)), true);
        const enrol = () => {
          check();
          const observed = exactObservation(store, scope, operation.target);
          const historical = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'opencode-bridge:%'").all()
            .map(row => JSON.parse(row.data)).filter(item => item.identity.directory === operation.request.directory);
          const bindingId = `observed-${digest(observed.id).slice(0, 24)}`;
          fail(historical.every(item => item.identity.bindingId === bindingId ||
            (item.state !== 'armed' && store.runs(item.identity.bindingId).every(run => run.nativeState === 'settled'))),
          'worker_bridge_conflict', 'Another bridge owns this directory');
          return true;
        };
        enrol();
        const bindingId = `observed-${digest(operation.target.observedId).slice(0, 24)}`;
        let bridge = store.operation(`opencode-bridge:${bindingId}`);
        if (!bridge) await configureBridge(store, directory, api, { observedId: operation.target.observedId, reserved: true }, enrol);
        enrol();
        bridge = store.operation(`opencode-bridge:${bindingId}`);
        fail(bridge.identity.bindingId === bindingId && bridge.identity.observedId === operation.target.observedId &&
          bridge.identity.directory === operation.target.directory && bridge.identity.terminalId === operation.target.terminalId &&
          bridge.identity.conversationId === operation.target.conversationId, 'worker_bridge_conflict', 'Worker bridge identity changed');
        const targetBinding = store.binding(bindingId);
        fail(!operation.targetBinding || canonical(operation.targetBinding) === canonical(targetBinding),
          'worker_bridge_conflict', 'Worker binding changed');
        fail(!operation.targetCreatedAt || operation.targetCreatedAt === bridge.sessionCreatedAt,
          'worker_bridge_conflict', 'Worker native session was replaced');
        if (operation.state === 'armed') {
          fail(bridge.state === 'armed', 'worker_bridge_conflict', 'Worker grant was explicitly disarmed');
          operation = store.saveOperation({ ...operation, blocker: !fresh(bridge.lastSeen, 10000) ? 'plugin_unavailable' :
            bridge.ready !== true ? 'native_busy' : null });
          results.push(summary(operation)); continue;
        }
        let state = 'configured', blocker = 'plugin_unavailable';
        if (bridge.epoch && fresh(bridge.lastSeen, 10000)) {
          blocker = 'native_busy';
          if (bridge.ready === true && store.runs(bindingId).every(run => run.nativeState === 'settled')) {
            await armBridge(store, directory, api, { bindingId }, () => {
              enrol();
              // armBridge also reports session recreation as bridge_unavailable;
              // that is replacement evidence, not a retryable readiness race.
              fail(store.operation(bridge.id)?.sessionCreatedAt === bridge.sessionCreatedAt,
                'worker_bridge_conflict', 'Worker native session was replaced during arming');
              return true;
            });
            enrol(); state = 'armed'; blocker = null;
          }
        }
        operation = store.saveOperation({ ...operation, state, bindingId, blocker, targetBinding,
          targetCreatedAt: bridge.sessionCreatedAt ?? null });
      } catch (error) {
        operation = store.operation(operation.id);
        if (operation.state === 'uncertain') {
          operation = store.saveOperation({ ...operation, blocker: 'manual_recovery_required' });
        } else if (error.code === 'herdr_rpc_failed') {
          operation = store.saveOperation({ ...operation, blocker: 'native_snapshot_unavailable' });
        } else if (error.code === 'worker_native_unavailable') {
          operation = store.saveOperation({ ...operation, blocker: 'native_session_unavailable' });
        } else if (error.code === 'bridge_unavailable') {
          operation = store.saveOperation({ ...operation, blocker: 'plugin_unavailable' });
        } else if (['conversation_busy', 'worker_origin_unavailable'].includes(error.code) || (operation.state === 'prepared' && error.code === 'worker_observation_mismatch' &&
          !store.operation(`opencode-bridge:observed-${digest(operation.target.observedId).slice(0, 24)}`))) {
          operation = store.saveOperation({ ...operation, blocker: 'enrolment_blocked' });
        } else {
          try { await revoke(); } catch {
            operation = store.saveOperation({ ...operation, state: 'blocked', disarmed: false, blocker: 'disarm_pending' });
          }
        }
      } finally {
        if (locks.get('observed-delivery') === pending) locks.delete('observed-delivery');
      }
      results.push(summary(operation));
    }
    return results;
  });
  locks.set('herdr-workers', pending);
  try { return await pending; } finally {
    reconciliations.delete(store);
    if (locks.get('herdr-workers') === pending) locks.delete('herdr-workers');
  }
}
