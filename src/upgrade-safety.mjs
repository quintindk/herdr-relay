import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { digest, requireValue } from './protocol.mjs';
import { assertTaskIdentityIntegrity } from './task-identity.mjs';
import { definitiveDispatchRefusal } from './interactive-dispatch-reconciliation.mjs';
import { definitivePublicationRefusal } from './publication-outcomes.mjs';

export function backendMaintenanceBlockers(db) {
  const blockers = [];
  for (const [kind, settled] of [
    ['execution', ['requested', 'waiting', 'waiting_children', 'waiting_time', 'in_review', 'monitor_review', 'monitor_blocked', 'completed', 'cancelled', 'failed', 'rejected']],
    ['message', ['queued', 'delivered', 'blocked']], ['provision_request', ['requested', 'waiting_driver', 'waiting_capacity', 'waiting_node_upgrade', 'ready', 'blocked', 'cancelled']], ['headless_setup', ['ready', 'blocked']],
  ]) for (const row of db.prepare('SELECT data FROM entities WHERE kind=?').all(kind)) {
    const entity = JSON.parse(row.data);
    if (!settled.includes(entity.state)) blockers.push({ kind: kind === 'provision_request' ? 'preparation' : kind, id: entity.id, state: entity.state });
  }
  return blockers;
}

const dependsOnInteractiveProtocol = request => request.admission?.state === 'reserved' ||
  request.admissionRequired && !['ready', 'blocked', 'cancelled'].includes(request.state);
const interactiveProtocolWork = (requests, permissions = []) => [
  ...requests.filter(dependsOnInteractiveProtocol).map(request => ({ kind: 'preparation', id: request.id, state: request.state })),
  ...permissions.filter(request => request.kind === 'interactive_repair' && request.state === 'awaiting_approval')
    .map(request => ({ kind: 'repair_permission', id: request.id, state: request.state })),
];
export function assertInteractiveUpgradeCompatibility(identity, release) {
  requireValue(release.compatibility.interactiveProvisioning === 1 || !identity.interactiveProtocolWork?.length,
    'upgrade_interactive_protocol_required', 'Pending capacity-aware preparations, held reservations or repair approvals require interactive provisioning protocol 1. Settle or explicitly cancel and inspect them before switching to older code. History and unrelated work remain intact.', 409);
  requireValue(release.compatibility.collaboration === 1 || !identity.collaborationWork?.length,
    'upgrade_collaboration_protocol_required', 'Active bounded collaboration requires protocol 1. Finish or explicitly cancel that job before switching to older code. Unrelated work and historical results are unchanged.', 409);
}

const collaborationWork = executions => executions.filter(e => (e?.collaboration || e?.collaborationDeadline) &&
  !['completed', 'failed', 'cancelled', 'rejected', 'in_review'].includes(e.state))
  .map(e => ({ kind: 'collaboration', id: e.id, state: e.state }));

