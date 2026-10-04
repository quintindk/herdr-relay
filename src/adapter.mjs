import { setTimeout as delay } from 'node:timers/promises';
import { call, credentials } from './client.mjs';
import { requireValue } from './protocol.mjs';

export const type = 'herdr_relay';
export const label = 'Herdr Relay';
export const agentConfigurationDoc = `# Herdr Relay (development)
Requires a local Relay service. Configure relayContextFile with an operator
credential file, bindingId, bindingRevision (1), and timeoutSec (default 300).
Bindings select explicit CLI pull with operator settlement, or reserved native
delivery with message-correlated native settlement.
timeoutSec requests cancellation, but cannot force an unverified native stop.
Only task-scoped work invocations are supported. Submission records a comment,
not task acceptance or a review transition.`;

export async function execute(ctx) {
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
  };
  let run;
  let timedOut = false;
  let lastError;
  while (true) {
    timedOut ||= Date.now() - started >= timeoutSec * 1000;
    try {
      if (!run) {
        // A lost response may already have persisted the dispatch. Replay only
        // this immutable backend-run key, never manufacture a replacement run.
        run = ctx.config.recoverRelayRunId
          ? await call(connection, 'POST', `/runs/${encodeURIComponent(ctx.config.recoverRelayRunId)}/recover`, { ...dispatch, token: ctx.authToken })
          : await call(connection, 'POST', '/runs', dispatch);
        await ctx.onLog('stdout', `${JSON.stringify({ relayRunId: run.id, deliveryState: run.deliveryState })}\n`);
      }
      run = await call(connection, 'GET', `/runs/${run.id}`);
      if ((ctx.signal?.aborted || timedOut) && run.nativeState !== 'settled') {
        run = await call(connection, 'POST', `/runs/${run.id}/cancel`, {});
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
        const completed = ['completed', 'waiting'].includes(run.settlement.outcome);
        return {
          exitCode: completed ? 0 : 1, signal: null, timedOut,
          errorMessage: completed ? null : `Native work ${run.settlement.outcome}`,
          sessionParams: { bindingId: run.request.bindingId, conversationId: run.conversationId },
          sessionDisplayId: run.conversationId,
          summary: run.result?.summary ?? run.waiting?.payload.question ?? run.settlement.evidence,
          resultJson: { relayRunId: run.id, submission: run.result, waiting: run.waiting, publication: run.publication, settlement: run.settlement },
        };
      }
      lastError = undefined;
    } catch (error) {
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
        requireValue(typeof ctx.config.relayContextFile === 'string', 'invalid_config', 'relayContextFile is required');
        const connection = credentials(ctx.config.relayContextFile);
        const bindings = await call(connection, 'GET', '/bindings');
        const binding = bindings.find(binding => binding.id === ctx.config.bindingId &&
          binding.revision === (ctx.config.bindingRevision ?? 1) && binding.config.companyId === ctx.companyId);
        requireValue(binding,
        'binding_not_found', 'Matching binding and company required');
        checks.push(['opencode', 'hermes'].includes(binding.config.delivery)
          ? { level: 'warn', code: 'reserved_native_delivery', message: 'Relay reachable. Native conversation must remain reserved. Automatic interruption is unavailable.' }
          : { level: 'warn', code: 'manual_settlement', message: 'Relay reachable. CLI pull and operator settlement required.' });
      } catch (error) {
        checks.push({ level: 'error', code: error.code ?? 'relay_unavailable', message: 'Relay configuration or connection failed' });
      }
      return { adapterType: type, status: checks.some(check => check.level === 'error') ? 'fail' : 'warn', checks, testedAt: new Date().toISOString() };
    },
  };
}
