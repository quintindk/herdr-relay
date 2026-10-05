import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, digest, requireValue, text } from './protocol.mjs';
import { workerContext } from './supervisor.mjs';

export async function prepareObservedPull(store, directory, api, input) {
  requireValue(input.reserved === true, 'reservation_required', 'Explicit operator reservation of the existing conversation is required');
  const observed = store.operation(text(input.observedId, 'observedId'));
  requireValue(observed?.id.startsWith('herdr-agent:') && observed.agentId && observed.identity.harness === 'opencode',
    'invalid_observed_agent', 'Registered OpenCode observation required');
  requireValue(observed.availability === 'present' && ['idle', 'done'].includes(observed.observation?.state) &&
    Date.now() - Date.parse(observed.updatedAt) < 15000 && !observed.error,
  'agent_not_ready', 'Recent unique idle Herdr observation required', 409);
  const taskId = text(input.taskId, 'taskId');
  const task = await api('GET', `/api/issues/${encodeURIComponent(taskId)}`);
  requireValue(task.companyId === observed.identity.companyId && (!task.assigneeAgentId || task.assigneeAgentId === observed.agentId) &&
    !task.executionRunId && !['done', 'cancelled'].includes(task.status), 'task_conflict', 'Task must be available in this company', 409);
  const bindingId = `observed-${digest(observed.id).slice(0, 24)}`;
  const id = `observed-pull:${bindingId}`;
  const request = { observedId: observed.id, taskId, agentId: observed.agentId };
  let permit = store.operation(id);
  const advance = permit?.state === 'closed' && input.previousTaskId === permit.request.taskId && taskId !== permit.request.taskId;
  if (permit && !advance) requireValue(canonical(permit.request) === canonical(request) && permit.state === 'active' && Date.parse(permit.expiresAt) > Date.now(),
    'reservation_conflict', 'Reservation is closed or belongs to another task', 409);
  const backend = await api('GET', `/api/agents/${observed.agentId}`);
  requireValue(backend.companyId === observed.identity.companyId && backend.adapterType === 'herdr_relay' &&
    backend.adapterConfig?.relayObservationMarker === observed.marker, 'agent_identity_mismatch', 'Backend observation identity changed', 409);
  if (advance) {
    requireValue(store.runs(bindingId).every(run => run.nativeState === 'settled') &&
      !store.runs(bindingId).some(run => run.request.taskId === taskId), 'reservation_conflict', 'Unsettled or previously attempted task cannot be rearmed', 409);
    const previous = await api('GET', `/api/issues/${encodeURIComponent(permit.request.taskId)}`);
    requireValue(previous.companyId === observed.identity.companyId && ['done', 'cancelled'].includes(previous.status) && !previous.executionRunId,
      'reservation_conflict', 'Previous task must be terminal before the next reservation', 409);
  }
  if (!permit || advance) {
    requireValue(backend.adapterConfig.observationOnly === true, 'agent_config_conflict', 'Existing adapter is not observation-only', 409);
    permit = store.saveOperation({ id, runId: '', request, state: 'active', expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
      ...(advance ? { history: [...(permit.history ?? []), { request: permit.request, state: permit.state, expiresAt: permit.expiresAt }] } : {}) });
  }
  const binding = store.register({ id: bindingId, companyId: observed.identity.companyId, agentId: observed.agentId,
    harness: 'opencode', instanceId: digest([observed.identity.machineId, observed.identity.session]),
    conversationId: observed.identity.conversationId, delivery: 'pull', label: observed.observation.display.name }).binding;
  const contextFile = workerContext(directory, join(directory, 'relay.sock'), store, binding);
  const operatorFile = join(directory, 'adapter-context.json');
  const context = JSON.stringify({ socketPath: join(directory, 'relay.sock'), token: readFileSync(join(directory, 'admin-token'), 'utf8').trim() });
  if (!existsSync(operatorFile)) writeFileSync(operatorFile, context, { flag: 'wx', mode: 0o600 });
  else requireValue(readFileSync(operatorFile, 'utf8') === context, 'context_conflict', 'Adapter context belongs to another service');
  await api('PATCH', `/api/agents/${observed.agentId}`, { adapterConfig: { ...backend.adapterConfig,
    observationOnly: false, bindingId, bindingRevision: binding.revision, relayContextFile: operatorFile, timeoutSec: 600,
    requireReviewDisposition: true } });
  return { bindingId, contextFile, taskId, expiresAt: permit.expiresAt, settlement: 'operator_attested' };
}

export async function releaseObservedPull(store, api, input) {
  const id = `observed-pull:${text(input.bindingId, 'bindingId')}`;
  const permit = store.operation(id);
  requireValue(permit, 'reservation_not_found', 'No observed delivery reservation', 404);
  requireValue((!permit.history?.length && input.taskId === undefined) || input.taskId === permit.request.taskId,
    'reservation_conflict', 'Release must identify the current reserved task', 409);
  requireValue(store.runs(input.bindingId).every(run => run.nativeState === 'settled'),
    'work_unsettled', 'Settle the explicitly correlated work before release', 409);
  store.saveOperation({ ...permit, state: 'closed' });
  const backend = await api('GET', `/api/agents/${permit.request.agentId}`);
  const observed = store.operation(permit.request.observedId);
  requireValue(backend.adapterConfig?.relayObservationMarker === observed.marker && backend.adapterConfig?.bindingId === input.bindingId,
    'agent_identity_mismatch', 'Adapter identity changed', 409);
  await api('PATCH', `/api/agents/${backend.id}`, { status: 'paused', adapterConfig: { ...backend.adapterConfig, observationOnly: true },
    runtimeConfig: { ...backend.runtimeConfig, heartbeat: { ...backend.runtimeConfig?.heartbeat, enabled: false, wakeOnDemand: false } } });
  return { released: true, bindingId: input.bindingId };
}
