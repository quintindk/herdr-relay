import { canonical, digest, requireValue, text } from './protocol.mjs';
import { createOperatorTask } from './operations.mjs';
import { isNotificationSource } from './completion-notifications.mjs';
import { validateTaskPolicy } from './task-policy.mjs';
import { taskOrigins } from './task-origin.mjs';

function fresh(value, limit) {
  const age = Date.now() - Date.parse(value);
  return age >= 0 && age < limit;
}

function availableAgent(store, binding, companyId) {
  if (!binding || binding.lifecycleState || binding.config.companyId !== companyId ||
    binding.config.harness !== 'opencode' || binding.config.delivery !== 'pull') return null;
  const bridge = store.operation(`opencode-bridge:${binding.id}`);
  const identity = bridge?.identity;
  if (bridge?.state !== 'armed' || bridge.ready !== true || !fresh(bridge.lastSeen, 10000) ||
    typeof bridge.epoch !== 'string' || !bridge.epoch.trim() ||
    !Number.isSafeInteger(bridge.sessionCreatedAt) || bridge.sessionCreatedAt <= 0 ||
    identity?.bindingId !== binding.id || identity.conversationId !== binding.config.conversationId ||
    typeof identity.directory !== 'string' || !identity.directory.trim() ||
    typeof identity.terminalId !== 'string' || !identity.terminalId.trim()) return null;
  const observed = store.operation(identity.observedId);
  if (observed?.availability !== 'present' || observed.error || !fresh(observed.updatedAt, 15000) ||
    observed.identity?.harness !== 'opencode' || observed.identity.sessionKind !== 'id' ||
    observed.identity.companyId !== companyId || observed.agentId !== binding.config.agentId ||
    observed.identity.conversationId !== identity.conversationId ||
    binding.config.instanceId !== digest([observed.identity.machineId, observed.identity.session]) ||
    observed.placement?.directory !== identity.directory || observed.placement.terminalId !== identity.terminalId ||
    store.runs(binding.id).some(run => run.nativeState !== 'settled')) return null;
  return { bindingId: binding.id, agentId: binding.config.agentId,
    label: observed.observation?.display?.name ?? binding.config.label ?? binding.config.agentId,
    directory: identity.directory };
}

function summary(store, operation, resolved = null) {
  // Creation intent alone never authorises receipt or result access.
  const receipt = resolved?.receipt;
  return { id: operation.id, state: operation.state,
    receipt: receipt ? Object.fromEntries(['id', 'identifier', 'title', 'status', 'companyId', 'assigneeAgentId']
      .filter(key => typeof receipt[key] === 'string').map(key => [key, receipt[key]])) : null,
    runs: receipt?.id ? store.runs().filter(run => run.request.companyId === resolved.request.companyId &&
      run.request.taskId === receipt.id).map(run => ({ id: run.id, deliveryState: run.deliveryState,
      nativeState: run.nativeState, outcome: run.settlement?.outcome ?? null,
      publicationState: run.publication?.state ?? null, reviewStatus: run.review?.status ?? null,
      candidate: run.result?.candidate ?? null, summary: run.result?.summary ?? null })) : [] };
}

