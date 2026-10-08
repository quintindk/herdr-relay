import { canonical, digest, requireValue, text } from './protocol.mjs';
import { createOperatorTask } from './operations.mjs';

const publicFields = ['id', 'companyId', 'identifier', 'title', 'description', 'parentId', 'projectId',
  'assigneeUserId', 'assigneeAgentId', 'status', 'priority', 'updatedAt'];
const guardedFields = [...publicFields, 'createdAt', 'responsibleUserId', 'executionRunId', 'checkoutRunId',
  'executionLockedAt', 'activeRun', 'activeRecoveryAction', 'executionBlocker', 'executionState',
  'executionPolicy', 'reviewPolicy', 'reviewAttention', 'blockedBy', 'blockedByIssueIds',
  'blockerAttention', 'blockedInboxAttention', 'unblockDescriptor', 'liveDescendantCount', 'hiddenAt'];
const pick = (value, fields) => Object.fromEntries(fields.map(field => [field, value[field] ?? null]));
const object = (value, fields) => requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(field => fields.includes(field) && value[field] !== undefined),
'invalid_request', 'Unsupported or missing request fields');
const fresh = (value, limit) => { const age = Date.now() - Date.parse(value); return age >= 0 && age < limit; };

// The caller serialises writes per task. Revision checks are best effort: the
// backend PATCH has no compare-and-swap contract. Uncertain PATCHes are never sent twice.
// Inspect returns { task, revision, defaultHumanUserId? }; mutations additionally
// return { operationId, state, reconciled? }. No backend configuration is returned.
export async function humanTask(store, api, input, { check = () => {}, authority = { kind: 'operator' } } = {}) {
  object(input, ['action', 'companyId', 'taskId', 'key', 'expectedRevision', 'payload', 'reason']);
  input = structuredClone(input);
  authority = structuredClone(authority);
  requireValue(authority && typeof authority === 'object' && !Array.isArray(authority), 'invalid_authority', 'Server authority required');
  text(authority.kind, 'authority.kind');
  const { action, companyId, taskId } = input;
  requireValue(['create', 'inspect', 'edit', 'assign', 'complete'].includes(action), 'invalid_request', 'Unknown human task action');
  text(companyId, 'companyId');
  if (action !== 'create') text(taskId, 'taskId');
  else requireValue(taskId === undefined && input.expectedRevision === undefined, 'invalid_request', 'Creation cannot target an existing task');
  if (input.reason !== undefined) text(input.reason, 'reason');
  if (action === 'inspect') requireValue(['key', 'expectedRevision', 'payload', 'reason'].every(field => input[field] === undefined),
    'invalid_request', 'Inspection accepts only companyId and taskId');
  else {
    text(input.key, 'key');
    if (action !== 'create') text(input.expectedRevision, 'expectedRevision');
  }
  const payload = input.payload ?? {};
  if (action === 'complete') requireValue(input.payload === undefined, 'invalid_request', 'Completion accepts no payload');
  if (['create', 'edit'].includes(action)) {
    object(input.payload, ['title', 'description', 'priority', 'status', 'unblockDescriptor',
      ...(action === 'create' ? ['parentId', 'projectId', 'assigneeUserId'] : [])]);
    requireValue(Object.keys(payload).length > 0, 'invalid_request', 'Task fields required');
    if (action === 'create' || payload.title !== undefined) text(payload.title, 'title');
    if (payload.description !== undefined) requireValue(typeof payload.description === 'string', 'invalid_request', 'Description must be a string');
    if (payload.priority !== undefined) requireValue(['critical', 'high', 'medium', 'low'].includes(payload.priority), 'invalid_request', 'Invalid priority');
    if (payload.status !== undefined) requireValue(['backlog', 'todo', 'in_progress', 'blocked',
      ...(action === 'edit' ? ['cancelled'] : [])].includes(payload.status), 'invalid_status', 'Use completion for done; review status is not editable');
    for (const field of ['parentId', 'projectId', 'assigneeUserId']) {
      if (payload[field] !== undefined && (field === 'assigneeUserId' || payload[field] !== null)) text(payload[field], field);
    }
    if (payload.unblockDescriptor !== undefined) {
      const descriptor = payload.unblockDescriptor;
      object(descriptor, ['owner', 'action']);
      requireValue(text(descriptor.action, 'unblockDescriptor.action').length <= 2000, 'invalid_request', 'Unblock action exceeds 2000 characters');
      if (descriptor.owner !== 'board') {
        object(descriptor.owner, ['userId']);
        text(descriptor.owner.userId, 'unblockDescriptor.owner.userId');
      }
    }
    requireValue(payload.status !== 'blocked' || payload.unblockDescriptor, 'invalid_request', 'Blocked status requires an unblock descriptor');
  }
  let desired;
  if (action === 'assign') {
    object(input.payload, ['assigneeUserId', 'assigneeAgentId']);
    const fields = Object.keys(payload);
    requireValue(fields.length === 1 || (fields.length === 2 && fields.every(field => payload[field] === null)),
      'invalid_request', 'Choose one assignee, or explicitly clear both');
    for (const field of fields) if (payload[field] !== null) text(payload[field], field);
    desired = { assigneeUserId: null, assigneeAgentId: null, ...payload };
    if (desired.assigneeAgentId) text(input.reason, 'reason');
  } else if (action === 'complete') desired = { status: 'done' };
  else if (action === 'edit') desired = payload;

  // Source evidence belongs to the immutable request, not the durable owner/key.
  const owner = Object.fromEntries(Object.entries(authority).filter(([field]) =>
    !['sourceMessageId', 'sourceCreatedAt', 'sourceDigest', 'source', 'epoch', 'bindingRevision', 'bindingConfig'].includes(field)));
  const id = action === 'inspect' ? null : `human-task:${digest([companyId, owner, input.key])}`;
  const request = { ...input, authority };
  const previous = () => {
    const operation = id && store.operation(id);
    requireValue(!operation || canonical(operation.request) === canonical(request), 'operation_conflict', 'Human task key has a different request or authority source', 409);
    return operation;
  };
  const send = async (...args) => {
    check();
    try { return await api(...args); }
    finally { check(); }
  };
  const scoped = (value, expectedId) => {
    requireValue(value && value.id === expectedId && value.companyId === companyId, 'forbidden', 'Task resource must belong to the requested company', 403);
    return value;
  };
  const runsFor = targetId => store.runs().filter(run => run.request.companyId === companyId && run.request.taskId === targetId);
  const localState = targetId => {
    const runs = runsFor(targetId);
    const decisions = [`review-decision:${digest([companyId, targetId])}`, ...runs.flatMap(run =>
      [`completion:${run.id}`, `no-review-completion:${run.id}`,
        ...(run.review?.interactionId ? [`harness-review:${digest([companyId, run.review.interactionId])}`] : [])])]
      .map(operationId => store.operation(operationId)).filter(Boolean);
    return { runs: runs.map(run => ({ id: run.id, request: run.request, nativeState: run.nativeState,
      result: run.result, review: run.review, publication: run.publication, settlement: run.settlement,
      waiting: run.waiting, dependency: run.dependency, cancellationRequested: run.cancellationRequested })), decisions };
  };
  const inspect = async targetId => {
    const task = scoped(await send('GET', `/api/issues/${encodeURIComponent(targetId)}`), targetId);
    requireValue(publicFields.every(field => task[field] == null || typeof task[field] === 'string') &&
      ['title', 'status', 'priority'].every(field => typeof task[field] === 'string') && task.descriptionTruncated !== true,
    'invalid_backend_response', 'Expected complete task text and scalar public fields', 502);
    const interactions = await send('GET', `/api/issues/${encodeURIComponent(targetId)}/interactions`);
    requireValue(Array.isArray(interactions) && interactions.every(item => item && typeof item.status === 'string' &&
      (item.companyId === undefined || item.companyId === companyId) && (item.issueId === undefined || item.issueId === targetId)),
    'invalid_backend_response', 'Invalid task interactions', 502);
    check();
    const local = localState(targetId);
    return { task, interactions, local, revision: digest([pick(task, guardedFields), interactions, local]) };
  };
  const response = (snapshot, operation) => ({ task: pick(snapshot.task, publicFields), revision: snapshot.revision,
    ...(operation ? { operationId: operation.id, state: operation.state, ...(operation.reconciled ? { reconciled: true } : {}) } : {}) });
  const company = async () => {
    const value = await send('GET', `/api/companies/${encodeURIComponent(companyId)}`);
    requireValue(value?.id === companyId, 'forbidden', 'Company identity changed', 403);
    return value;
  };
  check();
  let operation = previous();
  if (action === 'inspect') {
    const settings = await company();
    const snapshot = await inspect(taskId);
    check();
    return { ...response(snapshot), ...(typeof settings.defaultResponsibleUserId === 'string' && settings.defaultResponsibleUserId.trim()
      ? { defaultHumanUserId: settings.defaultResponsibleUserId } : {}) };
  }
  if (action === 'create') {
    if (!operation) {
      const settings = await company();
      check();
      const body = { ...payload, assigneeUserId: text(payload.assigneeUserId ?? settings.defaultResponsibleUserId, 'assigneeUserId'),
        description: payload.description ?? '', status: payload.status ?? 'todo' };
      operation = previous() ?? store.saveOperation({ id, runId: '', request, body, state: 'uncertain' });
    }
    if (operation.state !== 'recorded') {
      const { unblockDescriptor, ...body } = operation.body;
      // The existing creator owns backend idempotency. Its strict payload parser
      // predates unblockDescriptor, so append only the validated, persisted value.
      const created = await createOperatorTask(store, (method, path, value) => send(method, path,
        method === 'POST' && unblockDescriptor ? { ...value, unblockDescriptor } : value),
      { companyId, key: `human-task:create:${digest([companyId, owner, input.key])}`, payload: body });
      check();
      operation = store.saveOperation({ ...operation, state: 'recorded', taskId: created.receipt.id });
    }
    const snapshot = await inspect(operation.taskId);
    check();
    return response(snapshot, operation);
  }

  const initial = await inspect(taskId);
  check();
  operation = previous();
  if (operation) {
    if (operation.state !== 'recorded') {
      requireValue(Object.entries(operation.expected).every(([field, value]) => canonical(initial.task[field] ?? null) === canonical(value)),
        'operation_uncertain', 'Backend does not confirm the requested fields and ownership. No replay is authorised.', 409);
      operation = store.saveOperation({ ...operation, state: 'recorded', reconciled: true, receipt: pick(initial.task, publicFields) });
    }
    return response(initial, operation);
  }
  requireValue(initial.revision === input.expectedRevision, 'stale_revision', 'Inspect the task again before changing it', 409);
  const guard = snapshot => {
    check();
    const task = snapshot.task;
    requireValue(!task.executionRunId && !task.checkoutRunId && !task.executionLockedAt && !task.activeRun &&
      !task.activeRecoveryAction && !task.executionBlocker && !task.executionState,
    'task_busy', 'Execution, recovery or execution policy state prevents human mutation', 409);
    requireValue(!snapshot.interactions.some(item => item.status === 'pending'), 'interaction_pending', 'Resolve pending task interactions first', 409);
    requireValue(canonical(localState(taskId)) === canonical(snapshot.local), 'stale_revision', 'Relay task state changed', 409);
    requireValue(snapshot.local.decisions.every(item => item.state === 'recorded' || item.state === 'skipped'),
      'review_decision_uncertain', 'Resolve uncertain review or completion decisions first', 409);
    for (const run of runsFor(taskId)) {
      requireValue(run.nativeState === 'settled', 'task_busy', 'Relay work must settle before human mutation', 409);
      if (run.result) {
        requireValue(run.review?.status === 'accepted' && run.review.candidate === run.result.candidate &&
          run.publication?.state === 'recorded' && run.settlement?.outcome === 'completed',
        'acceptance_required', 'Every prior result must be accepted, settled and published', 409);
        requireValue(snapshot.interactions.some(item => item.id === run.review.interactionId && item.status === 'accepted' &&
          item.kind === 'request_confirmation' && item.payload?.target?.revisionId === run.result.candidate &&
          item.payload.target.label === run.id && item.payload.target.key === 'herdr-relay-candidate' &&
          item.payload.target.type === 'custom' && item.idempotencyKey === `relay-review:${run.id}:${digest(run.result)}`),
        'acceptance_required', 'Backend must confirm exact candidate acceptance', 409);
      }
    }
    if (action === 'complete') {
      requireValue(typeof task.assigneeUserId === 'string' && task.assigneeUserId.trim() && !task.assigneeAgentId,
        'human_assignment_required', 'Only a currently human-assigned task can be completed here', 409);
      requireValue(!task.reviewPolicy && !task.executionPolicy && !['blocked', 'in_review', 'cancelled'].includes(task.status),
        'review_required', 'Task policy or disposition requires its dedicated workflow', 409);
      requireValue(!task.liveDescendantCount, 'dependency_unresolved', 'Active descendants prevent completion', 409);
    }
  };
  const targetReady = () => {
    if (!desired.assigneeAgentId) return;
    for (const binding of store.bindings().filter(item => item.config.agentId === desired.assigneeAgentId && item.config.companyId === companyId)) {
      const bridge = store.operation(`opencode-bridge:${binding.id}`);
      if (!bridge) continue;
      const observed = store.operation(bridge.identity?.observedId);
      requireValue(!binding.lifecycleState && bridge.state === 'armed' && bridge.ready === true && fresh(bridge.lastSeen, 10000) &&
        binding.config.harness === 'opencode' && binding.config.delivery === 'pull' &&
        (!binding.config.taskId || binding.config.taskId === taskId) &&
        typeof bridge.epoch === 'string' && bridge.epoch.trim() && Number.isSafeInteger(bridge.sessionCreatedAt) && bridge.sessionCreatedAt > 0 &&
        bridge.identity.bindingId === binding.id && bridge.identity.conversationId === binding.config.conversationId &&
        typeof bridge.identity.terminalId === 'string' && bridge.identity.terminalId.trim() &&
        typeof bridge.identity.directory === 'string' && bridge.identity.directory.trim() &&
        observed?.availability === 'present' && !observed.error && fresh(observed.updatedAt, 15000) &&
        observed.agentId === desired.assigneeAgentId && observed.identity?.companyId === companyId &&
        observed.identity.harness === 'opencode' && observed.identity.sessionKind === 'id' &&
        binding.config.instanceId === digest([observed.identity.machineId, observed.identity.session]) &&
        observed.identity.conversationId === bridge.identity.conversationId &&
        observed.placement?.terminalId === bridge.identity.terminalId && observed.placement?.directory === bridge.identity.directory &&
        !store.runs(binding.id).some(run => run.nativeState !== 'settled'),
      'agent_not_ready', 'Assignment requires a fresh ready armed bridge without active work', 409);
      store.assertWorkerAdmission(binding.id);
    }
  };
  guard(initial);
  if (desired.assigneeAgentId) scoped(await send('GET', `/api/agents/${encodeURIComponent(desired.assigneeAgentId)}`), desired.assigneeAgentId);
  if (action === 'complete') {
    const blockers = initial.task.blockedBy ?? [];
    const blockerIds = initial.task.blockedByIssueIds ?? [];
    requireValue(Array.isArray(blockers) && Array.isArray(blockerIds), 'invalid_backend_response', 'Invalid task blockers', 502);
    for (const blockerId of new Set([...blockerIds, ...blockers.map(item => item.id ?? item.issueId)])) {
      text(blockerId, 'blockerId');
      const blocker = scoped(await send('GET', `/api/issues/${encodeURIComponent(blockerId)}`), blockerId);
      requireValue(blocker.status === 'done', 'dependency_unresolved', 'Every blocker must be done before completion', 409);
    }
    const query = new URLSearchParams({ parentId: taskId, status: 'backlog,todo,in_progress,blocked,in_review', limit: '1', includePluginOperations: 'true' });
    const children = await send('GET', `/api/companies/${encodeURIComponent(companyId)}/issues?${query}`);
    requireValue(Array.isArray(children), 'invalid_backend_response', 'Invalid child task response', 502);
    requireValue(children.length === 0, 'dependency_unresolved', 'Active children prevent completion', 409);
  }
  const current = await inspect(taskId);
  requireValue(current.revision === initial.revision, 'stale_revision', 'Task changed while validating the mutation', 409);
  guard(current);
  targetReady();
  requireValue(!previous(), 'operation_conflict', 'Concurrent human task operation', 409);
  const body = Object.fromEntries(Object.entries(desired).filter(([field, value]) => canonical(current.task[field] ?? null) !== canonical(value)));
  // Assignment must explicitly clear the opposite owner even when already null.
  if (action === 'assign' && Object.keys(body).length) Object.assign(body, desired);
  const expected = { ...pick(current.task, ['id', 'companyId', 'assigneeUserId', 'assigneeAgentId']), ...desired };
  check();
  operation = store.saveOperation({ id, runId: '', request, body, expected, state: 'uncertain' });
  if (Object.keys(body).length) await send('PATCH', `/api/issues/${encodeURIComponent(taskId)}`, body);
  const receipt = await inspect(taskId);
  check();
  operation = store.saveOperation({ ...operation, state: 'recorded', receipt: pick(receipt.task, publicFields) });
  return response(receipt, operation);
}
