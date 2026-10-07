import { canonical, digest, requireValue, text, RelayError } from './protocol.mjs';
import { taskOrigins } from './task-origin.mjs';
import { taskPolicy } from './task-policy.mjs';
import { isNotificationSource } from './completion-notifications.mjs';

function parentOrigin(store, companyId, parentTaskId) {
  const parent = taskOrigins(store).find(task => task.request.companyId === companyId && task.receipt.id === parentTaskId);
  requireValue(parent?.id.startsWith('operator-task:') && !parent.request.body?.parentId && !parent.receipt.parentId &&
    parent.receipt.companyId === companyId && typeof parent.request.origin.sourceMessageId === 'string' &&
    parent.request.origin.sourceMessageId.trim() && typeof parent.request.origin.sourceDigest === 'string' &&
    parent.request.origin.sourceDigest.trim(),
  'invalid_coordinator_parent', 'An exact recorded native-origin root task is required', 409);
  requireValue((parent.request.relayReviewPolicy === undefined || parent.request.relayReviewPolicy === 'human') &&
    taskPolicy(store, companyId, parentTaskId) === 'human',
    'invalid_coordinator_parent', 'The parent final review policy must remain human', 409);
  return parent;
}

function nativeReviewer(store, bindingId, companyId) {
  const binding = store.binding(bindingId, false);
  const bridge = store.operation(`opencode-bridge:${bindingId}`);
  requireValue(binding && !binding.lifecycleState && binding.config.companyId === companyId &&
    binding.config.harness === 'opencode' && binding.config.delivery === 'pull' &&
    Number.isSafeInteger(binding.revision) && binding.revision > 0 && bridge?.state === 'armed' &&
    bridge.identity?.bindingId === bindingId && bridge.identity.conversationId === binding.config.conversationId &&
    Number.isSafeInteger(bridge.sessionCreatedAt) && bridge.sessionCreatedAt > 0,
  'invalid_coordinator_reviewer', 'Reviewer requires an active same-company native conversation', 409);
  return { reviewerBindingId: bindingId, reviewerBindingRevision: binding.revision,
    reviewerAgentId: binding.config.agentId, reviewerConversationId: binding.config.conversationId,
    reviewerSessionCreatedAt: bridge.sessionCreatedAt };
}

// Synchronous authorisation only. Backend assignment must also be checked by the action using the grant.
export function validateCoordinatorGrant(store, grantId, { companyId, parentTaskId, reviewerBindingId } = {}) {
  const grant = typeof grantId === 'string' && store.operation(grantId);
  requireValue(grant && grant.id === grantId && grantId.startsWith('coordinator-review-grant:') && grant.runId === '' &&
    grant.state === 'active' && grant.request?.companyId === companyId && grant.request.parentTaskId === parentTaskId &&
    grant.id === `coordinator-review-grant:${digest([grant.request.origin, parentTaskId, grant.request.key])}`,
  'coordinator_grant_inactive', 'An active grant for this exact company and parent is required', 403);
  const request = grant.request;
  const parent = parentOrigin(store, companyId, parentTaskId);
  requireValue(['bindingId', 'conversationId', 'sessionCreatedAt'].every(field =>
    request.origin?.[field] === parent.request.origin[field]),
  'coordinator_grant_scope_changed', 'Recorded parent origin no longer matches the grant', 409);
  const reviewer = nativeReviewer(store, request.reviewerBindingId, companyId);
  requireValue(Object.entries(reviewer).every(([key, value]) => request[key] === value) &&
    (reviewerBindingId === undefined || reviewerBindingId === reviewer.reviewerBindingId) &&
    reviewer.reviewerBindingId !== request.origin.bindingId &&
    parent.request.body?.assigneeAgentId === reviewer.reviewerAgentId &&
    parent.receipt.assigneeAgentId === reviewer.reviewerAgentId,
  'coordinator_grant_scope_changed', 'Reviewer must remain the exact original parent assignee and native session', 409);
  return grant;
}

