import { canonical, digest, requireValue } from './protocol.mjs';
import { routineExecutionMode, routineTargetAdmission } from './routines.mjs';
import { resolveRoutineFolder } from './persistent-routines.mjs';
import { ownedRuntime } from './runtimes.mjs';
import { OpenCode } from './opencode.mjs';
import { retireExactRoutine } from './routine-retirement.mjs';

function exactTargetLoss(store, schedule) {
  if (routineExecutionMode(schedule) !== 'interactive_exact') return null;
  const target = schedule.target, binding = store.binding(schedule.request.targetBindingId, false);
  if (!binding) return 'binding_missing';
  if (binding.lifecycleState) return 'binding_retired';
  if (binding.id !== target?.bindingId || binding.revision !== target.bindingRevision ||
    binding.createdAt !== target.bindingCreatedAt || digest(binding.config) !== target.bindingConfig ||
    binding.config.companyId !== target.companyId || binding.config.agentId !== target.agentId ||
    binding.config.conversationId !== target.conversationId || binding.config.delivery !== 'pull') return 'binding_identity_changed';
  const bridge = store.operation(`opencode-bridge:${binding.id}`);
  if (!bridge) return 'conversation_missing';
  if (bridge.identity?.conversationId !== target.conversationId || bridge.sessionCreatedAt !== target.sessionCreatedAt) {
    return 'conversation_identity_changed';
  }
  const observed = bridge?.identity?.observedId && store.operation(bridge.identity.observedId);
  const offlineId = `routine-exact-offline:${schedule.id}`;
  if (observed?.availability === 'offline') {
    const evidence = store.operation(offlineId);
    const identity = digest([target.bindingId, target.conversationId, target.sessionCreatedAt]);
    if (!evidence || evidence.identity !== identity || evidence.state === 'cleared') {
      store.saveOperation({ id: offlineId, runId: '', state: 'observed', identity, firstSeenAt: new Date().toISOString() });
      return null;
    }
    if (Date.now() - Date.parse(evidence.firstSeenAt) >= 30000) return 'conversation_offline';
    return null;
  }
  const evidence = store.operation(offlineId);
  if (evidence?.state === 'observed') store.saveOperation({ ...evidence, state: 'cleared', clearedAt: new Date().toISOString() });
  return null;
}

export function assertRoutineTask(store, bindingId, taskId, { verifyRuntime = ownedRuntime } = {}) {
  const binding = store.binding(bindingId);
  const record = store.operation(`routine-task:${digest([binding.config.companyId, taskId])}`);
  if (!record) return;
  const schedule = store.operation(record.scheduleId);
  const bridge = store.operation(`opencode-bridge:${bindingId}`);
  const admission = routineTargetAdmission(store, binding, undefined, { allowBusyBridge: true, verifyRuntime });
  requireValue(schedule?.created && !schedule.cancellationRequested && schedule.state !== 'cancelled' &&
    (schedule.persistentScope ? schedule.router?.agentId === record.routingAgentId &&
      schedule.persistentScope.directory === record.target.directory : canonical(schedule.target) === canonical(record.target)) &&
    binding.id === record.target.bindingId &&
    binding.revision === record.target.bindingRevision && digest(binding.config) === record.target.bindingConfig &&
    admission.ready && canonical(admission.target) === canonical(record.target) &&
    (record.target.managed || bridge?.identity.conversationId === record.target.conversationId &&
      bridge.identity.terminalId === record.target.terminalId && bridge.sessionCreatedAt === record.target.sessionCreatedAt),
  'routine_execution_mismatch', 'Routine target or cancellation state changed', 409);
}

