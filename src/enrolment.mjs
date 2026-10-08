import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { observedAgents } from './herdr-agents.mjs';
import { isNotificationSource } from './completion-notifications.mjs';
import { canonical, digest, requireValue, text } from './protocol.mjs';

// The service authenticates operator calls, or polls the authenticated native
// bridge and verifies permission/latest human input before passing it here.
// Only the background reconciler may configure or arm the resulting reservation.
const fields = new Set(['key', 'directory', 'observedId', 'reserved', 'source', 'companyId']);
const fail = (condition, code, message) => requireValue(condition, code, message, 409);
const fresh = (value, limit) => Date.now() - Date.parse(value) >= 0 && Date.now() - Date.parse(value) < limit;
const exactPath = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value &&
  !/[\x00-\x1f\x7f-\x9f*]/.test(value);
const line = (value, name) => {
  value = text(value, name);
  requireValue(value.length <= 4096 && value === value.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(value),
    'invalid_request', `${name} must be exact single-line text`);
  return value;
};
const scopeOf = config => {
  requireValue(config && exactPath(config.socketPath), 'invalid_request', 'An exact configured Herdr socket is required');
  return { socketPath: config.socketPath, companyId: line(config.companyId, 'companyId'),
    machineId: line(config.machineId, 'machineId'), session: line(config.session, 'session') };
};
const inScope = (observed, scope) => observed?.identity?.companyId === scope.companyId &&
  observed.identity.machineId === scope.machineId && observed.identity.session === scope.session;
const records = (store, prefix) => store.db.prepare('SELECT data FROM operations WHERE id LIKE ? ORDER BY rowid')
  .all(`${prefix}:%`).map(row => JSON.parse(row.data));
const bindingId = observedId => `observed-${digest(observedId).slice(0, 24)}`;
const clean = value => typeof value === 'string'
  ? stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) : null;

async function inspectDirectory(directory) {
  fail((await lstat(directory)).isDirectory(), 'invalid_directory', 'An existing regular directory is required');
  const canonicalPath = await realpath(directory);
  fail(canonicalPath === directory, 'invalid_directory', 'Use the exact canonical directory, not a symlink or alias');
  // Do not inherit Git retargeting or config injection, and never trust a new repository implicitly.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), LC_ALL: 'C' };
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)('git', ['-c', 'safe.directory=', '-C', directory,
      'rev-parse', '--path-format=absolute', '--git-common-dir', '--absolute-git-dir'],
    { env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    const notRepository = /^fatal: not a git repository(?: \(or any of the parent directories\))?: \.git\s*$/.test(error.stderr ?? '') ||
      /^fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\s*$/.test(error.stderr ?? '');
    if (error.code === 128 && notRepository) {
      return { canonical: canonicalPath, linked: false };
    }
    fail(false, 'directory_inspection_failed', 'Git directory identity could not be verified');
  }
  const paths = stdout.trim().split('\n');
  fail(paths.length === 2 && paths.every(isAbsolute), 'directory_inspection_failed', 'Git returned an invalid directory identity');
  return { canonical: canonicalPath, linked: await realpath(paths[0]) !== await realpath(paths[1]) };
}

export function enrolmentDirectories(store, config) {
  const scope = scopeOf(config);
  const recorded = records(store, 'directory-enrolment').filter(item => item.state === 'recorded' &&
    canonical(item.scope) === canonical(scope) && item.request?.reserved === true).map(item => item.request.directory);
  const workers = new Set(records(store, 'herdr-worker').flatMap(item => [item.request?.directory, item.target?.directory]));
  return [...new Set([...(config.bridgeDirectories ?? []), ...recorded].filter(path => exactPath(path) && !workers.has(path)))];
}

function statusFor(store, scope, directory, observedId) {
  const operation = store.operation('bridge-enrolment');
  const result = (!operation?.scope || canonical(operation.scope) === canonical(scope)) &&
    operation?.results?.find(item => item.directory === directory && (!item.bindingId || item.bindingId === bindingId(observedId)));
  const bridge = store.operation(`opencode-bridge:${bindingId(observedId)}`);
  const observed = store.operation(observedId);
  const live = bridge?.identity?.observedId === observedId && bridge.identity.directory === directory &&
    bridge.epoch && fresh(bridge.lastSeen, 10000) && inScope(observed, scope) &&
    observed.availability === 'present' && !observed.error && fresh(observed.updatedAt, 15000) &&
    observed.placement?.directory === directory && observed.placement.terminalId === bridge.identity.terminalId &&
    observed.identity.conversationId === bridge.identity.conversationId;
  return { status: clean(result?.state), blocker: clean(result?.blocker ?? result?.error),
    ready: Boolean(result?.ready === true && live && bridge.state === 'armed' && bridge.ready === true) };
}

