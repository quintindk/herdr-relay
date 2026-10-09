import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical, digest, requireValue, text } from './protocol.mjs';
import { workerContext, promptFor } from './supervisor.mjs';
import { observe } from './opencode.mjs';
import { assertRoutineTask } from './routine-execution.mjs';

export function bridgeForToken(store, token) {
  return store.db.prepare("SELECT data FROM operations WHERE id LIKE 'opencode-bridge:%'").all()
    .map(row => JSON.parse(row.data)).find(item => item.tokenHash === digest(token));
}

function observation(store, observedId, previous) {
  const observed = store.operation(text(observedId, 'observedId'));
  requireValue(observed?.identity?.harness === 'opencode' && observed.identity.sessionKind === 'id' &&
    observed.availability === 'present' && !observed.error && Date.now() - Date.parse(observed.updatedAt) < 15000,
  'agent_not_ready', 'Recent unique OpenCode observation required', 409);
  if (previous) requireValue(canonical(observed.identity) === canonical(previous.identity) &&
    observed.agentId === previous.agentId && observed.marker === previous.marker &&
    observed.placement?.directory === previous.placement?.directory && observed.placement?.terminalId === previous.placement?.terminalId,
  'bridge_identity_mismatch', 'Herdr identity changed during bridge configuration', 409);
  return observed;
}

function unchangedBridge(store, id, previous) {
  const bridge = store.operation(id);
  const version = item => item && [item.identity, item.tokenHash, item.state, item.controlRevision ?? 0];
  requireValue(canonical(version(bridge)) === canonical(version(previous)), 'bridge_conflict', 'Bridge configuration changed', 409);
  return bridge;
}

function settled(store, bindingId) {
  requireValue(store.runs(bindingId).every(run => run.nativeState === 'settled'), 'work_unsettled', 'Unsettled work blocks bridge configuration', 409);
}

export async function configureBridge(store, directory, api, input, current = () => true) {
  requireValue(input.reserved === true, 'reservation_required', 'Reserve the conversation for Relay before configuring the bridge');
  const observed = observation(store, input.observedId);
  const bindingId = `observed-${digest(observed.id).slice(0, 24)}`;
  const id = `opencode-bridge:${bindingId}`;
  const previous = store.operation(id);
  const check = () => {
    requireValue(current(), 'bridge_identity_mismatch', 'Bridge enrolment is no longer current', 409);
    observation(store, observed.id, observed);
    unchangedBridge(store, id, previous);
    const permit = store.operation(`observed-pull:${bindingId}`);
    requireValue(!permit || permit.state === 'closed', 'reservation_conflict', 'Close the manual-pull reservation first', 409);
    settled(store, bindingId);
  };
  check();
  const backend = await api('GET', `/api/agents/${observed.agentId}`);
  check();
  requireValue(backend.adapterType === 'herdr_relay' && backend.companyId === observed.identity.companyId &&
    backend.adapterConfig?.relayObservationMarker === observed.marker, 'agent_identity_mismatch', 'Backend observation changed', 409);
  const identity = { observedId: observed.id, bindingId, conversationId: observed.identity.conversationId,
    directory: observed.placement.directory, terminalId: observed.placement.terminalId };
  if (previous) requireValue(canonical(previous.identity) === canonical(identity), 'bridge_conflict', 'Bridge identity changed', 409);
  const binding = store.binding(bindingId, false) ?? store.register({ id: bindingId, companyId: observed.identity.companyId,
    agentId: observed.agentId, harness: 'opencode', instanceId: digest([observed.identity.machineId, observed.identity.session]),
    conversationId: observed.identity.conversationId, delivery: 'pull', label: observed.observation.display.name }).binding;
  requireValue(!binding.lifecycleState && binding.config.companyId === observed.identity.companyId && binding.config.harness === 'opencode' &&
    binding.config.instanceId === digest([observed.identity.machineId, observed.identity.session]) &&
    binding.config.conversationId === identity.conversationId && binding.config.delivery === 'pull' && binding.config.agentId === observed.agentId,
    'binding_conflict', 'Existing binding is incompatible', 409);
  const worker = workerContext(directory, join(directory, 'relay.sock'), store, binding);
  const parent = join(directory, 'bridges'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, `${bindingId}.json`);
  const token = previous ? JSON.parse(readFileSync(path, 'utf8')).token : randomBytes(32).toString('hex');
  if (previous) requireValue(previous.tokenHash === digest(token), 'bridge_conflict', 'Bridge credential file changed');
  if (!previous) {
    requireValue(!existsSync(path), 'bridge_conflict', 'Unowned bridge credential file exists');
    writeFileSync(path, JSON.stringify({ ...identity, socketPath: join(directory, 'relay.sock'), token }), { flag: 'wx', mode: 0o600 });
    store.saveOperation({ id, runId: '', identity, tokenHash: digest(token), workerContext: worker, state: 'configured' });
  }
  return { bindingId, bridgeConfigFile: path, state: store.operation(id).state, restartRequired: true };
}

