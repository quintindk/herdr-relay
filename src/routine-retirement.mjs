import { canonical, digest, requireValue } from './protocol.mjs';
import { routineExecutionMode } from './routines.mjs';

export const routineRetirementId = (scheduleId, taskId, occurrenceId) =>
  `routine-retirement:${digest([scheduleId, taskId, occurrenceId])}`;
const retirementLocks = new WeakMap();

function verifyScope(operation, schedule, task) {
  requireValue(operation.scheduleId === schedule.id && operation.routineId === schedule.routineId &&
    operation.taskId === task.id && operation.companyId === task.companyId &&
    operation.occurrenceId === task.originRunId && operation.scheduleAuthority === digest([
      schedule.request, schedule.authority, schedule.target, schedule.routineId, schedule.triggerId,
    ]), 'routine_retirement_conflict', 'Routine retirement identity changed', 409);
}

async function performRetirement(store, api, schedule, task, reason) {
  requireValue(routineExecutionMode(schedule) === 'interactive_exact' && task.originKind === 'routine_execution' &&
    task.originId === schedule.routineId && task.originRunId && task.companyId === schedule.request.companyId,
  'routine_retirement_conflict', 'Only an exact owned occurrence can retire its schedule', 409);
  const id = routineRetirementId(schedule.id, task.id, task.originRunId);
  let operation = store.transaction(() => {
    const existing = store.operation(id);
    if (existing) return existing;
    const live = store.operation(schedule.id);
    requireValue(live && !store.operation(`routine-task:${digest([task.companyId, task.id])}`) &&
      !store.runs().some(run => run.request.companyId === task.companyId && run.request.taskId === task.id),
    'routine_occurrence_reserved', 'Admitted routine work cannot be retired as unavailable', 409);
    const value = { id, runId: '', state: 'uncertain', reason, scheduleId: schedule.id,
      routineId: schedule.routineId, taskId: task.id, companyId: task.companyId,
      occurrenceId: task.originRunId, scheduleAuthority: digest([
        schedule.request, schedule.authority, schedule.target, schedule.routineId, schedule.triggerId,
      ]), steps: {} };
    store.saveOperation({ ...live, cancellationRequested: true, retirementOperationId: id });
    return store.saveOperation(value);
  });
  verifyScope(operation, schedule, task);
  if (operation.state === 'recorded') return operation;
  const save = changes => { operation = store.saveOperation({ ...store.operation(id), ...changes }); return operation; };

  let routine = await api('GET', `/api/routines/${encodeURIComponent(schedule.routineId)}`);
  requireValue(routine.id === schedule.routineId && routine.companyId === task.companyId,
    'routine_retirement_conflict', 'Backend routine identity changed', 409);
  if (routine.status !== 'archived') {
    const prior = operation.steps.archive;
    requireValue(!prior || prior.baseRevisionId === routine.latestRevisionId,
      'routine_retirement_uncertain', 'Routine changed after an unconfirmed archive', 409);
    save({ steps: { ...operation.steps, archive: { sent: true, baseRevisionId: routine.latestRevisionId } } });
    await api('PATCH', `/api/routines/${encodeURIComponent(schedule.routineId)}`, {
      status: 'archived', baseRevisionId: routine.latestRevisionId,
    });
    routine = await api('GET', `/api/routines/${encodeURIComponent(schedule.routineId)}`);
  }
  requireValue(routine.status === 'archived', 'routine_retirement_uncertain', 'Backend routine archive is not confirmed', 409);
  if (!operation.steps.archive?.confirmed) save({ steps: { ...operation.steps, archive: { ...operation.steps.archive, confirmed: true } } });

  const taskPath = `/api/issues/${encodeURIComponent(task.id)}`;
  let current = await api('GET', taskPath);
  requireValue(current.id === task.id && current.companyId === task.companyId && current.originKind === 'routine_execution' &&
    current.originId === schedule.routineId && current.originRunId === task.originRunId,
  'routine_retirement_conflict', 'Backend occurrence identity changed', 409);
  if (current.status === 'done') {
    const live = store.operation(schedule.id);
    store.saveOperation({ ...live, state: 'cancelled', cancellationRequested: true, creationComplete: true,
      latestRevisionId: routine.latestRevisionId });
    return save({ state: 'recorded', occurrenceStatus: 'done' });
  }
  if (current.status !== 'cancelled') {
    const prior = operation.steps.cancel;
    requireValue(!prior || prior.status === current.status && prior.updatedAt === current.updatedAt,
      'routine_retirement_uncertain', 'Occurrence changed after an unconfirmed cancellation', 409);
    save({ steps: { ...operation.steps, cancel: { sent: true, status: current.status, updatedAt: current.updatedAt ?? null } } });
    await api('PATCH', taskPath, { status: 'cancelled' });
    current = await api('GET', taskPath);
  }
  requireValue(current.status === 'cancelled', 'routine_retirement_uncertain', 'Occurrence cancellation is not confirmed', 409);
  const live = store.operation(schedule.id);
  requireValue(live.retirementOperationId === id && canonical(live.request) === canonical(schedule.request),
    'routine_retirement_conflict', 'Routine changed during retirement', 409);
  store.saveOperation({ ...live, state: 'cancelled', cancellationRequested: true, creationComplete: true,
    latestRevisionId: routine.latestRevisionId });
  return save({ state: 'recorded', steps: { ...operation.steps, cancel: { ...operation.steps.cancel, confirmed: true } } });
}

export async function retireExactRoutine(store, api, schedule, task, reason) {
  let locks = retirementLocks.get(store);
  if (!locks) { locks = new Map(); retirementLocks.set(store, locks); }
  const key = `${schedule.id}:${task.id}`;
  if (locks.has(key)) return locks.get(key);
  const pending = performRetirement(store, api, schedule, task, reason);
  locks.set(key, pending);
  try { return await pending; } finally { locks.delete(key); }
}

export async function reconcileRoutineRetirements(store, api, locks = new Map()) {
  const pending = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'routine-retirement:%'").all()
    .map(row => JSON.parse(row.data)).filter(operation => operation.state !== 'recorded');
  for (const operation of pending) {
    const key = `routine-retirement:${operation.taskId}`;
    if (locks.has(key)) continue;
    const work = (async () => {
      const schedule = store.operation(operation.scheduleId);
      if (!schedule) return;
      try {
        const task = await api('GET', `/api/issues/${encodeURIComponent(operation.taskId)}`);
        await retireExactRoutine(store, api, schedule, task, operation.reason);
      } catch (error) {
        store.saveOperation({ ...store.operation(operation.id), lastError: error.code ?? 'backend_unavailable' });
      }
    })();
    locks.set(key, work);
    try { await work; } finally { locks.delete(key); }
  }
}
