import { canonical, digest, requireValue, text } from './protocol.mjs';
import { resultPolicy, validateTaskPolicy } from './task-policy.mjs';
import { attachTaskReference, finishTaskReference, lookupTaskReference, reserveTaskReference, validateTaskReference } from './task-references.mjs';
import { taskOrigins } from './task-origin.mjs';
import { validateCoordinatorGrant } from './coordinator-review.mjs';

function taskPayload(value, idempotencyKey) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'invalid_request', 'Task payload required');
  const allowed = ['title', 'description', 'assigneeAgentId', 'assigneeUserId', 'parentId', 'projectId', 'blockedByIssueIds', 'unblockDescriptor', 'status', 'priority', 'relayReviewPolicy', 'relayReviewGrantId'];
  requireValue(Object.keys(value).every(key => allowed.includes(key)), 'invalid_request', 'Unsupported task creation field');
  requireValue(!(value.assigneeAgentId && value.assigneeUserId), 'invalid_request', 'Choose a human or agent assignee, not both');
  requireValue(value.description === undefined || typeof value.description === 'string', 'invalid_request', 'Description must be a string');
  for (const key of ['assigneeAgentId', 'assigneeUserId', 'parentId', 'projectId']) {
    if (value[key] !== undefined && value[key] !== null) text(value[key], key);
  }
  if (value.blockedByIssueIds !== undefined) {
    requireValue(Array.isArray(value.blockedByIssueIds), 'invalid_request', 'blockedByIssueIds must be an array');
    value.blockedByIssueIds.forEach(id => text(id, 'blockedByIssueId'));
  }
  requireValue(value.status === undefined || ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'].includes(value.status),
    'invalid_status', 'Unsupported task status');
  requireValue(value.priority === undefined || ['critical', 'high', 'medium', 'low'].includes(value.priority), 'invalid_request', 'Unsupported task priority');
  if (value.relayReviewPolicy !== undefined) validateTaskPolicy(value.relayReviewPolicy);
  if (value.relayReviewPolicy === 'coordinator') text(value.relayReviewGrantId, 'relayReviewGrantId');
  else requireValue(value.relayReviewGrantId === undefined, 'invalid_review_policy', 'Only coordinator review accepts a grant reference');
  const { relayReviewPolicy, relayReviewGrantId, ...fields } = value;
  return { ...fields, title: text(value.title, 'title'), description: value.description ?? '', idempotencyKey };
}

function coordinatorCreationScope(store, request, companyId, run, expected) {
  if (request.relayReviewPolicy !== 'coordinator') return null;
  const grant = validateCoordinatorGrant(store, request.relayReviewGrantId, { companyId, parentTaskId: request.body.parentId });
  const scope = grant.request;
  requireValue(!expected || canonical(scope) === canonical(expected.request),
    'coordinator_grant_scope_changed', 'Coordinator grant changed during task creation', 409);
  requireValue(typeof request.body.assigneeAgentId === 'string' && request.body.assigneeAgentId.trim() &&
    request.body.assigneeAgentId !== scope.reviewerAgentId && !request.body.assigneeUserId,
  'invalid_coordinator_child', 'Coordinator children must be assigned to an independent agent', 403);
  if (run) {
    const live = store.run(run.id);
    requireValue(canonical(live.request) === canonical(run.request) && live.conversationId === run.conversationId &&
      (live.backendRunId ?? live.request.runId) === (run.backendRunId ?? run.request.runId) &&
      live.nativeState === 'claimed' && live.deliveryState === 'acknowledged' && !live.cancellationRequested && !live.result && !live.waiting &&
      run.request.taskId === scope.parentTaskId && run.request.bindingId === scope.reviewerBindingId &&
      run.request.bindingRevision === scope.reviewerBindingRevision && run.request.agentId === scope.reviewerAgentId &&
      run.conversationId === scope.reviewerConversationId,
    'coordinator_reviewer_mismatch', 'Only the current acknowledged parent reviewer may create coordinator children', 403);
  } else {
    const origin = request.origin;
    const binding = origin && store.binding(origin.bindingId, false);
    const bridge = binding && store.operation(`opencode-bridge:${binding.id}`);
    requireValue(origin && ['bindingId', 'conversationId', 'sessionCreatedAt'].every(field => origin[field] === scope.origin[field]) &&
      binding && !binding.lifecycleState && binding.config.companyId === companyId &&
      binding.config.harness === 'opencode' && binding.config.delivery === 'pull' && binding.config.conversationId === origin.conversationId &&
      bridge?.state === 'armed' && bridge.identity?.bindingId === origin.bindingId &&
      bridge.identity.conversationId === origin.conversationId && bridge.sessionCreatedAt === origin.sessionCreatedAt,
    'invalid_origin', 'Coordinator creation requires the exact native grant origin', 403);
  }
  return grant;
}

