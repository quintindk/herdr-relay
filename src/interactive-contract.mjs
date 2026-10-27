import { isAbsolute, normalize, relative, sep } from 'node:path';
import { digest, now, requireValue } from './protocol.mjs';
import { interactiveGrantCovers, requestInteractiveGrant } from './grants.mjs';

const fields = (p, allowed, required = []) => requireValue(p && typeof p === 'object' && !Array.isArray(p) &&
  Object.keys(p).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(p, k)), 'invalid_request', 'Missing or unsupported interactive provisioning fields');
const text = (s, max = 256) => requireValue(typeof s === 'string' && s.trim() && s.length <= max && !/[\x00-\x1f]/.test(s), 'invalid_request', 'Bounded text required');
export const canonicalDirectory = s => typeof s === 'string' && isAbsolute(s) && normalize(s) === s && s.length <= 4096;
export const withinRoots = (directory, roots) => roots.some(root => {
  const path = relative(root, directory);
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
});
export const interactiveTerminal = ['ready', 'blocked', 'cancelled'];
export const interactiveOperationHash = p => digest({ id: p.id, nodeId: p.nodeId, requesterAgentId: p.requesterAgentId,
  directory: p.directory, name: p.name, agentId: p.agentId ?? null, createDirectory: p.createDirectory ?? false,
  instance: p.instance ?? 'ensure', profile: p.profile ?? 'build', topic: p.topic ?? '', model: p.model ?? null });

export function interactiveAuthority(store, actor, id, { ready = false } = {}) {
  const request = store.get('provision_request', id);
  if (actor.type === 'user') store.ownerOnly(actor); else store.nodeOnly(actor, request.nodeId);
  const grant = store.get('provision_grant', request.grantId);
  requireValue(grant.state === 'active' && (!grant.expiresAt || Date.now() < Date.parse(grant.expiresAt)) &&
    grant.revision === request.grantRevision && (!grant.boundRequestId || grant.boundRequestId === request.id), 'provisioning_grant_inactive', 'Provisioning grant expired, changed or revoked', 403);
  requireValue(request.state !== 'cancelled' && (ready || !interactiveTerminal.includes(request.state)),
    'provisioning_inactive', 'Provisioning request is no longer active', 409);
  return { request, grant };
}