// Called only after authenticated native poll and permission/latest-user-message validation by the bridge plugin.
export async function coordinatorGrant(store, bridge, action, input, api) {
  requireValue(['grant-review', 'revoke-review'].includes(action), 'invalid_bridge_action', 'Unknown coordinator grant action');
  requireValue(input.origin === undefined && input.companyId === undefined,
    'invalid_request', 'Grant origin and company are derived from the authenticated bridge');
  const caller = store.binding(bridge.identity.bindingId, false);
  const origin = { bindingId: bridge.identity.bindingId, conversationId: bridge.identity.conversationId,
    sessionCreatedAt: bridge.sessionCreatedAt };
  const source = input.source;
  const check = () => {
    const current = store.operation(bridge.id);
    requireValue(current?.state === 'armed' && caller && !caller.lifecycleState &&
      canonical(current.identity) === canonical(bridge.identity) && current.tokenHash === bridge.tokenHash &&
      current.epoch === bridge.epoch && current.controlRevision === bridge.controlRevision &&
      current.sessionCreatedAt === bridge.sessionCreatedAt && canonical(store.binding(caller.id, false)) === canonical(caller) &&
      caller.config.harness === 'opencode' && caller.config.delivery === 'pull' &&
      caller.config.conversationId === origin.conversationId && Number.isSafeInteger(origin.sessionCreatedAt) && origin.sessionCreatedAt > 0,
    'bridge_identity_mismatch', 'An unchanged armed native origin conversation is required', 409);
    requireValue(store.runs(caller.id).every(run => run.nativeState === 'settled'),
      'conversation_busy', 'Active Relay work cannot grant coordinator review authority', 409);
    requireValue(source && typeof source.id === 'string' && source.id.trim() && source.id.length <= 65536 &&
      typeof source.text === 'string' && source.text.trim() && source.text.length <= 16000 &&
      Number.isSafeInteger(source.createdAt) && source.createdAt >= origin.sessionCreatedAt && source.createdAt <= Date.now() &&
      source.synthetic !== true && source.ignored !== true && (source.role === undefined || source.role === 'user') &&
      !isNotificationSource(store, bridge, source.id) && !store.runs().some(run => run.invocation?.messageId === source.id) &&
      !store.runs(caller.id).some(run => run.invocation?.priorUserIds?.includes(source.id)),
    'invalid_coordinator_source', 'Explicit native human input, not a notification or Relay prompt/history, is required', 409);
  };
  check();
  const evidence = { sourceMessageId: source.id, sourceDigest: digest(source.text), sourceCreatedAt: source.createdAt };
  if (action === 'revoke-review') {
    const grantId = text(input.grantId, 'grantId');
    const grant = store.operation(grantId);
    requireValue(grant?.id === grantId && grantId.startsWith('coordinator-review-grant:') && grant.runId === '' &&
      ['active', 'revoked'].includes(grant.state) && grant.request?.companyId === caller.config.companyId &&
      canonical(grant.request.origin) === canonical(origin) &&
      grantId === `coordinator-review-grant:${digest([origin, grant.request.parentTaskId, grant.request.key])}`,
    'coordinator_grant_not_found', 'Name a grant from this exact originating chat', 404);
    requireValue(source.id !== grant.request.sourceMessageId && source.createdAt > grant.request.sourceCreatedAt,
      'invalid_coordinator_source', 'Revocation requires a later explicit human message', 409);
    requireValue(!grant.revocation || canonical(grant.revocation) === canonical(evidence),
      'coordinator_grant_conflict', 'A different revocation is already recorded', 409);
    if (grant.state === 'revoked') return grant.receipt;
    return store.saveOperation({ ...grant, state: 'revoked', revocation: evidence,
      receipt: { ...grant.receipt, state: 'revoked' } }).receipt;
  }
  const companyId = caller.config.companyId;
  const parentTaskId = text(input.parentTaskId, 'parentTaskId');
  const reviewerBindingId = text(input.reviewerBindingId, 'reviewerBindingId');
  const key = text(input.key, 'key');
  const id = `coordinator-review-grant:${digest([origin, parentTaskId, key])}`;
  const parent = parentOrigin(store, companyId, parentTaskId);
  const reviewer = nativeReviewer(store, reviewerBindingId, companyId);
  const checkScope = () => {
    check();
    requireValue(canonical(parentOrigin(store, companyId, parentTaskId)) === canonical(parent) &&
      ['bindingId', 'conversationId', 'sessionCreatedAt'].every(field => parent.request.origin[field] === origin[field]),
    'invalid_coordinator_parent', 'Only the exact parent originating chat may grant review authority', 403);
    requireValue(reviewerBindingId !== caller.id && canonical(nativeReviewer(store, reviewerBindingId, companyId)) === canonical(reviewer) &&
      parent.request.body?.assigneeAgentId === reviewer.reviewerAgentId && parent.receipt.assigneeAgentId === reviewer.reviewerAgentId,
    'invalid_coordinator_reviewer', 'Reviewer must be the recorded parent assignee, not the originating chat', 409);
  };
  checkScope();
  const request = { companyId, parentTaskId, key, origin, ...reviewer, ...evidence };
  const issue = await api('GET', `/api/issues/${encodeURIComponent(parentTaskId)}`);
  checkScope();
  requireValue(source.id === evidence.sourceMessageId && source.createdAt === evidence.sourceCreatedAt &&
    digest(source.text) === evidence.sourceDigest,
  'invalid_coordinator_source', 'Native human source changed during grant validation', 409);
  requireValue(issue?.id === parentTaskId && issue.companyId === companyId && !issue.parentId &&
    issue.assigneeAgentId === reviewer.reviewerAgentId && !issue.assigneeUserId &&
    ['backlog', 'todo', 'in_progress', 'blocked', 'in_review'].includes(issue.status),
  'coordinator_parent_scope_changed', 'Backend parent must remain a nonterminal root assigned to this reviewer', 409);
  const previous = store.operation(id);
  requireValue(!previous || canonical(previous.request) === canonical(request),
    'coordinator_grant_conflict', 'Grant key already has a different immutable request', 409);
  requireValue(!previous || previous.state === 'active', 'coordinator_grant_inactive', 'Revoked grants cannot be reactivated', 409);
  if (previous) return previous.receipt;
  const receipt = { grantId: id, state: 'active', companyId, parentTaskId, reviewerBindingId };
  store.saveOperation({ id, runId: '', state: 'active', request, receipt });
  return receipt;
}

