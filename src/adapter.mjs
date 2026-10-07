import { setTimeout as delay } from 'node:timers/promises';
import { call, credentials } from './client.mjs';
import { requireValue } from './protocol.mjs';

export const type = 'herdr_relay';
export const label = 'Herdr Relay';
export const agentConfigurationDoc = `# Herdr Relay (development)
Requires a local Relay service. Configure relayContextFile with an operator
credential file, bindingId, current bindingRevision, and timeoutSec (default 300).
Bindings select explicit CLI pull with operator settlement, or reserved native
delivery with message-correlated native settlement.
timeoutSec requests cancellation, but cannot force an unverified native stop.
Invocations require a Paperclip task. Submission records a result comment.
Questions, review and acceptance use separate commands and backend interactions.`;

export async function execute(ctx) {
  requireValue(!ctx.config.observationOnly, 'agent_observation_only', 'This Herdr agent is registered for visibility only. Verified task delivery is not configured.', 409);
  if (ctx.config.relayNodeFile) {
    const { executeRemote } = await import('./remote-adapter.mjs');
    return executeRemote(ctx);
  }
  requireValue(ctx.authToken, 'missing_auth', 'Paperclip run authentication is required');
  requireValue(!ctx.executionTarget || ctx.executionTarget.kind === 'local', 'unsupported_target', 'Relay requires a local adapter host');
  requireValue(typeof ctx.config.relayContextFile === 'string', 'invalid_config', 'relayContextFile is required');
  const connection = credentials(ctx.config.relayContextFile);
  const taskId = ctx.context.taskId ?? ctx.context.issueId;
  requireValue(typeof taskId === 'string' && taskId.length > 0, 'task_required', 'Relay requires an issue/task invocation');
  const timeoutSec = ctx.config.timeoutSec ?? 300;
  requireValue(Number.isFinite(timeoutSec) && timeoutSec > 0, 'invalid_config', 'timeoutSec must be positive');
  const started = Date.now();
  await ctx.onCancellationReady?.();
  ctx.onDispatch?.();
  const dispatch = {
    bindingId: ctx.config.bindingId, bindingRevision: ctx.config.bindingRevision ?? 1,
    companyId: ctx.agent.companyId, agentId: ctx.agent.id,
    runId: ctx.runId, taskId,
    ...(ctx.context.relayScheduleId || ctx.context.paperclipWake?.relayScheduleId
      ? { scheduleId: ctx.context.relayScheduleId ?? ctx.context.paperclipWake.relayScheduleId } : {}),
  };
  let run;
  let timedOut = false;
  let lastError;
  while (true) {
    timedOut ||= Date.now() - started >= timeoutSec * 1000;
    try {
      if (!run) {
        if (!ctx.config.recoverRelayRunId && (ctx.context.wakeReason ?? ctx.context.paperclipWake?.reason) === 'issue_children_completed') {
          const decision = await call(connection, 'POST', '/review-wake', { ...dispatch, token: ctx.authToken });
          if (decision.skip) {
            await ctx.onLog('stdout', `${JSON.stringify({ event: 'relay.wake_suppressed', ...decision })}\n`);
            return { exitCode: 0, signal: null, timedOut: false,
              summary: 'Child completion recorded. The existing submitted candidate is still awaiting review; no additional worker turn was started.',
              sessionParams: { bindingId: dispatch.bindingId, conversationId: decision.conversationId },
              sessionDisplayId: decision.conversationId,
              resultJson: { skipped: true, reason: decision.reason, relayRunId: decision.relayRunId, reviewInteractionId: decision.interactionId } };
          }
        }
        // A lost response may already have persisted the dispatch. Replay only
        // this immutable backend-run key, never manufacture a replacement run.
        run = ctx.config.recoverRelayRunId
          ? await call(connection, 'POST', `/runs/${encodeURIComponent(ctx.config.recoverRelayRunId)}/recover`, { ...dispatch, token: ctx.authToken })
          : await call(connection, 'POST', '/runs', dispatch);
        await ctx.onLog('stdout', `${JSON.stringify({ relayRunId: run.id, deliveryState: run.deliveryState })}\n`);
      }
      run = await call(connection, 'GET', `/runs/${run.id}`);
      requireValue((run.backendRunId ?? run.request.runId) === ctx.runId,
        'stale_backend_run', 'This adapter invocation has been replaced', 409);
      if ((ctx.signal?.aborted || timedOut) && run.nativeState !== 'settled') {
        run = await call(connection, 'POST', `/runs/${run.id}/cancel`, { runId: ctx.runId });
      }
      // Apply known cancellation before making a fresh native run deliverable.
      await call(connection, 'POST', `/runs/${run.id}/attach`, { token: ctx.authToken, runId: ctx.runId });
      if (run.result && run.publication.state !== 'recorded') {
        run = await call(connection, 'POST', `/runs/${run.id}/publish`, { token: ctx.authToken, runId: ctx.runId });
      }
      if (run.waiting && run.waiting.state !== 'recorded') {
        run = await call(connection, 'POST', `/runs/${run.id}/publish-question`, { token: ctx.authToken, runId: ctx.runId });
      }
      if (run.nativeState === 'settled' && (!run.result || run.publication.state === 'recorded') && (!run.waiting || run.waiting.state === 'recorded')) {
        if (ctx.config.requireReviewDisposition === true && run.settlement.outcome === 'completed') {
          await call(connection, 'POST', `/runs/${run.id}/disposition`, { runId: ctx.runId });
        }
        const completed = ['completed', 'waiting'].includes(run.settlement.outcome);
        return {
          exitCode: completed ? 0 : 1, signal: null, timedOut,
          errorMessage: completed ? null : `Native work ${run.settlement.outcome}`,
          sessionParams: { bindingId: run.request.bindingId, conversationId: run.conversationId },
          sessionDisplayId: run.conversationId,
          summary: run.result?.summary ?? run.waiting?.payload.question ?? (run.dependency ? `Waiting for child tasks ${(run.dependency.taskIds ?? [run.dependency.childId]).join(', ')}` : run.settlement.evidence),
          resultJson: { relayRunId: run.id, submission: run.result, waiting: run.waiting, dependency: run.dependency, publication: run.publication, settlement: run.settlement },
        };
      }
      lastError = undefined;
    } catch (error) {
      if (error.code === 'stale_backend_run') throw error;
      // A definitive dispatch rejection needs operator correction, not retries.
      // Once a run exists, loss of access is still not proof that work stopped.
      if (!run && error.status >= 400 && error.status < 500) throw error;
      // A transport failure is not proof of native termination. Keep the run
      // supervised until Relay can reconcile it, without exposing credentials.
      const code = error.code ?? 'relay_unavailable';
      if (code !== lastError) await ctx.onLog('stderr', `${JSON.stringify({ code, relayRunId: run?.id, reconciliationPending: true })}\n`);
      lastError = code;
    }
    await delay(250);
  }
}

