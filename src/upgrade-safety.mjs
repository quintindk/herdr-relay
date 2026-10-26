import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { digest, requireValue } from './protocol.mjs';
import { assertTaskIdentityIntegrity } from './task-identity.mjs';

export function backendMaintenanceBlockers(db) {
  const blockers = [];
  for (const [kind, settled] of [
    ['execution', ['requested', 'waiting', 'waiting_children', 'waiting_time', 'in_review', 'monitor_review', 'monitor_blocked', 'completed', 'cancelled', 'failed', 'rejected']],
    ['message', ['queued', 'delivered', 'blocked']], ['provision_request', ['requested', 'waiting_driver', 'ready', 'blocked', 'cancelled']], ['headless_setup', ['ready', 'blocked']],
  ]) for (const row of db.prepare('SELECT data FROM entities WHERE kind=?').all(kind)) {
    const entity = JSON.parse(row.data);
    if (!settled.includes(entity.state)) blockers.push({ kind: kind === 'provision_request' ? 'preparation' : kind, id: entity.id, state: entity.state });
  }
  return blockers;
}

export function inspectDatabase(path, role) {
  requireValue(existsSync(path), 'upgrade_state_missing', 'Existing service database is required. Upgrade never initialises a new identity');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare('PRAGMA user_version').get().user_version;
    requireValue((role === 'backend' ? [1, 2] : [1]).includes(schema), 'upgrade_incompatible', 'Unsupported service database schema');
    requireValue(db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'upgrade_state_invalid', 'Database integrity check failed');
    const blockers = [];
    if (role === 'backend') {
      if (schema === 2) assertTaskIdentityIntegrity(db);
      const instanceId = db.prepare("SELECT value FROM settings WHERE key='instance'").get()?.value;
      requireValue(instanceId, 'upgrade_state_invalid', 'Existing backend instance identity is missing');
      blockers.push(...backendMaintenanceBlockers(db));
      return { instanceId, schema, blockers };
    }
    const identity = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='identity'").get()?.value ?? 'null');
    requireValue(identity?.nodeId && identity.instanceId, 'upgrade_state_invalid', 'Existing node/backend identity is missing');
    for (const row of db.prepare('SELECT data FROM work').all()) {
      const w = JSON.parse(row.data);
      if (!['pending', 'native_finished', 'settled', 'settled_waiting'].includes(w.state) || w.state === 'pending' &&
        (w.invocation || !['requested', 'completed', 'cancelled', 'failed', 'rejected'].includes(w.execution?.state)) ||
        ['native_finished', 'settled_waiting'].includes(w.state) && w.observation?.state !== 'finished') blockers.push({ kind: 'native_work', id: w.id, state: w.state });
    }
    for (const row of db.prepare('SELECT id,state,data FROM notices').all()) {
      if (!['pending', 'settled', 'obsolete'].includes(row.state) || row.state === 'pending' && JSON.parse(row.data).invocation) blockers.push({ kind: 'notice', id: row.id, state: row.state });
    }
    for (const row of db.prepare("SELECT key,state FROM outbox WHERE state NOT IN ('recorded','superseded')").all()) blockers.push({ kind: 'publication', id: row.key, state: row.state });
    for (const row of db.prepare("SELECT value FROM settings WHERE key LIKE 'headless-setup:%'").all()) {
      const setup = JSON.parse(row.value);
      if (!['ready', 'blocked'].includes(setup.state)) blockers.push({ kind: 'headless_setup', id: setup.id, state: setup.state });
    }
    for (const row of db.prepare('SELECT id,state FROM occurrences').all()) {
      if (!['pending', 'completed', 'failed', 'cancelled', 'in_review', 'waiting_question'].includes(row.state)) blockers.push({ kind: 'occurrence', ...row });
    }
    return { ...identity, schema, blockers };
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

export function identityFingerprint(identity, version = 2) {
  requireValue([1, 2].includes(version), 'upgrade_incompatible', 'Unknown identity fingerprint version');
  return digest({ instanceId: identity.instanceId, nodeId: identity.nodeId ?? null,
    files: identity.files.map(path => [path, version === 2 && identity.nodeId && basename(path) === 'worker-index.json'
      ? digest(JSON.parse(readFileSync(path, 'utf8'))) : digest(readFileSync(path).toString('base64'))]) });
}
