import { digest } from './protocol.mjs';

export const refusedDispatchErrors = new Set(['identity_conflict', 'stale_revision', 'task_busy', 'task_terminal', 'task_waiting',
  'dispatch_not_authorised', 'provisioning_not_ready', 'stale_binding', 'task_not_found', 'task_scope_mismatch']);

export function definitiveDispatchRefusal(row) {
  if (row.state !== 'conflict') return null;
  let item;
  try { item = JSON.parse(row.data); } catch { return null; }
  const command = item.command;
  return item.state === 'conflict' && !item.receipt && item.applied !== true && command?.action === 'interactive.dispatch' &&
    command.key === row.key && row.hash === digest(command) && refusedDispatchErrors.has(item.error)
    ? { id: row.key, action: command.action, error: item.error, applied: false } : null;
}

const optional = async (api, path) => {
  try { return await api('GET', path); }
  catch (error) { if (error.status === 404) return null; throw error; }
};

// Reconcile only an explicit repeat of the exact source-owned command. A prior
// transaction refusal is not an uncertain effect, and is never a new task/key.
export async function reconcileDispatchIdentity(journal, api, worker, command, features) {
  const previous = journal.receipt(command.key);
  if (!previous || !['conflict', 'superseded'].includes(previous.state) || previous.error !== 'identity_conflict') return;
  let retry = false, reason = 'Original dispatch was definitively refused. Inspect the existing task and execution before any new request.';
  if (features?.interactiveExistingTaskDispatch && !previous.dispatchReconciliation?.retried) {
    const p = command.payload;
    const [task, preparation, execution] = await Promise.all([
      optional(api, `/v1/tasks/${encodeURIComponent(p.taskId)}`),
      optional(api, `/v1/provision_requests/${encodeURIComponent(p.id)}`),
      optional(api, `/v1/executions/${encodeURIComponent(p.executionId)}`),
    ]);
    retry = !!(task && task.revision === (p.taskRevision ?? 1) && preparation?.state === 'ready' &&
      preparation.requesterAgentId === worker.agentId && !preparation.dispatchedExecutionId && !execution);
    reason = retry ? 'Backend now supports existing-task dispatch. Reusing the exact original key and unchanged payload once.' :
      'Task/preparation changed or an execution exists. Inspect current execution evidence; this refused command will not be replayed.';
  }
  journal.reconcileRefusedDispatch(command, { retry, reason });
}

export function dispatchReceipt(item) {
  return item?.state === 'superseded' && item.outcome === 'refused' ? { ...item, state: 'refused', applied: false,
    effectsUncertain: false, message: item.dispatchReconciliation?.reason ?? 'Dispatch was refused without applying changes. Original command retained.' } : item;
}