export function createServerAdapter() {
  return {
    type, execute, agentConfigurationDoc, supportsLocalAgentJwt: true,
    sessionCodec: {
      serialize: value => value,
      deserialize: value => value && typeof value === 'object' ? value : null,
      getDisplayId: value => value?.conversationId ?? null,
    },
    async testEnvironment(ctx) {
      const checks = [];
      try {
        if (ctx.config.observationOnly) return { adapterType: type, status: 'warn',
          checks: [{ level: 'warn', code: 'agent_observation_only', message: 'Existing Herdr conversation registered. Dispatch and lifecycle control remain disabled.' }],
          testedAt: new Date().toISOString() };
        if (ctx.config.relayNodeFile) {
          const { readFileSync } = await import('node:fs');
          const { remoteCommand } = await import('./remote.mjs');
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const node = JSON.parse(readFileSync(ctx.config.relayNodeFile, 'utf8'));
          const { stdout } = await promisify(execFile)('ssh', remoteCommand(node, ['agent', 'list']), { timeout: 15000 });
          const bindings = JSON.parse(stdout);
          requireValue(bindings.some(binding => binding.id === ctx.config.bindingId && binding.config.companyId === ctx.companyId &&
            binding.revision === (ctx.config.bindingRevision ?? 1)), 'binding_not_found', 'Matching remote binding required');
          return { adapterType: type, status: 'pass', checks: [{ level: 'info', code: 'remote_relay', message: 'Remote Relay binding verified over SSH.' }], testedAt: new Date().toISOString() };
        }
        requireValue(typeof ctx.config.relayContextFile === 'string', 'invalid_config', 'relayContextFile is required');
        const connection = credentials(ctx.config.relayContextFile);
        const bindings = await call(connection, 'GET', '/bindings');
        const binding = bindings.find(binding => binding.id === ctx.config.bindingId &&
          binding.revision === (ctx.config.bindingRevision ?? 1) && binding.config.companyId === ctx.companyId);
        requireValue(binding,
        'binding_not_found', 'Matching binding and company required');
        const managed = (binding.config.opencode ?? binding.config.hermes)?.runtimeKey;
        checks.push(managed
          ? { level: 'info', code: 'managed_native_delivery', message: 'Relay reachable. Dedicated owned runtime supports verified interruption and settlement.' }
          : ['opencode', 'hermes'].includes(binding.config.delivery)
          ? { level: 'warn', code: 'reserved_native_delivery', message: 'Relay reachable. Native conversation must remain reserved. Automatic interruption is unavailable.' }
          : { level: 'warn', code: 'manual_settlement', message: 'Relay reachable. CLI pull and operator settlement required.' });
      } catch (error) {
        checks.push({ level: 'error', code: error.code ?? 'relay_unavailable', message: 'Relay configuration or connection failed' });
      }
      return { adapterType: type, status: checks.some(check => check.level === 'error') ? 'fail' : checks.some(check => check.level === 'warn') ? 'warn' : 'pass', checks, testedAt: new Date().toISOString() };
    },
  };
}
