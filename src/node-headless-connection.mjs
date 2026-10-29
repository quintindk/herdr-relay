import { requireValue } from './protocol.mjs';
import { connectionRebindPreview } from './headless-connection.mjs';
import { inspectContract } from './node-headless-contract.mjs';
import { abandonedWork, commandWorkId } from './node-journal.mjs';
import { definitivePublicationRefusal } from './publication-outcomes.mjs';
import { HeadlessAccess, accessReferences } from '../packages/opencode-relay/headless-access.mjs';
import { NativeOpenCodeV2 } from '../packages/opencode-relay/native.mjs';

export async function previewHeadlessConnection(journal, api, worker, setupId, native) {
  const { setup, grant } = await api('GET', `/v1/headless_setups/${encodeURIComponent(setupId)}/authority`);
  requireValue(!worker.headlessSetupId && setup.requesterAgentId === worker.agentId && setup.nodeId === journal.nodeId,
    'headless_requester_scope', 'Only the original local interactive coordinator may rebind a connection', 403);
  const row = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`headless-op:${setup.id}`);
  const op = row && JSON.parse(row.value);
  requireValue(op?.binding?.id === setup.bindingId && op.binding.agentId === setup.agentId && op.binding.identity?.sessionId === setup.sessionId,
    'headless_binding_unavailable', 'The original durable worker binding is required');
  inspectContract(journal, setup, grant);
  const works = journal.works().filter(w => w.execution.targetAgentId === setup.agentId && !abandonedWork(w));
  requireValue(works.every(w => ['completed', 'cancelled', 'failed', 'rejected'].includes(w.execution.state) &&
    ['settled', 'native_finished'].includes(w.state)), 'headless_rebind_busy', 'Unsettled worker evidence must be reconciled, never replayed by connection recovery');
  const ids = new Set(works.map(w => w.id));
  const publications = journal.db.prepare("SELECT key,hash,state,data FROM outbox WHERE state IN ('pending','conflict')").all()
    .filter(row => ids.has(commandWorkId(JSON.parse(row.data).command)) && !definitivePublicationRefusal(row));
  requireValue(!publications.length && !journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain','conflict')").all()
    .some(row => JSON.parse(row.data).bindingId === setup.bindingId), 'headless_rebind_busy', 'Uncertain publications or notices require their own recovery');
  requireValue(native, 'headless_recovery_unavailable', 'Destination-native connection inspection is unavailable');
  const connection = await native();
  requireValue(connection.url === op.binding.url, 'headless_service_changed', 'Recovery must inspect the original authenticated native service');
  // Inspect immutable identity and idle state without borrowing the stale model
  // authorisation. This adapter is read-only here: no prompt or session edit.
  const inspector = new NativeOpenCodeV2(connection.client, op.binding.identity);
  const session = await inspector.verify(), snapshot = await inspector.snapshot();
  requireValue(session.model?.providerID === grant.model.providerID && session.model?.id === grant.model.id,
    'headless_model_changed', 'Connection recovery cannot change the approved model');
  requireValue(snapshot.idle && !snapshot.inbox.length, 'headless_rebind_busy', 'The original native session must be idle without pending input');
  const rpc = connection.client.rpc(HeadlessAccess), location = { location: { directory: setup.directory } };
  const candidates = (await rpc.inspect({}, location)).models.filter(m => m.providerID === grant.model.providerID &&
    m.id === grant.model.id && m.integrationID === grant.model.integrationID);
  requireValue(candidates.length === 1, 'model_connection_unavailable', 'Exactly one current connection for the unchanged provider, integration and model is required');
  const schedule = await api('GET', `/v1/schedules/${encodeURIComponent(setup.scheduleId)}`);
  const preview = connectionRebindPreview(setup, grant, schedule, candidates[0].connectionId);
  const check = await rpc.check(accessReferences({ ...grant, model: preview.model }), location);
  requireValue(check.allowed, check.blocker, 'The replacement connection must pass native access inspection');
  return preview;
}

export function connectionRebindCommand(preview) {
  const { setupId, expectedRevision, grantRevision, scheduleRevision, fromConnectionId, toConnectionId, scopeDigest, scheduleDigest, previewHash } = preview;
  return { setupId, expectedRevision, grantRevision, scheduleRevision, fromConnectionId, toConnectionId, scopeDigest, scheduleDigest, previewHash };
}
