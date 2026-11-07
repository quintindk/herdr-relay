import { canonical, digest, now, requireValue } from './protocol.mjs';
import { interactiveGrantCovers, interactiveGrantScope, interactiveScope, nodeGrantPolicy } from './grants.mjs';
import { interactiveCapacity } from './interactive-capacity.mjs';

export const repairPhases = ['initial', 'directory', 'selected', 'workspace', 'opening', 'attaching', 'verifying', 'ready'];
const fields = (p, allowed, required = []) => requireValue(p && typeof p === 'object' && !Array.isArray(p) &&
  Object.keys(p).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(p, key)), 'invalid_interactive_repair', 'Exact bounded repair fields required');
const text = (s, max = 256) => typeof s === 'string' && s.trim() && s.length <= max && !/[\x00-\x1f]/.test(s);

export function validateRepairCheckpoint(store, request, checkpoint) {
  fields(checkpoint, ['protocol', 'safe', 'phase', 'unresolved', 'directoryIdentity', 'sessionId', 'placement', 'bindingId', 'generation'], ['protocol', 'safe', 'phase', 'unresolved']);
  requireValue(checkpoint.protocol === 1 && typeof checkpoint.safe === 'boolean' && repairPhases.includes(checkpoint.phase) &&
    Array.isArray(checkpoint.unresolved) && checkpoint.unresolved.length <= 16 && checkpoint.unresolved.every(code => text(code, 128)) &&
    (!checkpoint.safe || checkpoint.unresolved.length === 0), 'invalid_interactive_repair', 'A safe checkpoint cannot contain unresolved effects');
  if (checkpoint.directoryIdentity) {
    fields(checkpoint.directoryIdentity, ['directory', 'dev', 'ino'], ['directory', 'dev', 'ino']);
    requireValue(checkpoint.directoryIdentity.directory === request.directory && ['dev', 'ino'].every(key => Number.isSafeInteger(checkpoint.directoryIdentity[key]) && checkpoint.directoryIdentity[key] >= 0),
      'invalid_interactive_repair', 'Checkpoint must identify the original workspace');
  }
  if (checkpoint.sessionId) requireValue([request.desiredSessionId, request.previousConversationId].includes(checkpoint.sessionId),
    'invalid_interactive_repair', 'Checkpoint must identify the original receiving conversation');
  if (checkpoint.placement) {
    fields(checkpoint.placement, ['workspaceId', 'tabId', 'paneId', 'terminalId'], ['workspaceId', 'tabId', 'paneId', 'terminalId']);
    requireValue(Object.values(checkpoint.placement).every(value => text(value)), 'invalid_interactive_repair', 'Exact placement identities required');
  }
  if (checkpoint.bindingId || checkpoint.generation) {
    const agent = store.get('agent', request.agentId);
    requireValue(checkpoint.bindingId === agent.bindingId && checkpoint.generation === agent.bindingRevision,
      'stale_repair_checkpoint', 'The receiving binding changed before inspection', 409);
  }
  return checkpoint;
}

function repairRequester(store, actor, request, p) {
  if (actor.type === 'user') { store.ownerOnly(actor); return; }
  const requester = store.agent(actor, p.requesterAgentId);
  requireValue(requester.id === request.requesterAgentId && requester.standingGrant && requester.mode === 'interactive' &&
    requester.conversationId === p.sourceConversationId && requester.bindingRevision === p.sourceBindingRevision,
    'stale_binding', 'Only the original requester in its current verified chat may request repair', 409);
}

export function interactiveRepairPreview(store, actor, p) {
  if (!store.inTransaction) return store.transaction(() => interactiveRepairPreview(store, actor, p));
  fields(p, ['id', 'scope', 'requesterAgentId', 'sourceConversationId', 'sourceBindingRevision'], ['id']);
  const request = store.get('provision_request', p.id);
  repairRequester(store, actor, request, p);
  const grant = store.get('provision_grant', request.grantId);
  const operation = { ...request, agentId: request.newEnrolment ? undefined : request.agentId };
  const before = interactiveGrantScope(grant);
  const defaults = { ...before, mode: 'roots', roots: [request.directory], profiles: [request.profile],
    allowNewEnrolments: request.newEnrolment, allowCreateDirectories: !!request.createDirectory, allowReplacement: request.instance === 'replace',
    allowDispatch: request.permissionScope?.allowDispatch ?? before.allowDispatch ?? false, maxAgents: nodeGrantPolicy(store, request.nodeId).maxAgents };
  if (defaults.expiresAt && Date.parse(defaults.expiresAt) <= Date.now()) delete defaults.expiresAt;
  const scope = interactiveScope(store, request.nodeId, p.scope ?? defaults, operation);
  requireValue(interactiveGrantCovers({ ...scope, state: 'active', requesterAgentId: request.requesterAgentId, nodeId: request.nodeId }, operation),
    'invalid_grant_scope', 'Repair permission must cover the original preparation');
  const pending = store.all('grant_request').find(r => r.kind === 'interactive_repair' && r.operation.preparationId === request.id && r.state === 'awaiting_approval');
  const eligibleState = ['blocked', 'waiting_capacity'].includes(request.state);
  const reason = !eligibleState || request.dispatchedExecutionId ? 'preparation_not_repairable' : pending ? 'repair_approval_pending' :
    !request.checkpoint ? 'awaiting_node_inspection' : !request.checkpoint.safe ? 'unresolved_provisioning_effects' : null;
  if (request.checkpoint) validateRepairCheckpoint(store, request, request.checkpoint);
  const preview = { preparationId: request.id, expectedRevision: request.revision, grantId: grant.id, grantRevision: grant.revision,
    requesterAgentId: request.requesterAgentId, nodeId: request.nodeId, directory: request.directory, name: request.name,
    agentId: request.agentId, scope, before, checkpoint: request.checkpoint ?? null, grantDigest: digest(grant),
    eligible: !reason, reason, pendingRequestId: pending?.id ?? null,
    capacity: interactiveCapacity(store, request, { ...grant, ...scope }, nodeGrantPolicy(store, request.nodeId).maxAgents),
    changes: [...new Set([...Object.keys(before), ...Object.keys(scope)])].filter(field => canonical(before[field] ?? null) !== canonical(scope[field] ?? null))
      .map(field => ({ field, before: before[field] ?? null, after: scope[field] ?? null })),
    preserves: ['preparation', 'agent identity', 'receiving conversation', 'verified workspace and placement', 'captured tasks', 'original operation keys and failure history'] };
  // Occupancy is informational and may change independently. Admission reserves
  // capacity later. The exact request, grant, scope and checkpoint are fenced.
  const { capacity, ...pinned } = preview;
  return { ...preview, previewHash: digest(pinned) };
}