function coordinatorParent(parent, grant, run) {
  requireValue(parent?.id === grant.request.parentTaskId && parent.companyId === grant.request.companyId && !parent.parentId &&
    parent.assigneeAgentId === grant.request.reviewerAgentId && !parent.assigneeUserId &&
    ['backlog', 'todo', 'in_progress', 'blocked', 'in_review'].includes(parent.status) &&
    (!run || !parent.executionRunId || parent.executionRunId === (run.backendRunId ?? run.request.runId)),
  'coordinator_parent_scope_changed', 'Backend parent must remain a nonterminal root assigned to this reviewer', 409);
}

export async function createOperatorTask(store, api, input) {
  input = structuredClone(input);
  const companyId = text(input.companyId, 'companyId');
  const key = text(input.key, 'key');
  const id = `operator-task:${digest([companyId, key])}`;
  const request = { companyId, body: taskPayload(input.payload, `relay-operator:${digest([companyId, key])}`) };
  request.relayReviewPolicy = input.payload.relayReviewPolicy ?? 'none';
  if (input.payload.relayReviewGrantId !== undefined) request.relayReviewGrantId = input.payload.relayReviewGrantId;
  if (input.origin !== undefined) {
    const origin = input.origin;
    requireValue(origin && Object.keys(origin).every(key => ['bindingId', 'conversationId', 'sessionCreatedAt', 'sourceMessageId', 'sourceDigest'].includes(key)),
      'invalid_origin', 'Unsupported task origin fields');
    const binding = store.binding(text(origin.bindingId, 'origin.bindingId'));
    const bridge = store.operation(`opencode-bridge:${binding.id}`);
    requireValue(binding.config.companyId === companyId && binding.config.conversationId === origin.conversationId &&
      bridge?.identity.conversationId === origin.conversationId && bridge.sessionCreatedAt === origin.sessionCreatedAt &&
      Number.isSafeInteger(origin.sessionCreatedAt) && origin.sessionCreatedAt > 0,
    'invalid_origin', 'Task origin must identify an enrolled conversation in this company', 409);
    request.origin = { bindingId: binding.id, conversationId: text(origin.conversationId, 'origin.conversationId'),
      sessionCreatedAt: origin.sessionCreatedAt, sourceMessageId: text(origin.sourceMessageId, 'origin.sourceMessageId'),
      sourceDigest: text(origin.sourceDigest, 'origin.sourceDigest') };
  }
  let operation = store.operation(id);
  if (operation) {
    if (input.payload.relayReviewPolicy === undefined && operation.request.relayReviewPolicy === undefined) delete request.relayReviewPolicy;
    requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'Task creation key has a different payload', 409);
    if (operation.state === 'recorded') return operation;
  }
  const grant = coordinatorCreationScope(store, request, companyId);
  const parentOrigin = () => {
    const parent = taskOrigins(store).find(task => task.request.companyId === companyId && task.receipt.id === request.body.parentId);
    requireValue(parent && ['bindingId', 'conversationId', 'sessionCreatedAt'].every(field =>
      parent.request.origin[field] === request.origin[field]),
    'forbidden', 'Parent task must have a recorded origin in this exact native conversation', 403);
    return parent;
  };
  const ownedParent = request.origin && request.body.parentId ? parentOrigin() : null;
  // Validate explicit resource scope before creating. Paperclip remains authority
  // for membership/assignment permissions and validates the mutation itself.
  const company = await api('GET', `/api/companies/${encodeURIComponent(companyId)}`);
  coordinatorCreationScope(store, request, companyId, null, grant);
  requireValue(company.id === companyId, 'identity_mismatch', 'Company identity changed', 409);
  const checks = [
    ...(request.body.parentId && !ownedParent ? [['issues', request.body.parentId]] : []),
    ...(request.body.projectId ? [['projects', request.body.projectId]] : []),
    ...(request.body.assigneeAgentId ? [['agents', request.body.assigneeAgentId]] : []),
    ...(request.body.blockedByIssueIds ?? []).map(id => ['issues', id]),
  ];
  for (const [collection, resourceId] of checks) {
    const resource = await api('GET', `/api/${collection}/${encodeURIComponent(resourceId)}`);
    coordinatorCreationScope(store, request, companyId, null, grant);
    requireValue(resource.id === resourceId && resource.companyId === companyId, 'forbidden', 'Task resource belongs to another company', 403);
  }
  if (ownedParent) {
    const parent = await api('GET', `/api/issues/${encodeURIComponent(request.body.parentId)}`);
    coordinatorCreationScope(store, request, companyId, null, grant);
    if (grant) coordinatorParent(parent, grant);
    requireValue(parent.id === request.body.parentId && parent.companyId === companyId,
      'forbidden', 'Parent task belongs to another company', 403);
    requireValue(['backlog', 'todo', 'in_progress', 'blocked', 'in_review'].includes(parent.status),
      'parent_unavailable', 'Parent task must be nonterminal', 409);
    requireValue(canonical(parentOrigin()) === canonical(ownedParent),
      'parent_scope_changed', 'Recorded parent origin changed during task creation', 409);
  }
  operation = store.operation(id);
  if (operation) {
    requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'Task creation key has a different payload', 409);
    if (operation.state === 'recorded') return operation;
  }
  if (!operation) operation = store.saveOperation({ id, runId: '', request, state: 'uncertain' });
  // This endpoint supports idempotency keys; uncertainty reuses the exact key/body.
  const receipt = await api('POST', `/api/companies/${encodeURIComponent(companyId)}/issues`, request.body);
  requireValue(typeof receipt.id === 'string' && receipt.id && receipt.companyId === companyId,
    'invalid_backend_response', 'Task receipt must identify the requested company', 502);
  return store.saveOperation({ ...operation, state: 'recorded', receipt });
}

