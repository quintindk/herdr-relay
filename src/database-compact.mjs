import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digest, requireValue, RelayError } from './protocol.mjs';
import { acquireCompactionLock } from './compact-lock.mjs';
import { readPrivateJson } from './private-files.mjs';
import { defaultNodeConfig } from './native-onboarding.mjs';
import { serviceLock } from './service-lock.mjs';
import { assertTaskIdentityIntegrity, backendSchema } from './task-identity.mjs';

const CHUNK = 5000;
const fdPath = (fd, name) => name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`;
const owned = entry => typeof process.getuid !== 'function' || BigInt(entry.uid) === BigInt(process.getuid());
const ident = name => `"${name.replaceAll('"', '""')}"`;
const uri = (path, query) => `${pathToFileURL(path).href}?${query}`;
const invalid = (condition, message) => requireValue(condition, 'invalid_database', message);
const sameEntry = (a, b) => a.dev === b.dev && a.ino === b.ino;

function jsonObject(raw) {
  if (typeof raw !== 'string' || raw.includes('\0')) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

export function isEphemeralPresenceReceipt(actor, key, hash, dataJson) {
  if (typeof actor !== 'string' || !actor.startsWith('node:') || typeof key !== 'string' ||
    typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return false;
  const heartbeat = /^heartbeat:\d+$/.test(key);
  const advertise = /^advertise:.+:\d+$/.test(key);
  const observe = /^observe:observed_[0-9a-f]+:\d+$/.test(key);
  if (!heartbeat && !advertise && !observe) return false;
  const data = jsonObject(dataJson);
  if (!data) return false;
  const nodeId = actor.slice(5);
  try {
    if (heartbeat) return data.id === nodeId && typeof data.name === 'string' && Object.hasOwn(data, 'lastSeenAt') &&
      (hash === digest({ action: 'node.heartbeat', payload: { id: nodeId } }) || data.machine !== undefined &&
        hash === digest({ action: 'node.heartbeat', payload: { id: nodeId, machine: data.machine } }));
    if (data.nodeId !== nodeId || typeof data.id !== 'string' || !Number.isSafeInteger(data.revision) || data.revision < 2 ||
      !['available', 'busy', 'offline', 'unknown'].includes(data.availability) || data.deletedAt ||
      observe && !(Array.isArray(data.capabilities) && data.capabilities.includes('observation_only'))) return false;
    const base = { id: data.id, expectedRevision: data.revision - 1, availability: data.availability };
    for (const bindingRevision of data.bindingRevision == null ? [undefined] : [undefined, data.bindingRevision]) {
      for (const conversationId of data.conversationId == null ? [undefined] : [undefined, data.conversationId]) {
        const payload = { ...base, ...(bindingRevision === undefined ? {} : { bindingRevision }),
          ...(conversationId === undefined ? {} : { conversationId }) };
        if (hash === digest({ action: 'agent.advertise', payload })) return true;
      }
    }
  } catch (error) {
    // A malformed receipt can contain a payload deeper than canonical() can
    // hash. No provable preimage means the row must stay.
    if (!(error instanceof RangeError)) throw error;
  }
  return false;
}

const presenceTypes = ['node.heartbeat', 'agent.advertise'];
function isoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

export function isEphemeralPresenceEvent(dataJson, sqlType) {
  if (sqlType !== undefined && !presenceTypes.includes(sqlType)) return false;
  const event = jsonObject(dataJson);
  if (!event || !presenceTypes.includes(event.type) || sqlType !== undefined && sqlType !== event.type) return false;
  const { id, entityId, revision, actor, data, at } = event;
  if (typeof id !== 'string' || !id || typeof entityId !== 'string' || !entityId || !Number.isSafeInteger(revision) || revision <= 0 ||
    actor?.type !== 'node' || typeof actor.id !== 'string' || !actor.id || !data || typeof data !== 'object' ||
    Array.isArray(data) || data.id !== entityId || data.revision !== revision || !isoTimestamp(at) || !isoTimestamp(data.lastSeenAt)) return false;
  if (event.type === 'node.heartbeat' ? actor.id !== entityId || typeof data.name !== 'string' || !data.name.trim() :
    data.nodeId !== actor.id || data.deletedAt != null || !['available', 'busy', 'offline', 'unknown'].includes(data.availability)) return false;
  // JSON.parse keeps the last duplicate key and SQLite can use the first.
  // Tokenise only already-valid JSON and reject duplicates, including escaped
  // spellings and duplicates whose values happen to agree.
  const stack = [], tokens = /"(?:[^"\\]|\\.)*"(\s*:)?|[{}\[\]]/gu;
  for (const [token, key] of dataJson.matchAll(tokens)) {
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (key) {
      const name = JSON.parse(token.slice(0, -key.length)), keys = stack.at(-1);
      if (keys.has(name)) return false;
      keys.add(name);
    }
  }
  return true;
}

