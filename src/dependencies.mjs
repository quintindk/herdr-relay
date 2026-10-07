import { canonical, requireValue, text } from './protocol.mjs';

export async function waitForChild(store, run, token, api, input) {
  requireValue(input && (input.taskIds === undefined || input.taskId === undefined),
    'invalid_request', 'Supply taskId or taskIds, not both');
  const ids = input.taskIds === undefined ? [input.taskId] : input.taskIds;
  requireValue(Array.isArray(ids) && ids.length > 0 && ids.length <= 64,
    'invalid_request', 'taskIds must contain between 1 and 64 task IDs');
  const taskIds = ids.map(id => text(id, 'taskId')).sort();
  requireValue(new Set(taskIds).size === taskIds.length && taskIds.every(id => id === id.trim()),
    'invalid_request', 'Task IDs must be unique and have no surrounding whitespace');
  const shape = taskIds.length === 1 ? { childId: taskIds[0] } : { taskIds };
  const sameTasks = value => canonical([...(value.taskIds ?? [value.childId])].sort()) === canonical(taskIds);
  const current = () => {
    const live = store.run(run.id);
    requireValue(live.nativeState === 'claimed' && !live.result && !live.waiting && !live.cancellationRequested &&
      canonical(live.request) === canonical(run.request) &&
      (live.backendRunId ?? live.request.runId) === (run.backendRunId ?? run.request.runId),
    'work_inactive', 'Only current active acknowledged work can wait for children', 409);
    requireValue(!live.dependency || sameTasks(live.dependency), 'operation_conflict', 'Dependency changed', 409);
    return live;
  };
  const id = `dependency:${run.id}`;
  const intent = () => {
    const operation = store.operation(id);
    requireValue(!operation || sameTasks(operation), 'operation_conflict', 'Run already has a different child wait set', 409);
    return operation;
  };
  current();
  intent();
  const children = [];
  for (const taskId of taskIds) {
    const child = await api(run, token, 'GET', `/api/issues/${encodeURIComponent(taskId)}`);
    current();
    requireValue(child.id === taskId && child.companyId === run.request.companyId &&
      child.parentId === run.request.taskId && child.id !== run.request.taskId,
    'dependency_scope_mismatch', 'Dependency must be an exact child of this issue in the same company', 409);
    requireValue(child.assigneeAgentId && child.assigneeAgentId !== run.request.agentId,
      'invalid_dependency', 'Child must be assigned to another agent', 409);
    children.push(child);
  }
  const path = `/api/issues/${encodeURIComponent(run.request.taskId)}`;
  const owned = issue => requireValue(issue.id === run.request.taskId && issue.companyId === run.request.companyId &&
    issue.assigneeAgentId === run.request.agentId &&
    (!issue.executionRunId || issue.executionRunId === (run.backendRunId ?? run.request.runId)),
  'dependency_scope_mismatch', 'Parent ownership changed', 409);
  const issue = await api(run, token, 'GET', path);
  current();
  owned(issue);
  let operation = intent();
  const doneTaskIds = children.filter(child => child.status === 'done').map(child => child.id);
  const cancelledTaskIds = children.filter(child => child.status === 'cancelled').map(child => child.id);
  const pendingTaskIds = children.filter(child => !['done', 'cancelled'].includes(child.status)).map(child => child.id);
  const inspection = {
    state: pendingTaskIds.length ? (cancelledTaskIds.length ? 'blocked' : 'waiting') : 'needs_inspection',
    taskIds, doneTaskIds, cancelledTaskIds, pendingTaskIds,
    message: cancelledTaskIds.length
      ? 'Cancelled children are not successful dependencies. Inspect each child with task inspect RUN --task CHILD_ID and resolve the blocked work.'
      : 'Inspect child results with task inspect RUN --task CHILD_ID before continuing or submitting.',
  };
  // A committed wait ends this turn even if its response was lost and children have since finished.
  const live = current();
  if (live.dependency) return { ...live, dependencyWait: { ...inspection, state: 'waiting',
    message: 'Waiting is already recorded. Finish this turn without submitting. Inspect child results on continuation.' +
      (cancelledTaskIds.length ? ' Cancelled children are not successful dependencies and still require resolution.' : ''),
  } };
  // Terminal children need inspection, not a new blocked parent or native settlement.
  if (!pendingTaskIds.length && !operation) return { ...current(), dependencyWait: inspection };
  const blockers = (issue.blockedBy ?? []).map(item => item.id ?? item.issueId);
  requireValue(blockers.every(id => typeof id === 'string' && id.length > 0),
    'invalid_backend_response', 'Invalid blocker identities', 502);
  const expected = operation?.blockedByIssueIds ?? [...new Set([...blockers, ...pendingTaskIds, ...cancelledTaskIds])].sort();
  // Legacy intents only recorded childId. New intents retain the original blocker set.
  const required = operation?.blockedByIssueIds ?? (operation ? taskIds : expected);
  const matches = value => value.status === 'blocked' &&
    required.every(id => value.blockedBy?.some(item => (item.id ?? item.issueId) === id));
  if (!pendingTaskIds.length && !matches(issue)) {
    return { ...current(), dependencyWait: { ...inspection,
      message: `${inspection.message} The earlier dependency mutation is unconfirmed; inspect the parent and original blockers too.` } };
  }
  if (operation) {
    requireValue(matches(issue), 'dependency_uncertain', 'Dependency mutation attempted; inspect the parent and original blockers before retrying', 409);
  } else {
    current();
    operation = store.saveOperation({ id, runId: run.id, ...shape, blockedByIssueIds: expected, state: 'uncertain' });
    if (!matches(issue)) {
      await api(run, token, 'PATCH', path, { status: 'blocked', blockedByIssueIds: expected });
      current();
    }
  }
  const receipt = await api(run, token, 'GET', path);
  current();
  intent();
  owned(receipt);
  requireValue(matches(receipt), 'dependency_uncertain', 'Backend has not confirmed the blocked dependency', 409);
  store.saveOperation({ ...operation, state: 'recorded' });
  if (!pendingTaskIds.length) return { ...current(), dependencyWait: inspection };
  return { ...store.waitForDependency(run.id, taskIds), dependencyWait: inspection };
}
