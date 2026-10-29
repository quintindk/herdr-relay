import { digest, now, requireValue } from './protocol.mjs';

const terminal = ['completed', 'cancelled', 'failed', 'rejected'];
const fields = ['setupId', 'expectedRevision', 'grantRevision', 'scheduleRevision', 'fromConnectionId', 'toConnectionId', 'scopeDigest', 'scheduleDigest'];

export function connectionRebindPreview(setup, grant, schedule, connectionId) {
  requireValue(['ready', 'blocked'].includes(setup.state) && setup.readiness &&
    (!setup.contract || setup.contract.revision === setup.appliedContractRevision),
  'headless_rebind_ineligible', 'An established setup with fully applied instructions is required');
  requireValue(schedule && !schedule.cancelled && schedule.definition.nodeId === setup.nodeId &&
    schedule.definition.targetAgentId === setup.agentId && schedule.id === grant.schedule.id &&
    (!schedule.transfer || schedule.transfer.state === 'completed'),
  'headless_scope_mismatch', 'The existing schedule must still belong to this worker');
  requireValue(typeof connectionId === 'string' && connectionId.trim() && connectionId.length <= 256 && !/[\x00-\x1f]/.test(connectionId) &&
    connectionId !== grant.model.connectionId, 'invalid_connection_rebind', 'A different active connection identity is required');
  const operation = { setupId: setup.id, expectedRevision: setup.revision, grantRevision: grant.revision,
    scheduleRevision: schedule.revision, fromConnectionId: grant.model.connectionId, toConnectionId: connectionId,
    scopeDigest: digest(grant), scheduleDigest: digest(schedule) };
  return { ...operation, previewHash: digest(operation), model: { ...grant.model, connectionId },
    workerUnchanged: true, sessionUnchanged: true, permissionsUnchanged: true, instructionsUnchanged: true,
    scheduleUnchanged: true, readinessRequired: true, businessWorkReplayed: false };
}

export function applyConnectionRebind(store, actor, p, setup, grant, changed) {
  requireValue(p && Object.keys(p).every(key => [...fields, 'previewHash'].includes(key)) &&
    fields.every(key => Object.hasOwn(p, key)), 'invalid_connection_rebind', 'Only the exact connection preview may be applied');
  store.revision(setup, p.expectedRevision); store.revision(grant, p.grantRevision);
  const schedule = store.get('schedule', setup.scheduleId);
  store.revision(schedule, p.scheduleRevision);
  const preview = connectionRebindPreview(setup, grant, schedule, p.toConnectionId);
  requireValue(p.previewHash === preview.previewHash && fields.every(key => p[key] === preview[key]),
    'stale_connection_preview', 'Setup, grant, connection or schedule changed after preview');
  requireValue(!store.all('execution').some(e => e.targetAgentId === setup.agentId && !terminal.includes(e.state)),
    'headless_rebind_busy', 'Settle existing worker executions before rebinding. No work is replayed or cancelled');
  requireValue(!store.all('grant_request').some(r => r.kind === 'headless_contract' && r.operation?.setupId === setup.id && r.state === 'awaiting_approval'),
    'headless_rebind_busy', 'Resolve the pending instruction approval before rebinding');
  const updated = changed('headless_grant', grant, { model: preview.model });
  store.event('headless.grant_connection_changed', updated, actor, setup.id);
  return changed('headless_setup', setup, { grantRevision: updated.revision, state: 'requested', blocker: null,
    attempt: (setup.attempt ?? 1) + 1, connectionRebind: { state: 'checking', previewHash: p.previewHash,
      fromConnectionId: p.fromConnectionId, toConnectionId: p.toConnectionId, requestedAt: now(), previousReadiness: setup.readiness } });
}
