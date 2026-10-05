import { requireValue, text } from './protocol.mjs';

export async function waitForChild(store, run, token, api, input) {
  const childId = text(input.taskId, 'taskId');
  requireValue(run.nativeState === 'claimed' && !run.result && !run.waiting && !run.cancellationRequested,
    'work_inactive', 'Only active acknowledged work can wait for a child', 409);
  const child = await api(run, token, 'GET', `/api/issues/${encodeURIComponent(childId)}`);
  requireValue(child.companyId === run.request.companyId && child.parentId === run.request.taskId && child.id !== run.request.taskId,
    'dependency_scope_mismatch', 'Dependency must be an exact child of this issue', 409);
  requireValue(child.assigneeAgentId && child.assigneeAgentId !== run.request.agentId,
    'invalid_dependency', 'Child must be assigned to another agent', 409);
  const path = `/api/issues/${encodeURIComponent(run.request.taskId)}`;
  const issue = await api(run, token, 'GET', path);
  requireValue(issue.companyId === run.request.companyId && issue.assigneeAgentId === run.request.agentId &&
    (!issue.executionRunId || issue.executionRunId === (run.backendRunId ?? run.request.runId)),
    'dependency_scope_mismatch', 'Parent ownership changed', 409);
  requireValue(!['done', 'cancelled'].includes(child.status), 'dependency_already_terminal', 'Child already finished; inspect its result instead', 409);
  const id = `dependency:${run.id}`;
  let operation = store.operation(id);
  if (operation) requireValue(operation.childId === childId, 'operation_conflict', 'Run is already waiting for another child', 409);
  const matches = value => value.status === 'blocked' && value.blockedBy?.some(item => (item.id ?? item.issueId) === childId);
  if (!matches(issue)) {
    requireValue(!operation, 'dependency_uncertain', 'Dependency mutation attempted; inspect before retrying', 409);
    const blockers = (issue.blockedBy ?? []).map(item => item.id ?? item.issueId);
    requireValue(blockers.every(id => typeof id === 'string'), 'invalid_backend_response', 'Invalid blocker identities', 502);
    operation = store.saveOperation({ id, runId: run.id, childId, state: 'uncertain' });
    await api(run, token, 'PATCH', path, { status: 'blocked', blockedByIssueIds: [...new Set([...blockers, childId])] });
  }
  const receipt = await api(run, token, 'GET', path);
  requireValue(matches(receipt), 'dependency_uncertain', 'Backend has not confirmed the blocked dependency', 409);
  store.saveOperation({ id, runId: run.id, childId, state: 'recorded' });
  return store.waitForDependency(run.id, childId);
}
