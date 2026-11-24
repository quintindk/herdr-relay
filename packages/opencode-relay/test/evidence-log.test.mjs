import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { createEvidenceRecorder } from '../evidence-log.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'human-inbox.jsonl');
}
const events = file => readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
const writePrivate = (file, data) => writeFileSync(file, data, { mode: 0o600 });
const lockFor = file => join(dirname(file), `.${basename(file)}.lock`);

test('evidence logs render transitions and never deduplicates action or lifecycle events', t => {
  const file = fixture(t), record = createEvidenceRecorder(file, { clientId: 'client' });
  const sidebar = sessionId => ({ type: 'attachment_sidebar_rendered', sessionId });
  const clock = (slot, time) => ({ type: 'status_clock_rendered', slot, time });
  const attachment = (sessionId, state) => ({ type: 'attachment_sidebar', sessionId, state });
  const first = [sidebar('a'), clock('home', '08:30'), clock('prompt', '08:30'), attachment('a', 'checking')];
  const transitions = [sidebar('b'), sidebar('a'), clock('home', '08:31'), attachment('a', 'attached'), attachment('b', 'attached')];
  const lifecycle = ['loaded', 'rpc', 'notification', 'human_decision', 'receiver_attached', 'disposed', 'attachment_sidebar_unavailable'];
  for (const event of [...first, ...first]) record(event);
  for (const event of transitions) { record(event); record(event); }
  record(clock('prompt', '08:30'));
  for (const type of lifecycle) { record({ type }); record({ type }); }
  assert.deepEqual(events(file), [...first, ...transitions, ...lifecycle.flatMap(type => [{ type }, { type }])]
    .map(event => ({ ...event, clientId: 'client' })));
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('evidence replaces the previous rotation and bounds both files', t => {
  const file = fixture(t), rotated = `${file}.1`, lineSize = Buffer.byteLength('{"type":"rpc","attempt":0}\n');
  const maxBytes = 2 * lineSize, record = createEvidenceRecorder(file, { maxBytes });
  for (let attempt = 0; attempt < 5; attempt++) record({ type: 'rpc', attempt });
  assert.deepEqual(events(rotated).map(event => event.attempt), [2, 3]);
  assert.deepEqual(events(file).map(event => event.attempt), [4]);
  assert.ok(statSync(file).size + statSync(rotated).size <= 2 * maxBytes);
});

test('the first rotation of a pre-existing oversized log retains a bounded complete tail', t => {
  const file = fixture(t), rotated = `${file}.1`, lineSize = Buffer.byteLength('{"type":"rpc","attempt":9}\n');
  const maxBytes = 2 * lineSize + 4;
  writePrivate(file, Array.from({ length: 10 }, (_, attempt) => `${JSON.stringify({ type: 'rpc', attempt })}\n`).join(''));
  createEvidenceRecorder(file, { maxBytes })({ type: 'loaded' });
  assert.deepEqual(events(rotated).map(event => event.attempt), [8, 9]);
  assert.deepEqual(events(file), [{ type: 'loaded' }]);
  assert.ok(statSync(file).size + statSync(rotated).size <= 2 * maxBytes);
});

test('archive exactly one byte over the cap is trimmed even when all lines are valid', t => {
  const file = fixture(t), archive = `${file}.1`, lines = [{ text: 'a'.repeat(18) }, { text: 'b'.repeat(18) }];
  writePrivate(archive, lines.map(line => `${JSON.stringify(line)}\n`).join(''));
  assert.equal(statSync(archive).size, 60);
  createEvidenceRecorder(file, { maxBytes: 59 })({ type: 'loaded' });
  assert.ok(statSync(archive).size <= 59);
  assert.deepEqual(events(archive), [lines[1]]);
  assert.deepEqual(events(file), [{ type: 'loaded' }]);
});

test('evidence refuses symlinked active or rotated files without changing their target', t => {
  const file = fixture(t), target = `${file}.target`;
  writeFileSync(target, 'do not touch');
  symlinkSync(target, file);
  createEvidenceRecorder(file)({ type: 'loaded' });
  assert.equal(readFileSync(target, 'utf8'), 'do not touch');
  assert.equal(existsSync(`${file}.1`), false);

  const active = `${file}.active`, rotated = `${active}.1`;
  writePrivate(active, 'x'.repeat(32));
  symlinkSync(target, rotated);
  createEvidenceRecorder(active, { maxBytes: 32 })({ type: 'loaded' });
  assert.equal(readFileSync(active, 'utf8'), 'x'.repeat(32));
  assert.equal(readFileSync(rotated, 'utf8'), 'do not touch');
});

test('evidence is non-fatal when disabled, unavailable or given a non-regular file', t => {
  const file = fixture(t);
  createEvidenceRecorder()({ type: 'disposed' });
  createEvidenceRecorder(`${file}/missing/parent`)({ type: 'disposed' });
  createEvidenceRecorder(join(file, '..'))({ type: 'disposed' });
  assert.equal(existsSync(file), false);
});

test('evidence refuses non-private or multiply linked active and archive files without changing them', t => {
  const file = fixture(t), existing = '{"type":"existing"}\n';
  for (const suffix of ['', '.1']) {
    const publicLog = `${file}.public${suffix ? '-archive' : '-active'}`, publicPath = `${publicLog}${suffix}`;
    writePrivate(publicPath, existing); chmodSync(publicPath, 0o644);
    createEvidenceRecorder(publicLog)({ type: 'loaded' });
    assert.equal(readFileSync(publicPath, 'utf8'), existing);
    assert.equal(statSync(publicPath).mode & 0o7777, 0o644);
    if (suffix) assert.equal(existsSync(publicLog), false);

    const linkedLog = `${file}.linked${suffix ? '-archive' : '-active'}`, alias = `${linkedLog}.alias`, linkedPath = `${linkedLog}${suffix}`;
    writePrivate(alias, existing); linkSync(alias, linkedPath);
    createEvidenceRecorder(linkedLog)({ type: 'loaded' });
    assert.equal(readFileSync(alias, 'utf8'), existing);
    assert.equal(statSync(alias).nlink, 2);
    if (suffix) assert.equal(existsSync(linkedLog), false);
  }
});

test('evidence refuses symlinked ancestors and non-sticky writable parents', t => {
  const base = dirname(fixture(t)), target = join(base, 'target'), safe = join(target, 'safe'), symlink = join(base, 'link');
  mkdirSync(safe, { recursive: true, mode: 0o700 }); symlinkSync(target, symlink);
  createEvidenceRecorder(join(symlink, 'safe', 'evidence.jsonl'))({ type: 'loaded' });
  assert.equal(existsSync(join(safe, 'evidence.jsonl')), false);

  const writable = join(base, 'writable'); mkdirSync(writable); chmodSync(writable, 0o777);
  createEvidenceRecorder(join(writable, 'evidence.jsonl'))({ type: 'loaded' });
  assert.equal(existsSync(join(writable, 'evidence.jsonl')), false);
  assert.equal(statSync(writable).mode & 0o7777, 0o777);
});

test('concurrent recorders recover after a lock holder is killed and rotate across the exact size boundary', async t => {
  const file = fixture(t), archive = `${file}.1`, lock = lockFor(file);
  const example = { type: 'rpc', clientId: 'a', i: '00' }, maxBytes = 8 * Buffer.byteLength(`${JSON.stringify(example)}\n`);
  const seed = createEvidenceRecorder(file, { clientId: 's', maxBytes });
  for (let i = 0; i < 8; i++) seed({ type: 'rpc', i: String(i).padStart(2, '0') });
  assert.equal(statSync(file).size, maxBytes);
  const identity = statSync(lock);
  assert.equal(identity.mode & 0o7777, 0o600);
  assert.equal(identity.nlink, 1);

  const child = (code, ...args) => {
    const processHandle = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], timeout: 10000 });
    const closed = once(processHandle, 'exit');
    t.after(async () => { if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGKILL'); await closed; });
    const message = () => Promise.race([once(processHandle, 'message').then(([value]) => value),
      closed.then(([code, signal]) => { throw Error(`Child exited before its signal: ${code ?? signal}`); })]);
    return { processHandle, closed, message };
  };
  const holder = child(`
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
    process.send('locked');
    process.on('message', () => {});`, lock);
  assert.equal(await holder.message(), 'locked');
  const url = new URL('../evidence-log.mjs', import.meta.url).href;
  const writer = `
    import { createEvidenceRecorder } from ${JSON.stringify(url)};
    const [file, id, maxBytes] = process.argv.slice(1);
    const record = createEvidenceRecorder(file, { clientId: id, maxBytes: Number(maxBytes) });
    process.once('message', () => {
      process.send('writing');
      for (let i = 0; i < 8; i++) record({ type: 'rpc', i: String(i).padStart(2, '0') });
      process.disconnect();
    });
    process.send('ready');`;
  const writers = ['a', 'b'].map(id => child(writer, file, id, String(maxBytes)));
  assert.deepEqual(await Promise.all(writers.map(writer => writer.message())), ['ready', 'ready']);
  const starting = Promise.all(writers.map(writer => writer.message()));
  for (const writer of writers) writer.processHandle.send('go');
  assert.deepEqual(await starting, ['writing', 'writing']);
  assert.equal(statSync(lock).ino, identity.ino);
  assert.deepEqual(events(file).map(event => event.clientId), Array(8).fill('s'));
  holder.processHandle.kill('SIGKILL');
  assert.deepEqual(await holder.closed, [null, 'SIGKILL']);
  assert.deepEqual(await Promise.all(writers.map(writer => writer.closed)), [[0, null], [0, null]]);

  assert.equal(statSync(file).size, maxBytes);
  assert.equal(statSync(archive).size, maxBytes);
  const retained = [file, archive].flatMap(events);
  assert.equal(retained.length, 16);
  assert.ok(retained.every(event => event && typeof event === 'object' && !Array.isArray(event) && ['a', 'b'].includes(event.clientId)));
  assert.equal(new Set(retained.map(({ clientId, i }) => `${clientId}:${i}`)).size, 16);
  assert.equal(statSync(lock).ino, identity.ino);
  assert.equal(statSync(lock).size, 0);
  assert.deepEqual(readdirSync(dirname(file)).sort(), [lock, file, archive].map(path => basename(path)).sort());
});

test('archive drops invalid JSON, primitive values and partial records in the retained window', t => {
  const file = fixture(t), archive = `${file}.1`, maxBytes = 96;
  writePrivate(file, `${'{"type":"old"}\n'.repeat(200)}{"type":"valid-one"}\ninvalid JSON\n[1]\nnull\n{"type":"valid-two"}\n{"torn":`);
  createEvidenceRecorder(file, { maxBytes })({ type: 'loaded' });
  const retained = events(archive);
  assert.ok(statSync(archive).size <= maxBytes);
  assert.ok(retained.every(event => event && typeof event === 'object' && !Array.isArray(event)));
  assert.deepEqual(retained.slice(-2), [{ type: 'valid-one' }, { type: 'valid-two' }]);
  assert.deepEqual(events(file), [{ type: 'loaded' }]);
});

test('evidence repairs a torn active tail before appending', t => {
  const file = fixture(t);
  writePrivate(file, '{"type":"existing"}\n{"type":"torn"');
  createEvidenceRecorder(file)({ type: 'loaded' });
  assert.deepEqual(events(file), [{ type: 'existing' }, { type: 'loaded' }]);
  assert.equal(existsSync(`${file}.1`), false);
});
