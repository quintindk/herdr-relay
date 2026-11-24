import { closeSync, constants, fchmodSync, linkSync, lstatSync, openSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RelayError, requireValue } from './protocol.mjs';

const lockName = 'compact-lock.sqlite';
const noCompaction = () => new RelayError('database_compacting', 'Database compaction is in progress. Retry afterwards', 409);

function lockEntry(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat) requireValue(stat.isFile() && (stat.mode & 0o7777) === 0o600 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid()), 'invalid_database', 'Compaction lock must be a private regular file owned by the service user');
  return stat;
}

function lockBusy(error) {
  if ([5, 6].includes(error.errcode & 0xff)) throw noCompaction();
  throw error;
}

function exclusive(path, initialise) {
  for (const suffix of ['-journal', '-wal', '-shm']) lockEntry(path + suffix);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
    if (initialise) db.exec('CREATE TABLE IF NOT EXISTS lock(id INTEGER PRIMARY KEY); COMMIT; BEGIN EXCLUSIVE');
  }
  catch (error) {
    db.close();
    lockBusy(error);
  }
  return () => db.close();
}

export function acquireCompactionLock(dirFd) {
  const path = `/proc/self/fd/${dirFd}/${lockName}`;
  // Keep the inode across runs. Unlinking a lock file allows two processes to
  // hold exclusive locks on different inodes that once had the same name.
  const existing = lockEntry(path);
  if (existing) return exclusive(path, existing.size === 0);

  // Publish an already initialised and exclusively locked inode. A read-only
  // probe of a zero-byte SQLite file can succeed without taking a real lock.
  const candidate = `${path}.init-${randomUUID()}`;
  const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let unlock;
  try {
    try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
    unlock = exclusive(candidate, true);
    linkSync(candidate, path);
    unlinkSync(candidate);
    return unlock;
  } catch (error) {
    try { unlock?.(); } finally { unlinkSync(candidate); }
    if (error.code !== 'EEXIST') throw error;
    return exclusive(path, lockEntry(path)?.size === 0);
  }
}

export function assertNotCompacting(stateDir) {
  const path = join(stateDir, lockName);
  const stat = lockEntry(path);
  if (!stat) return;
  if (stat.size === 0) throw noCompaction();
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=0; BEGIN; SELECT 1 FROM sqlite_master LIMIT 1; ROLLBACK');
  }
  catch (error) { lockBusy(error); }
  finally { db?.close(); }
}
