import { randomUUID } from 'node:crypto';
import { canonical, digest, now, requireValue } from './protocol.mjs';
import { canonicalDirectory, withinRoots, interactiveOperationHash } from './interactive-contract.mjs';
import { approveContractUpdate } from './headless-contract.mjs';

const fields = (p, allowed, required = allowed) => requireValue(p && typeof p === 'object' && !Array.isArray(p) &&
  Object.keys(p).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(p, k)), 'invalid_grant_request', 'Missing or unsupported grant fields');
const scopeFields = ['mode', 'roots', 'profiles', 'allowNewEnrolments', 'allowCreateDirectories', 'allowReplacement', 'allowDispatch', 'maxAgents', 'reviewPolicy', 'expiresAt'];
export const grantKinds = Object.freeze({ interactive: 'provision_grant', headless: 'headless_grant', reference: 'task_reference_grant', review: 'review_grant' });
export const grantDecider = actor => ({ type: actor.scope?.kind === 'grant_approval' ? 'human_tui' : actor.scope?.kind ?? actor.type,
  userId: actor.id, ...(actor.scope?.nodeId ? { nodeId: actor.scope.nodeId } : {}), ...(actor.scope?.terminalId ? { terminalId: actor.scope.terminalId } : {}) });

export function nodeGrantPolicy(store, nodeId) {
  store.get('node', nodeId);
  const policies = store.db.prepare("SELECT data FROM credentials WHERE json_extract(data,'$.scope.kind')='node_operator' AND json_extract(data,'$.scope.nodeId')=?").all(nodeId)
    .map(row => JSON.parse(row.data)).filter(c => !c.revoked).map(c => ({ mode: c.scope.mode, roots: c.scope.roots ?? [], maxAgents: c.scope.maxAgents ?? 100 }));
  requireValue(policies.length > 0 && policies.every(p => canonical(p) === canonical(policies[0])),
    'node_policy_unavailable', 'Destination node has no unambiguous joined-node workspace policy');
  return policies[0];
}

export function interactiveScope(store, nodeId, value, { directory, profile = 'build', createDirectory = false, instance = 'ensure', agentId } = {}) {
  const ceiling = nodeGrantPolicy(store, nodeId);
  fields(value ?? {}, scopeFields, []);
  const scope = { mode: value?.mode ?? 'roots', roots: value?.roots ?? (directory ? [directory] : []), profiles: value?.profiles ?? [profile],
    allowNewEnrolments: value?.allowNewEnrolments ?? !agentId, allowCreateDirectories: value?.allowCreateDirectories ?? createDirectory,
    allowReplacement: value?.allowReplacement ?? instance === 'replace', allowDispatch: value?.allowDispatch ?? false,
    maxAgents: value?.maxAgents ?? ceiling.maxAgents, reviewPolicy: value?.reviewPolicy ?? 'human', ...(value?.expiresAt ? { expiresAt: value.expiresAt } : {}) };
  requireValue(scope.mode === 'roots' && Array.isArray(scope.roots) && scope.roots.length > 0 && scope.roots.length <= 32 &&
    scope.roots.every(root => canonicalDirectory(root) && (ceiling.mode === 'localUser' || withinRoots(root, ceiling.roots))),
  'grant_scope_outside_node', 'Permission folders must stay within the destination node workspace policy');
  requireValue(Array.isArray(scope.profiles) && scope.profiles.length > 0 && scope.profiles.length <= 16 && scope.profiles.every(p => typeof p === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p)),
    'invalid_grant_scope', 'Explicit valid profiles required');
  for (const key of ['allowNewEnrolments', 'allowCreateDirectories', 'allowReplacement', 'allowDispatch']) requireValue(typeof scope[key] === 'boolean', 'invalid_grant_scope', 'Permission actions must be boolean');
  requireValue(Number.isSafeInteger(scope.maxAgents) && scope.maxAgents > 0 && scope.maxAgents <= ceiling.maxAgents && ['none', 'human'].includes(scope.reviewPolicy),
    'invalid_grant_scope', 'Agent limit must fit the node-wide ceiling and review policy must be explicit');
  if (scope.expiresAt) requireValue(Date.parse(scope.expiresAt) > Date.now(), 'invalid_expiry', 'Future expiry required');
  return scope;
}

export function interactiveGrantCovers(grant, p) {
  return grant.state === 'active' && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now()) &&
    grant.requesterAgentId === p.requesterAgentId && grant.nodeId === p.nodeId && (!grant.boundRequestId || grant.boundRequestId === p.id) &&
    canonicalDirectory(p.directory) && (grant.mode === 'localUser' || withinRoots(p.directory, grant.roots)) && grant.profiles.includes(p.profile ?? 'build') &&
    (p.agentId || grant.allowNewEnrolments) && (!p.createDirectory || grant.allowCreateDirectories) &&
    (p.instance !== 'replace' || grant.allowReplacement);
}

