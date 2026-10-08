import { canonical, digest, requireValue, text } from './protocol.mjs';
import { humanTask } from './human-tasks.mjs';
import { isNotificationSource } from './completion-notifications.mjs';

// The service authenticates and polls the bridge first, then removes only the
// known transport fields. Native user selection is checked by the plugin.
export async function harnessTask(store, bridge, action, input, api) {
  requireValue(['task-inspect', 'task-create', 'task-edit', 'task-assign', 'task-complete'].includes(action),
    'invalid_bridge_action', 'Unknown human task action');
  requireValue(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(field => ['key', 'taskId', 'expectedRevision', 'payload', 'reason', 'source'].includes(field) && input[field] !== undefined),
  'invalid_request', 'Only human task arguments and native source are accepted');
  requireValue(bridge?.identity && typeof bridge.id === 'string', 'bridge_identity_mismatch', 'Current native bridge required', 409);
  bridge = structuredClone(bridge);
  const caller = store.binding(bridge.identity.bindingId, false);
  requireValue(caller && !caller.lifecycleState && caller.id === bridge.identity.bindingId &&
    caller.config.harness === 'opencode' && caller.config.delivery === 'pull' &&
    caller.config.conversationId === bridge.identity.conversationId &&
    Number.isSafeInteger(bridge.sessionCreatedAt) && bridge.sessionCreatedAt > 0 && bridge.sessionCreatedAt <= Date.now() &&
    typeof bridge.epoch === 'string' && bridge.epoch.trim() && typeof bridge.tokenHash === 'string' && bridge.tokenHash.trim(),
  'bridge_identity_mismatch', 'Human tasks require an active binding and exact native session identity', 409);
  const bindingProof = canonical(caller);
  const companyId = text(caller.config.companyId, 'companyId');
  const reading = action === 'task-inspect';
  const sourceProof = reading ? null : canonical(input.source);
  const check = () => {
    const current = store.operation(bridge.id);
    requireValue(current && ['configured', 'armed'].includes(current.state),
      'bridge_unavailable', 'Human tasks require a configured or armed bridge', 409);
    requireValue(canonical(current.identity) === canonical(bridge.identity) && current.epoch === bridge.epoch &&
      current.tokenHash === bridge.tokenHash && current.sessionCreatedAt === bridge.sessionCreatedAt &&
      current.controlRevision === bridge.controlRevision && canonical(store.binding(caller.id, false)) === bindingProof,
    'bridge_identity_mismatch', 'Human task caller identity or session changed', 409);
    if (reading) return;
    requireValue(store.runs(caller.id).every(run => run.nativeState === 'settled'), 'conversation_busy',
      'Active Relay work cannot use the human task operator connector', 409);
    const source = input.source;
    requireValue(source && typeof source.id === 'string' && source.id.trim() && source.id.length <= 65536 &&
      typeof source.text === 'string' && source.text.trim() && source.text.length <= 16000 &&
      Number.isSafeInteger(source.createdAt) && source.createdAt >= bridge.sessionCreatedAt && source.createdAt <= Date.now() &&
      source.synthetic !== true && source.ignored !== true && (source.role === undefined || source.role === 'user') &&
      canonical(source) === sourceProof && !isNotificationSource(store, bridge, source.id) &&
      !store.runs().some(run => run.invocation?.messageId === source.id),
    'invalid_task_source', 'Human tasks require unchanged native user text, not a notification or Relay invocation', 409);
  };
  check();
  const authority = { kind: 'native', bindingId: caller.id, conversationId: bridge.identity.conversationId,
    sessionCreatedAt: bridge.sessionCreatedAt, ...(!reading ? {
      sourceMessageId: input.source.id, sourceDigest: digest(input.source.text),
    } : {}) };
  const { source, ...args } = input;
  return humanTask(store, api, { ...args, action: action.slice(5), companyId }, { authority, check });
}