export function requestInteractiveRepair(store, actor, p, { created }) {
  fields(p, ['id', 'preparationId', 'expectedRevision', 'scope', 'previewHash', 'reason', 'requesterAgentId', 'sourceConversationId', 'sourceBindingRevision'],
    ['id', 'preparationId', 'expectedRevision', 'scope', 'previewHash']);
  requireValue(text(p.id, 96) && (!p.reason || text(p.reason, 2000)), 'invalid_interactive_repair', 'Bounded repair identity and reason required');
  const preview = interactiveRepairPreview(store, actor, { id: p.preparationId, scope: p.scope,
    ...(actor.type === 'user' ? {} : { requesterAgentId: p.requesterAgentId, sourceConversationId: p.sourceConversationId, sourceBindingRevision: p.sourceBindingRevision }) });
  requireValue(preview.expectedRevision === p.expectedRevision && preview.previewHash === p.previewHash,
    'stale_repair_preview', 'Preparation, permission or checkpoint changed. Inspect a fresh repair preview.', 409);
  requireValue(preview.eligible, 'repair_not_eligible', `Repair cannot proceed: ${preview.reason}. Reconcile existing evidence before requesting another attempt.`, 409);
  const original = store.get('provision_request', p.preparationId);
  return created('grant_request', { id: p.id, permissionRequest: true, kind: 'interactive_repair',
    requesterAgentId: original.requesterAgentId, requesterNodeId: original.requesterNodeId, nodeId: original.nodeId,
    directory: original.directory, name: original.name, scope: preview.scope, operation: preview, requestHash: preview.previewHash,
    reason: p.reason ?? '', state: 'awaiting_approval', responsibleUserId: store.owner });
}

export function approveInteractiveRepair(store, actor, permission, grant, changed, decision) {
  const p = permission.operation, request = store.get('provision_request', p.preparationId);
  store.revision(request, p.expectedRevision);
  const originalGrant = store.get('provision_grant', p.grantId);
  requireValue(originalGrant.revision === p.grantRevision && digest(originalGrant) === p.grantDigest &&
    digest(request.checkpoint ?? null) === digest(p.checkpoint) && request.checkpoint?.safe &&
    ['blocked', 'waiting_capacity'].includes(request.state) && !request.dispatchedExecutionId,
    'stale_repair_preview', 'Original permission, preparation or recovery evidence changed. Inspect a new repair request.', 409);
  const requester = store.get('agent', request.requesterAgentId);
  const attempt = (request.repair?.attempt ?? 0) + 1;
  const history = { state: request.state, reason: request.reason ?? null, revision: request.revision, grantId: request.grantId,
    grantRevision: request.grantRevision, checkpoint: request.checkpoint, repairRequestId: permission.id, at: now() };
  const resumed = changed('provision_request', request, { grantId: grant.id, grantRevision: grant.revision,
    approvalRequestId: permission.id, sourceConversationId: requester.conversationId, sourceBindingRevision: requester.bindingRevision,
    state: 'requested', reason: undefined, admissionRequired: true, admission: { protocol: 1, state: 'required' },
    repair: { requestId: permission.id, attempt, checkpointHash: digest(request.checkpoint), fromRevision: request.revision },
    repairHistory: [...(request.repairHistory ?? []), history] });
  store.event('interactive.request', resumed, actor, permission.id);
  return changed('grant_request', permission, { state: 'approved', grantId: grant.id, provisionRequestId: request.id, decision });
}

export function applyInteractiveInspection(store, actor, action, p, changed) {
  fields(p, ['id', 'expectedRevision', 'checkpoint'], ['id', 'expectedRevision', 'checkpoint']);
  const request = store.get('provision_request', p.id);
  store.nodeOnly(actor, request.nodeId); store.revision(request, p.expectedRevision);
  requireValue(['blocked', 'cancelled', 'waiting_capacity'].includes(request.state), 'repair_not_eligible', 'Only a stopped or capacity-waiting preparation may publish a recovery checkpoint', 409);
  validateRepairCheckpoint(store, request, p.checkpoint);
  const agent = store.get('agent', request.agentId, false);
  const release = request.admission?.state === 'reserved' && p.checkpoint.safe && !agent && ['blocked', 'cancelled'].includes(request.state);
  if (digest(request.checkpoint ?? null) === digest(p.checkpoint) && !release) return request;
  return changed('provision_request', request, { checkpoint: p.checkpoint,
    ...(release ? { admission: { ...request.admission, state: 'released', releasedAt: now(),
      reason: 'terminal_request_fenced_and_no_enrolment', checkpointHash: digest(p.checkpoint) } } : {}) });
}