// The service authenticates the bridge and validates its native snapshot via poll first.
// Caller readiness is not required: its native turn is executing this tool.
export async function harnessDelegation(store, bridge, action, input, api) {
  const current = store.operation(bridge.id);
  requireValue(current && canonical(current.identity) === canonical(bridge.identity) &&
    current.tokenHash === bridge.tokenHash && current.epoch === bridge.epoch &&
    current.sessionCreatedAt === bridge.sessionCreatedAt,
  'bridge_identity_mismatch', 'Bridge identity or epoch changed', 409);
  bridge = current;
  requireValue(bridge.state === 'armed', 'bridge_unavailable', 'Delegation requires an armed bridge', 409);
  requireValue(Number.isSafeInteger(bridge.sessionCreatedAt) && bridge.sessionCreatedAt > 0 &&
    input.sessionCreatedAt === bridge.sessionCreatedAt && input.conversationId === bridge.identity.conversationId &&
    typeof bridge.epoch === 'string' && bridge.epoch.trim() && input.epoch === bridge.epoch &&
    (input.bindingId === undefined || input.bindingId === bridge.identity.bindingId),
  'bridge_identity_mismatch', 'Delegation must match the exact native session and epoch', 409);
  const caller = store.binding(bridge.identity.bindingId);
  requireValue(!caller.lifecycleState && caller.config.conversationId === bridge.identity.conversationId &&
    caller.config.harness === 'opencode' && caller.config.delivery === 'pull',
  'bridge_identity_mismatch', 'Delegation binding is no longer active in this conversation', 409);
  const companyId = caller.config.companyId;
  if (action === 'agents') {
    return { agents: store.bindings().filter(binding => binding.id !== caller.id)
      .map(binding => availableAgent(store, binding, companyId)).filter(Boolean) };
  }
  if (action === 'delegation-status') {
    const intents = store.db.prepare("SELECT id, run_id, data FROM operations WHERE id LIKE 'operator-task:%' ORDER BY rowid DESC").all()
      .flatMap(row => {
        const operation = JSON.parse(row.data);
        return operation.id === row.id && operation.runId === row.run_id && operation.state === 'uncertain' ? [operation] : [];
      });
    const operations = [...intents, ...taskOrigins(store)];
    return { delegations: operations.filter(operation => operation.request?.companyId === companyId &&
      operation.request.origin?.bindingId === caller.id &&
      operation.request.origin.conversationId === bridge.identity.conversationId &&
      operation.request.origin.sessionCreatedAt === bridge.sessionCreatedAt)
      .map(operation => summary(store, operation, operation.state === 'recorded' ? operation : null)) };
  }
  requireValue(action === 'delegate', 'invalid_bridge_action', 'Unknown delegation action');
  requireValue(input.origin === undefined && input.companyId === undefined,
    'invalid_request', 'Delegation origin and company are derived from the authenticated bridge');
  const runs = store.runs(caller.id);
  requireValue(runs.every(run => run.nativeState === 'settled'), 'conversation_busy',
    'Active Relay work must delegate through the worker task route, not the harness operator route', 409);
  const source = input.source;
  requireValue(source && typeof source.id === 'string' && source.id.trim() && source.id.length <= 65536 &&
    typeof source.text === 'string' && source.text.trim() && source.text.length <= 16000 &&
    Number.isSafeInteger(source.createdAt) && source.createdAt >= bridge.sessionCreatedAt && source.createdAt <= Date.now() &&
    source.synthetic !== true && source.ignored !== true && !isNotificationSource(store, bridge, source.id) &&
    !runs.some(run => run.invocation?.messageId === source.id),
  'invalid_delegation_source', 'Delegation requires native user text, not a notification or Relay invocation', 409);
  const origin = { bindingId: caller.id, conversationId: bridge.identity.conversationId,
    sessionCreatedAt: bridge.sessionCreatedAt, sourceMessageId: source.id, sourceDigest: digest(source.text) };
  const key = `harness-delegation:${digest([origin, text(input.key, 'key'),
    { id: source.id, text: source.text, createdAt: source.createdAt }])}`;
  const targetBindingId = text(input.targetBindingId, 'targetBindingId');
  requireValue(targetBindingId !== caller.id, 'invalid_delegation_target', 'Choose another bridge', 409);
  const target = store.binding(targetBindingId, false);
  requireValue(target && target.config.companyId === companyId,
    'invalid_delegation_target', 'Target must belong to the same company', 409);
  const targetBridge = store.operation(`opencode-bridge:${targetBindingId}`);
  const payload = { title: text(input.title, 'title'), description: text(input.description, 'description'),
    assigneeAgentId: target.config.agentId, status: 'todo',
    relayReviewPolicy: validateTaskPolicy(input.relayReviewPolicy === undefined ? 'human' : input.relayReviewPolicy) };
  if (input.parentTaskId !== undefined) payload.parentId = text(input.parentTaskId, 'parentTaskId');
  if (input.grantId !== undefined) payload.relayReviewGrantId = text(input.grantId, 'grantId');
  // Recorded retries still pass through createOperatorTask's exact-payload check,
  // but never depend on the worker remaining idle after the original dispatch.
  const result = await createOperatorTask(store, (method, path, body) => {
    const latest = store.operation(bridge.id);
    requireValue(latest?.state === 'armed' && canonical(latest.identity) === canonical(bridge.identity) &&
      latest.tokenHash === bridge.tokenHash && latest.epoch === bridge.epoch && latest.sessionCreatedAt === bridge.sessionCreatedAt &&
      canonical(store.binding(caller.id)) === canonical(caller),
    'bridge_identity_mismatch', 'Delegation caller changed during task creation', 409);
    requireValue(store.runs(caller.id).every(run => run.nativeState === 'settled'), 'conversation_busy',
      'Active Relay work must delegate through the worker task route, not the harness operator route', 409);
    const latestTarget = store.binding(targetBindingId, false);
    const latestBridge = store.operation(`opencode-bridge:${targetBindingId}`);
    requireValue(targetBridge && latestBridge && canonical(latestBridge.identity) === canonical(targetBridge.identity) &&
      latestBridge.epoch === targetBridge.epoch && latestBridge.sessionCreatedAt === targetBridge.sessionCreatedAt &&
      latestBridge.tokenHash === targetBridge.tokenHash &&
      canonical(latestTarget) === canonical(target) && availableAgent(store, latestTarget, companyId),
      'agent_not_ready', 'Target requires a fresh, ready, armed bridge and matching Herdr placement', 409);
    return api(method, path, body);
  }, { companyId, key, origin, payload });
  const resolved = taskOrigins(store).find(task => task.request.companyId === companyId &&
    task.receipt.id === result.receipt?.id && canonical(task.request.origin) === canonical(origin));
  return summary(store, result, resolved);
}