export function requestInteractiveGrant(store, actor, p, { created }) {
  const existing = store.get('grant_request', p.id, false);
  const { grantId, permissionScope, ...operation } = p;
  const operationHash = interactiveOperationHash(operation);
  if (existing) {
    requireValue(existing.requestHash === operationHash && existing.requestedScopeHash === digest(permissionScope ?? null) &&
      existing.requesterAgentId === p.requesterAgentId, 'operation_conflict', 'Saved provisioning intent or permission scope changed');
    return existing;
  }
  requireValue(canonicalDirectory(p.directory) && typeof p.name === 'string' && p.name.trim() && p.name.length <= 256,
    'invalid_grant_request', 'An exact canonical folder and agent name are required');
  const scope = interactiveScope(store, p.nodeId, permissionScope, p);
  requireValue(interactiveGrantCovers({ ...scope, requesterAgentId: p.requesterAgentId, nodeId: p.nodeId, state: 'active' }, p),
    'invalid_grant_scope', 'Requested permission must cover the requested operation');
  return created('grant_request', { id: p.id, permissionRequest: true, kind: 'interactive', requesterAgentId: p.requesterAgentId, nodeId: p.nodeId,
    requesterNodeId: store.get('agent', p.requesterAgentId).nodeId,
    directory: p.directory, name: p.name, operation, requestHash: operationHash, requestedScopeHash: digest(permissionScope ?? null), scope, state: 'awaiting_approval', responsibleUserId: store.owner });
}

function approvalActor(store, actor) {
  store.ownerOnly(actor);
  requireValue(!actor.scope || actor.scope.kind === 'grant_approval', 'human_grant_decision_required', 'Grant decisions require the human Grants UI, not an agent/operator command', 403);
}

export function issueGrantApprovalSession(store, actor, p) {
  store.ownerOnly(actor);
  requireValue(!actor.scope || actor.scope.kind === 'node_operator', 'human_grant_decision_required', 'Human TUI operator context required', 403);
  fields(p, ['terminalId']);
  requireValue(typeof p.terminalId === 'string' && p.terminalId.length > 0 && p.terminalId.length <= 128, 'invalid_request', 'Terminal identity required');
  return store.issueCredential({ type: 'user', id: store.owner, scope: { kind: 'grant_approval', terminalId: p.terminalId,
    parentCredentialId: actor.credentialId, ...(actor.scope?.nodeId ? { nodeId: actor.scope.nodeId } : {}), expiresAt: new Date(Date.now() + 3600000).toISOString() } });
}

function mintInteractiveGrant(store, actor, id, requesterAgentId, nodeId, scope, extra = {}) {
  const requester = store.get('agent', requesterAgentId);
  requireValue(requester.standingGrant && requester.mode === 'interactive', 'requester_not_enrolled', 'Enrolled interactive requester required');
  const grant = store.apply(actor, 'interactive.grant', { id, requesterAgentId, nodeId, ...scope });
  const saved = store.save('provision_grant', { ...grant, managed: true, issuedBy: grantDecider(actor), ...extra });
  store.event('interactive.grant', saved, actor, id);
  return saved;
}

function resumeRequest(store, actor, request, grant, changed, decision) {
  const requester = store.get('agent', request.requesterAgentId);
  const provision = store.apply(actor, 'interactive.request', { ...request.operation, grantId: grant.id,
    sourceConversationId: requester.conversationId, sourceBindingRevision: requester.bindingRevision }, { grantResume: true });
  const saved = store.save('provision_request', { ...provision, approvalRequestId: request.id, permissionScopeHash: request.requestedScopeHash });
  store.event('interactive.request', saved, actor, request.id);
  return changed('grant_request', request, { state: 'approved', grantId: grant.id, provisionRequestId: provision.id, decision });
}