export async function armBridge(store, directory, api, input, current = () => true) {
  const id = `opencode-bridge:${text(input.bindingId, 'bindingId')}`;
  let bridge = store.operation(id);
  requireValue(bridge && Date.now() - Date.parse(bridge.lastSeen) < 10000 && bridge.epoch && bridge.ready,
    'bridge_unavailable', 'The bridge plugin must report ready from the reserved conversation first', 409);
  const binding = store.binding(input.bindingId);
  const observed = observation(store, bridge.identity.observedId);
  const check = () => {
    requireValue(current(), 'bridge_identity_mismatch', 'Bridge enrolment is no longer current', 409);
    const latest = unchangedBridge(store, id, bridge);
    observation(store, observed.id, observed);
    requireValue(canonical(store.binding(binding.id)) === canonical(binding) && !binding.lifecycleState &&
      binding.config.agentId === observed.agentId && binding.config.companyId === observed.identity.companyId &&
      binding.config.conversationId === bridge.identity.conversationId && binding.config.delivery === 'pull' &&
      observed.identity.conversationId === bridge.identity.conversationId && observed.placement.directory === bridge.identity.directory &&
      observed.placement.terminalId === bridge.identity.terminalId,
    'bridge_identity_mismatch', 'Herdr placement or binding changed', 409);
    requireValue(latest.epoch === bridge.epoch && latest.sessionCreatedAt === bridge.sessionCreatedAt && latest.ready &&
      Date.now() - Date.parse(latest.lastSeen) < 10000, 'bridge_unavailable', 'Plugin readiness changed', 409);
    settled(store, binding.id);
    return latest;
  };
  check();
  const backend = await api('GET', `/api/agents/${binding.config.agentId}`);
  check();
  requireValue(backend.companyId === binding.config.companyId && backend.adapterConfig?.relayObservationMarker === observed.marker &&
    backend.adapterType === 'herdr_relay', 'agent_identity_mismatch', 'Backend adapter changed', 409);
  const operatorFile = join(directory, 'adapter-context.json');
  const heartbeat = backend.runtimeConfig?.heartbeat;
  if (bridge.state === 'armed' && backend.status !== 'paused' && backend.adapterConfig.observationOnly === false &&
    backend.adapterConfig.bindingId === binding.id && backend.adapterConfig.bindingRevision === binding.revision &&
    backend.adapterConfig.relayContextFile === operatorFile && backend.adapterConfig.requireReviewDisposition === true &&
    backend.adapterConfig.timeoutSec === 600 && heartbeat?.enabled === true && heartbeat.wakeOnDemand === true &&
    heartbeat.intervalSec === 0 && heartbeat.maxConcurrentRuns === 1) {
    return { bindingId: binding.id, state: 'armed' };
  }
  const context = JSON.stringify({ socketPath: join(directory, 'relay.sock'), token: readFileSync(join(directory, 'admin-token'), 'utf8').trim() });
  if (!existsSync(operatorFile)) writeFileSync(operatorFile, context, { flag: 'wx', mode: 0o600 });
  else requireValue(readFileSync(operatorFile, 'utf8') === context, 'context_conflict', 'Adapter context changed');
  // Keep dispatch closed until the backend write completes and the identity is revalidated.
  bridge = store.saveOperation({ ...check(), state: 'configured', controlRevision: (bridge.controlRevision ?? 0) + 1 });
  await api('PATCH', `/api/agents/${binding.config.agentId}`, { status: 'idle',
    adapterConfig: { ...backend.adapterConfig, observationOnly: false, bindingId: binding.id,
      bindingRevision: binding.revision, relayContextFile: operatorFile, requireReviewDisposition: true, timeoutSec: 600 },
    runtimeConfig: { ...backend.runtimeConfig, heartbeat: { ...backend.runtimeConfig?.heartbeat, enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 } } });
  store.saveOperation({ ...check(), state: 'armed', backendPaused: false, controlRevision: (bridge.controlRevision ?? 0) + 1 });
  return { bindingId: binding.id, state: 'armed' };
}

