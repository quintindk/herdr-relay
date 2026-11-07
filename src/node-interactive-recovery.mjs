import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './protocol.mjs';

const identity = directory => {
  if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw Error('directory_identity_changed');
  const stat = lstatSync(directory);
  return { directory, dev: stat.dev, ino: stat.ino };
};
const refusedEnrolments = new Set(['agent_limit', 'interactive_admission_required', 'provisioning_grant_inactive', 'provisioning_inactive']);

// Inspection can reconcile observations, never repeat a directory, session,
// workspace or launch effect. Its public projection contains no auth or env.
export async function inspectInteractiveCheckpoint(journal, records, api, request, original, { snapshot, native }) {
  const op = { ...original }, unresolved = [], refusedKeys = [];
  let phase = op.resumePhase ?? op.phase;
  if (phase === 'blocked') phase = op.bindingId ? 'verifying' : op.placement ? op.startIntent ? 'opening' : 'workspace' :
    op.sessionId ? 'selected' : op.directoryIdentity ? 'directory' : 'initial';
  if (!original) unresolved.push('local_preparation_record_missing');
  try {
    if (op.directoryIdentity && digest(identity(request.directory)) !== digest(op.directoryIdentity)) unresolved.push('directory_identity_changed');
    else if (op.directoryIntent && !op.directoryIdentity) {
      if (existsSync(request.directory) && readFileSync(join(request.directory, '.relay-workspace-owner'), 'utf8') === request.id) {
        op.directoryIdentity = identity(request.directory); phase = 'directory';
      } else unresolved.push('directory_creation_uncertain');
    }
  } catch { unresolved.push('directory_identity_changed'); }
  let agent;
  try { agent = await api('GET', `/v1/agents/${encodeURIComponent(request.agentId)}`); }
  catch (error) { if (error.status !== 404) unresolved.push('enrolment_observation_unavailable'); }
  if (agent && (agent.nodeId !== request.nodeId || agent.directory !== request.directory ||
    request.newEnrolment && agent.standingGrant?.provisioningRequestId !== request.id)) unresolved.push('agent_identity_changed');
  for (const item of journal.db.prepare("SELECT data FROM outbox WHERE state IN ('pending','conflict')").all().map(row => JSON.parse(row.data))) {
    if (item.command.payload.id !== request.id || !['interactive.enrol', 'interactive.attach'].includes(item.command.action)) continue;
    if (item.command.action === 'interactive.enrol' && item.state === 'conflict' && refusedEnrolments.has(item.error) && !agent && request.state === 'blocked')
      refusedKeys.push(item.command.key);
    else unresolved.push('provisioning_publication_unresolved');
  }
  if (op.sessionId) {
    try {
      const connection = await native();
      let session;
      try { session = await connection.client.session.get({ sessionID: op.sessionId }); }
      catch (error) { if (error.status !== 404 && !['NotFoundError', 'SessionNotFoundError'].includes(error.name)) throw error; }
      if (session) {
        if (session.location?.directory !== request.directory || session.time.archived || session.parentID || session.revert ||
          op.sessionId === request.desiredSessionId && session.metadata?.relayProvisionRequest !== request.id) unresolved.push('native_identity_mismatch');
      } else if (op.sessionIntent || phase !== 'selected') unresolved.push('native_create_uncertain');
    } catch { unresolved.push('native_observation_unavailable'); }
  }
  if (op.workspaceIntent || op.placement) {
    try {
      const view = await snapshot();
      if (!op.placement) {
        const candidates = view.workspaces.filter(w => w.label === op.workspaceIntent.label && !op.workspaceIntent.beforeIds.includes(w.workspace_id));
        const panes = view.panes.filter(p => p.workspace_id === candidates[0]?.workspace_id && p.cwd === request.directory);
        if (candidates.length === 1 && panes.length === 1) {
          const pane = panes[0];
          op.placement = { workspaceId: pane.workspace_id, tabId: pane.tab_id, paneId: pane.pane_id, terminalId: pane.terminal_id };
          phase = 'workspace';
        } else unresolved.push('workspace_create_uncertain');
      }
      if (op.placement) {
        const p = op.placement, panes = view.panes.filter(pane => pane.pane_id === p.paneId || pane.terminal_id === p.terminalId);
        if (panes.length !== 1 || panes[0].pane_id !== p.paneId || panes[0].terminal_id !== p.terminalId || panes[0].cwd !== request.directory ||
          panes[0].workspace_id !== p.workspaceId || panes[0].tab_id !== p.tabId) unresolved.push('placement_changed');
        const nativeAgents = view.agents.filter(a => a.pane_id === p.paneId);
        if (op.startIntent && (nativeAgents.length !== 1 || nativeAgents[0].agent !== 'opencode' || !nativeAgents[0].interactive_ready ||
          nativeAgents[0].launch_pending || nativeAgents[0].agent_session?.kind !== 'id' || nativeAgents[0].agent_session.value !== op.sessionId)) unresolved.push('native_start_uncertain');
        else if (op.startIntent && phase === 'workspace') phase = 'opening';
      }
    } catch { unresolved.push('placement_observation_unavailable'); }
  }
  const receiver = records.receiver(request.agentId);
  if (receiver?.state === 'pending') unresolved.push('attachment_unresolved');
  if (op.bindingId && (receiver?.state !== 'active' || receiver.bindingId !== op.bindingId || agent?.bindingId !== op.bindingId || agent?.bindingRevision !== op.generation))
    unresolved.push('stale_binding');
  const errors = [...new Set(unresolved)];
  const checkpoint = { protocol: 1, safe: errors.length === 0, phase: phase ?? 'initial', unresolved: errors,
    ...(op.directoryIdentity ? { directoryIdentity: op.directoryIdentity } : {}), ...(op.sessionId ? { sessionId: op.sessionId } : {}),
    ...(op.placement ? { placement: op.placement } : {}), ...(op.bindingId ? { bindingId: op.bindingId, generation: op.generation } : {}) };
  return { checkpoint, refusedKeys, reconciled: op };
}
