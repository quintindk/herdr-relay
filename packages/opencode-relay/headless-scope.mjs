import { requireValue } from '../../src/protocol.mjs';
import { headlessSessionPermissions } from '../../src/headless-permissions.mjs';
import { accessReferences, checkHeadlessAccess } from './headless-access.mjs';
import { workerConnection } from './worker-context.mjs';
import { call } from '../../src/client.mjs';

export async function headlessToolScope(ctx, context, { connection = workerConnection, request = call } = {}) {
  const worker = connection(ctx.options, context.sessionID);
  requireValue(worker.headlessSetupId && worker.sessionId === context.sessionID, 'headless_tool_scope_required', 'Exact headless worker required', 403);
  const current = await request(worker, 'POST', '/work/current', { sessionId: context.sessionID });
  const run = { executionId: current.execution.id, runId: current.execution.runId };
  const scope = await request(worker, 'POST', '/work/headless-access', run);
  requireValue(scope.id === worker.headlessSetupId && scope.sessionId === context.sessionID, 'headless_scope_mismatch', 'Exact headless execution scope required', 403);
  const check = await checkHeadlessAccess(ctx, accessReferences(scope));
  requireValue(check.allowed, check.blocker, 'Approved model/capability is unavailable', 403);
  const session = await ctx.session.get({ sessionID: context.sessionID });
  requireValue(session.id === context.sessionID && session.location?.directory === scope.directory && ctx.location?.directory === scope.directory,
    'headless_scope_mismatch', 'Calls must stay in the approved session and workspace', 403);
  requireValue(session.model?.providerID === scope.model.providerID && session.model?.id === scope.model.id,
    'headless_model_changed', 'Session must retain its authorised model', 403);
  return { scope, worker, run };
}

export async function syncHeadlessPermissions(ctx, context, scope, catalog) {
  await ctx.session.update({ sessionID: context.sessionID, permissions: headlessSessionPermissions(scope, scope.permissions.mcp ? catalog.tools : []) });
}

export function assertHeadlessEffect(scope, capability) {
  requireValue(scope.permissions[capability] === true, `headless_${capability}_not_granted`, `${capability} is denied by this grant`, 403);
  requireValue(!scope.readiness, 'headless_probe_external_effect_forbidden', 'Readiness may inspect permissions, not execute effectful tools', 403);
  requireValue(!scope.outcomeStaged, 'headless_outcome_staged', 'Finish the native turn after submitting its outcome', 403);
}
