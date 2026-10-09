import { canonical, digest, requireValue, text } from './protocol.mjs';

export async function recoverBackend(store, api, input) {
  const run = store.run(text(input.runId, 'runId'));
  requireValue(run.nativeState === 'settled' && run.result && run.settlement.outcome === 'completed',
    'native_settlement_required', 'Recovery orchestration requires a completed native result', 409);
  const prior = store.db.prepare("SELECT data FROM operations WHERE run_id = ? AND id LIKE 'backend-recovery:%' ORDER BY rowid DESC")
    .all(run.id).map(row => JSON.parse(row.data));
  const pending = prior.find(operation => operation.state !== 'recorded');
  const originalId = pending?.originalId ?? run.backendRunId ?? run.request.runId;
  const id = pending?.id ?? `backend-recovery:${run.id}:${originalId}`;
  let operation = pending ?? store.operation(id);
  if (operation?.state === 'recorded') return operation;
  const old = await api('GET', `/api/heartbeat-runs/${encodeURIComponent(originalId)}`);
  const completed = prior.find(operation => operation.state === 'recorded' && operation.replacementId === originalId);
  if (completed && ['running', 'succeeded'].includes(old.status)) return completed;
  requireValue(old.id === originalId && old.companyId === run.request.companyId && old.agentId === run.request.agentId &&
    ['failed', 'timed_out', 'interrupted', 'cancelled'].includes(old.status),
  'recovery_not_authorised', 'Original backend run must be terminal for the same identity', 409);
  const agentPath = `/api/agents/${encodeURIComponent(run.request.agentId)}`;
  const agent = await api('GET', agentPath);
  const routed = store.operation(`routine-task:${digest([run.request.companyId, run.request.taskId])}`);
  const routine = routed?.routingAgentId && store.operation(routed.scheduleId);
  requireValue(agent.companyId === run.request.companyId && agent.adapterType === 'herdr_relay' &&
    (routine ? routine.router?.agentId === run.request.agentId &&
      canonical(agent.adapterConfig.relayRoutineScope) === canonical(routine.persistentScope) &&
      agent.adapterConfig.relayRoutineMarker === routine.router.marker : agent.adapterConfig.bindingId === run.request.bindingId),
  'recovery_identity_mismatch', 'Backend agent no longer targets this Relay binding', 409);
  if (!operation) operation = store.saveOperation({ id, runId: run.id, state: 'intent',
    originalId, adapterConfig: agent.adapterConfig, runtimeConfig: agent.runtimeConfig });
  const taskPath = `/api/issues/${encodeURIComponent(run.request.taskId)}`;
  const recovery = await api('GET', `${taskPath}/recovery-actions`);
  if (recovery.active) {
    requireValue(recovery.active.evidence?.runId === originalId, 'recovery_conflict', 'Another recovery action owns the task', 409);
    await api('POST', `${taskPath}/recovery-actions/resolve`, {
      actionId: recovery.active.id, outcome: 'restored', sourceIssueStatus: 'todo',
      executionReconciliation: { runId: originalId, providerStopped: true, actionOutcome: 'completed',
        outcomeEvidence: `Relay ${run.id} recorded candidate ${run.result.candidate}. Native settlement: ${run.settlement.evidence}` },
    });
  }
  const config = { ...operation.adapterConfig, recoverRelayRunId: run.id };
  requireValue(canonical(agent.adapterConfig) === canonical(operation.adapterConfig) || canonical(agent.adapterConfig) === canonical(config),
    'recovery_config_conflict', 'Agent configuration changed during recovery', 409);
  if (!operation.replacementId) {
    await api('PATCH', agentPath, { adapterConfig: config,
      runtimeConfig: { ...operation.runtimeConfig, heartbeat: { ...operation.runtimeConfig?.heartbeat,
        enabled: true, wakeOnDemand: true, intervalSec: 0 } } });
    operation = store.saveOperation({ ...operation, state: 'replacement_pending' });
    const receipt = await api('POST', `${agentPath}/heartbeat/invoke`, { reason: 'relay_backend_recovery',
      idempotencyKey: id, payload: { taskId: run.request.taskId, issueId: run.request.taskId } });
    requireValue(receipt.id, 'recovery_wake_skipped', 'Paperclip did not schedule the replacement run', 409);
    operation = store.saveOperation({ ...operation, replacementId: receipt.id, state: 'replacement_started' });
  }
  const replacement = await api('GET', `/api/heartbeat-runs/${encodeURIComponent(operation.replacementId)}`);
  requireValue(replacement.agentId === run.request.agentId && replacement.companyId === run.request.companyId,
    'recovery_identity_mismatch', 'Replacement backend identity changed', 409);
  if (store.run(run.id).backendRunId !== operation.replacementId) return operation;
  const current = await api('GET', agentPath);
  requireValue(canonical(current.adapterConfig) === canonical(config) || canonical(current.adapterConfig) === canonical(operation.adapterConfig),
    'recovery_config_conflict', 'Agent configuration changed before restoration', 409);
  await api('PATCH', agentPath, { adapterConfig: operation.adapterConfig, runtimeConfig: operation.runtimeConfig });
  return store.saveOperation({ ...operation, state: 'recorded' });
}
