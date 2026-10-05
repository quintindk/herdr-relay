import { canonical, digest, requireValue, text } from './protocol.mjs';
import { validateTaskPolicy } from './task-policy.mjs';

function taskPayload(value, idempotencyKey) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'invalid_request', 'Task payload required');
  const allowed = ['title', 'description', 'assigneeAgentId', 'assigneeUserId', 'parentId', 'projectId', 'blockedByIssueIds', 'status', 'priority', 'relayReviewPolicy'];
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
  const { relayReviewPolicy, ...fields } = value;
  return { ...fields, title: text(value.title, 'title'), description: value.description ?? '', idempotencyKey };
}

export async function createOperatorTask(store, api, input) {
  const companyId = text(input.companyId, 'companyId');
  const key = text(input.key, 'key');
  const id = `operator-task:${digest([companyId, key])}`;
  const request = { companyId, body: taskPayload(input.payload, `relay-operator:${digest([companyId, key])}`) };
  if (input.payload.relayReviewPolicy !== undefined) request.relayReviewPolicy = input.payload.relayReviewPolicy;
  let operation = store.operation(id);
  if (operation) {
    requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'Task creation key has a different payload', 409);
    if (operation.state === 'recorded') return operation;
  }
  // Validate explicit resource scope before creating. Paperclip remains authority
  // for membership/assignment permissions and validates the mutation itself.
  const company = await api('GET', `/api/companies/${encodeURIComponent(companyId)}`);
  requireValue(company.id === companyId, 'identity_mismatch', 'Company identity changed', 409);
  const checks = [
    ...(request.body.parentId ? [['issues', request.body.parentId]] : []),
    ...(request.body.projectId ? [['projects', request.body.projectId]] : []),
    ...(request.body.assigneeAgentId ? [['agents', request.body.assigneeAgentId]] : []),
    ...(request.body.blockedByIssueIds ?? []).map(id => ['issues', id]),
  ];
  for (const [collection, resourceId] of checks) {
    const resource = await api('GET', `/api/${collection}/${encodeURIComponent(resourceId)}`);
    requireValue(resource.id === resourceId && resource.companyId === companyId, 'forbidden', 'Task resource belongs to another company', 403);
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
  const key = text(input.key, 'key');
  const kind = text(input.kind, 'kind');
  const taskId = input.taskId ?? run.request.taskId;
  text(taskId, 'taskId');
  const taskPath = `/api/issues/${encodeURIComponent(taskId)}`;
  if (taskId !== run.request.taskId) {
    const target = await api(run, token, 'GET', taskPath);
    requireValue(target.companyId === run.request.companyId, 'forbidden', 'Target task belongs to another company', 403);
  }
  let method = 'POST';
  let path;
  let body;
  let replaySafe = false;
  if (kind === 'task.create') {
    body = taskPayload(input.payload, `relay:${run.request.bindingId}:${digest(key)}`);
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
    for (const field of ['title', 'description', 'priority', 'blockedByIssueIds']) {
      if (input.payload[field] !== undefined) body[field] = input.payload[field];
    }
    if (input.payload.status !== undefined) {
      requireValue(['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'].includes(input.payload.status),
        'invalid_status', 'Unsupported task status');
      if (input.payload.status === 'done') {
        const latest = store.runs().find(item => item.request.companyId === run.request.companyId && item.request.taskId === taskId && item.result);
        requireValue(latest?.review?.status === 'accepted' && latest.nativeState === 'settled',
          'acceptance_required', 'Latest candidate must be accepted and settled before task completion', 409);
        const interactions = await api(run, token, 'GET', `${taskPath}/interactions`);
        const accepted = interactions.find(item => item.id === latest.review.interactionId);
        requireValue(accepted?.status === 'accepted' && accepted.payload?.target?.revisionId === latest.result.candidate,
          'acceptance_required', 'Backend must confirm exact candidate acceptance', 409);
      }
      body.status = input.payload.status;
    }
    requireValue(Object.keys(body).length > 0, 'invalid_request', 'No supported task update fields');
    method = 'PATCH';
    path = taskPath;
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
  const operationId = digest([run.request.companyId, run.request.bindingId, kind, key]);
  const request = { kind, method, path, body };
  if (kind === 'task.create' && input.payload.relayReviewPolicy !== undefined) request.relayReviewPolicy = input.payload.relayReviewPolicy;
  let operation = store.operation(operationId);
  if (operation) {
    requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'Operation key has a different payload', 409);
    if (operation.state === 'recorded') return operation;
    if (!replaySafe) {
      if (kind === 'task.assign' || kind === 'task.update') {
        const current = await api(run, token, 'GET', path);
        if (Object.entries(body).every(([key, value]) => canonical(current[key]) === canonical(value))) {
          return store.saveOperation({ ...operation, state: 'recorded', receipt: current, reconciled: true });
        }
      } else if (kind === 'question.answer') {
        const interactions = await api(run, token, 'GET', `${taskPath}/interactions`);
        const current = interactions.find(item => item.id === input.interactionId);
        if (current?.status === 'answered' && canonical(current.result?.answers) === canonical(body.answers)) {
          return store.saveOperation({ ...operation, state: 'recorded', receipt: current, reconciled: true });
        }
      }
      requireValue(false, 'operation_uncertain', 'Backend does not confirm this mutation. No replay is authorised.', 409);
    }
  } else operation = store.saveOperation({ id: operationId, runId: run.id, request, state: 'uncertain' });
  const receipt = await api(run, token, method, path, body);
  return store.saveOperation({ ...operation, state: 'recorded', receipt });
}
