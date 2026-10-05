import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical, digest, requireValue, text } from './protocol.mjs';
import { workerContext, promptFor } from './supervisor.mjs';
import { observe } from './opencode.mjs';

export function bridgeForToken(store, token) {
  return store.db.prepare("SELECT data FROM operations WHERE id LIKE 'opencode-bridge:%'").all()
    .map(row => JSON.parse(row.data)).find(item => item.tokenHash === digest(token));
}

export async function configureBridge(store, directory, api, input) {
  requireValue(input.reserved === true, 'reservation_required', 'Reserve the conversation for Relay before configuring the bridge');
  const observed = store.operation(text(input.observedId, 'observedId'));
  requireValue(observed?.identity?.harness === 'opencode' && observed.identity.sessionKind === 'id' &&
    observed.availability === 'present' && !observed.error && Date.now() - Date.parse(observed.updatedAt) < 15000,
  'agent_not_ready', 'Recent unique OpenCode observation required', 409);
  const bindingId = `observed-${digest(observed.id).slice(0, 24)}`;
  const permit = store.operation(`observed-pull:${bindingId}`);
  requireValue(!permit || permit.state === 'closed', 'reservation_conflict', 'Close the manual-pull reservation first', 409);
  requireValue(store.runs(bindingId).every(run => run.nativeState === 'settled'), 'work_unsettled', 'Unsettled work blocks bridge setup', 409);
  const backend = await api('GET', `/api/agents/${observed.agentId}`);
  requireValue(backend.adapterType === 'herdr_relay' && backend.companyId === observed.identity.companyId &&
    backend.adapterConfig?.relayObservationMarker === observed.marker, 'agent_identity_mismatch', 'Backend observation changed', 409);
  const id = `opencode-bridge:${bindingId}`;
  const previous = store.operation(id);
  const identity = { observedId: observed.id, bindingId, conversationId: observed.identity.conversationId,
    directory: observed.placement.directory, terminalId: observed.placement.terminalId };
  if (previous) requireValue(canonical(previous.identity) === canonical(identity), 'bridge_conflict', 'Bridge identity changed', 409);
  const binding = store.binding(bindingId, false) ?? store.register({ id: bindingId, companyId: observed.identity.companyId,
    agentId: observed.agentId, harness: 'opencode', instanceId: digest([observed.identity.machineId, observed.identity.session]),
    conversationId: observed.identity.conversationId, delivery: 'pull', label: observed.observation.display.name }).binding;
  requireValue(binding.config.conversationId === identity.conversationId && binding.config.delivery === 'pull' && binding.config.agentId === observed.agentId,
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

export async function armBridge(store, directory, api, input) {
  const id = `opencode-bridge:${text(input.bindingId, 'bindingId')}`;
  const bridge = store.operation(id);
  requireValue(bridge && Date.now() - Date.parse(bridge.lastSeen) < 10000 && bridge.epoch && bridge.ready,
    'bridge_unavailable', 'The bridge plugin must report ready from the reserved conversation first', 409);
  const binding = store.binding(input.bindingId);
  requireValue(store.runs(input.bindingId).every(run => run.nativeState === 'settled'), 'work_unsettled', 'Cannot arm over active work', 409);
  const observed = store.operation(bridge.identity.observedId);
  requireValue(observed?.availability === 'present' && observed.placement?.terminalId === bridge.identity.terminalId && !observed.error &&
    Date.now() - Date.parse(observed.updatedAt) < 15000,
    'bridge_identity_mismatch', 'Herdr placement changed', 409);
  const backend = await api('GET', `/api/agents/${binding.config.agentId}`);
  requireValue(backend.companyId === binding.config.companyId && backend.adapterConfig?.relayObservationMarker === observed.marker &&
    backend.adapterType === 'herdr_relay', 'agent_identity_mismatch', 'Backend adapter changed', 409);
  const operatorFile = join(directory, 'adapter-context.json');
  const context = JSON.stringify({ socketPath: join(directory, 'relay.sock'), token: readFileSync(join(directory, 'admin-token'), 'utf8').trim() });
  if (!existsSync(operatorFile)) writeFileSync(operatorFile, context, { flag: 'wx', mode: 0o600 });
  else requireValue(readFileSync(operatorFile, 'utf8') === context, 'context_conflict', 'Adapter context changed');
  store.saveOperation({ ...bridge, state: 'armed' });
  await api('PATCH', `/api/agents/${binding.config.agentId}`, { status: 'idle',
    adapterConfig: { ...backend.adapterConfig, observationOnly: false, bindingId: binding.id,
      bindingRevision: binding.revision, relayContextFile: operatorFile, requireReviewDisposition: true, timeoutSec: 600 },
    runtimeConfig: { ...backend.runtimeConfig, heartbeat: { ...backend.runtimeConfig?.heartbeat, enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 } } });
  return { bindingId: binding.id, state: 'armed' };
}

export async function disarmBridge(store, api, input) {
  const id = `opencode-bridge:${text(input.bindingId, 'bindingId')}`;
  const bridge = store.operation(id);
  requireValue(bridge, 'bridge_not_found', 'No bridge configured', 404);
  requireValue(store.runs(input.bindingId).every(run => run.nativeState === 'settled'), 'work_unsettled', 'Settle bridge work before disarming', 409);
  store.saveOperation({ ...bridge, state: 'configured' });
  const binding = store.binding(input.bindingId);
  const observed = store.operation(bridge.identity.observedId);
  const backend = await api('GET', `/api/agents/${binding.config.agentId}`);
  requireValue(backend.companyId === binding.config.companyId && backend.adapterType === 'herdr_relay' &&
    backend.adapterConfig?.relayObservationMarker === observed.marker, 'agent_identity_mismatch', 'Backend adapter changed', 409);
  await api('PATCH', `/api/agents/${binding.config.agentId}`, { status: 'paused',
    adapterConfig: { ...backend.adapterConfig, observationOnly: true },
    runtimeConfig: { ...backend.runtimeConfig, heartbeat: { ...backend.runtimeConfig?.heartbeat, enabled: false, wakeOnDemand: false } } });
  return { bindingId: binding.id, state: 'configured' };
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