// Called before a new dispatch. The backend issue and native routine-run receipt,
// not caller-supplied wake metadata, establish provenance.
export async function admitRoutineExecution(store, api, input, { observationConfig, verifyRuntime = ownedRuntime,
  nativeSnapshot = binding => new OpenCode(binding.config).snapshot(), recoverManaged } = {}) {
  const schedules = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'routine:%'").all()
    .map(row => JSON.parse(row.data));
  if (!schedules.length) return;
  const previous = store.runs().find(run => run.request.companyId === input.companyId &&
    (run.request.runId === input.runId || run.backendRunId === input.runId));
  if (previous) {
    const receipt = store.operation(`routine-task:${digest([input.companyId, input.taskId])}`);
    if (!receipt?.routingAgentId) return;
    requireValue(previous.request.taskId === input.taskId && previous.request.agentId === input.agentId &&
      (input.bindingId === undefined || input.bindingId === previous.request.bindingId),
    'dispatch_conflict', 'Existing routine dispatch identity changed', 409);
    return previous; // Never resolve a replacement chat for an admitted occurrence.
  }
  const task = await api('GET', `/api/issues/${encodeURIComponent(input.taskId)}`);
  requireValue(task.id === input.taskId && task.companyId === input.companyId,
    'routine_execution_mismatch', 'Task identity changed', 409);
  if (task.originKind !== 'routine_execution') return;
  const matching = schedules.filter(r => r.routineId === task.originId && r.request.companyId === input.companyId &&
    (r.persistentScope ? r.router?.agentId === input.agentId : r.request.targetBindingId === input.bindingId));
  let schedule = matching[0];
  const priorClaim = store.operation(`routine-task:${digest([task.companyId, task.id])}`);
  if (schedule?.persistentScope && priorClaim?.scheduleId === schedule.id && priorClaim.routineRunId === task.originRunId) {
    const priorRun = priorClaim.relayRunId && store.run(priorClaim.relayRunId);
    if (input.reportedOccurrenceNoop === true && priorRun?.nativeState === 'settled' && priorRun.settlement?.outcome === 'completed' &&
      priorRun.result && priorRun.publication.state === 'recorded') {
      return { skipped: true, reason: 'routine_occurrence_already_reported', relayRunId: priorRun.id,
        conversationId: priorRun.conversationId };
    }
    requireValue(!schedule.editOperationId || store.operation(schedule.editOperationId)?.state === 'recorded',
      'routine_target_busy', 'Job review transition is being reconciled', 409);
    requireValue(false, 'routine_occurrence_reserved', 'This occurrence is already pinned; recover its original run', 409);
  }
  requireValue(!schedule?.editOperationId || store.operation(schedule.editOperationId)?.state === 'recorded',
    'routine_target_busy', 'Job definition update is being reconciled', 409);
  const definition = schedule && [{ body: schedule.body, relayReviewPolicy: schedule.request.relayReviewPolicy },
    ...[...(schedule.versions ?? [])].reverse()].find(version => version.body && task.title === version.body.title &&
      task.description === version.body.description && task.assigneeAgentId === version.body.assigneeAgentId &&
      (task.projectId ?? null) === version.body.projectId && (task.parentId ?? null) === version.body.parentIssueId);
  requireValue(matching.length === 1 && schedule.created && task.originRunId &&
    task.assigneeAgentId === (schedule.router?.agentId ?? schedule.target?.agentId) && !task.assigneeUserId &&
    definition,
  'routine_execution_mismatch', 'Task is not an exact owned routine occurrence', 409);
  const routine = await api('GET', `/api/routines/${encodeURIComponent(task.originId)}`);
  requireValue(routine.id === schedule.routineId && routine.companyId === input.companyId &&
    Object.entries(schedule.body).filter(([k]) => k !== 'status').every(([k,v]) => canonical(routine[k]) === canonical(v)),
  'routine_execution_mismatch', 'Routine configuration changed', 409);
  requireValue(Array.isArray(routine.triggers) && routine.triggers.length === 1 &&
    routine.triggers[0].id === schedule.triggerId && routine.triggers[0].routineId === schedule.routineId &&
    routine.triggers[0].kind === 'schedule' && routine.triggers[0].cronExpression === schedule.request.cron &&
    routine.triggers[0].timezone === schedule.request.timezone && !routine.triggers[0].archived,
  'routine_execution_mismatch', 'Routine trigger changed', 409);
  const runs = await api('GET', `/api/routines/${encodeURIComponent(task.originId)}/runs?limit=200`);
  const evidence = Array.isArray(runs) ? runs.filter(run => run.id === task.originRunId) : [];
  const occurrence = evidence[0];
  requireValue(evidence.length === 1 && occurrence.companyId === input.companyId && occurrence.routineId === task.originId &&
    occurrence.linkedIssueId === task.id &&
    ((occurrence.source === 'schedule' && occurrence.triggerId === schedule.triggerId) ||
      (occurrence.source === 'manual' && !occurrence.triggerId && store.db.prepare("SELECT data FROM operations WHERE id LIKE 'routine-mutation:%'").all()
        .map(row => JSON.parse(row.data)).some(op => op.request.scheduleId === schedule.id && op.request.action === 'run' &&
          op.body?.idempotencyKey === occurrence.idempotencyKey))),
  'routine_execution_mismatch', 'Exact occurrence receipt is unavailable', 409);
  const authority = value => value && [value.id, value.routineId, value.triggerId, value.request, value.editOperationId,
    value.body, value.target, value.authority, value.persistentScope, value.router,
    value.created, value.state, value.cancellationRequested ?? false];
  requireValue(canonical(authority(store.operation(schedule.id))) === canonical(authority(schedule)),
    'routine_execution_mismatch', 'Routine authority changed during admission', 409);
  requireValue(!schedule.cancellationRequested && schedule.state !== 'cancelled',
    'routine_cancelled', 'Cancelled routine cannot admit new work', 409);
  if (schedule.target?.managed && recoverManaged) {
    await recoverManaged();
    schedule = store.operation(schedule.id);
    const health = store.operation(`routine-runtime-health:${schedule.id}`);
    requireValue(health?.state !== 'unavailable', 'routine_target_busy',
      `Managed scheduled runtime unavailable: ${health?.reason}. Recovery is pending; no native work has started.`, 409);
  }
  const recordId = `routine-task:${digest([task.companyId, task.id])}`;
  const claimed = store.operation(recordId);
  requireValue(!schedule.persistentScope || !claimed,
    'routine_occurrence_reserved', 'This occurrence is already pinned; use exact backend recovery, not another delivery', 409);
  const loss = exactTargetLoss(store, schedule);
  if (loss) {
    await retireExactRoutine(store, api, schedule, task, loss);
    requireValue(false, 'routine_retired', 'Exact interactive conversation is permanently unavailable', 409);
  }
  const admission = schedule.persistentScope
    ? resolveRoutineFolder(store, schedule.persistentScope, observationConfig, routineTargetAdmission)
    : routineTargetAdmission(store, store.binding(input.bindingId), task, { verifyRuntime });
  const transientExact = routineExecutionMode(schedule) === 'interactive_exact' &&
    ['conversation_busy', 'routine_bridge_unavailable', 'routine_observation_mismatch', 'worker_grant_inactive'].includes(admission.blocker);
  requireValue(admission.ready, transientExact || ['conversation_busy', 'routine_bridge_unavailable'].includes(admission.blocker)
    ? 'routine_target_busy' : admission.blocker,
    `Scheduled target unavailable: ${admission.blocker}. Managed runtime recovery is reported by routine inspect.`, 409);
  const target = admission.target;
  if (target.managed) {
    const snapshot = await nativeSnapshot(store.binding(target.bindingId));
    requireValue(snapshot?.idle === true, 'routine_target_busy', 'Managed routine target must have an idle native session', 409);
    const latest = routineTargetAdmission(store, store.binding(target.bindingId), task, { verifyRuntime });
    requireValue(latest.ready && canonical(latest.target) === canonical(target),
      'routine_target_busy', 'Managed routine target changed before admission', 409);
  }
  const origin = schedule.persistentScope ? {
    bindingId: target.bindingId, conversationId: target.conversationId, sessionCreatedAt: target.sessionCreatedAt,
  } : schedule.authority.kind === 'native' ? {
    bindingId: schedule.authority.bindingId, conversationId: schedule.authority.conversationId,
    sessionCreatedAt: schedule.authority.sessionCreatedAt,
  } : null;
  const operation = { id: recordId, runId: '', state: 'recorded',
    scheduleId: schedule.id, routineRunId: occurrence.id, target,
    ...(schedule.persistentScope ? { routingAgentId: schedule.router.agentId, backendRunId: input.runId } : {}),
    request: { companyId: task.companyId, relayReviewPolicy: definition.relayReviewPolicy,
      body: { title: task.title, description: task.description, assigneeAgentId: task.assigneeAgentId, parentId: task.parentId ?? null },
      ...(origin ? { origin } : {}) },
    receipt: { id: task.id, companyId: task.companyId, identifier: task.identifier, title: task.title,
      assigneeAgentId: task.assigneeAgentId, parentId: task.parentId ?? null } };
  const saved = store.operation(operation.id);
  requireValue(!saved || canonical({ ...saved, updatedAt: undefined }) === canonical({ ...operation, updatedAt: undefined }),
    'routine_execution_mismatch', 'Occurrence provenance conflicts', 409);
  if (schedule.persistentScope) {
    requireValue(canonical(authority(store.operation(schedule.id))) === canonical(authority(schedule)),
      'routine_execution_mismatch', 'Routine changed before dispatch', 409);
    const latest = resolveRoutineFolder(store, schedule.persistentScope, observationConfig, routineTargetAdmission);
    requireValue(latest.ready && canonical(latest.target) === canonical(target),
      'routine_target_busy', 'Folder target changed before admission', 409);
    requireValue(!store.operation(operation.id), 'routine_occurrence_reserved', 'Occurrence was already admitted', 409);
    return store.dispatch({ ...input, bindingId: target.bindingId, bindingRevision: target.bindingRevision }, operation);
  }
  if (!saved) store.saveOperation(operation);
  if (target.managed) return store.dispatch({ ...input, bindingRevision: target.bindingRevision });
}