// Persist integration mutation intent and response, not a second task store.
export async function mutate(store, run, token, api, input) {
  input = structuredClone(input);
  if (input.kind === 'task.create' && input.payload?.relayReviewPolicy === 'coordinator') run = structuredClone(run);
  const key = text(input.key, 'key');
  const kind = text(input.kind, 'kind');
  const taskId = input.taskId ?? run.request.taskId;
  text(taskId, 'taskId');
  const taskPath = `/api/issues/${encodeURIComponent(taskId)}`;
  if (kind === 'task.reference-attach') return attachTaskReference(store, (method, path, body) => api(run, token, method, path, body), {
    ...input.payload, companyId: run.request.companyId, taskId, key,
  }, { authority: { kind: 'job', companyId: run.request.companyId, runId: run.id } });
  if (taskId !== run.request.taskId) {
    const target = await api(run, token, 'GET', taskPath);
    requireValue(target.companyId === run.request.companyId, 'forbidden', 'Target task belongs to another company', 403);
  }
  let method = 'POST';
  let path;
  let body;
  let replaySafe = false;
  let reference;
  let operationId = digest([run.request.companyId, run.request.bindingId, kind, key]);
  if (kind === 'task.create') {
    const { externalReference, ...payload } = input.payload ?? {};
    if (externalReference !== undefined) {
      reference = validateTaskReference({ ...externalReference, companyId: run.request.companyId });
      operationId = digest(['job-task-reference', reference.companyId, reference.namespace, reference.externalId]);
      const existing = await lookupTaskReference(store, (method, path) => api(run, token, method, path), {
        companyId: reference.companyId, namespace: reference.namespace, externalId: reference.externalId,
      });
      if (existing?.state === 'attached') {
        reserveTaskReference(store, reference, operationId);
        return { id: operationId, runId: run.id, state: 'recorded', receipt: existing.task, reusedExisting: true };
      }
    }
    body = taskPayload(payload, reference ? `relay-reference:${operationId}` : `relay:${run.request.bindingId}:${digest(key)}`);
    path = `/api/companies/${encodeURIComponent(run.request.companyId)}/issues`;
    replaySafe = true;
  } else if (kind === 'task.assign') {
    requireValue(input.payload && typeof input.payload === 'object', 'invalid_request', 'Assignment required');
    body = {};
    for (const field of ['assigneeAgentId', 'assigneeUserId']) if (input.payload[field] !== undefined) body[field] = input.payload[field];
    requireValue(Object.keys(body).length > 0, 'invalid_request', 'Assignee required');
    method = 'PATCH';
    path = taskPath;
  } else if (kind === 'task.update') {
    requireValue(input.payload && typeof input.payload === 'object', 'invalid_request', 'Task update required');
    body = {};
    for (const field of ['title', 'description', 'priority', 'parentId', 'blockedByIssueIds', 'unblockDescriptor']) {
      if (input.payload[field] !== undefined) body[field] = input.payload[field];
    }
    if (input.payload.status !== undefined) {
      requireValue(['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'].includes(input.payload.status),
        'invalid_status', 'Unsupported task status');
      if (input.payload.status === 'done') {
        requireValue(taskId !== run.request.taskId, 'execution_managed', 'Submit the job result; execution completion follows verified settlement', 409);
        requireValue(!store.runs().some(item => item.request.companyId === run.request.companyId &&
          item.request.taskId === taskId && item.nativeState !== 'settled'), 'task_busy', 'Target has active work', 409);
        const latest = store.runs().find(item => item.request.companyId === run.request.companyId && item.request.taskId === taskId && item.result);
        if (latest && ['human', 'coordinator'].includes(resultPolicy(store, latest, latest.result))) {
          requireValue(latest.review?.status === 'accepted' && latest.nativeState === 'settled',
          'acceptance_required', 'Latest candidate must be accepted and settled before task completion', 409);
          const interactions = await api(run, token, 'GET', `${taskPath}/interactions`);
          const accepted = interactions.find(item => item.id === latest.review.interactionId);
          requireValue(accepted?.status === 'accepted' && accepted.payload?.target?.revisionId === latest.result.candidate,
          'acceptance_required', 'Backend must confirm exact candidate acceptance', 409);
        }
      }
      body.status = input.payload.status;
    }
    requireValue(Object.keys(body).length > 0, 'invalid_request', 'No supported task update fields');
    method = 'PATCH';
    path = taskPath;
  } else if (kind === 'task.comment') {
    body = { body: text(input.payload?.body, 'comment.body') };
    path = `${taskPath}/comments`;
  } else if (kind === 'question.answer') {
    const interactionId = text(input.interactionId, 'interactionId');
    const interactions = await api(run, token, 'GET', `${taskPath}/interactions`);
    requireValue(interactions.some(item => item.id === interactionId && item.kind === 'ask_user_questions'),
      'interaction_not_found', 'Question does not belong to this task', 404);
    path = `${taskPath}/interactions/${encodeURIComponent(interactionId)}/respond`;
    body = input.payload;
    requireValue(body && Array.isArray(body.answers), 'invalid_request', 'Answers array required');
  } else {
    requireValue(false, 'unsupported_operation', 'Unsupported work operation');
  }
  const request = { kind, method, path, body };
  if (kind === 'task.create') request.relayReviewPolicy = input.payload.relayReviewPolicy ?? 'none';
  if (reference) request.externalReference = reference;
  if (kind === 'task.create' && input.payload.relayReviewGrantId !== undefined) request.relayReviewGrantId = input.payload.relayReviewGrantId;
  let operation = store.operation(operationId);
  if (operation) {
    if (kind === 'task.create' && input.payload.relayReviewPolicy === undefined && operation.request.relayReviewPolicy === undefined) delete request.relayReviewPolicy;
    requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'Operation key has a different payload', 409);
    if (operation.state === 'recorded') {
      if (reference) finishTaskReference(store, reference, operationId, operation.receipt.id);
      return operation;
    }
    if (!replaySafe) {
      if (kind === 'task.assign' || kind === 'task.update') {
        const current = await api(run, token, 'GET', path);
        if (Object.entries(body).every(([key, value]) => canonical(current[key]) === canonical(value))) {
          return store.saveOperation({ ...operation, state: 'recorded', receipt: current, reconciled: true });
        }
      } else if (kind === 'task.comment') {
        const comments = await api(run, token, 'GET', path);
        requireValue(Array.isArray(comments), 'invalid_backend_response', 'Expected comments array', 502);
        const matches = comments.filter(comment => comment.body === body.body && comment.authorAgentId === run.request.agentId &&
          comment.createdByRunId === operation.backendRunId);
        if (matches.length === 1) return store.saveOperation({ ...operation, state: 'recorded', receipt: matches[0], reconciled: true });
      } else if (kind === 'question.answer') {
        const interactions = await api(run, token, 'GET', `${taskPath}/interactions`);
        const current = interactions.find(item => item.id === input.interactionId);
        if (current?.status === 'answered' && canonical(current.result?.answers) === canonical(body.answers)) {
          return store.saveOperation({ ...operation, state: 'recorded', receipt: current, reconciled: true });
        }
      }
      requireValue(false, 'operation_uncertain', 'Backend does not confirm this mutation. No replay is authorised.', 409);
    }
  }
  const grant = coordinatorCreationScope(store, request, run.request.companyId, run);
  if (grant) {
    const parent = await api(run, token, 'GET', `/api/issues/${encodeURIComponent(request.body.parentId)}`);
    coordinatorCreationScope(store, request, run.request.companyId, run, grant);
    coordinatorParent(parent, grant, run);
    operation = store.operation(operationId);
    if (operation) {
      requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'Operation key has a different payload', 409);
      if (operation.state === 'recorded') return operation;
    }
  }
  if (reference) reserveTaskReference(store, reference, operationId);
  if (!operation) operation = store.saveOperation({ id: operationId, runId: run.id, request, state: 'uncertain',
    ...(kind === 'task.comment' ? { backendRunId: run.backendRunId ?? run.request.runId } : {}) });
  const receipt = await api(run, token, method, path, body);
  if (reference) {
    requireValue(receipt?.id && receipt.companyId === run.request.companyId, 'invalid_backend_response', 'Created task must belong to this company', 502);
    finishTaskReference(store, reference, operationId, receipt.id);
  }
  return store.saveOperation({ ...operation, state: 'recorded', receipt });
}
