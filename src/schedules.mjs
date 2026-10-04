import { readFileSync } from 'node:fs';
import { canonical, digest, requireValue, text } from './protocol.mjs';

export function backendOperator(base, authFile) {
  const origin = new URL(base);
  requireValue(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password,
    'invalid_backend', 'Operator backend origin must not contain credentials');
  return async (method, path, body) => {
    requireValue(authFile, 'operator_backend_unavailable', 'Configure a backend operator context file', 503);
    const auth = JSON.parse(readFileSync(authFile, 'utf8'));
    const headers = { 'Content-Type': 'application/json' };
    if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
    else requireValue(auth.localTrusted === true && ['127.0.0.1', '[::1]'].includes(origin.hostname),
      'operator_backend_unavailable', 'Backend operator authentication required', 503);
    const response = await fetch(new URL(path, origin), { method, headers, redirect: 'error', signal: AbortSignal.timeout(10000),
      body: body === undefined ? undefined : JSON.stringify(body) });
    requireValue(response.ok, 'paperclip_error', `Paperclip operator request returned HTTP ${response.status}`, 502);
    return response.json();
  };
}

export function createSchedule(store, input) {
  const id = `schedule:${text(input.key, 'key')}`;
  const binding = store.binding(text(input.bindingId, 'bindingId'));
  requireValue(binding.config.lifetime === 'service', 'invalid_lifetime', 'Schedules require a service-scoped binding');
  const request = { bindingId: binding.id, taskId: text(input.taskId, 'taskId'),
    startsAt: text(input.startsAt, 'startsAt'), endsAt: text(input.endsAt, 'endsAt'), intervalSec: input.intervalSec };
  requireValue(Number.isFinite(Date.parse(request.startsAt)) && Number.isFinite(Date.parse(request.endsAt)) &&
    Date.parse(request.endsAt) > Date.parse(request.startsAt), 'invalid_window', 'Valid start/end window required');
  requireValue(Number.isSafeInteger(request.intervalSec) && request.intervalSec >= 1,
    'invalid_interval', 'Positive whole-second interval required');
  const existing = store.operation(id);
  if (existing) {
    requireValue(canonical(existing.request) === canonical(request), 'operation_conflict', 'Schedule key has different configuration', 409);
    return existing;
  }
  return store.saveOperation({ id, runId: '', request, state: 'active', nextAt: request.startsAt });
}

export async function tickSchedules(store, api, clock = Date.now()) {
  const schedules = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'schedule:%'").all().map(row => JSON.parse(row.data));
  for (let schedule of schedules) {
    if (schedule.state !== 'active') continue;
    if (clock >= Date.parse(schedule.request.endsAt)) {
      store.saveOperation({ ...schedule, state: 'ended' });
      continue;
    }
    if (clock < Date.parse(schedule.nextAt)) continue;
    const binding = store.binding(schedule.request.bindingId);
    if (binding.lifecycleState || store.runs(binding.id).some(run => run.nativeState !== 'settled')) continue;
    const slot = schedule.pendingSlot ?? schedule.nextAt;
    const key = `relay-schedule:${digest([schedule.id, slot])}`;
    // A stable slot survives a lost invocation response. The backend owns the run.
    schedule = store.saveOperation({ ...schedule, pendingSlot: slot });
    try {
      const task = await api('GET', `/api/issues/${encodeURIComponent(schedule.request.taskId)}`);
      requireValue(task.companyId === binding.config.companyId && task.assigneeAgentId === binding.config.agentId,
        'schedule_identity_mismatch', 'Scheduled task must belong to the bound agent', 409);
      if (store.operation(schedule.id).state !== 'active') continue;
      const receipt = await api('POST', `/api/agents/${encodeURIComponent(binding.config.agentId)}/heartbeat/invoke`, {
        reason: 'relay_scheduled_check', idempotencyKey: key,
        payload: { taskId: task.id, issueId: task.id },
      });
      if (!receipt.id) {
        store.saveOperation({ ...store.operation(schedule.id), reason: 'backend_wake_skipped' });
        continue;
      }
      store.saveOperation({ ...store.operation(schedule.id), pendingSlot: null, reason: null, lastRunId: receipt.id,
        nextAt: new Date(clock + schedule.request.intervalSec * 1000).toISOString() });
    } catch (error) { store.saveOperation({ ...store.operation(schedule.id), reason: error.code ?? 'backend_unavailable' }); }
  }
}

export function scheduleRunner(store, api) {
  let stopped = false;
  let pending = Promise.resolve();
  let timer;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { pending = tickSchedules(store, api).finally(schedule); }, 1000);
  };
  schedule();
  return { close: async () => { stopped = true; clearTimeout(timer); await pending; } };
}