export function applyInteractive(store, actor, action, p, { created, changed, grantResume = false }) {
  if (action === 'interactive.grant') {
    store.ownerOnly(actor);
    fields(p, ['id', 'requesterAgentId', 'nodeId', 'mode', 'roots', 'allowNewEnrolments', 'allowCreateDirectories', 'allowReplacement', 'allowDispatch', 'reviewPolicy', 'profiles', 'maxAgents', 'expiresAt'],
      ['id', 'requesterAgentId', 'nodeId', 'mode']);
    store.get('node', p.nodeId);
    const requester = store.get('agent', p.requesterAgentId);
    requireValue(requester.standingGrant && requester.mode === 'interactive', 'requester_not_enrolled', 'A durable interactive requester is required');
    requireValue(['roots', 'localUser'].includes(p.mode) && (p.mode === 'localUser' ? !p.roots?.length : Array.isArray(p.roots) && p.roots.length > 0 && p.roots.length <= 32 && p.roots.every(canonicalDirectory)),
      'invalid_provisioning_scope', 'Choose localUser or explicit canonical directory roots');
    for (const k of ['allowNewEnrolments', 'allowCreateDirectories', 'allowReplacement', 'allowDispatch']) requireValue(p[k] === undefined || typeof p[k] === 'boolean', 'invalid_request', 'Grant permissions must be boolean');
    const profiles = p.profiles ?? ['build'];
    requireValue(Array.isArray(profiles) && profiles.length > 0 && profiles.length <= 16 && profiles.every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s)), 'invalid_profile', 'Explicit native agent profiles required');
    requireValue(['none', 'human'].includes(p.reviewPolicy ?? 'human') && Number.isSafeInteger(p.maxAgents ?? 10) && (p.maxAgents ?? 10) > 0 && (p.maxAgents ?? 10) <= 100,
      'invalid_request', 'Bounded agent limit and supported review policy required');
    if (p.expiresAt) requireValue(Date.parse(p.expiresAt) > Date.now(), 'invalid_expiry', 'Future grant expiry required');
    return created('provision_grant', { ...p, profiles, maxAgents: p.maxAgents ?? 10, reviewPolicy: p.reviewPolicy ?? 'human', state: 'active', userId: actor.id });
  }
  if (action === 'interactive.revoke') {
    store.ownerOnly(actor); fields(p, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
    const grant = store.get('provision_grant', p.id); store.revision(grant, p.expectedRevision);
    return changed('provision_grant', grant, { state: 'revoked' });
  }
  const source = input => {
    const agent = store.agent(actor, input.requesterAgentId);
    requireValue(agent.standingGrant && agent.mode === 'interactive' && agent.conversationId === input.sourceConversationId && agent.bindingRevision === input.sourceBindingRevision,
      'stale_binding', 'The designated interactive requester must submit this operation', 409);
    return agent;
  };
  if (action === 'interactive.request') {
    fields(p, ['id', 'grantId', 'nodeId', 'requesterAgentId', 'sourceConversationId', 'sourceBindingRevision', 'directory', 'agentId', 'name', 'createDirectory', 'instance', 'profile', 'topic', 'model', 'permissionScope'],
      ['id', 'nodeId', 'requesterAgentId', 'sourceConversationId', 'sourceBindingRevision']);
    text(p.id, 96);
    if (p.model !== undefined) { fields(p.model, ['providerID', 'id', 'variant'], ['providerID', 'id']); text(p.model.providerID); text(p.model.id); if (p.model.variant !== undefined) text(p.model.variant); }
    source(p);
    const agent = p.agentId ? store.get('agent', p.agentId) : null;
    p.directory ??= agent?.directory; p.name ??= agent?.name;
    requireValue(p.createDirectory === undefined || typeof p.createDirectory === 'boolean', 'invalid_request', 'Directory creation must be explicit');
    requireValue(['ensure', 'replace'].includes(p.instance ?? 'ensure') && /^[A-Za-z0-9_-]{1,64}$/.test(p.profile ?? 'build'), 'invalid_profile', 'Unsupported instance mode or profile');
    if (p.topic !== undefined) requireValue(typeof p.topic === 'string' && p.topic.length <= 4000, 'invalid_topic', 'Bounded discussion context required');
    requireValue(!agent || agent.nodeId === p.nodeId && agent.standingGrant && agent.mode === 'interactive' &&
      agent.directory === p.directory && agent.name === p.name, 'agent_scope_mismatch', 'Existing agent must match the destination, folder and name');
    const intentHash = interactiveOperationHash(p);
    const saved = store.get('provision_request', p.id, false);
    if (saved) {
      const savedHash = saved.intentHash ?? interactiveOperationHash({ ...saved, agentId: saved.newEnrolment ? undefined : saved.agentId });
      requireValue(savedHash === intentHash && (saved.permissionScopeHash ?? digest(null)) === digest(p.permissionScope ?? null) && (!p.grantId || p.grantId === saved.grantId),
        'operation_conflict', 'Prepared operation identity changed');
      return saved;
    }
    if (store.get('grant_request', p.id, false) && !grantResume) {
      return requestInteractiveGrant(store, actor, p, { created });
    }
    const grant = p.grantId ? store.get('provision_grant', p.grantId) : store.all('provision_grant').find(grant => interactiveGrantCovers(grant, p));
    if (!grant) return requestInteractiveGrant(store, actor, p, { created, changed });
    p.grantId = grant.id;
    requireValue(grant.state === 'active' && (!grant.boundRequestId || grant.boundRequestId === p.id) && (!grant.expiresAt || Date.now() < Date.parse(grant.expiresAt)) && grant.requesterAgentId === p.requesterAgentId && grant.nodeId === p.nodeId,
      'provisioning_grant_inactive', 'An active grant for this requester and destination node is required', 403);
    requireValue(!agent || agent.nodeId === p.nodeId && agent.standingGrant && agent.mode === 'interactive', 'agent_scope_mismatch', 'Existing agent must belong to the destination node');
    const directory = p.directory ?? agent?.directory, name = p.name ?? agent?.name;
    requireValue(canonicalDirectory(directory) && (!agent || directory === agent.directory) && (grant.mode === 'localUser' || withinRoots(directory, grant.roots)),
      'provisioning_directory_forbidden', 'Directory is outside the authorised destination scope', 403);
    text(name);
    requireValue(!agent || !p.name || p.name === agent.name, 'agent_scope_mismatch', 'Attachment cannot rename an existing enrolment');
    requireValue(p.createDirectory === undefined || typeof p.createDirectory === 'boolean', 'invalid_request', 'Directory creation must be explicit');
    requireValue((agent || grant.allowNewEnrolments) && (!p.createDirectory || grant.allowCreateDirectories), 'provisioning_forbidden', 'Grant does not permit this creation', 403);
    const instance = p.instance ?? 'ensure', profile = p.profile ?? 'build';
    requireValue(['ensure', 'replace'].includes(instance) && grant.profiles.includes(profile), 'invalid_profile', 'Unsupported instance mode or profile');
    requireValue(instance !== 'replace' || grant.allowReplacement, 'replacement_forbidden', 'Explicit replacement permission required', 403);
    if (p.topic !== undefined) requireValue(typeof p.topic === 'string' && p.topic.length <= 4000, 'invalid_topic', 'Bounded discussion context required');
    if (!agent) requireValue(!store.all('agent').some(a => a.nodeId === p.nodeId && a.directory === directory && a.name === name && a.standingGrant),
      'enrolment_exists', 'Use the existing enrolment ID rather than silently creating another');
    const targetAgentId = agent?.id ?? `agent_${digest(['interactive', p.id])}`;
    requireValue(!store.all('provision_request').some(r => r.agentId === targetAgentId && !interactiveTerminal.includes(r.state)), 'provisioning_busy', 'This agent already has an outstanding preparation');
    return created('provision_request', { ...p, directory, name, instance, profile, agentId: targetAgentId, newEnrolment: !agent,
      intentHash, permissionScopeHash: digest(p.permissionScope ?? null),
      requesterNodeId: store.get('agent', p.requesterAgentId).nodeId,
      previousConversationId: agent?.conversationId ?? null, expectedBindingRevision: agent?.bindingRevision ?? 0,
      desiredSessionId: `ses_${digest(['interactive', p.id]).slice(0, 26)}`, grantRevision: grant.revision, state: 'requested' });
  }
  if (action === 'interactive.cancel') {
    fields(p, ['id', 'expectedRevision', 'reason', 'requesterAgentId', 'sourceConversationId', 'sourceBindingRevision'], ['id', 'expectedRevision', 'reason']);
    const pending = store.get('grant_request', p.id, false);
    if (pending?.state === 'awaiting_approval') {
      if (actor.type === 'user') store.ownerOnly(actor); else requireValue(source(p).id === pending.requesterAgentId, 'forbidden', 'Only the requester may cancel', 403);
      store.revision(pending, p.expectedRevision); text(p.reason, 2000);
      return changed('grant_request', pending, { state: 'cancelled', reason: p.reason });
    }
    const request = store.get('provision_request', p.id); store.revision(request, p.expectedRevision); text(p.reason, 2000);
    if (actor.type === 'user') store.ownerOnly(actor); else requireValue(source(p).id === request.requesterAgentId, 'forbidden', 'Only the original requester can cancel', 403);
    requireValue(!interactiveTerminal.includes(request.state), 'provisioning_inactive', 'Only an outstanding preparation can be cancelled');
    return changed('provision_request', request, { state: 'cancelled', reason: p.reason });
  }
  if (action === 'interactive.progress') {
    fields(p, ['id', 'expectedRevision', 'state', 'receipt', 'reason'], ['id', 'expectedRevision', 'state']);
    const request = store.get('provision_request', p.id); store.nodeOnly(actor, request.nodeId); store.revision(request, p.expectedRevision);
    requireValue(!interactiveTerminal.includes(request.state), 'provisioning_inactive', 'Preparation already ended');
    requireValue(['waiting_driver', 'accepted', 'preparing_workspace', 'opening_chat', 'attaching', 'ready', 'blocked', 'uncertain'].includes(p.state), 'invalid_state', 'Known provisioning phase required');
    if (p.state !== 'blocked' && p.state !== 'uncertain') interactiveAuthority(store, actor, p.id);
    if (p.reason !== undefined) text(p.reason, 2000);
    if (p.state === 'ready') {
      fields(p.receipt, ['agentId', 'conversationId', 'bindingId', 'generation', 'directory', 'workspaceId', 'tabId', 'paneId', 'terminalId', 'reused', 'readyAt', 'model'],
        ['agentId', 'conversationId', 'bindingId', 'generation', 'directory', 'workspaceId', 'tabId', 'paneId', 'terminalId', 'reused', 'readyAt']);
      const agent = store.get('agent', request.agentId);
      if (p.receipt.model) { fields(p.receipt.model, ['providerID', 'id', 'variant'], ['providerID', 'id']); text(p.receipt.model.providerID); text(p.receipt.model.id); }
      requireValue(agent.nodeId === actor.id && agent.bindingId === p.receipt.bindingId && agent.conversationId === p.receipt.conversationId &&
        agent.bindingRevision === p.receipt.generation && p.receipt.agentId === agent.id && p.receipt.directory === request.directory &&
        (p.receipt.conversationId === request.desiredSessionId || request.instance === 'ensure' && p.receipt.conversationId === request.previousConversationId),
        'stale_binding', 'Ready receipt must identify the exact current receiving agent');
      for (const k of ['workspaceId', 'tabId', 'paneId', 'terminalId']) text(p.receipt[k]);
      requireValue(typeof p.receipt.reused === 'boolean' && Number.isFinite(Date.parse(p.receipt.readyAt)), 'invalid_receipt', 'Readiness evidence required');
    } else requireValue(p.receipt === undefined, 'invalid_receipt', 'Only readiness publishes a placement receipt');
    return changed('provision_request', request, { state: p.state, ...(p.receipt ? { receipt: p.receipt } : {}), ...(p.reason ? { reason: p.reason } : {}) });
  }
  if (action === 'interactive.enrol' || action === 'interactive.attach') {
    fields(p, action === 'interactive.enrol' ? ['id'] : ['id', 'attachment'], action === 'interactive.enrol' ? ['id'] : ['id', 'attachment']);
    const { request, grant } = interactiveAuthority(store, actor, p.id); store.nodeOnly(actor, request.nodeId);
    if (action === 'interactive.enrol') {
      requireValue(request.newEnrolment && grant.allowNewEnrolments, 'provisioning_forbidden', 'New enrolment not authorised', 403);
      requireValue(store.all('agent').filter(a => a.nodeId === request.nodeId && a.standingGrant).length < grant.maxAgents, 'agent_limit', 'Destination enrolment limit reached');
      const agent = store.apply(actor, 'agent.enrol', { id: request.agentId, nodeId: request.nodeId, directory: request.directory, name: request.name }, { interactiveRequest: request });
      store.event('agent.enrol', agent, actor, request.id); return agent;
    }
    const a = p.attachment;
    fields(a, ['id', 'expectedBindingRevision', 'conversationId', 'directory', 'bindingId'], ['id', 'expectedBindingRevision', 'conversationId', 'directory', 'bindingId']);
    requireValue(a.id === request.agentId && a.directory === request.directory && a.expectedBindingRevision === request.expectedBindingRevision &&
      (a.conversationId === request.desiredSessionId || request.instance === 'ensure' && a.conversationId === request.previousConversationId),
      'provisioning_scope_mismatch', 'Attachment differs from the approved request');
    const agent = store.apply(actor, 'agent.attach', a, { interactiveRequest: request });
    store.event('agent.attach', agent, actor, request.id); return agent;
  }
  if (action === 'interactive.dispatch') {
    fields(p, ['id', 'requesterAgentId', 'sourceConversationId', 'sourceBindingRevision', 'taskId', 'taskRevision', 'executionId', 'title', 'instructions'],
      ['id', 'requesterAgentId', 'sourceConversationId', 'sourceBindingRevision', 'taskId', 'executionId', 'instructions']);
    if (p.title !== undefined) text(p.title, 512);
    const requester = source(p), request = store.get('provision_request', p.id);
    const grant = store.get('provision_grant', request.grantId);
    requireValue(request.requesterAgentId === requester.id && grant.requesterAgentId === requester.id && grant.state === 'active' &&
      grant.revision === request.grantRevision && (!grant.boundRequestId || grant.boundRequestId === request.id) && (!grant.expiresAt || Date.now() < Date.parse(grant.expiresAt)) && grant.allowDispatch,
      'dispatch_not_authorised', 'A current grant explicitly permitting work dispatch is required', 403);
    requireValue(request.state === 'ready' && !request.dispatchedExecutionId, 'provisioning_not_ready', 'One ready, undispatched preparation required');
    const target = store.get('agent', request.agentId);
    requireValue(target.bindingId === request.receipt.bindingId && target.bindingRevision === request.receipt.generation,
      'stale_binding', 'The prepared receiver changed before work assignment', 409);
    let task = store.get('task', p.taskId, false);
    if (task) {
      // Older callers could not supply a revision. Their original, unchanged
      // task is safe to reuse, but never silently adopt a later edited revision.
      store.revision(task, p.taskRevision ?? 1);
      requireValue(task.responsibleUserId === store.owner, 'task_scope_mismatch', 'Prepared dispatch requires a human-owned task', 403);
    } else {
      requireValue(p.taskRevision === undefined || p.taskRevision === 0, 'task_not_found', 'The inspected task no longer exists; dispatch will not recreate it', 404);
      text(p.title, 512);
      task = store.apply(actor, 'task.create', { id: p.taskId, title: p.title, description: p.instructions }, { interactiveRequest: request });
      store.event('task.create', task, actor, request.id);
    }
    const execution = store.apply(actor, 'execution.request', { id: p.executionId, taskId: task.id, taskRevision: task.revision,
      targetAgentId: target.id, originAgentId: requester.id, originConversation: p.sourceConversationId, instructions: p.instructions,
      reviewPolicy: grant.reviewPolicy }, { interactiveRequest: request });
    store.event('execution.request', execution, actor, request.id);
    const updated = changed('provision_request', request, { dispatchedExecutionId: execution.id });
    store.event('interactive.dispatched', updated, actor, request.id);
    return execution;
  }
  requireValue(false, 'invalid_action', 'Unknown interactive provisioning action');
}
