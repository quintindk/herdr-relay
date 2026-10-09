import { canonical, digest, requireValue, text } from './protocol.mjs';
import { createOperatorTask } from './operations.mjs';
import { resultPolicy } from './task-policy.mjs';
import { finishTaskReference, reserveTaskReference, taskReferences, validateTaskReference } from './task-references.mjs';

const publicFields = ['id', 'companyId', 'identifier', 'title', 'description', 'parentId', 'projectId',
  'assigneeUserId', 'assigneeAgentId', 'responsibleUserId', 'status', 'priority', 'updatedAt',
  'createdAt', 'completedAt', 'cancelledAt'];
const guardedFields = [...publicFields, 'executionRunId', 'checkoutRunId',
  'executionLockedAt', 'activeRun', 'activeRecoveryAction', 'executionBlocker', 'executionState',
  'executionPolicy', 'reviewPolicy', 'reviewAttention', 'blockedBy', 'blockedByIssueIds',
  'blocks', 'blockerAttention', 'blockedInboxAttention', 'unblockDescriptor', 'liveDescendantCount', 'hiddenAt'];
const pick = (value, fields) => Object.fromEntries(fields.map(field => [field, value[field] ?? null]));
const object = (value, fields) => requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(field => fields.includes(field) && value[field] !== undefined),
'invalid_request', 'Unsupported or missing request fields');
const fresh = (value, limit) => { const age = Date.now() - Date.parse(value); return age >= 0 && age < limit; };