export async function disarmBridge(store, api, input, current = () => true) {
  const id = `opencode-bridge:${text(input.bindingId, 'bindingId')}`;
  let bridge = store.operation(id);
  requireValue(bridge, 'bridge_not_found', 'No bridge configured', 404);
  settled(store, input.bindingId);
  requireValue(current(), 'bridge_identity_mismatch', 'Bridge enrolment is no longer current', 409);
  bridge = store.saveOperation({ ...bridge, state: 'configured', ready: false, backendPaused: false,
    controlRevision: (bridge.controlRevision ?? 0) + 1 });
  const binding = store.binding(input.bindingId);
  const observed = store.operation(bridge.identity.observedId);
  const backend = await api('GET', `/api/agents/${binding.config.agentId}`);
  const check = () => {
    requireValue(current(), 'bridge_identity_mismatch', 'Bridge enrolment is no longer current', 409);
    const latest = unchangedBridge(store, id, bridge);
    const latestObserved = store.operation(bridge.identity.observedId);
    requireValue(canonical(store.binding(binding.id)) === canonical(binding) && latestObserved?.agentId === observed?.agentId &&
      latestObserved?.marker === observed?.marker, 'bridge_identity_mismatch', 'Bridge ownership changed', 409);
    settled(store, binding.id);
    return latest;
  };
  check();
  requireValue(backend.companyId === binding.config.companyId && backend.adapterType === 'herdr_relay' &&
    backend.adapterConfig?.relayObservationMarker === observed?.marker, 'agent_identity_mismatch', 'Backend adapter changed', 409);
  await api('PATCH', `/api/agents/${binding.config.agentId}`, { status: 'paused',
    adapterConfig: { ...backend.adapterConfig, observationOnly: true },
    runtimeConfig: { ...backend.runtimeConfig, heartbeat: { ...backend.runtimeConfig?.heartbeat, enabled: false, wakeOnDemand: false } } });
  store.saveOperation({ ...check(), backendPaused: true });
  return { bindingId: binding.id, state: 'configured' };
}

export async function refreshBridge(store, directory, api, input, current = () => true) {
  requireValue(input.reserved === true, 'reservation_required', 'Reserve the conversation before refreshing the bridge');
  const observed = observation(store, input.observedId);
  const bindingId = `observed-${digest(observed.id).slice(0, 24)}`;
  const id = `opencode-bridge:${bindingId}`;
  const previous = store.operation(id);
  requireValue(previous, 'bridge_not_found', 'No bridge configured', 404);
  const identity = { ...previous.identity, terminalId: observed.placement.terminalId };
  requireValue(identity.observedId === observed.id && identity.bindingId === bindingId &&
    identity.conversationId === observed.identity.conversationId && identity.directory === observed.placement.directory,
  'bridge_conflict', 'Refresh may only replace the terminal for the same conversation and directory', 409);
  if (canonical(previous.identity) === canonical(identity)) return configureBridge(store, directory, api, input, current);
  const binding = store.binding(bindingId);
  requireValue(!binding.lifecycleState && binding.config.agentId === observed.agentId && binding.config.companyId === observed.identity.companyId &&
    binding.config.harness === 'opencode' && binding.config.instanceId === digest([observed.identity.machineId, observed.identity.session]) &&
    binding.config.conversationId === identity.conversationId && binding.config.delivery === 'pull',
  'binding_conflict', 'Existing binding is incompatible', 409);
  const path = join(directory, 'bridges', `${bindingId}.json`);
  requireValue(digest(JSON.parse(readFileSync(path, 'utf8')).token) === previous.tokenHash,
    'bridge_conflict', 'Bridge credential file changed', 409);
  const check = () => {
    requireValue(current(), 'bridge_identity_mismatch', 'Bridge enrolment is no longer current', 409);
    observation(store, observed.id, observed);
    const latest = store.operation(id);
    requireValue(canonical(store.binding(bindingId)) === canonical(binding), 'binding_conflict', 'Binding changed during refresh', 409);
    requireValue(canonical(latest?.identity) === canonical(previous.identity) && latest?.tokenHash === previous.tokenHash,
      'bridge_conflict', 'Bridge identity changed during refresh', 409);
    const permit = store.operation(`observed-pull:${bindingId}`);
    requireValue(!permit || permit.state === 'closed', 'reservation_conflict', 'Close the manual-pull reservation first', 409);
    settled(store, bindingId);
    return true;
  };
  check();
  await disarmBridge(store, api, { bindingId }, check);
  check();
  const bridge = store.operation(id);
  requireValue(bridge.state === 'configured' && bridge.backendPaused, 'bridge_conflict', 'Bridge was rearmed during refresh', 409);
  requireValue(digest(JSON.parse(readFileSync(path, 'utf8')).token) === previous.tokenHash,
    'bridge_conflict', 'Bridge credential file changed during refresh', 409);
  const token = randomBytes(32).toString('hex');
  const temporary = `${path}.next`;
  // A crash between file replacement and the store write fails credential validation, never replays work.
  writeFileSync(temporary, JSON.stringify({ ...identity, socketPath: join(directory, 'relay.sock'), token }), { mode: 0o600 });
  renameSync(temporary, path);
  store.saveOperation({ ...bridge, identity, tokenHash: digest(token), state: 'configured', ready: false,
    epoch: null, lastSeen: null, controlRevision: (bridge.controlRevision ?? 0) + 1 });
  return { bindingId, bridgeConfigFile: path, state: 'configured', restartRequired: true };
}

