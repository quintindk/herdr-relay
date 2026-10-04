import { canonical, digest, requireValue, text } from './protocol.mjs';

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
    const value = input.payload;
    requireValue(value && typeof value === 'object', 'invalid_request', 'Task payload required');
    body = { title: text(value.title, 'title'), description: value.description ?? '',
      idempotencyKey: `relay:${run.request.bindingId}:${digest(key)}` };
    for (const field of ['assigneeAgentId', 'assigneeUserId', 'parentId', 'projectId', 'blockedByIssueIds', 'status', 'priority']) {
      if (value[field] !== undefined) body[field] = value[field];
    }
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