// The caller serialises writes per task. Revision checks are best effort: the
// backend PATCH has no compare-and-swap contract. Uncertain writes are never sent twice
// except creation, whose existing wrapper owns backend idempotency.
// Inspect returns { task, revision, defaultHumanUserId? }; mutations additionally
// return { operationId, state, outcome: { confirmed, reused? }, reconciled? }.
// Recording a backend response does not imply it matched the requested outcome.
// Create alone accepts externalReference: { namespace, externalId, url? }. Existing
// references reuse the actual task without editing it. Lookup/attach remain separate
// dispatcher routes, whose public attach wrapper must require expectedRevision.
export async function humanTask(store, api, input, { check = () => {}, authority = { kind: 'operator' } } = {}) {
  object(input, ['action', 'companyId', 'taskId', 'key', 'expectedRevision', 'payload', 'reason', 'externalReference']);
  input = structuredClone(input);
  authority = structuredClone(authority);
  requireValue(authority && typeof authority === 'object' && !Array.isArray(authority), 'invalid_authority', 'Server authority required');
  text(authority.kind, 'authority.kind');
  const { action, companyId, taskId } = input;
  requireValue(['create', 'inspect', 'edit', 'assign', 'complete', 'comment', 'reopen', 'cancel', 'recover'].includes(action), 'invalid_request', 'Unknown human task action');
  text(companyId, 'companyId');
  let externalReference;
  if (input.externalReference !== undefined) {
    requireValue(action === 'create', 'invalid_request', 'External reference is only supported on creation');
    object(input.externalReference, ['namespace', 'externalId', 'url']);
    externalReference = validateTaskReference({ companyId, ...input.externalReference });
  }
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
  if (['complete', 'cancel', 'recover'].includes(action)) requireValue(input.payload === undefined, 'invalid_request', 'This action accepts no payload');
  if (['cancel', 'recover'].includes(action)) text(input.reason, 'reason');
  if (action === 'comment') {
    object(input.payload, ['body']);
    text(payload.body, 'body');
    // Paperclip 2026.1001.0 shared/project-mentions parses agent:// Markdown
    // links, not bare @names or email addresses. Reject the scheme conservatively
    // (even in code/plain text), without a racy company-agent lookup.
    requireValue(!/agent:\/\//i.test(payload.body), 'agent_mention_forbidden',
      'Human task comments cannot contain agent:// references: backend mentions can wake agents');
  }
  if (action === 'reopen') {
    object(input.payload, ['status']);
    requireValue(payload.status === undefined || ['todo', 'in_progress'].includes(payload.status), 'invalid_status', 'Reopen to todo or in_progress');
  }
  if (['create', 'edit'].includes(action)) {
    object(input.payload, ['title', 'description', 'priority', 'status', 'unblockDescriptor', 'parentId', 'blockedByIssueIds',
      ...(action === 'create' ? ['projectId', 'assigneeUserId'] : [])]);
    requireValue(Object.keys(payload).length > 0, 'invalid_request', 'Task fields required');
    if (action === 'create' || payload.title !== undefined) text(payload.title, 'title');
    if (payload.description !== undefined) requireValue(typeof payload.description === 'string', 'invalid_request', 'Description must be a string');
    if (payload.priority !== undefined) requireValue(['critical', 'high', 'medium', 'low'].includes(payload.priority), 'invalid_request', 'Invalid priority');
    if (payload.status !== undefined) requireValue(['backlog', 'todo', 'in_progress', 'blocked'].includes(payload.status),
      'invalid_status', 'Use dedicated completion, reopen and cancellation actions');
    if (payload.blockedByIssueIds !== undefined) {
      requireValue(Array.isArray(payload.blockedByIssueIds) && payload.blockedByIssueIds.length <= 100 &&
        new Set(payload.blockedByIssueIds).size === payload.blockedByIssueIds.length, 'invalid_request', 'Expected at most 100 unique dependencies');
      payload.blockedByIssueIds.forEach(id => text(id, 'blockedByIssueId'));
    }
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
  } else if (['complete', 'recover'].includes(action)) desired = { status: 'done' };
  else if (action === 'reopen') desired = { status: payload.status ?? 'todo' };
  else if (action === 'cancel') desired = { status: 'cancelled' };
  else if (action === 'comment') desired = {};
  else if (action === 'edit') desired = payload;

  // Source evidence belongs to the immutable request, not the durable owner/key.
  const owner = Object.fromEntries(Object.entries(authority).filter(([field]) =>
    !['sourceMessageId', 'sourceCreatedAt', 'sourceDigest', 'source', 'epoch', 'bindingRevision', 'bindingConfig'].includes(field)));
  const id = action === 'inspect' ? null : `human-task:${digest([companyId, owner, input.key])}`;
  // UUID-shaped deterministic request identity, independent of retries and backend authorship.
  const hash = digest(id);
  const clientRequestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
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
  const fence = targetId => {
    const pending = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'human-task:%'").all()
      .map(row => JSON.parse(row.data)).some(item => item.id !== id && item.state !== 'recorded' &&
        item.request?.companyId === companyId && (item.request.taskId === targetId || item.taskId === targetId));
    requireValue(!pending, 'operation_uncertain', 'Reconcile the earlier human task write before using a different key', 409);
  };
  const relations = async () => {
    const cache = new Map();
    const read = async targetId => {
      text(targetId, 'relatedTaskId');
      requireValue(targetId !== taskId, 'relationship_cycle', 'Task cannot refer back to itself', 409);
      if (!cache.has(targetId)) {
        requireValue(cache.size < 100, 'graph_limit', 'Relationship validation exceeds 100 tasks', 409);
        cache.set(targetId, scoped(await send('GET', `/api/issues/${encodeURIComponent(targetId)}`), targetId));
      }
      return cache.get(targetId);
    };
    const visit = async (targetId, kind, visiting, visited) => {
      requireValue(!visiting.has(targetId), 'relationship_cycle', 'Relationship graph contains a cycle', 409);
      if (visited.has(targetId)) return;
      const task = await read(targetId);
      visiting.add(targetId);
      const next = kind === 'parent' ? (task.parentId == null ? [] : [task.parentId]) : dependencyIds(task);
      for (const nextId of next) await visit(nextId, kind, visiting, visited);
      visiting.delete(targetId);
      visited.add(targetId);
    };
    if (payload.parentId != null) await visit(payload.parentId, 'parent', new Set(), new Set());
    const visited = new Set();
    for (const dependencyId of payload.blockedByIssueIds ?? []) await visit(dependencyId, 'dependency', new Set(), visited);
  };
  const dependencyIds = task => {
    requireValue((task.blockedByIssueIds == null || Array.isArray(task.blockedByIssueIds)) &&
      (task.blockedBy == null || Array.isArray(task.blockedBy)), 'invalid_backend_response', 'Invalid task dependencies', 502);
    const ids = [...new Set([...(task.blockedByIssueIds ?? []), ...(task.blockedBy ?? []).map(item => item?.id)])];
    requireValue(ids.length <= 100 && ids.every(id => typeof id === 'string' && id.trim()), 'invalid_backend_response', 'Invalid task dependencies', 502);
    return ids;
  };
  const project = task => {
    const value = { ...pick(task, publicFields), blockedByIssueIds: dependencyIds(task) };
    for (const field of ['blockedBy', 'blocks']) {
      requireValue(task[field] == null || Array.isArray(task[field]), 'invalid_backend_response', 'Invalid relationship summaries', 502);
      value[field] = (task[field] ?? []).map(item => {
        const fields = ['id', 'identifier', 'title', 'status', 'priority', 'assigneeAgentId', 'assigneeUserId'];
        requireValue(item && fields.every(key => item[key] == null || typeof item[key] === 'string') &&
          (item.companyId === undefined || item.companyId === companyId), 'invalid_backend_response', 'Invalid relationship summary', 502);
        return pick(item, fields);
      });
    }
    const descriptor = task.unblockDescriptor;
    value.unblockDescriptor = null;
    if (descriptor != null) {
      const owner = descriptor.owner;
      requireValue(typeof descriptor.action === 'string' && descriptor.action.length <= 2000 &&
        (owner === 'board' || (owner && typeof owner === 'object' && !Array.isArray(owner) &&
          ['userId', 'agentId'].filter(key => typeof owner[key] === 'string' && owner[key].trim()).length === 1)),
      'invalid_backend_response', 'Invalid unblock descriptor', 502);
      value.unblockDescriptor = { action: descriptor.action, owner: owner === 'board' ? owner :
        (typeof owner.userId === 'string' ? { userId: owner.userId } : { agentId: owner.agentId }) };
    }
    return value;
  };
  const commentReceipt = async operation => {
    // Paperclip's after cursor round-trips SQL timestamps through JS Date,
    // losing sub-millisecond precision and potentially returning the anchor again.
    const comments = await send('GET', `/api/issues/${encodeURIComponent(taskId)}/comments?order=asc`);
    requireValue(Array.isArray(comments) && comments.length <= 10000,
      'invalid_backend_response', 'Expected at most 10000 comments. No replay is authorised.', 502);
    const seen = new Set();
    let match;
    for (const comment of comments) {
      requireValue(comment && typeof comment.id === 'string' && comment.id.trim() && !seen.has(comment.id) &&
        comment.companyId === companyId && comment.issueId === taskId,
      'invalid_backend_response', 'Invalid comment receipt scope or identity', 502);
      seen.add(comment.id);
      if (comment.clientRequestId !== operation.clientRequestId) continue;
      requireValue(!match && comment.body === operation.commentBody && (!operation.commentId || operation.commentId === comment.id) &&
        comment.authorType === 'user' && typeof comment.authorUserId === 'string' && comment.authorUserId.trim() &&
        comment.authorAgentId == null && comment.derivedAuthorAgentId == null &&
        comment.createdByRunId == null && comment.derivedCreatedByRunId == null && comment.deletedAt == null,
      'operation_uncertain', 'Exact user-authored comment receipt not confirmed', 409);
      match = comment;
    }
    requireValue(match, 'operation_uncertain', 'Comment not confirmed. No replay is authorised.', 409);
    return match.id;
  };
  const runsFor = targetId => store.runs().filter(run => run.request.companyId === companyId && run.request.taskId === targetId);
  const recordRecoveredCompletion = () => {
    const run = runsFor(taskId).find(item => item.result);
    const id = `no-review-completion:${run.id}`;
    const value = { id, runId: run.id, companyId, taskId, state: 'recorded', status: 'done', policy: 'none',
      candidate: run.result.candidate, decision: run.result.reviewDecision ?? null, recoveredFrom: 'cancelled_published_routine' };
    const existing = store.operation(id);
    const { updatedAt, ...persisted } = existing ?? {};
    requireValue(!existing || canonical(persisted) === canonical(value), 'completion_uncertain', 'Recovered completion record conflicts', 409);
    if (!existing) store.saveOperation(value);
  };
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
    const references = taskReferences(store, companyId, targetId);
    const publicTask = { ...project(task), references };
    return { task, publicTask, interactions, local, revision: digest([pick(task, guardedFields), interactions, local, references]) };
  };
  const matches = (snapshot, expected) => Object.entries(expected).every(([field, value]) =>
    canonical(snapshot.publicTask[field] ?? null) === canonical(value));
  const response = (snapshot, operation) => ({ task: snapshot.publicTask, revision: snapshot.revision,
    ...(operation ? { operationId: operation.id, state: operation.state,
      outcome: { confirmed: matches(snapshot, operation.expected ?? operation.body) &&
        (!operation.clientRequestId || Boolean(operation.commentId)), ...(operation.reused ? { reused: true } : {}) },
      ...(operation.reconciled ? { reconciled: true } : {}) } : {}) });
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
    if (externalReference && operation?.state !== 'recorded') {
      // Persist exact key/source before reservation, so even pre-create failures
      // cannot adopt this reservation with changed task fields or authority.
      operation = store.transaction(() => {
        check();
        return previous() ?? store.saveOperation({ id, runId: '', request, state: 'uncertain' });
      });
      check();
      const reservation = reserveTaskReference(store, externalReference, id);
      check();
      if (reservation.state === 'attached' && !operation.taskId) {
        operation = store.saveOperation({ ...operation, taskId: reservation.taskId, reused: true,
          expected: { id: reservation.taskId, companyId } });
      }
    }
    if (!operation?.body && !operation?.taskId) {
      const settings = await company();
      check();
      const body = { ...payload, assigneeUserId: text(payload.assigneeUserId ?? settings.defaultResponsibleUserId, 'assigneeUserId'),
        description: payload.description ?? '', status: payload.status ?? 'todo' };
      await relations();
      check();
      operation = store.transaction(() => {
        check();
        const current = previous();
        return current?.body || current?.taskId ? current : store.saveOperation({ ...current, id, runId: '', request, body, state: 'uncertain' });
      });
    }
    if (operation.state !== 'recorded' && !operation.taskId) {
      const { unblockDescriptor, ...body } = operation.body;
      // The existing creator owns backend idempotency. Its strict payload parser
      // predates unblockDescriptor, so append only the validated, persisted value.
      const created = await createOperatorTask(store, (method, path, value) => send(method, path,
        method === 'POST' && unblockDescriptor ? { ...value, unblockDescriptor } : value),
      { companyId, key: `human-task:create:${digest([companyId, owner, input.key])}`, payload: body });
      check();
      operation = store.saveOperation({ ...previous(), taskId: created.receipt.id });
    }
    check();
    if (externalReference && !operation.reused) finishTaskReference(store, externalReference, id, operation.taskId);
    const snapshot = await inspect(operation.taskId);
    check();
    operation = store.transaction(() => {
      check();
      const current = previous();
      return current.state === 'recorded' ? current : store.saveOperation({ ...current, state: 'recorded', receipt: snapshot.publicTask });
    });
    return response(snapshot, operation);
  }

  let initial = await inspect(taskId);
  check();
  operation = previous();
  if (operation) {
    if (operation.state !== 'recorded') {
      requireValue(matches(initial, operation.expected),
        'operation_uncertain', 'Backend does not confirm the requested fields and ownership. No replay is authorised.', 409);
      const commentId = operation.clientRequestId ? await commentReceipt(operation) : undefined;
      if (commentId) {
        initial = await inspect(taskId);
        requireValue(matches(initial, operation.expected), 'operation_uncertain', 'Task changed during comment reconciliation', 409);
      }
      operation = store.saveOperation({ ...operation, ...(commentId ? { commentId } : {}), state: 'recorded', reconciled: true, receipt: initial.publicTask });
      if (action === 'recover') { recordRecoveredCompletion(); initial = await inspect(taskId); }
    }
    return response(initial, operation);
  }
  fence(taskId);
  requireValue(initial.revision === input.expectedRevision, 'stale_revision', 'Inspect the task again before changing it', 409);
  const guard = snapshot => {
    check();
    const task = snapshot.task;
    if (action === 'recover') {
      const runs = runsFor(taskId), run = runs.find(item => item.result);
      const routed = store.operation(`routine-task:${digest([companyId, taskId])}`);
      const blocker = task.executionBlocker;
      requireValue(task.status === 'blocked' && !task.assigneeUserId && typeof task.assigneeAgentId === 'string' &&
        !task.executionRunId && !task.checkoutRunId && !task.executionLockedAt && !task.activeRun &&
        !task.activeRecoveryAction && !task.executionState && blocker?.cause === 'legacy_execution_requires_reconciliation' &&
        typeof blocker.recoveryActionId === 'string' && blocker.recoveryActionId && run && runs.filter(item => item.result).length === 1 &&
        run.nativeState === 'settled' && run.settlement?.outcome === 'cancelled' && run.cancellationRequested === true &&
        run.publication?.state === 'recorded' && !run.waiting && !run.dependency && !run.review &&
        run.request.agentId === task.assigneeAgentId && blocker.agentId === run.request.agentId &&
        blocker.runId === (run.backendRunId ?? run.request.runId) && resultPolicy(store, run, run.result) === 'none' &&
        !task.reviewPolicy && routed?.state === 'recorded' && routed.receipt?.id === taskId && routed.relayRunId === run.id &&
        routed.routingAgentId === run.request.agentId && routed.request?.relayReviewPolicy === 'none' &&
        snapshot.interactions.every(item => item.status !== 'pending') &&
        snapshot.local.decisions.every(item => item.state === 'recorded' || item.state === 'skipped'),
      'recovery_not_authorised', 'Only an exact published no-review routine result with a legacy cancelled-execution blocker can be recovered', 409);
      return;
    }
    requireValue(!task.executionRunId && !task.checkoutRunId && !task.executionLockedAt && !task.activeRun &&
      !task.activeRecoveryAction && !task.executionBlocker && !task.executionState,
    'task_busy', 'Execution, recovery or execution policy state prevents human mutation', 409);
    // Paperclip 2026.1001.0 issueExecutionPolicySchema defaults. Unknown policy
    // fields, configured stages, monitors and review controls are never inert.
    const policy = task.executionPolicy;
    requireValue(policy == null || (typeof policy === 'object' && !Array.isArray(policy) && policy.mode === 'normal' &&
      Object.keys(policy).every(key => ['mode', 'commentRequired', 'stages', 'monitor', 'maxReviewRounds'].includes(key)) &&
      (policy.commentRequired === undefined || typeof policy.commentRequired === 'boolean') &&
      (policy.stages === undefined || (Array.isArray(policy.stages) && policy.stages.length === 0)) &&
      policy.monitor == null && policy.maxReviewRounds == null), 'review_required', 'Execution policy requires its dedicated workflow', 409);
    requireValue(!snapshot.interactions.some(item => item.status === 'pending'), 'interaction_pending', 'Resolve pending task interactions first', 409);
    requireValue(canonical(localState(taskId)) === canonical(snapshot.local), 'stale_revision', 'Relay task state changed', 409);
    requireValue(snapshot.local.decisions.every(item => item.state === 'recorded' || item.state === 'skipped'),
      'review_decision_uncertain', 'Resolve uncertain review or completion decisions first', 409);
    const runs = runsFor(taskId);
    requireValue(runs.every(run => run.nativeState === 'settled'), 'task_busy', 'Relay work must settle before human mutation', 409);
    const run = runs.find(run => run.result);
    if (run && action !== 'comment') {
      const completion = store.operation(`no-review-completion:${run.id}`);
      const noReview = completion?.state === 'recorded' && completion.runId === run.id && completion.companyId === companyId &&
        completion.taskId === taskId && completion.status === 'done' && completion.policy === 'none' &&
        completion.candidate === run.result.candidate && canonical(completion.decision) === canonical(run.result.reviewDecision ?? null) &&
        resultPolicy(store, run, run.result) === 'none' && !task.reviewPolicy;
      requireValue(run.publication?.state === 'recorded' && run.settlement?.outcome === 'completed',
        'acceptance_required', 'Latest result must be settled and published', 409);
      if (!noReview) {
        requireValue(run.review?.status === 'accepted' && run.review.candidate === run.result.candidate,
        'acceptance_required', 'Latest result must have exact acceptance or recorded policy-matched no-review completion', 409);
        requireValue(snapshot.interactions.some(item => item.id === run.review.interactionId && item.status === 'accepted' &&
          item.kind === 'request_confirmation' && canonical(item.payload?.target) === canonical({ type: 'custom',
            key: 'herdr-relay-candidate', revisionId: run.result.candidate, label: run.id }) &&
          item.idempotencyKey === `relay-review:${run.id}:${digest(run.result)}`),
        'acceptance_required', 'Backend must confirm exact candidate acceptance', 409);
      }
    }
    // resume:false only suppresses self-comment resumption, not assignee wakes.
    if (['complete', 'reopen', 'cancel', 'comment'].includes(action)) {
      requireValue(typeof task.assigneeUserId === 'string' && task.assigneeUserId.trim() && !task.assigneeAgentId,
        'human_assignment_required', 'Only a currently human-assigned task can change disposition or receive comments here', 409);
    }
    if (action === 'reopen') requireValue(['done', 'cancelled'].includes(task.status), 'invalid_status', 'Only done or cancelled tasks can reopen', 409);
    if (action === 'edit' && desired.status !== undefined) requireValue(!['done', 'cancelled'].includes(task.status),
      'invalid_status', 'Use explicit reopen for terminal tasks', 409);
    if (action === 'complete') {
      requireValue(!task.reviewPolicy && !['blocked', 'in_review', 'cancelled'].includes(task.status),
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
  if (action === 'edit') await relations();
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
  fence(taskId);
  requireValue(!previous(), 'operation_conflict', 'Concurrent human task operation', 409);
  const body = Object.fromEntries(Object.entries(desired).filter(([field, value]) => canonical(current.task[field] ?? null) !== canonical(value)));
  // Assignment must explicitly clear the opposite owner even when already null.
  if (action === 'assign' && Object.keys(body).length) Object.assign(body, desired);
  const expected = { ...pick(current.task, ['id', 'companyId', 'assigneeUserId', 'assigneeAgentId']), ...desired };
  check();
  // Cancellation reasons remain in request.reason, not backend comments. Terminal
  // child transitions can still wake parents through Paperclip's own automation.
  const commentBody = action === 'comment' ? payload.body : undefined;
  if (action === 'comment') Object.assign(body, { body: commentBody, clientRequestId, reopen: false, resume: false, interrupt: false });
  operation = store.saveOperation({ id, runId: '', request, body, expected, state: 'uncertain',
    ...(commentBody !== undefined ? { clientRequestId, commentBody } : {}) });
  if (Object.keys(body).length) await send(action === 'comment' ? 'POST' : 'PATCH',
    `/api/issues/${encodeURIComponent(taskId)}${action === 'comment' ? '/comments' : ''}`, body);
  const commentId = commentBody !== undefined ? await commentReceipt(operation) : undefined;
  let receipt = await inspect(taskId);
  check();
  operation = store.saveOperation({ ...operation, ...(commentId ? { commentId } : {}), state: 'recorded', receipt: receipt.publicTask });
  if (action === 'recover') { recordRecoveredCompletion(); receipt = await inspect(taskId); }
  return response(receipt, operation);
}