export function applyGrantAction(store, actor, action, p, { created, changed }) {
  approvalActor(store, actor);
  const record = value => {
    const decision = created('grant_decision', { id: `grant_decision_${randomUUID()}`, ...value, decidedBy: grantDecider(actor), decidedAt: now() });
    store.event('grant.decision_recorded', decision, actor, p.id); return decision;
  };
  if (action === 'grant.request_decide') {
    fields(p, ['id', 'expectedRevision', 'requestHash', 'decision', 'reason', 'scope'], ['id', 'expectedRevision', 'requestHash', 'decision']);
    const request = store.get('grant_request', p.id); store.revision(request, p.expectedRevision);
    requireValue(request.state === 'awaiting_approval' && request.requestHash === p.requestHash, 'stale_grant_request', 'Refresh the exact permission request');
    requireValue(['approve_once', 'allow_scope', 'reject'].includes(p.decision), 'invalid_grant_decision', 'Choose approve once, allow scope or reject');
    requireValue(p.reason === undefined || typeof p.reason === 'string' && p.reason.length <= 4000, 'invalid_request', 'Bounded decision reason required');
    const decision = { decision: p.decision, requestHash: request.requestHash, reason: p.reason ?? '', decidedBy: grantDecider(actor), at: now() };
    if (request.kind === 'headless_contract') {
      requireValue(['approve_once', 'reject'].includes(p.decision) && p.scope === undefined, 'invalid_grant_decision', 'Approve this exact instruction revision or reject it; standing scope is unchanged');
      const result = p.decision === 'reject' ? changed('grant_request', request, { state: 'rejected', decision }) : approveContractUpdate(store, actor, request, changed, decision);
      record({ requestId: request.id, grantKind: 'headless_contract', outcome: p.decision === 'reject' ? 'rejected' : 'instructions_approved',
        reason: decision.reason, requestHash: request.requestHash });
      return result;
    }
    if (p.decision === 'reject') {
      record({ requestId: request.id, grantKind: 'interactive', outcome: 'rejected', reason: decision.reason });
      return changed('grant_request', request, { state: 'rejected', decision });
    }
    const once = p.decision === 'approve_once';
    const scope = interactiveScope(store, request.nodeId, once ? { ...request.scope, roots: [request.directory], profiles: [request.operation.profile ?? 'build'],
      allowNewEnrolments: !request.operation.agentId, allowCreateDirectories: !!request.operation.createDirectory,
      allowReplacement: request.operation.instance === 'replace' } : p.scope ?? request.scope, request.operation);
    requireValue(interactiveGrantCovers({ ...scope, state: 'active', requesterAgentId: request.requesterAgentId, nodeId: request.nodeId }, request.operation),
      'invalid_grant_scope', 'Approved permission must cover the saved request');
    const grant = mintInteractiveGrant(store, actor, `permission_${digest([request.id, request.revision]).slice(0, 48)}`, request.requesterAgentId, request.nodeId, scope,
      { approvalRequestId: request.id, ...(once ? { boundRequestId: request.id } : {}) });
    const result = resumeRequest(store, actor, request, grant, changed, decision);
    record({ requestId: request.id, grantId: grant.id, grantKind: 'interactive', outcome: once ? 'approved_once' : 'allowed_scope', reason: decision.reason, scope });
    return result;
  }
  if (action === 'grant.create') {
    fields(p, ['id', 'requesterAgentId', 'nodeId', 'scope', 'reason'], ['id', 'requesterAgentId', 'nodeId', 'scope']);
    requireValue(p.reason === undefined || typeof p.reason === 'string' && p.reason.length <= 4000, 'invalid_request', 'Bounded reason required');
    const scope = interactiveScope(store, p.nodeId, p.scope);
    const grant = mintInteractiveGrant(store, actor, p.id, p.requesterAgentId, p.nodeId, scope);
    const resumed = [];
    for (const request of store.all('grant_request').filter(r => r.state === 'awaiting_approval' && interactiveGrantCovers(grant, r.operation))) {
      const decision = { decision: 'allow_scope', requestHash: request.requestHash, reason: p.reason ?? 'Covered by a new standing permission', decidedBy: grantDecider(actor), at: now() };
      resumeRequest(store, actor, request, grant, changed, decision); resumed.push(request.id);
    }
    record({ grantId: grant.id, grantKind: 'interactive', outcome: 'created', reason: p.reason ?? '', scope });
    return { ...grant, grantKind: 'interactive', scopeHash: digest(p.scope), resumedRequestIds: resumed };
  }
  if (action === 'grant.revoke') {
    fields(p, ['id', 'kind', 'expectedRevision', 'reason'], ['id', 'kind', 'expectedRevision']);
    requireValue(p.reason === undefined || typeof p.reason === 'string' && p.reason.length <= 4000, 'invalid_request', 'Bounded reason required');
    requireValue(Object.hasOwn(grantKinds, p.kind), 'invalid_grant_kind', 'Unknown grant family');
    const grant = store.get(grantKinds[p.kind], p.id); store.revision(grant, p.expectedRevision);
    let result;
    if (p.kind === 'interactive') result = store.apply(actor, 'interactive.revoke', { id: grant.id, expectedRevision: grant.revision });
    else if (p.kind === 'headless') result = store.apply(actor, 'headless.revoke', { id: grant.id, expectedRevision: grant.revision });
    else if (p.kind === 'review') result = store.apply(actor, 'review.revoke', { id: grant.id, expectedRevision: grant.revision });
    else result = store.apply(actor, 'task.reference_namespace.revoke', { principal: grant.principal, prefix: grant.prefix, expectedRevision: grant.revision }, { grantDecision: true });
    const saved = store.save(grantKinds[p.kind], { ...result, revokedBy: grantDecider(actor) });
    record({ grantId: grant.id, grantKind: p.kind, outcome: 'revoked', reason: p.reason ?? '' });
    return { ...saved, grantKind: p.kind };
  }
  requireValue(false, 'invalid_action', 'Unknown grant decision');
}