export function bridgeRequest(store, bridgeId, action, input, ready) {
  let bridge = store.operation(bridgeId);
  const identity = bridge.identity;
  const observed = store.operation(identity.observedId);
  requireValue(observed?.availability === 'present' && !observed.error && Date.now() - Date.parse(observed.updatedAt) < 15000 &&
    observed.identity.conversationId === identity.conversationId && observed.placement.terminalId === identity.terminalId &&
    observed.placement.directory === identity.directory, 'bridge_identity_mismatch', 'Current Herdr conversation is not verified', 409);
  requireValue(input.conversationId === identity.conversationId && input.terminalId === identity.terminalId,
    'bridge_identity_mismatch', 'Plugin conversation does not match bridge', 409);
  const epoch = text(input.epoch, 'epoch');
  const active = store.runs(identity.bindingId).find(run => run.nativeState !== 'settled');
  if (bridge.epoch && bridge.epoch !== epoch) requireValue(!active?.invocation, 'bridge_epoch_conflict', 'Unsettled delivery cannot transfer to another plugin process', 409);
  requireValue(Number.isSafeInteger(input.sessionCreatedAt) && input.sessionCreatedAt > 0 &&
    (!bridge.sessionCreatedAt || bridge.sessionCreatedAt === input.sessionCreatedAt), 'bridge_identity_mismatch', 'Native session creation identity changed', 409);
  bridge = store.saveOperation({ ...bridge, epoch, sessionCreatedAt: input.sessionCreatedAt,
    lastSeen: new Date().toISOString(), ready: input.idle === true });
  if (action === 'poll') return { state: bridge.state, run: active ?? null };
  requireValue(bridge.state === 'armed' && active?.id === input.runId, 'bridge_run_mismatch', 'No matching active bridge run', 409);
  if (action === 'begin') {
    requireValue(ready(active.id), 'adapter_unavailable', 'Paperclip credentials are not attached', 503);
    requireValue(input.idle === true && Array.isArray(input.priorUserIds) && input.priorUserIds.length <= 4000 &&
      input.priorUserIds.every(id => typeof id === 'string'), 'native_busy', 'Validated idle snapshot required', 409);
    if (active.invocation || active.cancellationRequested) return { run: active, dispatch: false };
    store.assertWorkerAdmission(identity.bindingId);
    assertRoutineTask(store, identity.bindingId, active.request.taskId);
    const run = store.beginNative(active.id, promptFor(active, bridge.workerContext).trim(), input.priorUserIds);
    store.saveOperation({ ...bridge, ready: false });
    return { run, dispatch: Boolean(run.invocation) };
  }
  requireValue(action === 'observe' && active.invocation, 'invalid_bridge_action', 'Observation requires persisted delivery intent');
  const snapshot = input.snapshot;
  requireValue(snapshot && typeof snapshot.idle === 'boolean' && Array.isArray(snapshot.messages) && snapshot.messages.every(message =>
    message.info?.sessionID === identity.conversationId && typeof message.info.id === 'string' && Array.isArray(message.parts)),
  'invalid_native_response', 'Bound native message snapshot required');
  store.nativeStatus(active.id, input.conflict ? { state: 'conflict', reason: 'concurrent_native_input' } : observe(snapshot, active.invocation));
  const run = store.run(active.id);
  if (run.native?.state === 'finished') store.finishNative(active.id, run.native);
  return { run: store.run(active.id) };
}
