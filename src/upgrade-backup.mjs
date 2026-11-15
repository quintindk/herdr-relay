import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, linkSync, lstatSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { digest, requireValue } from './protocol.mjs';
import { readPrivateJson, writePrivateJson } from './private-files.mjs';

const bufferSize = 4 * 1024 * 1024;
const file = path => {
  const stat = lstatSync(path);
  requireValue(stat.isFile() && !stat.isSymbolicLink(), 'upgrade_backup_failed', 'Backup must be a regular private file');
  return stat;
};
const unchanged = (before, after) => before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs;
const standalone = path => requireValue(!existsSync(`${path}-wal`) || file(`${path}-wal`).size === 0,
  'upgrade_backup_failed', 'Backup has uncheckpointed WAL data. Retain it for inspection');

export function upgradeBackupSpace(services, directory, { operationPath, direction = 'upgrade', statfs = statfsSync } = {}) {
  let retained = 0n, required = 0n;
  for (const service of services) {
    if (operationPath && existsSync(join(operationPath, `${service.role}-before-${direction}.sqlite`))) continue;
    const db = new DatabaseSync(service.database, { readOnly: true });
    let bytes;
    try { bytes = BigInt(db.prepare('PRAGMA page_count').get().page_count) * BigInt(db.prepare('PRAGMA page_size').get().page_size); }
    finally { db.close(); }
    const peak = retained + 2n * bytes;
    if (peak > required) required = peak;
    retained += bytes;
  }
  const space = statfs(directory, { bigint: true }), available = space.bavail * space.bsize;
  requireValue(!required || available >= required + 8n * 1024n * 1024n, 'upgrade_disk_space',
    'Insufficient space for the SQLite snapshot and verified backup copy');
  return { requiredBytes: Number(required), availableBytes: Number(available) };
}

function checkIdentity(db, expected) {
  const schema = db.prepare('PRAGMA user_version').get().user_version;
  const value = db.prepare('SELECT value FROM settings WHERE key=?').get(expected.role === 'backend' ? 'instance' : 'identity')?.value;
  const identity = expected.role === 'backend' ? { instanceId: value } : JSON.parse(value ?? 'null');
  requireValue(schema === expected.schema && identity?.instanceId === expected.instanceId &&
    (expected.role === 'backend' || identity.nodeId === expected.nodeId), 'upgrade_backup_failed', 'Backup schema or service identity differs');
}

async function checksum(path, progress, step) {
  const before = lstatSync(path, { bigint: true }), hash = createHash('sha256');
  file(path); let bytes = 0;
  progress({ step, bytes, totalBytes: Number(before.size) });
  for await (const chunk of createReadStream(path, { highWaterMark: bufferSize })) {
    hash.update(chunk); bytes += chunk.length;
    progress({ step, bytes, totalBytes: Number(before.size) });
  }
  requireValue(unchanged(before, lstatSync(path, { bigint: true })) && bytes === Number(before.size),
    'upgrade_backup_failed', 'Backup changed during checksum verification');
  return { bytes, sha256: hash.digest('hex') };
}

