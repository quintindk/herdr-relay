import { canonical, digest, requireValue, text } from './protocol.mjs';
import { humanTask } from './human-tasks.mjs';
import { isNotificationSource } from './completion-notifications.mjs';
import { queryTasks } from './task-query.mjs';
import { attachTaskReference, lookupTaskReference } from './task-references.mjs';
import { concurrentResultConflict } from './store.mjs';

// The service authenticates and polls the bridge first, then removes only the
// known transport fields. Native user selection is checked by the plugin.
export async function harnessTask(store, bridge, action, input, api) {
  const queryKinds = { 'task-list': 'list', 'task-children': 'children', 'task-comments': 'comments', 'task-activity': 'activity' };
  const reading = action === 'task-inspect' || action === 'task-reference-lookup' || Object.hasOwn(queryKinds, action);
  requireValue(['task-inspect', 'task-create', 'task-edit', 'task-assign', 'task-complete', 'task-comment', 'task-reopen', 'task-cancel', 'task-recover',
    'task-reference-lookup', 'task-reference-attach', ...Object.keys(queryKinds)].includes(action),
    'invalid_bridge_action', 'Unknown human task action');
  requireValue(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(field => ['key', 'taskId', 'expectedRevision', 'payload', 'reason', 'source', 'externalReference',
      'projectId', 'statuses', 'assigneeAgentId', 'assigneeUserId', 'parentId', 'limit', 'cursor', 'from', 'to'].includes(field) && input[field] !== undefined),
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
    const active = store.runs(caller.id).filter(run => run.nativeState !== 'settled');
    const recoveringOwnResult = action === 'task-recover' && active.length === 1 &&
      active[0].request.taskId === input.taskId && concurrentResultConflict(active[0]);
    requireValue(active.length === 0 || recoveringOwnResult, 'conversation_busy',
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
  const send = async (...request) => { check(); try { return await api(...request); } finally { check(); } };
  if (Object.hasOwn(queryKinds, action)) return queryTasks(send, { ...args, kind: queryKinds[action], companyId });
  if (action === 'task-reference-lookup') {
    requireValue(Object.keys(args).length === 1 && args.payload, 'invalid_request', 'Reference lookup requires only payload');
    requireValue(Object.keys(args.payload).every(field => ['namespace', 'externalId'].includes(field)), 'invalid_request', 'Unsupported reference lookup fields');
    return lookupTaskReference(store, send, { ...args.payload, companyId });
  }
  if (action === 'task-reference-attach') {
    requireValue(Object.keys(args).every(field => ['key', 'taskId', 'expectedRevision', 'payload', 'reason'].includes(field)), 'invalid_request', 'Unsupported attachment fields');
    text(args.expectedRevision, 'expectedRevision');
    text(args.reason, 'reason');
    requireValue(args.payload && Object.keys(args.payload).every(field => ['namespace', 'externalId', 'url'].includes(field)), 'invalid_request', 'Unsupported reference attachment fields');
    return attachTaskReference(store, send, { ...args.payload, companyId, taskId: args.taskId, key: args.key,
      expectedRevision: args.expectedRevision }, { authority, check });
  }
  return humanTask(store, api, { ...args, action: action.slice(5), companyId }, { authority, check });
}
