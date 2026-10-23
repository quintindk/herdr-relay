import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { now, requireValue } from './protocol.mjs';
import { backendSchema, taskIdentitySchema, assertTaskIdentityIntegrity, claimTaskReference, indexTaskAliases, parseTaskReference } from './task-identity.mjs';
import { backendMaintenanceBlockers } from './upgrade-safety.mjs';

function plan(db) {
  const schema = db.prepare('PRAGMA user_version').get().user_version;
  requireValue([1, backendSchema].includes(schema), 'unsupported_schema', 'Only an existing native schema-1 or schema-2 backend can be inspected');
  requireValue(db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'migration_blocked', 'Database integrity check failed');
  const instanceId = db.prepare("SELECT value FROM settings WHERE key='instance'").get()?.value;
  requireValue(instanceId && db.prepare("SELECT value FROM settings WHERE key='owner'").get()?.value, 'migration_blocked', 'Existing backend identity required');
  const tasks = db.prepare("SELECT data FROM entities WHERE kind='task'").all().map(row => JSON.parse(row.data));
  requireValue(tasks.every(task => typeof task.id === 'string' && Number.isSafeInteger(task.revision) && task.revision > 0 && task.revision < Number.MAX_SAFE_INTEGER),
    'migration_blocked', 'Every existing task needs a valid ID and incrementable revision');
  const seen = new Set();
  for (const task of tasks) if (task.reference !== undefined) {
    parseTaskReference(task.reference);
    requireValue(!seen.has(task.reference), 'task_reference_conflict', 'Existing tasks claim the same reference', 409);
    seen.add(task.reference);
  }
  const pending = tasks.filter(task => !task.reference).sort((a, b) => {
    // Valid timestamps first, invalid/missing timestamps last, native ID breaks ties.
    const time = task => Number.isFinite(Date.parse(task.createdAt)) ? Date.parse(task.createdAt) : Infinity;
    return (time(a) < time(b) ? -1 : time(a) > time(b) ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  if (schema === backendSchema) {
    assertTaskIdentityIntegrity(db);
  }
  const blockers = backendMaintenanceBlockers(db);
  return { schema, targetSchema: backendSchema, instanceId, tasks: tasks.length, pending: pending.length, ready: !blockers.length, blockers, ordered: pending, existing: tasks.filter(task => task.reference) };
}

export function planTaskIdentityMigration(database) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { const { ordered, existing, ...result } = plan(db); return result; } finally { db.close(); }
}

// Caller must hold the backend's service lock. Snapshot and migration share the
// same exclusive SQLite write boundary. No constructor or GET performs a backfill.
export function migrateTaskIdentity(database, { backup } = {}) {
  requireValue(existsSync(database), 'migration_state_missing', 'An existing initialised backend database is required. Migration never creates one');
  requireValue(backup && resolve(backup) !== resolve(database), 'migration_backup_required', 'A new explicit backup path is required');
  const db = new DatabaseSync(database);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    const current = plan(db);
    if (current.schema === backendSchema) {
      db.exec('COMMIT');
      return { ...planTaskIdentityMigration(database), alreadyApplied: true };
    }
    requireValue(current.ready, 'migration_busy', 'Settle active backend work before migrating task references', 409);
    // VACUUM INTO cannot run inside a transaction. A separate read connection
    // serialises the complete SQLite snapshot while this connection owns the write lock.
    const fd = openSync(backup, 'wx', 0o600); closeSync(fd);
    const snapshot = new DatabaseSync(database, { readOnly: true });
    try { snapshot.prepare('VACUUM INTO ?').run(resolve(backup)); }
    catch (error) { unlinkSync(backup); throw error; }
    finally { snapshot.close(); }
    chmodSync(backup, 0o600);
    const check = new DatabaseSync(backup, { readOnly: true });
    try { requireValue(check.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'migration_backup_failed', 'Backup integrity check failed'); } finally { check.close(); }
    for (const path of [backup, dirname(resolve(backup))]) { const handle = openSync(path, 'r'); try { fsyncSync(handle); } finally { closeSync(handle); } }
    const backupSha256 = createHash('sha256').update(readFileSync(backup)).digest('hex');
    db.exec(taskIdentitySchema);
    for (const task of current.existing) claimTaskReference(db, task.id, task.reference);
    const at = now(), actor = { type: 'system', id: 'task-identity-migration' };
    for (const task of current.ordered) {
      const updated = { ...task, reference: claimTaskReference(db, task.id), revision: task.revision + 1, updatedAt: at };
      db.prepare("UPDATE entities SET revision=?,data=? WHERE kind='task' AND id=?").run(updated.revision, JSON.stringify(updated), task.id);
      const event = { id: randomUUID(), type: 'task.reference_backfilled', entityId: task.id, revision: updated.revision, at, actor,
        causation: 'task-identity-schema-2', data: updated };
      db.prepare('INSERT INTO changes(id,at,data) VALUES (?,?,?)').run(event.id, at, JSON.stringify(event));
      indexTaskAliases(db, updated);
    }
    for (const task of current.existing) indexTaskAliases(db, task);
    assertTaskIdentityIntegrity(db);
    const receipt = { instanceId: current.instanceId, fromSchema: 1, schema: backendSchema, tasks: current.tasks, backfilled: current.pending, backup: resolve(backup), backupSha256, at };
    db.prepare('INSERT INTO settings VALUES (?,?)').run('task-identity-migration', JSON.stringify(receipt));
    db.exec(`PRAGMA user_version=${backendSchema}; COMMIT`);
    return { ...receipt, alreadyApplied: false };
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}