// No inferred policy or backend-only parent link can confer coordinator authority.
// Returns the active grant operation, or null when recorded creation evidence is insufficient.
export function coordinatorReviewGrant(store, companyId, taskId) {
  const records = store.db.prepare('SELECT id, run_id, data FROM operations').all().flatMap(row => {
    const operation = JSON.parse(row.data);
    const { request, receipt } = operation;
    return operation.id === row.id && operation.runId === row.run_id && operation.state === 'recorded' &&
      receipt?.id === taskId && receipt.companyId === companyId &&
      ((operation.id.startsWith('operator-task:') && request?.companyId === companyId) ||
        (request?.kind === 'task.create' && request.method === 'POST' &&
          request.path === `/api/companies/${encodeURIComponent(companyId)}/issues`)) ? [operation] : [];
  });
  if (!records.length || records.some(({ request }) => request.relayReviewPolicy !== 'coordinator')) return null;
  const first = records[0];
  if (records.some(({ request, receipt }) => canonical([request.relayReviewGrantId, request.body, receipt.parentId, receipt.assigneeAgentId]) !==
    canonical([first.request.relayReviewGrantId, first.request.body, first.receipt.parentId, first.receipt.assigneeAgentId]))) return null;
  const { request, receipt } = first;
  try {
    const grant = validateCoordinatorGrant(store, request.relayReviewGrantId, { companyId, parentTaskId: request.body?.parentId });
    const parentTaskId = grant.request.parentTaskId;
    if (taskPolicy(store, companyId, taskId) !== 'coordinator' || taskId === parentTaskId || receipt.parentId !== parentTaskId ||
      typeof request.body?.assigneeAgentId !== 'string' || !request.body.assigneeAgentId.trim() ||
      receipt.assigneeAgentId !== request.body.assigneeAgentId || request.body.assigneeUserId || receipt.assigneeUserId ||
      request.body.assigneeAgentId === grant.request.reviewerAgentId) return null;
    return grant;
  } catch (error) {
    if (error instanceof RelayError) return null;
    throw error;
  }
}