export function enrolmentCandidates(store, config) {
  const scope = scopeOf(config), directories = enrolmentDirectories(store, config);
  return observedAgents(store).filter(item => inScope(item, scope) && item.identity.harness === 'opencode' &&
    item.identity.sessionKind === 'id' && item.availability === 'present' && fresh(item.updatedAt, 15000) &&
    exactPath(item.placement?.directory)).map(item => ({ observedId: item.id, directory: item.placement.directory,
    label: clean(item.observation?.display?.name), availability: item.availability, state: clean(item.observation?.state),
    enrolled: directories.includes(item.placement.directory), ...statusFor(store, scope, item.placement.directory, item.id) }));
}

function nativeOrigin(store, bridge, scope, source) {
  const live = store.operation(bridge?.id);
  const proof = value => value && [value.identity, value.tokenHash, value.epoch, value.sessionCreatedAt, value.controlRevision ?? 0];
  fail(live && ['configured', 'armed'].includes(live.state) && canonical(proof(live)) === canonical(proof(bridge)) &&
    live.id === `opencode-bridge:${live.identity?.bindingId}` && typeof live.tokenHash === 'string' && live.tokenHash &&
    typeof live.epoch === 'string' && live.epoch && fresh(live.lastSeen, 10000) &&
    Number.isSafeInteger(live.sessionCreatedAt) && live.sessionCreatedAt > 0,
  'bridge_identity_mismatch', 'An exact configured native bridge with a fresh poll is required');
  const binding = store.binding(live.identity.bindingId, false), observed = store.operation(live.identity.observedId);
  fail(binding && !binding.lifecycleState && binding.config.companyId === scope.companyId &&
    binding.config.harness === 'opencode' && binding.config.delivery === 'pull' &&
    binding.config.instanceId === digest([scope.machineId, scope.session]) && binding.config.agentId === observed?.agentId &&
    binding.config.conversationId === live.identity.conversationId && inScope(observed, scope) &&
    observed.identity.harness === 'opencode' && observed.identity.sessionKind === 'id' &&
    observed.identity.conversationId === live.identity.conversationId && observed.availability === 'present' &&
    !observed.error && fresh(observed.updatedAt, 15000) && observed.placement?.directory === live.identity.directory &&
    observed.placement.terminalId === live.identity.terminalId,
  'bridge_identity_mismatch', 'Native binding, conversation or placement changed');
  fail(store.runs(binding.id).every(run => run.nativeState === 'settled'),
    'conversation_busy', 'Relay work must settle before granting a directory reservation');
  fail(source && typeof source.id === 'string' && source.id.trim() && source.id.length <= 65536 &&
    typeof source.text === 'string' && source.text.trim() && source.text.length <= 16000 &&
    Number.isSafeInteger(source.createdAt) && source.createdAt >= live.sessionCreatedAt && source.createdAt <= Date.now() &&
    (source.role === undefined || source.role === 'user') && source.synthetic !== true && source.ignored !== true &&
    !isNotificationSource(store, live, source.id) && !store.runs().some(run => run.invocation?.messageId === source.id) &&
    !store.runs(binding.id).some(run => run.invocation?.priorUserIds?.includes(source.id)),
  'invalid_enrolment_source', 'Explicit native human input, not a notification or Relay invocation/history, is required');
  return { kind: 'native', bindingId: binding.id, bindingCreatedAt: binding.createdAt, bindingRevision: binding.revision,
    bindingConfig: digest(binding.config), conversationId: live.identity.conversationId, sessionCreatedAt: live.sessionCreatedAt,
    sourceMessageId: source.id, sourceCreatedAt: source.createdAt, sourceDigest: digest(source.text) };
}

