import { requireValue } from './protocol.mjs';

export function validateTaskPolicy(policy) {
  requireValue(['none', 'human', 'agent_decides'].includes(policy), 'invalid_review_policy', 'Use none, human or agent_decides');
  return policy;
}

export function taskPolicy(store, companyId, taskId) {
  const records = store.db.prepare('SELECT data FROM operations').all().map(row => JSON.parse(row.data))
    .filter(operation => operation.state === 'recorded' && operation.receipt?.id === taskId &&
      (operation.request?.companyId === companyId || operation.request?.path === `/api/companies/${encodeURIComponent(companyId)}/issues`) &&
      (operation.id.startsWith('operator-task:') || operation.request?.kind === 'task.create'));
  const policies = [...new Set(records.map(operation => operation.request.relayReviewPolicy ?? 'human'))];
  requireValue(policies.length <= 1, 'review_policy_conflict', 'Conflicting task creation policies', 409);
  return validateTaskPolicy(policies[0] ?? 'human');
}

export function resultPolicy(store, run, submission) {
  const policy = taskPolicy(store, run.request.companyId, run.request.taskId);
  const choice = submission.reviewDecision;
  if (choice !== undefined) {
    requireValue(choice && ['none', 'human'].includes(choice.mode) && typeof choice.reason === 'string' &&
      choice.reason.trim().length > 0 && choice.reason.length <= 2000, 'invalid_review_decision', 'Review decision requires mode none/human and a reason');
    requireValue(policy === 'agent_decides' || choice.mode === policy, 'review_policy_locked', 'Worker cannot override the creator review policy', 403);
  }
  requireValue(policy !== 'agent_decides' || choice, 'review_decision_required', 'Task delegates review choice: submit reviewDecision with mode and reason');
  return policy === 'agent_decides' ? choice.mode : policy;
}
