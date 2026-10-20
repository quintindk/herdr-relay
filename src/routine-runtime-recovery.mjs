import { digest, canonical } from './protocol.mjs';
import { ownedRuntime, stoppedRuntime } from './runtimes.mjs';
import { resumeRuntime } from './resume.mjs';
import { manageRoutine, routineTargetAdmission } from './routines.mjs';

// Only active, already-provisioned managed schedules grant recovery scope. Never
// replay an occurrence, replace a conversation, or infer that unsettled work ended.
export async function reconcileRoutineRuntimes(store, directory, api, locks = new Map(), deps = {}) {
  const verify = deps.verify ?? ownedRuntime, stopped = deps.stopped ?? stoppedRuntime;
  const resume = deps.resume ?? resumeRuntime, manage = deps.manage ?? manageRoutine;
  const schedules = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'routine:%'").all()
    .map(row => JSON.parse(row.data)).filter(item => item.created && item.state === 'active' &&
      !item.cancellationRequested && item.target?.managed && item.request?.targetBindingId);
  for (const schedule of schedules) {
    const bindingId = schedule.request.targetBindingId;
    const lock = `scheduled-runtime:${bindingId}`;
    if (locks.has(lock)) { await locks.get(lock); continue; }
    const pending = (async () => {
      const statusId = `routine-runtime-health:${schedule.id}`;
      let status = store.operation(statusId);
      try {
        let binding = store.binding(bindingId);
        const unsettled = store.runs(bindingId).filter(run => run.nativeState !== 'settled');
        if (binding.lifecycleState || unsettled.length) {
          const blocked = { id: statusId, runId: '', state: 'blocked', bindingId,
            reason: binding.lifecycleState ? 'routine_target_ineligible' : 'conversation_busy',
            blockingRuns: unsettled.map(run => ({ runId: run.id, taskId: run.request.taskId,
              nativeState: run.nativeState, ...(run.native?.reason ? { reason: run.native.reason } : {}) })) };
          if (canonical({ ...status, updatedAt: undefined }) !== canonical(blocked)) store.saveOperation(blocked);
          return;
        }
        if (status?.retryAt && Date.parse(status.retryAt) > Date.now()) return;
        const active = () => {
          const current = store.operation(schedule.id);
          if (!current || current.state !== 'active' || current.cancellationRequested ||
            canonical(current.request) !== canonical(schedule.request)) throw Object.assign(new Error('Schedule authority changed'), { code: 'routine_scope_changed' });
        };
        active();
        const runtimeKey = binding.config.opencode?.runtimeKey;
        // Validate provision and complete resume lineage even for a dead process.
        const identity = routineTargetAdmission(store, binding, undefined, { verifyRuntime: (s, key) => {
          const operation = s.operation(`runtime:${key}`);
          if (!operation) throw Object.assign(new Error('Unknown runtime'), { code: 'runtime_not_ready' });
          return operation;
        } });
        if (!identity.ready) throw Object.assign(new Error('Managed schedule identity is invalid'), { code: identity.blocker });
        let alive = true;
        try { verify(store, runtimeKey); } catch { alive = false; }
        if (!alive) {
          stopped(store, runtimeKey);
          active();
          const key = `scheduled-runtime-${digest([bindingId, binding.revision, runtimeKey]).slice(0, 32)}`;
          store.saveOperation({ id: statusId, runId: '', state: 'recovering', bindingId, previousRuntime: runtimeKey });
          await resume(store, directory, api, { key, bindingId, revision: binding.revision, runtimeKey: key });
          active();
          binding = store.binding(bindingId);
        }
        const target = routineTargetAdmission(store, binding, undefined, { verifyRuntime: verify });
        if (!target.ready) throw Object.assign(new Error('Runtime unavailable'), { code: target.blocker });
        if (canonical(schedule.target) !== canonical(target.target)) {
          active();
          await manage(store, api, { action: 'resume', companyId: schedule.request.companyId, scheduleId: schedule.id,
            key: `runtime-recovered-${digest([schedule.id, binding.revision]).slice(0, 32)}` }, { stateDirectory: directory });
        }
        if (status?.state !== 'ready' || !alive) store.saveOperation({ id: statusId, runId: '', state: 'ready', bindingId,
          runtimeKey: binding.config.opencode.runtimeKey, revision: binding.revision });
      } catch (error) {
        const failures = (status?.failures ?? 0) + 1;
        const failed = { id: statusId, runId: '', state: 'unavailable', bindingId, failures,
          reason: error.code ?? 'runtime_recovery_failed', retryAt: new Date(Date.now() + 30000).toISOString() };
        store.saveOperation(failed);
        // Stop admitting hourly failures after bounded recovery attempts. Preserve
        // the schedule and its evidence for an explicit repair/resume.
        if (failures >= 3 && store.operation(schedule.id)?.state === 'active') {
          try {
            await manage(store, api, { action: 'pause', companyId: schedule.request.companyId, scheduleId: schedule.id,
              key: `runtime-unavailable-${digest([schedule.id, store.binding(bindingId).revision]).slice(0, 32)}` }, { stateDirectory: directory });
            store.saveOperation({ ...failed, schedulingPaused: true });
          } catch (pauseError) {
            store.saveOperation({ ...failed, pauseReason: pauseError.code ?? 'backend_unavailable' });
          }
        }
      }
    })();
    locks.set(lock, pending);
    try { await pending; } finally { if (locks.get(lock) === pending) locks.delete(lock); }
  }
}