export async function enrolAgent(store, config, input, { bridge, ...deps } = {}) {
  const scope = scopeOf(config);
  requireValue(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => fields.has(key)),
    'invalid_request', 'Only structured enrolment fields are accepted');
  requireValue(input.companyId === undefined || input.companyId === scope.companyId,
    'company_mismatch', 'Enrolment must belong to the configured company', 403);
  requireValue(input.reserved === true, 'reservation_required', 'Explicit standing directory reservation is required');
  const request = { key: line(input.key, 'key'), directory: line(input.directory, 'directory'), reserved: true,
    ...(input.observedId === undefined ? {} : { observedId: line(input.observedId, 'observedId') }) };
  requireValue(exactPath(request.directory), 'invalid_directory', 'Use one exact absolute directory, without wildcards or aliases');
  requireValue(bridge || input.source === undefined, 'invalid_enrolment_source', 'Native source requires an authenticated bridge');
  const origin = bridge ? nativeOrigin(store, bridge, scope, input.source) : { kind: 'operator' };
  const owner = origin.kind === 'operator' ? origin : { kind: origin.kind, bindingId: origin.bindingId,
    bindingCreatedAt: origin.bindingCreatedAt, conversationId: origin.conversationId, sessionCreatedAt: origin.sessionCreatedAt };
  const id = `directory-enrolment:${digest([scope, owner, request.key])}`;
  const receipt = operation => ({ enrolmentId: operation.id, directory: operation.request.directory, state: 'requested',
    observedId: operation.observedId, alreadyConfigured: (config.bridgeDirectories ?? []).includes(operation.request.directory),
    ...statusFor(store, scope, operation.request.directory, operation.observedId) });
  const previous = () => {
    const operation = store.operation(id);
    if (!operation) return null;
    fail(operation.state === 'recorded' && canonical(operation.scope) === canonical(scope) &&
      canonical(operation.request) === canonical(request) && canonical(operation.origin) === canonical(origin),
    'enrolment_conflict', 'Enrolment key already has a different immutable request or source');
    return receipt(operation);
  };
  // A standing directory grant survives chat replacement. Never reselect a target
  // or rewrite the original payload when acknowledging an unchanged retry.
  const existing = previous();
  if (existing) return existing;
  const select = () => {
    const matches = observedAgents(store).filter(item => inScope(item, scope) && item.identity.harness === 'opencode' &&
      item.identity.sessionKind === 'id' && item.placement?.directory === request.directory && item.availability !== 'offline');
    fail(matches.length <= 1, 'bridge_candidates_ambiguous', 'Multiple current or uncertain OpenCode observations occupy this directory');
    const target = matches[0];
    fail(target && target.availability === 'present' && !target.error && target.agentId &&
      typeof target.placement.terminalId === 'string' && target.placement.terminalId && fresh(target.updatedAt, 15000),
    'agent_not_ready', 'One recent present OpenCode registration is required');
    fail(request.observedId === undefined || request.observedId === target.id,
      'enrolment_observation_mismatch', 'Observed ID must match the exact current directory candidate');
    return target;
  };
  const target = select();
  const identity = item => [item.id, item.identity, item.agentId, item.marker, item.placement];
  const check = () => {
    fail(canonical(scopeOf(config)) === canonical(scope), 'enrolment_scope_changed', 'Configured enrolment scope changed');
    if (bridge) fail(canonical(nativeOrigin(store, bridge, scope, input.source)) === canonical(origin),
      'bridge_identity_mismatch', 'Native origin or human source changed');
    fail(canonical(identity(select())) === canonical(identity(target)),
      'enrolment_observation_mismatch', 'Directory candidate changed during enrolment');
    fail(!records(store, 'herdr-worker').some(item => item.request?.directory === request.directory ||
      item.target?.directory === request.directory), 'worker_directory_reserved', 'Use worker_prepare adoption for worker directories, including blocked workers');
    const ids = new Set([bindingId(target.id)]);
    for (const item of records(store, 'opencode-bridge')) {
      if (item.identity?.directory === request.directory && inScope(store.operation(item.identity.observedId), scope)) ids.add(item.identity.bindingId);
    }
    for (const item of observedAgents(store)) {
      if (inScope(item, scope) && item.placement?.directory === request.directory) ids.add(bindingId(item.id));
    }
    fail([...ids].every(id => store.runs(id).every(run => run.nativeState === 'settled')),
      'work_unsettled', 'All prior Relay work in this directory must settle before a new grant');
    fail([...ids].every(id => {
      const permit = store.operation(`observed-pull:${id}`);
      return !permit || permit.state === 'closed';
    }), 'reservation_conflict', 'Close manual-pull reservations in this directory first');
  };
  check();
  const inspected = await (deps.inspectDirectory ?? inspectDirectory)(request.directory);
  fail(inspected?.canonical === request.directory && typeof inspected.linked === 'boolean',
    'invalid_directory', 'Directory must be existing, canonical and unaliased');
  fail(!inspected.linked, 'linked_worktree_forbidden', 'Use worker_prepare adoption for linked Git worktrees');
  return store.transaction(() => {
    check();
    const concurrent = previous();
    if (concurrent) return concurrent;
    return receipt(store.saveOperation({ id, runId: '', state: 'recorded', scope, request, origin, observedId: target.id }));
  });
}