const ephemeralEvent = `relay_ephemeral_event(data, CASE WHEN json_valid(data) THEN json_extract(data, '$.type') ELSE NULL END)`;
const ephemeralReceipt = 'relay_ephemeral_receipt(actor, key, hash, data)';
function registerFilters(db, role) {
  const options = { deterministic: true, useBigIntArguments: true };
  db.function('relay_ephemeral_event', options, (data, type) => Number(isEphemeralPresenceEvent(data, type)));
  if (role === 'backend') db.function('relay_ephemeral_receipt', options,
    (actor, key, hash, data) => Number(isEphemeralPresenceReceipt(actor, key, hash, data)));
}

function entry(path) {
  try { return lstatSync(path, { bigint: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function databaseFiles(dirFd, name, { optional = false, requirePrivate = false } = {}) {
  return ['', '-wal', '-shm', '-journal'].map(suffix => {
    const file = entry(fdPath(dirFd, name + suffix));
    invalid(file ? file.isFile() && owned(file) : suffix || optional,
      `${name + suffix} must be an existing regular file owned by the service user, not a symlink`);
    if (file && requirePrivate) invalid(suffix ? (file.mode & 0o077n) === 0n : (file.mode & 0o7777n) === 0o600n,
      suffix ? `${name + suffix} must have no group or other permissions` : `${name} must have mode 0600`);
    return file;
  });
}

const fileBytes = files => files.slice(0, 3).reduce((sum, file) => sum + Number(file?.size ?? 0n), 0);

function pinDirectory(directory) {
  let fd;
  try {
    fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    invalid(owned(stat) && (stat.mode & 0o022) === 0 && realpathSync(fdPath(fd)) === directory,
      'State directory must be owned by the service user, not group/other writable, and have no symlink components');
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw new RelayError('invalid_database',
      'State directory must exist and have no symlink components', 400);
    throw error;
  }
}

function unlinkIfExists(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function syncDirectory(fd, fsync = fsyncSync) {
  fsync(fd);
}

function compactionArtifacts(dirFd, name) {
  const files = readdirSync(fdPath(dirFd)).sort();
  const candidates = files.filter(file => file.startsWith(`${name}.compact-`)).map(file => file.replace(/(\.sqlite)-(wal|shm|journal)$/, '$1'));
  const originals = files.filter(file => file.startsWith(`${name}.pre-compact-`)).map(file => file.replace(/-(wal|shm|journal)$/, ''));
  return { strandedCandidates: [...new Set(candidates)], retainedOriginals: [...new Set(originals)] };
}

function removeStrandedCandidates(dirFd, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const generated = new RegExp(`^${escapedName}\\.compact-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.sqlite$`);
  for (const candidate of compactionArtifacts(dirFd, name).strandedCandidates) {
    if (!generated.test(candidate)) continue;
    const paths = ['-journal', '-wal', '-shm', ''].map(suffix => fdPath(dirFd, candidate + suffix));
    const entries = paths.map(entry);
    // Do not follow symlinks or remove files with uncertain provenance.
    if (!entries.every(file => !file || file.isFile() && owned(file) && (file.mode & 0o7777n) === 0o600n && file.nlink === 1n)) continue;
    for (const path of paths) unlinkIfExists(path);
  }
}

function artifactPaths(dirFd, name, directory) {
  const { strandedCandidates, retainedOriginals } = compactionArtifacts(dirFd, name);
  return { strandedCandidates: strandedCandidates.map(file => join(directory, file)),
    retainedOriginals: retainedOriginals.map(file => join(directory, file)) };
}

function verifySchema(db, expected) {
  requireValue(db.prepare('PRAGMA user_version').get().user_version === expected,
    'unsupported_schema', `Compaction requires existing database schema ${expected}`);
}

function verifyQuickCheck(db) {
  invalid(db.prepare('PRAGMA quick_check(1)').get().quick_check === 'ok', 'Database quick check failed');
}

function identity(db, role) {
  const row = db.prepare('SELECT typeof(value) AS type, hex(value) AS bytes FROM settings WHERE key=?')
    .get(role === 'backend' ? 'instance' : 'identity');
  invalid(row?.type === 'text' && row.bytes, 'Database identity is missing');
  return row.bytes;
}

function eventSequence(db) {
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes').get().seq;
  const allocated = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM sqlite_sequence WHERE name='changes'").get().seq;
  const highWaterSeq = Math.max(maxSeq, allocated, 0);
  invalid(Number.isSafeInteger(highWaterSeq), 'Backend event high-water sequence is not a safe integer');
  return { maxSeq, highWaterSeq };
}

// Older backends fence cursors against MAX(changes.seq), not sqlite_sequence.
// Keep the existing tail even if it is a removable legacy presence event.
const ephemeralChange = maxSeq => `seq < ${maxSeq} AND ${ephemeralEvent}`;
const count = (db, table) => db.prepare(`SELECT count(*) AS n FROM ${ident(table)}`).get().n;
const filteredCount = (db, table, predicate) => db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(${predicate}), 0) AS removable FROM ${ident(table)}`).get();
const filteredSummary = (name, { total, removable }) => ({ [`${name}Total`]: total, [`${name}Removable`]: removable, [`${name}Retained`]: total - removable });

function summary(db, role, filtered, sequence) {
  if (!filtered) registerFilters(db, role);
  if (role === 'backend') {
    const { maxSeq, highWaterSeq } = sequence ?? eventSequence(db);
    return { entitiesCount: count(db, 'entities'),
      ...filteredSummary('changes', filtered?.get('changes') ?? filteredCount(db, 'changes', ephemeralChange(maxSeq))),
      ...filteredSummary('receipts', filtered?.get('receipts') ?? filteredCount(db, 'receipts', ephemeralReceipt)),
      highWaterSeq };
  }
  return { ...filteredSummary('inbox', filtered?.get('inbox') ?? filteredCount(db, 'inbox', ephemeralEvent)),
    workCount: count(db, 'work'), outboxCount: count(db, 'outbox'), schedulesCount: count(db, 'schedules'),
    noticesCount: count(db, 'notices'), cachedEntitiesCount: count(db, 'cached_entities') };
}

function dryRun(dirFd, name, source, files, role, schema) {
  const [main, wal, shm, journal] = files;
  // SQLite's ordinary read-only WAL open creates sidecars when absent. Use an
  // immutable handle only if no WAL frames can be hidden, and discard the plan
  // if the offline main file changed while it was being inspected.
  const immutable = !wal?.size;
  requireValue(!journal && (immutable || shm?.size), 'database_busy',
    'A recovery journal or WAL without a shared-memory index is present. Use offline --apply to recover and checkpoint it.', 409);
  if (!immutable) {
    // SQLite can reuse a writable SHM mapping from another connection in this
    // process, even with readonly_shm=1. Isolate the WAL read on the pinned fd.
    const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--read-wal-plan', role],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', dirFd] }));
    if (result.error) throw new RelayError(result.error.code, result.error.message, result.error.status);
    return result.counts;
  }
  const db = new DatabaseSync(uri(source, 'immutable=1'), { readOnly: true });
  try {
    db.exec('BEGIN');
    verifySchema(db, schema);
    const counts = summary(db, role);
    const [current, currentWal, , currentJournal] = databaseFiles(dirFd, name);
    requireValue(sameEntry(main, current) && main.size === current.size && main.mtimeNs === current.mtimeNs &&
      main.ctimeNs === current.ctimeNs && !currentWal?.size && !currentJournal, 'database_busy',
    'Database changed during dry-run. Stop the service and retry.', 409);
    return counts;
  } finally { db.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--read-wal-plan') {
  try {
    const role = process.argv[3];
    invalid(['backend', 'node'].includes(role), 'Invalid database role');
    const name = `${role}.sqlite`, [, wal, shm, journal] = databaseFiles(3, name);
    requireValue(wal?.size && shm?.size && !journal, 'database_busy', 'Database sidecars changed during dry-run. Stop the service and retry.', 409);
    const db = new DatabaseSync(uri(fdPath(3, name), 'readonly_shm=1'), { readOnly: true });
    let counts;
    try {
      db.exec('BEGIN');
      verifySchema(db, role === 'backend' ? backendSchema : 1);
      counts = summary(db, role);
    } finally { db.close(); }
    console.log(JSON.stringify({ counts }));
  } catch (error) {
    console.log(JSON.stringify({ error: { code: error.code ?? 'invalid_database', message: error.message, status: error.status ?? 400 } }));
  }
}

function schemaObjects(db) {
  return db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY rowid`).all();
}

const schemaSignature = db => JSON.stringify(schemaObjects(db).map(row => JSON.stringify(row)).sort());

function copyTable(dest, name, predicate) {
  const table = ident(name);
  const columns = dest.prepare(`PRAGMA main.table_xinfo(${table})`).all();
  const names = new Set(columns.map(column => column.name.toLowerCase()));
  const rowid = ['rowid', '_rowid_', 'oid'].find(alias => !names.has(alias));
  invalid(rowid, `Table ${name} has no unshadowed SQLite rowid`);
  const fields = [rowid, ...columns.filter(column => column.hidden === 0).map(column => ident(column.name))].join(', ');
  const from = `source.${table}`;
  const chunkEnd = start => {
    const statement = dest.prepare(`SELECT MAX(k) AS last, COUNT(*) AS total FROM (
      SELECT ${rowid} AS k FROM ${from} ${start} ORDER BY ${rowid} LIMIT ?)`);
    statement.setReadBigInts(true);
    return statement;
  };
  const insert = range => dest.prepare(`INSERT INTO main.${table} (${fields}) SELECT ${fields} FROM ${from}
    WHERE ${range}${predicate ? ` AND NOT (${predicate})` : ''} ORDER BY ${rowid}`);
  const firstChunk = chunkEnd(''), nextChunk = chunkEnd(`WHERE ${rowid} > ?`);
  const firstInsert = insert(`${rowid} <= ?`), nextInsert = insert(`${rowid} > ? AND ${rowid} <= ?`);
  let after, total = 0, retained = 0;
  for (;;) {
    dest.exec('BEGIN');
    const batch = after === undefined ? firstChunk.get(CHUNK) : nextChunk.get(after, CHUNK);
    if (batch.total !== 0n) {
      const inserted = after === undefined ? firstInsert.run(batch.last) : nextInsert.run(after, batch.last);
      after = batch.last;
      total += Number(batch.total);
      retained += Number(inserted.changes);
    }
    dest.exec('COMMIT');
    if (batch.total < CHUNK) return { total, removable: total - retained, retained };
  }
}

function copyDatabase(sourceDb, source, temp, role, schema, originalIdentity, sequence) {
  const objects = schemaObjects(sourceDb), tableList = new Map(sourceDb.prepare('PRAGMA main.table_list').all().map(row => [row.name, row]));
  const internal = sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'sqlite_*'").all().map(row => row.name);
  invalid(internal.every(name => ['sqlite_sequence', 'sqlite_stat1', 'sqlite_stat4'].includes(name)), 'Database has an unsupported internal table');
  invalid(objects.every(({ type, name }) => ['index', 'trigger'].includes(type) ||
    type === 'table' && tableList.get(name)?.type === 'table' && tableList.get(name).wr === 0), 'Database has an unsupported schema object');
  const tables = objects.filter(object => object.type === 'table');
  const copied = new Map();
  const filters = role === 'backend' ? new Map([['changes', ephemeralChange(sequence.maxSeq)], ['receipts', ephemeralReceipt]]) : new Map([['inbox', ephemeralEvent]]);
  invalid([...filters.keys()].every(name => tables.some(table => table.name === name)), 'Database event or receipt table is missing');

  const dest = new DatabaseSync(temp);
  try {
    dest.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=OFF;');
    // Let SQLite transfer values directly, including exact INTEGERs, BLOBs and
    // embedded NULs. Never materialise a batch of large event bodies in JS.
    // The source is checkpointed and its exclusive lock prevents any writes
    // while this immutable attachment reads the main file.
    dest.prepare('ATTACH DATABASE ? AS source').run(uri(source, 'immutable=1'));
    for (const { sql } of tables) dest.exec(sql);
    registerFilters(dest, role);
    for (const { name } of tables) copied.set(name, copyTable(dest, name, filters.get(name)));
    if (tableList.has('sqlite_sequence')) {
      dest.exec(`DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence(name, seq)
        SELECT name, seq FROM source.sqlite_sequence ${role === 'backend' ? "WHERE name IS NOT 'changes'" : ''}`);
      // sqlite_sequence has no UNIQUE constraint on name, so REPLACE alone
      // would append a duplicate instead of restoring the high-water mark.
      if (role === 'backend') dest.prepare("INSERT INTO main.sqlite_sequence(name, seq) VALUES ('changes', ?)").run(sequence.highWaterSeq);
    }
    dest.exec('DETACH DATABASE source');
    for (const { type, sql } of objects) if (type !== 'table') dest.exec(sql);
    if (internal.includes('sqlite_stat1') || internal.includes('sqlite_stat4')) dest.exec('ANALYZE');
    dest.exec(`PRAGMA user_version=${schema}; PRAGMA synchronous=FULL;`);
    invalid(dest.prepare('PRAGMA journal_mode=WAL').get().journal_mode === 'wal', 'Cannot enable WAL on compacted database');
    checkpoint(dest);

    invalid(dest.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'Compacted database integrity check failed');
    invalid(!dest.prepare('PRAGMA foreign_key_check').get(), 'Compacted database has inconsistent foreign keys');
    verifySchema(dest, schema);
    invalid(schemaSignature(dest) === schemaSignature(sourceDb), 'Compacted database schema does not match source');
    registerFilters(sourceDb, role);
    for (const { name } of tables) {
      const { retained } = copied.get(name), predicate = filters.get(name);
      const expected = predicate ? sourceDb.prepare(`SELECT count(*) AS n FROM ${ident(name)} WHERE NOT (${predicate})`).get().n : count(sourceDb, name);
      invalid(retained === expected && count(dest, name) === expected, `Compacted row count does not match for ${name}`);
    }
    invalid(identity(dest, role) === originalIdentity, 'Compacted database identity does not match source');
    if (role === 'backend') {
      const { maxSeq, highWaterSeq } = eventSequence(dest);
      invalid(maxSeq === sequence.maxSeq && highWaterSeq === sequence.highWaterSeq &&
        dest.prepare("SELECT seq FROM sqlite_sequence WHERE name='changes'").get()?.seq === highWaterSeq, 'Compacted event sequence does not match source');
      assertTaskIdentityIntegrity(dest);
    }
    return summary(sourceDb, role, copied, sequence);
  } finally { dest.close(); }
}

function checkpoint(db) {
  const { busy } = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  requireValue(busy === 0, 'database_busy', 'Cannot checkpoint database WAL. Stop all database readers and writers and retry.', 409);
}

function removeSidecars(dirFd, name) {
  const [, wal, shm, journal] = databaseFiles(dirFd, name);
  invalid(!wal?.size && !journal?.size, `Cannot remove uncheckpointed database sidecars for ${name}`);
  if (wal) unlinkSync(fdPath(dirFd, `${name}-wal`));
  if (shm) unlinkSync(fdPath(dirFd, `${name}-shm`));
  if (journal) unlinkSync(fdPath(dirFd, `${name}-journal`));
}

function retireWal(db) {
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') return;
  // An idle raw SQLite handle may already have the old inode open without a
  // lock. If that inode still advertises WAL after rename, its first write can
  // open the NEW live pathname's WAL using pages from the OLD database. Retire
  // the original into rollback-journal mode so SQLite's moved-file checks
  // apply. Exclusive locking keeps the kernel inode lock across the mode switch.
  db.exec('ROLLBACK; PRAGMA journal_size_limit=0');
  invalid(db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode === 'delete', 'Cannot retire the database WAL safely');
  db.exec('BEGIN IMMEDIATE');
}

function installDatabase(dirFd, name, source, temp, tempName, destGuard, schema, role, originalIdentity, keepOriginal, hooks) {
  const backupName = `${name}.pre-compact-${randomUUID()}`, backup = fdPath(dirFd, backupName);
  const sync = () => syncDirectory(dirFd, hooks.fsyncDir);
  // Pin the original under the backup name without copying any bytes. A single
  // replacement rename has no crash window with the live filename missing.
  const [original] = databaseFiles(dirFd, name, { requirePrivate: true });
  linkSync(source, backup);
  sync();
  let replaced = false, durabilityFailed = false;
  try {
    removeSidecars(dirFd, name);
    hooks.beforeSwap?.();
    renameSync(temp, source);
    replaced = true;
    hooks.afterSwap?.();
    try { sync(); } catch (error) { durabilityFailed = true; throw error; }
    const live = new DatabaseSync(uri(source, 'immutable=1'), { readOnly: true });
    try {
      verifyQuickCheck(live);
      verifySchema(live, schema);
      invalid(identity(live, role) === originalIdentity, 'Live database identity does not match source');
    } finally { live.close(); }
  } catch (error) {
    try {
      if (replaced) {
        // The rejected replacement may also have dormant handles opened while
        // it was live. Temporarily give its lock connection its pathname back
        // so it can retire WAL before the replacement inode is moved away.
        linkSync(source, temp);
        try { retireWal(destGuard); removeSidecars(dirFd, tempName); }
        finally { unlinkSync(temp); }
        // Roll back without consuming the only durable backup name. If the
        // rollback cannot be fsynced, leave that name for explicit recovery.
        linkSync(backup, temp);
        renameSync(temp, source);
      }
      sync();
    } catch (rollback) {
      throw Object.assign(new AggregateError([error, rollback],
        `Compaction rollback durability could not be confirmed. Original retained as ${backupName}: ${error.message}; ${rollback.message}`),
      { code: error.code ?? rollback.code });
    }
    if (!durabilityFailed) unlinkSync(backup);
    throw error;
  }
  // Cutover is already durable. The unlink reclaims space now, but need not
  // survive power loss: a reappearing backup is a reportable retained original.
  if (!keepOriginal) unlinkSync(backup);
  return { backupName, originalLinkCount: original.nlink };
}

export function compactDatabase({ role, stateDir, databaseName, apply = false, keepOriginal = false, _hooks = {} }) {
  invalid(['backend', 'node'].includes(role) && databaseName === `${role}.sqlite`, 'Invalid database role or filename');
  invalid(typeof stateDir === 'string' && stateDir.length > 0, 'Existing state directory required');
  const directory = resolve(stateDir), schema = role === 'backend' ? backendSchema : 1;
  const database = join(directory, databaseName);
  const dirFd = pinDirectory(directory);
  let unlockService, unlockCompact, temp;
  try {
    const source = fdPath(dirFd, databaseName), files = databaseFiles(dirFd, databaseName, { requirePrivate: apply });
    if (!apply) return { state: 'compact_plan', role, database, schema, applied: false, sizeBytes: fileBytes(files),
      ...dryRun(dirFd, databaseName, source, files, role, schema), ...artifactPaths(dirFd, databaseName, directory) };

    databaseFiles(dirFd, 'service-lock.sqlite', { optional: true });
    unlockService = serviceLock(fdPath(dirFd));
    unlockCompact = acquireCompactionLock(dirFd);
    requireValue(!entry(fdPath(dirFd, 'maintenance.json')), 'maintenance_active',
      'Finish or clear active upgrade maintenance before compacting', 409);
    removeStrandedCandidates(dirFd, databaseName);
    const [original] = databaseFiles(dirFd, databaseName, { requirePrivate: true });
    const sourceDb = new DatabaseSync(uri(source, 'mode=rw'));
    let destGuard;
    try {
      // In WAL mode BEGIN IMMEDIATE under normal locking guards the *SHM*
      // inode, which would stop fencing writes after unlinking the sidecars.
      // Select exclusive mode before the first read to fence the main inode.
      sourceDb.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
      verifySchema(sourceDb, schema);
      verifyQuickCheck(sourceDb);
      checkpoint(sourceDb);
      // Fence writers that do not use serviceLock while the read-only attached
      // connection copies. The transaction itself changes no source rows.
      sourceDb.exec('BEGIN IMMEDIATE');
      const bytesBefore = fileBytes(databaseFiles(dirFd, databaseName, { requirePrivate: true }));
      const originalIdentity = identity(sourceDb, role);
      const sequence = role === 'backend' ? eventSequence(sourceDb) : undefined;

      const tempName = `${databaseName}.compact-${randomUUID()}.sqlite`, candidate = fdPath(dirFd, tempName);
      const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temp = candidate;
      try { if ((fstatSync(fd).mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600); }
      finally { closeSync(fd); }
      const counts = copyDatabase(sourceDb, source, temp, role, schema, originalIdentity, sequence);
      const verifiedFd = openSync(temp, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if ((fstatSync(verifiedFd).mode & 0o7777) !== 0o600) fchmodSync(verifiedFd, 0o600);
        // Bulk writes used synchronous=OFF. Flush the actual file before it
        // can become the live name, regardless of SQLite's checkpoint state.
        fsyncSync(verifiedFd);
      } finally { closeSync(verifiedFd); }
      invalid(realpathSync(fdPath(dirFd)) === directory, 'State directory moved during compaction');
      invalid(sameEntry(original, databaseFiles(dirFd, databaseName, { requirePrivate: true })[0]), 'Source database was replaced during compaction');
      destGuard = new DatabaseSync(uri(temp, 'mode=rw'));
      // Lock the replacement inode before exposing it at the live pathname.
      // Raw SQLite clients cannot write to either inode during verification.
      destGuard.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN IMMEDIATE');
      removeSidecars(dirFd, tempName);
      retireWal(sourceDb);
      const { backupName, originalLinkCount } = installDatabase(dirFd, databaseName, source, temp, tempName, destGuard, schema, role,
        originalIdentity, keepOriginal, _hooks);
      const bytesAfter = fileBytes(databaseFiles(dirFd, databaseName));
      const sizeReductionBytes = Math.max(0, bytesBefore - bytesAfter);
      return { state: 'compacted', role, database, schema, applied: true, bytesBefore, bytesAfter, sizeReductionBytes,
        bytesReclaimed: !keepOriginal && originalLinkCount === 1n ? sizeReductionBytes : 0, originalRetained: Boolean(keepOriginal),
        keptOriginalPath: keepOriginal ? join(directory, backupName) : null, ...counts, ...artifactPaths(dirFd, databaseName, directory) };
    } finally {
      // The source connection still remembers the old WAL pathname. Close it
      // before allowing any writer on the replacement to create a new WAL.
      try { sourceDb.close(); } finally { destGuard?.close(); }
    }
  } finally {
    try { if (temp) for (const suffix of ['-journal', '-wal', '-shm', '']) unlinkIfExists(temp + suffix); }
    finally { try { unlockCompact?.(); } finally { try { unlockService?.(); } finally { closeSync(dirFd); } } }
  }
}

export function compactBackendDatabase({ stateDir, apply, keepOriginal, _hooks }) {
  return compactDatabase({ role: 'backend', databaseName: 'backend.sqlite', stateDir, apply, keepOriginal, _hooks });
}

export function compactNodeDatabase({ configFile, stateDir, apply, keepOriginal, _hooks } = {}) {
  const directory = stateDir ?? readPrivateJson(configFile ?? defaultNodeConfig())?.stateDirectory;
  requireValue(typeof directory === 'string' && directory.length > 0, 'invalid_config', 'Node configuration requires a stateDirectory');
  return compactDatabase({ role: 'node', databaseName: 'node.sqlite', stateDir: directory, apply, keepOriginal, _hooks });
}