export function inspectDatabase(path, role) {
  requireValue(existsSync(path), 'upgrade_state_missing', 'Existing service database is required. Upgrade never initialises a new identity');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare('PRAGMA user_version').get().user_version;
    requireValue(schema === (role === 'backend' ? 2 : 1), 'upgrade_incompatible', 'Unsupported service database schema');
    requireValue(db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'upgrade_state_invalid', 'Database integrity check failed');
    const blockers = [];
    if (role === 'backend') {
      assertTaskIdentityIntegrity(db);
      const instanceId = db.prepare("SELECT value FROM settings WHERE key='instance'").get()?.value;
      requireValue(instanceId, 'upgrade_state_invalid', 'Existing backend instance identity is missing');
      blockers.push(...backendMaintenanceBlockers(db));
      return { instanceId, schema, blockers, collaborationWork: collaborationWork(db.prepare("SELECT data FROM entities WHERE kind='execution'").all().map(row => JSON.parse(row.data))),
        interactiveProtocolWork: interactiveProtocolWork(
        db.prepare("SELECT data FROM entities WHERE kind='provision_request'").all().map(row => JSON.parse(row.data)),
        db.prepare("SELECT data FROM entities WHERE kind='grant_request'").all().map(row => JSON.parse(row.data))) };
    }
    const identity = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='identity'").get()?.value ?? 'null');
    requireValue(identity?.nodeId && identity.instanceId, 'upgrade_state_invalid', 'Existing node/backend identity is missing');
    for (const row of db.prepare('SELECT data FROM work').all()) {
      const w = JSON.parse(row.data);
      if (w.state === 'administratively_abandoned' && w.administrativeDisposition?.kind === 'abandonment' &&
        w.administrativeDisposition.promptReplayAllowed === false && w.administrativeDisposition.nativeSettlementClaimed === false &&
        digest(w.invocation ?? null) === w.administrativeDisposition.invocationDigest && digest(w.observation ?? null) === w.administrativeDisposition.observationDigest) continue;
      if (!['pending', 'native_finished', 'settled', 'settled_waiting'].includes(w.state) || w.state === 'pending' &&
        (w.invocation || !['requested', 'completed', 'cancelled', 'failed', 'rejected'].includes(w.execution?.state)) ||
        ['native_finished', 'settled_waiting'].includes(w.state) && w.observation?.state !== 'finished') blockers.push({ kind: 'native_work', id: w.id, state: w.state });
    }
    for (const row of db.prepare('SELECT id,state,data FROM notices').all()) {
      if (!['pending', 'settled', 'obsolete'].includes(row.state) || row.state === 'pending' && JSON.parse(row.data).invocation) blockers.push({ kind: 'notice', id: row.id, state: row.state });
    }
    const refusedPublications = [];
    for (const row of db.prepare("SELECT key,hash,state,data FROM outbox WHERE state NOT IN ('recorded','superseded')").all()) {
      const item = JSON.parse(row.data);
      if (row.state === 'administratively_abandoned' && item.administrativeDisposition?.kind === 'abandonment' &&
        item.applied === false && item.effectsUncertain === false && item.administrativeDisposition.commandHash === row.hash && digest(item.command) === row.hash) continue;
      const refusal = definitiveDispatchRefusal(row) ?? definitivePublicationRefusal(row);
      if (refusal) refusedPublications.push(refusal);
      else blockers.push({ kind: 'publication', id: row.key, state: row.state });
    }
    for (const row of db.prepare("SELECT value FROM settings WHERE key LIKE 'headless-setup:%'").all()) {
      const setup = JSON.parse(row.value);
      if (!['ready', 'blocked'].includes(setup.state)) blockers.push({ kind: 'headless_setup', id: setup.id, state: setup.state });
    }
    for (const row of db.prepare('SELECT id,state,data FROM occurrences').all()) {
      if (row.state === 'administratively_abandoned' && JSON.parse(row.data).administrativeDisposition?.kind === 'abandonment') continue;
      if (!['pending', 'completed', 'failed', 'cancelled', 'in_review', 'waiting_question'].includes(row.state)) blockers.push({ kind: 'occurrence', id: row.id, state: row.state });
    }
    const preparations = db.prepare("SELECT value FROM settings WHERE key LIKE 'interactive-request:%'").all().map(row => JSON.parse(row.value));
    const permissions = db.prepare("SELECT data FROM cached_entities WHERE kind='grant_request'").all().map(row => JSON.parse(row.data).entity);
    const pendingRepairs = db.prepare("SELECT key,data FROM outbox WHERE state IN ('pending','conflict')").all()
      .filter(row => JSON.parse(row.data).command.action === 'interactive.repair_request').map(row => ({ kind: 'repair_publication', id: row.key, state: JSON.parse(row.data).state }));
    return { ...identity, schema, blockers, collaborationWork: collaborationWork(db.prepare('SELECT data FROM work').all().map(row => JSON.parse(row.data).execution)),
      interactiveProtocolWork: [...interactiveProtocolWork(preparations, permissions), ...pendingRepairs],
      ...(refusedPublications.length ? { refusedPublications } : {}) };
  } finally { db.close(); }
}

export function serviceIdentity(unit) {
  if (unit.role === 'backend') return { database: join(unit.statePath, 'backend.sqlite'), stateDirectory: unit.statePath,
    files: [join(unit.statePath, 'owner.json')], ...inspectDatabase(join(unit.statePath, 'backend.sqlite'), 'backend') };
  const config = JSON.parse(readFileSync(unit.statePath, 'utf8'));
  requireValue(config.identityVersion === 2 && typeof config.stateDirectory === 'string' && resolve(config.stateDirectory) === config.stateDirectory,
    'upgrade_state_invalid', 'Stable existing node configuration is required');
  const result = inspectDatabase(join(config.stateDirectory, 'node.sqlite'), 'node');
  requireValue(config.nodeId === result.nodeId, 'backend_identity_mismatch', 'Node config and journal identity differ');
  const pin = join(config.stateDirectory, 'backend-instance.json');
  requireValue(existsSync(pin) && JSON.parse(readFileSync(pin, 'utf8')).instanceId === result.instanceId,
    'backend_identity_mismatch', 'Pinned backend instance must match the node journal');
  const privateFiles = readdirSync(config.stateDirectory).filter(name => name.endsWith('.json') && !['runtime.json', 'maintenance.json'].includes(name))
    .map(name => join(config.stateDirectory, name));
  return { database: join(config.stateDirectory, 'node.sqlite'), stateDirectory: config.stateDirectory,
    files: [...new Set([unit.statePath, pin, ...privateFiles])].filter(existsSync).sort(), ...result };
}

export function identityFingerprint(identity, version = 2, baselineFiles = identity.files) {
  requireValue([1, 2, 3].includes(version), 'upgrade_incompatible', 'Unknown identity fingerprint version');
  return digest({ instanceId: identity.instanceId, nodeId: identity.nodeId ?? null,
    files: (version === 3 ? baselineFiles.filter(path => basename(path) !== 'worker-index.json') : identity.files).map(path => [path, version === 2 && identity.nodeId && basename(path) === 'worker-index.json'
      ? digest(JSON.parse(readFileSync(path, 'utf8'))) : digest(readFileSync(path).toString('base64'))]) });
}
