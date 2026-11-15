import assert from 'node:assert/strict';
import test from 'node:test';
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { upgradeDatabaseBackup, upgradeBackupSpace } = await import(process.env.RELAY_PACKAGE_DIRECTORY
  ? pathToFileURL(join(resolve(process.env.RELAY_PACKAGE_DIRECTORY), 'src/upgrade-backup.mjs')).href
  : new URL('../src/upgrade-backup.mjs', import.meta.url).href);

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(t, { role = 'backend', large = false } = {}) {
  const root = mkdtempSync('/tmp/opencode/upgrade-backup-'), source = join(root, 'source.sqlite'), destination = join(root, 'backup.sqlite');
  const db = new DatabaseSync(source);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=${role === 'backend' ? 2 : 1};
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE payload (id TEXT PRIMARY KEY, data BLOB);`);
  db.prepare('INSERT INTO settings VALUES (?,?)').run(role === 'backend' ? 'instance' : 'identity', role === 'backend' ? 'instance' : JSON.stringify({ instanceId: 'instance', nodeId: 'node' }));
  db.prepare('INSERT INTO payload VALUES (?,zeroblob(?))').run('committed', large ? 24 * 1024 * 1024 : 65536);
  const input = { source, destination, role, schema: role === 'backend' ? 2 : 1, instanceId: 'instance', nodeId: role === 'node' ? 'node' : null };
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, source, destination, input, receipt: `${destination}.verification.json` };
}

for (const role of ['backend', 'node']) test(`${role} snapshot includes committed WAL data, excludes uncommitted writes and verifies the copied SHA-256`, async t => {
  const f = fixture(t, { role }), progress = [];
  assert.ok(statSync(`${f.source}-wal`).size > 0);
  f.db.exec("BEGIN IMMEDIATE; INSERT INTO payload VALUES ('uncommitted','must not enter backup')");
  const result = await upgradeDatabaseBackup({ ...f.input, progress: value => progress.push(value) });
  f.db.exec('ROLLBACK');
  const saved = new DatabaseSync(f.destination, { readOnly: true });
  try {
    assert.deepEqual(saved.prepare('SELECT id FROM payload ORDER BY id').all().map(row => row.id), ['committed']);
    assert.equal(saved.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(saved.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  } finally { saved.close(); }
  assert.equal(result.sha256, sha(f.destination)); assert.equal(result.bytes, statSync(f.destination).size);
  assert.equal(statSync(f.destination).mode & 0o777, 0o600); assert.equal(statSync(f.receipt).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(f.receipt)).sha256, result.sha256);
  for (const step of ['sqlite_snapshot', 'backup_copy', 'backup_checksum']) {
    const events = progress.filter(value => value.step === step);
    assert.ok(events.length); assert.equal(events.at(-1).bytes, events.at(-1).totalBytes);
  }
  assert.ok(!readdirSync(f.root).some(name => /\.(copy|snapshot)-/.test(name)));
});

test('one pinned WAL read snapshot does not restart or include writes committed through another connection during backup', async t => {
  const f = fixture(t, { large: true }); let wrote = false;
  const result = await upgradeDatabaseBackup({ ...f.input, progress: value => {
    if (value.step === 'sqlite_snapshot' && !wrote) { wrote = true; f.db.exec("INSERT INTO payload VALUES ('after-snapshot','preserve in source only')"); }
  } });
  assert.equal(wrote, true); assert.equal(result.reused, false);
  const saved = new DatabaseSync(f.destination, { readOnly: true });
  try { assert.equal(saved.prepare("SELECT 1 FROM payload WHERE id='after-snapshot'").get(), undefined); }
  finally { saved.close(); }
  assert.ok(f.db.prepare("SELECT 1 FROM payload WHERE id='after-snapshot'").get());
});

test('checksum receipts allow exact retries without another SQLite backup and detect later changed bytes without overwriting them', async t => {
  const f = fixture(t), first = await upgradeDatabaseBackup(f.input), steps = [];
  const second = await upgradeDatabaseBackup({ ...f.input, progress: value => steps.push(value.step) });
  assert.deepEqual(second, { ...first, reused: true }); assert.ok(steps.every(step => step === 'backup_checksum'));
  const original = readFileSync(f.destination), changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
  writeFileSync(f.destination, changed);
  await assert.rejects(upgradeDatabaseBackup(f.input), { code: 'upgrade_backup_failed' });
  assert.deepEqual(readFileSync(f.destination), changed);
});

test('a changed copied byte is refused before a backup or checksum receipt can be published', async t => {
  const f = fixture(t, { large: true }); let corrupted = false;
  await assert.rejects(upgradeDatabaseBackup({ ...f.input, progress: value => {
    if (value.step === 'backup_copy' && value.bytes >= 8 * 1024 * 1024 && !corrupted) {
      const path = join(f.root, readdirSync(f.root).find(name => name.startsWith('backup.sqlite.copy-')));
      const data = readFileSync(path);
      if (data.length) { corrupted = true; data[data.length - 1] ^= 1; writeFileSync(path, data); }
    }
  } }), { code: 'upgrade_backup_failed' });
  assert.equal(corrupted, true);
  assert.equal(existsSync(f.destination), false); assert.equal(existsSync(f.receipt), false);
  assert.ok(readdirSync(f.root).some(name => name.startsWith('backup.sqlite.copy-')));
});

test('an interrupted copy retains private scratch evidence but never becomes a completed backup or blocks a clean retry', async t => {
  const f = fixture(t, { large: true });
  await assert.rejects(upgradeDatabaseBackup({ ...f.input, progress: value => {
    if (value.step === 'backup_copy' && value.bytes > 0) throw Error('Fixture copy interrupted');
  } }), /Fixture copy interrupted/);
  assert.equal(existsSync(f.destination), false); assert.equal(existsSync(f.receipt), false);
  const evidence = readdirSync(f.root).filter(name => /\.(copy|snapshot)-/.test(name));
  assert.ok(evidence.length);
  assert.equal((await upgradeDatabaseBackup(f.input)).reused, false);
  assert.ok(evidence.every(name => existsSync(join(f.root, name))));
});

test('pre-0.2.10 backups receive one linear legacy check and checksum receipt, not another copy or repeated SQL verification', async t => {
  const f = fixture(t); await backup(f.db, f.destination);
  const before = sha(f.destination), steps = [];
  const first = await upgradeDatabaseBackup({ ...f.input, progress: value => steps.push(value.step) });
  const second = await upgradeDatabaseBackup({ ...f.input, progress: value => steps.push(value.step) });
  assert.equal(first.reused, true); assert.equal(second.sha256, before); assert.equal(sha(f.destination), before);
  assert.equal(steps.filter(step => step === 'legacy_backup_check').length, 1);
  assert.ok(!steps.includes('sqlite_snapshot'));
});

test('unverified partial files, foreign identities, missing verified files and symlink substitutions are never accepted or overwritten', async t => {
  const partial = fixture(t); writeFileSync(partial.destination, 'interrupted sqlite backup');
  await assert.rejects(upgradeDatabaseBackup(partial.input));
  assert.equal(readFileSync(partial.destination, 'utf8'), 'interrupted sqlite backup'); assert.equal(existsSync(partial.receipt), false);
  const foreign = fixture(t);
  await assert.rejects(upgradeDatabaseBackup({ ...foreign.input, instanceId: 'another-instance' }), { code: 'upgrade_backup_failed' });
  assert.equal(existsSync(foreign.destination), false);
  const missing = fixture(t); await upgradeDatabaseBackup(missing.input); rmSync(missing.destination);
  await assert.rejects(upgradeDatabaseBackup(missing.input), { code: 'upgrade_backup_failed' });
  const linked = fixture(t); symlinkSync(linked.source, linked.destination);
  await assert.rejects(upgradeDatabaseBackup(linked.input), { code: 'upgrade_backup_failed' });
});

test('preflight accounts for the live WAL snapshot size and space for both snapshot and verified copy before any backup is started', t => {
  const f = fixture(t), bytes = f.db.prepare('PRAGMA page_count').get().page_count * f.db.prepare('PRAGMA page_size').get().page_size;
  assert.ok(bytes > statSync(f.source).size, 'Fixture data must still be in the WAL');
  assert.throws(() => upgradeBackupSpace([{ database: f.source, role: 'backend' }], f.root,
    { statfs: () => ({ bsize: 1n, bavail: BigInt(bytes) }) }), { code: 'upgrade_disk_space' });
  assert.equal(existsSync(f.destination), false);
  const plan = upgradeBackupSpace([{ database: f.source, role: 'backend' }], f.root,
    { statfs: () => ({ bsize: 1n, bavail: 100n * 1024n * 1024n }) });
  assert.equal(plan.requiredBytes, 2 * bytes);
});