// SQLite first produces a consistent snapshot, including committed WAL data.
// Hash its bytes while copying, then compare the persisted copy's SHA-256. Never
// compare a live main database file with a WAL-aware snapshot or walk every index.
export async function upgradeDatabaseBackup({ source, destination, role, schema, instanceId, nodeId = null, progress = () => {} }) {
  const expected = { role, schema, instanceId, nodeId }, receiptPath = `${destination}.verification.json`;
  requireValue(['backend', 'node'].includes(role) && Number.isSafeInteger(schema) && typeof instanceId === 'string' && instanceId &&
    (role === 'backend' || typeof nodeId === 'string' && nodeId), 'upgrade_backup_failed', 'Exact backup service identity required');
  if (existsSync(destination)) {
    file(destination); standalone(destination);
    let receipt;
    if (existsSync(receiptPath)) {
      file(receiptPath); receipt = readPrivateJson(receiptPath);
      requireValue(receipt.format === 1 && receipt.source === resolve(source) && digest(receipt.identity) === digest(expected) &&
        Number.isSafeInteger(receipt.bytes) && /^[a-f0-9]{64}$/.test(receipt.sha256), 'upgrade_backup_failed', 'Backup verification receipt differs');
    }
    const db = new DatabaseSync(destination, { readOnly: true });
    try {
      checkIdentity(db, expected);
      if (!receipt) {
        // A retained pre-0.2.10 backup has no checksum receipt. Check it once,
        // rather than trusting its existence or repeating the old index scan.
        progress({ step: 'legacy_backup_check' });
        requireValue(db.prepare('PRAGMA quick_check(1)').get().quick_check === 'ok', 'upgrade_backup_failed', 'Legacy backup integrity check failed');
      }
    } finally { db.close(); }
    const actual = await checksum(destination, progress, 'backup_checksum');
    if (receipt) requireValue(actual.bytes === receipt.bytes && actual.sha256 === receipt.sha256,
      'upgrade_backup_failed', 'Backup checksum differs. Existing backup was not overwritten');
    else writePrivateJson(receiptPath, { format: 1, source: resolve(source), identity: expected, ...actual }, true);
    return { ...actual, reused: true };
  }
  requireValue(!existsSync(receiptPath), 'upgrade_backup_failed', 'Verified backup is missing. Retain its receipt for inspection');
  const snapshot = `${destination}.snapshot-${randomUUID()}`, copy = `${destination}.copy-${randomUUID()}`;
  writeFileSync(snapshot, '', { flag: 'wx', mode: 0o600 });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    // Pin one read snapshot so another connection cannot restart a large backup.
    db.exec('BEGIN'); checkIdentity(db, expected);
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    progress({ step: 'sqlite_snapshot', bytes: 0, totalBytes: db.prepare('PRAGMA page_count').get().page_count * pageSize });
    let progressError;
    const totalPages = await backup(db, snapshot, { rate: 4096, progress: ({ remainingPages, totalPages }) => {
      try { progress({ step: 'sqlite_snapshot', bytes: (totalPages - remainingPages) * pageSize, totalBytes: totalPages * pageSize }); }
      catch (error) { progressError ??= error; }
    } });
    if (progressError) throw progressError;
    progress({ step: 'sqlite_snapshot', bytes: totalPages * pageSize, totalBytes: totalPages * pageSize });
  } finally { db.close(); }
  const saved = new DatabaseSync(snapshot);
  try {
    // Only the private snapshot is changed. Its final copy must be standalone.
    requireValue(saved.prepare('PRAGMA journal_mode=DELETE').get().journal_mode === 'delete',
      'upgrade_backup_failed', 'Cannot make a standalone backup snapshot');
    checkIdentity(saved, expected);
  } finally { saved.close(); }
  standalone(snapshot);
  const before = lstatSync(snapshot, { bigint: true }), hash = createHash('sha256');
  let bytes = 0;
  progress({ step: 'backup_copy', bytes, totalBytes: Number(before.size) });
  await pipeline(createReadStream(snapshot, { highWaterMark: bufferSize }), new Transform({
    transform(chunk, encoding, callback) {
      try {
        hash.update(chunk); bytes += chunk.length;
        progress({ step: 'backup_copy', bytes, totalBytes: Number(before.size) }); callback(null, chunk);
      } catch (error) { callback(error); }
    },
  }), createWriteStream(copy, { flags: 'wx', mode: 0o600, flush: true }));
  requireValue(unchanged(before, lstatSync(snapshot, { bigint: true })) && bytes === Number(before.size),
    'upgrade_backup_failed', 'Snapshot changed while copying');
  const sha256 = hash.digest('hex'), actual = await checksum(copy, progress, 'backup_checksum');
  requireValue(actual.bytes === bytes && actual.sha256 === sha256, 'upgrade_backup_failed', 'Copied backup checksum differs');
  // Do not publish a partial copy or overwrite a retained backup. Interrupted
  // scratch files remain private evidence and are never accepted as completed.
  linkSync(copy, destination);
  writePrivateJson(receiptPath, { format: 1, source: resolve(source), identity: expected, bytes, sha256 }, true);
  unlinkSync(copy); unlinkSync(snapshot);
  return { bytes, sha256, reused: false };
}
