import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { digest, requireValue } from './protocol.mjs';

export function inspectDatabase(path, role) {
  requireValue(existsSync(path), 'upgrade_state_missing', 'Existing service database is required. Upgrade never initialises a new identity');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    requireValue(db.prepare('PRAGMA user_version').get().user_version === 1, 'upgrade_incompatible', 'Only existing schema-1 state is supported');
    requireValue(db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'upgrade_state_invalid', 'Database integrity check failed');
    const blockers = [];
    if (role === 'backend') {
      const instanceId = db.prepare("SELECT value FROM settings WHERE key='instance'").get()?.value;
      requireValue(instanceId, 'upgrade_state_invalid', 'Existing backend instance identity is missing');
      for (const row of db.prepare("SELECT data FROM entities WHERE kind='execution'").all()) {
        const e = JSON.parse(row.data);
        if (!['requested', 'waiting', 'waiting_children', 'waiting_time', 'in_review', 'monitor_review', 'monitor_blocked',
          'completed', 'cancelled', 'failed', 'rejected'].includes(e.state)) blockers.push({ kind: 'execution', id: e.id, state: e.state });
      }
      for (const row of db.prepare("SELECT data FROM entities WHERE kind='message'").all()) {
        const m = JSON.parse(row.data);
        if (!['queued', 'delivered', 'blocked'].includes(m.state)) blockers.push({ kind: 'message', id: m.id, state: m.state });
      }
      for (const row of db.prepare("SELECT data FROM entities WHERE kind='provision_request'").all()) {
        const p = JSON.parse(row.data);
        if (!['ready', 'blocked', 'cancelled'].includes(p.state)) blockers.push({ kind: 'preparation', id: p.id, state: p.state });
      }
      return { instanceId, blockers };
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
    for (const row of db.prepare('SELECT id,state FROM occurrences').all()) {
      if (!['pending', 'completed', 'failed', 'cancelled', 'in_review', 'waiting_question'].includes(row.state)) blockers.push({ kind: 'occurrence', ...row });
    }
    return { ...identity, blockers };
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
