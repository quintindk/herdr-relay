import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import React from 'react';
import { render } from 'ink-testing-library';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { nativeWorkerApi } from '../src/native-worker-api.mjs';
import { nativeBoard } from '../src/native-board.mjs';
import { TaskBoardInkApp } from '../src/task-board-ink.mjs';
import { attachTaskFile, downloadTaskAttachment } from '../src/task-attachments-cli.mjs';
import { call, callDownloadStream } from '../src/client.mjs';
import { runRelayCli } from '../packages/opencode-relay/cli-bridge.mjs';
import { FilesystemBlobStore, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_TASK, MemoryBlobStore } from '../src/task-attachments.mjs';
import { identityFingerprint, serviceIdentity } from '../src/upgrade-safety.mjs';
import { digest } from '../src/protocol.mjs';
import { attachmentReceiptPath } from '../src/attachment-transport.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const blobRoute = digest => `/v1/blobs/${digest}`;
const contentRoute = a => `/v1/tasks/${a.taskId}/attachments/${a.id}/content`;
const attachment = (taskId, bytes, others = {}) => ({ taskId, name: 'report.bin', sha256: sha(bytes), size: bytes.length, ...others });
const detach = a => ({ id: a.id, taskId: a.taskId, expectedRevision: a.revision });
const rootDirectory = () => mkdtempSync('/tmp/opencode/relay-attachments-');

async function fixture(t, options = {}) {
  const root = rootDirectory(), database = join(root, 'backend.sqlite');
  const maintenanceFile = join(root, 'maintenance.json');
  const backend = await startBackend({ database, maintenanceFile, ...options });
  t.after(async () => { await backend.close(); rmSync(root, { recursive: true, force: true }); });
  const { store, origin } = backend;
  const owner = store.bootstrap().token;
  const api = (path, { token = owner, headers, ...init } = {}) => fetch(`${origin}${path}`, {
    ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });
  const post = (path, body, token) => api(path, { token, method: 'POST', body: JSON.stringify(body) });
  const command = (key, action, payload, token) => post('/v1/commands', { key, action, payload }, token);
  const create = id => ok(command(`create-${id}`, 'task.create', { id, title: id }));
  const upload = (body, { digest = sha(body), ...init } = {}) => api(blobRoute(digest), { method: 'PUT', body, ...init });
  const blobPath = digest => join(root, 'blobs', digest.slice(0, 2), digest);
  return { root, database, maintenanceFile, store, origin, owner, api, post, command, create, upload, blobPath, tmp: join(root, 'blobs', '.tmp') };
}

async function ok(response) {
  const res = await response, value = await res.json();
  assert.equal(res.status, 200, JSON.stringify(value));
  return value;
}

async function refused(response, status, code) {
  const res = await response, value = await res.json();
  assert.equal(res.status, status, JSON.stringify(value));
  assert.equal(value.code, code);
}

function rawPut(f, digest, headers, send) {
  return new Promise((resolve, reject) => {
    const req = request(`${f.origin}${blobRoute(digest)}`, { method: 'PUT', headers: { Authorization: `Bearer ${f.owner}`, ...headers } }, async res => {
      try { resolve({ status: res.statusCode, body: JSON.parse((await buffer(res)).toString()) }); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.setTimeout(2500, () => req.destroy(new Error('Backend did not reject the upload without waiting for the body')));
    send(req);
  });
}

test('streams binary uploads and downloads on disk, deduplicates and sweeps only stale regular files', async t => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(196700, 0xfb);
  const p = attachment('one', bytes, { name: 'réport".html', mimeType: 'text/html' });
  const res = await f.upload(bytes, { body: Readable.from([bytes.subarray(0, 65000), bytes.subarray(65000)]), duplex: 'half' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ok(res), { sha256: p.sha256, size: p.size, existed: false });
  assert.equal(statSync(f.blobPath(p.sha256)).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.root, 'blobs', p.sha256.slice(0, 2))).mode & 0o777, 0o700);
  assert.deepEqual(readFileSync(f.blobPath(p.sha256)), bytes);
  assert.deepEqual(await ok(f.upload(bytes)), { sha256: p.sha256, size: p.size, existed: true });
  assert.deepEqual(readdirSync(f.tmp), []);
  const info = await ok(f.api('/v1/info'));
  assert.equal(info.features.taskAttachments, true);
  assert.equal(info.protocol, 'relay/0.2');
  assert.equal(info.compatibility.backendSchema, 2);
  assert.equal(info.compatibility.nodeSchema, 1);

  await f.create('one');
  const a = await ok(f.command('attach', 'task.attach', p));
  assert.equal(a.mimeType, 'text/html');
  const content = await f.api(contentRoute(a));
  assert.equal(content.status, 200);
  for (const [name, value] of Object.entries({ 'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
    'x-content-sha256': p.sha256, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
    'content-disposition': 'attachment; filename="r_port_.html"' })) assert.equal(content.headers.get(name), value);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
  await refused(f.api(`${contentRoute(a)}?extra=1`), 400, 'invalid_query');
  await refused(f.api(`/v1/tasks/not-one/attachments/${a.id}/content`), 404, 'not_found');

  writeFileSync(join(f.tmp, 'stale'), 'partial upload');
  symlinkSync(f.blobPath(p.sha256), join(f.tmp, 'symlink'));
  mkdirSync(join(f.tmp, 'directory'));
  const restarted = new FilesystemBlobStore(join(f.root, 'blobs'));
  t.after(() => restarted.close());
  assert.deepEqual(readdirSync(f.tmp).sort(), ['directory', 'symlink']);
  assert.deepEqual(restarted.stat(p.sha256), { size: p.size });
  assert.deepEqual(readFileSync(f.blobPath(p.sha256)), bytes);
});

test('both stores validate expected size, streaming limits, hashes and zero-byte content', async t => {
  const root = rootDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const store of [new FilesystemBlobStore(root), new MemoryBlobStore()]) {
    t.after(() => store.close());
    const bytes = Buffer.alloc(1025, 0xad), hash = sha(bytes);
    const put = (digest, data, options) => store.putStream(digest, Readable.from(data), options);
    await assert.rejects(put(hash, [bytes], { expectedSize: 1025, maxBytes: 1024 }), { status: 413, code: 'blob_too_large' });
    await assert.rejects(put(hash, [bytes.subarray(0, 1024), bytes.subarray(1024)], { maxBytes: 1024 }), { status: 413, code: 'blob_too_large' });
    for (const invalid of [-1, 1.5, '1025', NaN]) await assert.rejects(put(hash, [bytes], { expectedSize: invalid }), { status: 400, code: 'invalid_attachment' });
    for (const mismatch of [0, 1026]) await assert.rejects(put(hash, [bytes], { expectedSize: mismatch }), { status: 400, code: 'blob_size_mismatch' });
    await assert.rejects(put(sha('other'), [bytes]), { status: 400, code: 'blob_digest_mismatch' });
    assert.equal(store.stat(hash), null);

    const empty = sha('');
    assert.deepEqual(await put(empty, [], { expectedSize: 0 }), { sha256: empty, size: 0, existed: false });
    assert.deepEqual(store.stat(empty), { size: 0 });
    const { stream, size } = store.openReadStream(empty);
    assert.equal(size, 0);
    assert.deepEqual(await buffer(stream), Buffer.alloc(0));
    assert.deepEqual(await put(empty, []), { sha256: empty, size: 0, existed: true });
    store.removeIfExists(empty);
    store.removeIfExists(empty);
    assert.throws(() => store.openReadStream(empty), { status: 404, code: 'blob_missing' });
  }
  assert.deepEqual(readdirSync(join(root, '.tmp')), []);
});

test('HTTP upload refuses oversized headers and chunked bodies without waiting for more input', async t => {
  const f = await fixture(t);
  const digest = sha('irrelevant');
  assert.deepEqual(await rawPut(f, digest, { 'Content-Length': String(MAX_ATTACHMENT_BYTES + 1) }, req => req.flushHeaders()), {
    status: 413, body: { code: 'blob_too_large', message: 'Attachment exceeds the size limit' },
  });
  const putStream = f.store.blobs.putStream.bind(f.store.blobs);
  f.store.blobs.putStream = (hash, stream, options) => putStream(hash, stream, { ...options, maxBytes: 1024 });
  const chunked = await rawPut(f, digest, { 'Transfer-Encoding': 'chunked' }, req => {
    req.write(Buffer.alloc(1024));
    req.write(Buffer.alloc(1));
  });
  assert.equal(chunked.status, 413);
  assert.equal(chunked.body.code, 'blob_too_large');
  await refused(f.upload(Buffer.from('wrong'), { digest }), 400, 'blob_digest_mismatch');
  await refused(f.upload(Buffer.from('wrong'), { digest: digest.toUpperCase() }), 400, 'invalid_attachment');
  assert.equal(existsSync(f.blobPath(digest)), false);
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('the production streaming limit accepts exactly 64 MiB and refuses 64 MiB plus one byte', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const slice = Buffer.alloc(1024 * 1024), count = MAX_ATTACHMENT_BYTES / slice.length;
  const hash = createHash('sha256');
  for (let i = 0; i < count; i++) hash.update(slice);
  const digest = hash.digest('hex');
  const body = (extra = false) => Readable.from((function* () {
    for (let i = 0; i < count; i++) yield slice;
    if (extra) yield slice.subarray(0, 1);
  })());
  const put = (hash, body) => f.api(blobRoute(hash), { method: 'PUT', body, duplex: 'half' });
  assert.deepEqual(await ok(put(digest, body())), { sha256: digest, size: MAX_ATTACHMENT_BYTES, existed: false });
  assert.equal(statSync(f.blobPath(digest)).size, MAX_ATTACHMENT_BYTES);
  const oversizedDigest = sha('over the limit');
  await refused(put(oversizedDigest, body(true)), 413, 'blob_too_large');
  assert.equal(existsSync(f.blobPath(oversizedDigest)), false);
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('aborted upload clears its temp file and the backend keeps serving', async t => {
  const f = await fixture(t);
  const putStream = f.store.blobs.putStream.bind(f.store.blobs);
  const entered = Promise.withResolvers(), completed = Promise.withResolvers();
  f.store.blobs.putStream = (hash, stream, options) => {
    const put = putStream(hash, stream, options);
    entered.resolve();
    put.then(completed.resolve, completed.reject);
    return put;
  };
  const bytes = Buffer.from('upload aborted before the client sent everything');
  const req = request(`${f.origin}${blobRoute(sha(bytes))}`, { method: 'PUT', headers: {
    Authorization: `Bearer ${f.owner}`, 'Content-Length': String(bytes.length),
  } });
  req.on('error', () => {});
  req.write(bytes.subarray(0, 12));
  await entered.promise;
  const failed = assert.rejects(completed.promise);
  req.destroy();
  await failed;
  assert.deepEqual(readdirSync(f.tmp), []);
  assert.equal(f.store.blobs.stat(sha(bytes)), null);
  assert.equal((await ok(f.api('/v1/info'))).features.taskAttachments, true);
});

test('aborting a streamed download closes the file and leaves the backend available', { timeout: 5000 }, async t => {
  const f = await fixture(t), bytes = Buffer.alloc(8 * 1024 * 1024, 0x7a);
  await f.create('one');
  await ok(f.upload(bytes));
  const a = await ok(f.command('attach', 'task.attach', attachment('one', bytes)));
  const open = f.store.blobs.openReadStream.bind(f.store.blobs), closed = Promise.withResolvers();
  f.store.blobs.openReadStream = hash => {
    const blob = open(hash);
    blob.stream.once('close', () => closed.resolve(blob.stream.bytesRead));
    return blob;
  };
  await new Promise((resolve, reject) => {
    const req = request(`${f.origin}${contentRoute(a)}`, { headers: { Authorization: `Bearer ${f.owner}` } }, res => {
      res.on('error', reject);
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', reject);
    req.end();
  });
  assert.ok(await closed.promise < bytes.length);
  assert.equal((await ok(f.api('/v1/info'))).features.taskAttachments, true);
});

test('rejects blob and shard symlinks without following or deleting their targets', async t => {
  const f = await fixture(t), bytes = Buffer.from('contents');
  const p = attachment('one', bytes), blobPath = f.blobPath(p.sha256);
  const shard = join(f.root, 'blobs', p.sha256.slice(0, 2));
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  const target = join(outside, p.sha256);
  writeFileSync(target, bytes);
  mkdirSync(shard, { mode: 0o700 });
  symlinkSync(target, blobPath);
  await f.create('one');
  await refused(f.upload(bytes), 500, 'blob_invalid');
  await refused(f.command('symlink-file', 'task.attach', p), 500, 'blob_invalid');
  assert.throws(() => f.store.blobs.openReadStream(p.sha256), { code: 'blob_invalid' });
  assert.throws(() => f.store.blobs.removeIfExists(p.sha256), { code: 'blob_invalid' });
  assert.ok(existsSync(blobPath));
  unlinkSync(blobPath);
  rmSync(shard, { recursive: true });
  symlinkSync(outside, shard);
  await refused(f.upload(bytes), 500, 'blob_invalid');
  await refused(f.command('symlink-shard', 'task.attach', p), 500, 'blob_invalid');
  assert.throws(() => f.store.blobs.removeIfExists(p.sha256), { code: 'blob_invalid' });
  assert.deepEqual(readFileSync(target), bytes);
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('rejects incorrect modes on blob roots, temporary directories, shards and existing files without changing them', async t => {
  const f = await fixture(t), bytes = Buffer.from('private contents'), p = attachment('one', bytes);
  const loose = join(f.root, 'loose');
  mkdirSync(loose);
  for (const wrongMode of [0o755, 0o2700]) {
    chmodSync(loose, wrongMode);
    assert.throws(() => new FilesystemBlobStore(loose), { status: 500, code: 'blob_invalid' });
    assert.equal(statSync(loose).mode & 0o7777, wrongMode);
  }
  assert.equal(existsSync(join(loose, '.tmp')), false);

  await f.create('one');
  await ok(f.upload(bytes));
  const a = await ok(f.command('attach', 'task.attach', p));
  const path = f.blobPath(p.sha256), root = join(f.root, 'blobs'), shard = join(root, p.sha256.slice(0, 2));
  for (const [entry, wrongMode, privateMode] of [
    [root, 0o755, 0o700], [shard, 0o755, 0o700], [shard, 0o2700, 0o700],
    [path, 0o644, 0o600], [path, 0o700, 0o600], [path, 0o4600, 0o600],
  ]) {
    chmodSync(entry, wrongMode);
    await refused(f.upload(bytes), 500, 'blob_invalid');
    await refused(f.command('private-required', 'task.attach', p), 500, 'blob_invalid');
    await refused(f.api(contentRoute(a)), 500, 'blob_invalid');
    assert.throws(() => f.store.blobs.removeIfExists(p.sha256), { status: 500, code: 'blob_invalid' });
    assert.equal(statSync(entry).mode & 0o7777, wrongMode);
    chmodSync(entry, privateMode);
  }
  chmodSync(f.tmp, 0o755);
  assert.throws(() => new FilesystemBlobStore(root), { status: 500, code: 'blob_invalid' });
  await refused(f.upload(bytes), 500, 'blob_invalid');
  assert.throws(() => f.store.blobs.removeIfExists(p.sha256), { status: 500, code: 'blob_invalid' });
  assert.equal(statSync(f.tmp).mode & 0o777, 0o755);
  assert.deepEqual(readFileSync(path), bytes);
});

test('a permissive parent is rejected before creating any blob directories', t => {
  const parent = rootDirectory();
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  chmodSync(parent, 0o755);
  for (const path of [join(parent, 'blobs'), join(parent, 'nested', 'blobs')]) {
    assert.throws(() => new FilesystemBlobStore(path), { status: 500, code: 'blob_invalid' });
  }
  assert.deepEqual(readdirSync(parent), []);
  assert.equal(statSync(parent).mode & 0o7777, 0o755);
});

test('new blob directories clear inherited setgid without changing their parent', async t => {
  const root = rootDirectory(), directory = join(root, 'nested', 'blobs');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o2700);
  const store = new FilesystemBlobStore(directory);
  t.after(() => store.close());
  const bytes = Buffer.from('setgid parent'), digest = sha(bytes);
  await store.putStream(digest, Readable.from([bytes]));
  for (const path of [join(root, 'nested'), directory, join(directory, '.tmp'), join(directory, digest.slice(0, 2))]) {
    assert.equal(statSync(path).mode & 0o7777, 0o700);
  }
  assert.equal(statSync(root).mode & 0o7777, 0o2700);
});

test('creation does not chmod a new directory with an unexpected mode', t => {
  const parent = rootDirectory(), directory = join(parent, 'blobs');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  // Mask owner-write on a new child to distinguish refusal from normalisation.
  const previous = process.umask(0o277);
  try { assert.throws(() => new FilesystemBlobStore(directory), { status: 500, code: 'blob_invalid' }); }
  finally { process.umask(previous); }
  assert.equal(statSync(directory).mode & 0o7777, 0o500);
  assert.equal(existsSync(join(directory, '.tmp')), false);
});

test('post-start root and temporary symlinks are refused without touching their targets', async t => {
  const f = await fixture(t), bytes = Buffer.from('private contents'), p = attachment('one', bytes);
  const outside = join(f.root, 'outside'), root = join(f.root, 'blobs'), shard = p.sha256.slice(0, 2);
  mkdirSync(join(outside, shard), { recursive: true, mode: 0o700 });
  const target = join(outside, shard, p.sha256);
  writeFileSync(target, 'untouched', { mode: 0o600 });

  await f.create('one');
  await ok(f.upload(bytes));
  const a = await ok(f.command('attach', 'task.attach', p));
  renameSync(root, `${root}-original`);
  symlinkSync(outside, root);
  await refused(f.upload(bytes), 500, 'blob_invalid');
  await refused(f.api(contentRoute(a)), 500, 'blob_invalid');
  assert.throws(() => f.store.blobs.stat(p.sha256), { status: 500, code: 'blob_invalid' });
  assert.throws(() => f.store.blobs.removeIfExists(p.sha256), { status: 500, code: 'blob_invalid' });
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  assert.equal(existsSync(join(outside, '.tmp')), false);
  unlinkSync(root);
  renameSync(`${root}-original`, root);

  // Swap the temporary directory while an upload is open. Its error cleanup
  // must not unlink a same-named file planted in the replacement directory.
  const stream = new Readable({ read() {} });
  const upload = f.store.blobs.putStream(p.sha256, stream);
  const [tempName] = readdirSync(f.tmp);
  assert.ok(tempName);
  renameSync(f.tmp, `${f.tmp}-original`);
  symlinkSync(outside, f.tmp);
  const tempTarget = join(outside, tempName);
  writeFileSync(tempTarget, 'untouched', { mode: 0o600 });
  stream.push(bytes);
  stream.push(null);
  await assert.rejects(upload, { status: 500, code: 'blob_invalid' });
  await refused(f.upload(bytes), 500, 'blob_invalid');
  assert.throws(() => f.store.blobs.removeIfExists(p.sha256), { status: 500, code: 'blob_invalid' });
  assert.equal(readFileSync(tempTarget, 'utf8'), 'untouched');
  assert.deepEqual(readdirSync(outside).sort(), [shard, tempName].sort());
  assert.deepEqual(readdirSync(`${f.tmp}-original`), []);
});

test('closing the blob store during an upload still cleans up the temporary file', async t => {
  const root = rootDirectory(), store = new FilesystemBlobStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const bytes = Buffer.from('pending upload'), digest = sha(bytes), stream = new Readable({ read() {} });
  const upload = store.putStream(digest, stream);
  assert.equal(readdirSync(join(root, '.tmp')).length, 1);
  store.close();
  store.close();
  assert.throws(() => store.stat(digest), { status: 500, code: 'blob_invalid' });
  stream.push(bytes);
  stream.push(null);
  await assert.rejects(upload, { status: 500, code: 'blob_invalid' });
  assert.deepEqual(readdirSync(join(root, '.tmp')), []);
  assert.equal(existsSync(store.pathFor(digest)), false);
});

test('attachment writes validate metadata and use immutable receipts and an active-only limit', async t => {
  const f = await fixture(t, { database: ':memory:' }), bytes = Buffer.from('attach me');
  await f.create('one');
  const p = attachment('one', bytes);
  await refused(f.command('missing-task', 'task.attach', { ...p, taskId: 'missing' }), 404, 'not_found');
  await refused(f.command('missing', 'task.attach', p), 400, 'blob_not_found');
  await ok(f.upload(bytes));
  await refused(f.command('wrong-size', 'task.attach', { ...p, size: 0 }), 400, 'blob_size_mismatch');
  await refused(f.command('too-large', 'task.attach', { ...p, size: MAX_ATTACHMENT_BYTES + 1 }), 413, 'blob_too_large');
  for (const [key, invalid] of [
    ...['a/b', 'a\\b', '.', '..', '.env', '.git', 'a\0b', 'a\nb', 'a\x7fb', '', 'long'.repeat(64), ' spaces', 'spaces '].map(name => ({ name })),
    ...[null, '', ' text/plain', 'text/plain ', 'text/plain\n', 'text/plain; charset=UTF-8', 'noslash', 'a/b/c', `a/${'b'.repeat(127)}`].map(mimeType => ({ mimeType })),
    { sha256: p.sha256.toUpperCase() }, { sha256: `${p.sha256}\n` }, { size: -1 }, { size: '1' }, { size: 1.5 },
    { id: null }, { id: 'with spaces' }, { id: '' }, { unexpected: true },
  ].entries()) await refused(f.command(`invalid-${key}`, 'task.attach', { ...p, ...invalid }), 400, 'invalid_attachment');
  const a = await ok(f.command('replay', 'task.attach', p));
  assert.match(a.id, /^attachment_/);
  assert.equal(a.mimeType, 'application/octet-stream');
  assert.deepEqual(a.uploadedBy, { id: 'owner', type: 'user' });
  assert.deepEqual(await ok(f.command('replay', 'task.attach', p)), a);
  await refused(f.command('replay', 'task.attach', { ...p, name: 'different' }), 409, 'operation_conflict');
  for (let i = 1; i < MAX_ATTACHMENTS_PER_TASK; i++) await ok(f.command(`fill-${i}`, 'task.attach', { ...p, id: `file-${i}` }));
  assert.equal(f.store.query('task_attachment', { taskId: 'one' }).items.length, MAX_ATTACHMENTS_PER_TASK);
  await refused(f.command('over-limit', 'task.attach', p), 409, 'attachment_limit');
  await ok(f.command('free-slot', 'task.detach', detach(a)));
  await ok(f.command('over-limit', 'task.attach', p));
  assert.equal(f.store.query('task_attachment', { taskId: 'one' }).items.length, MAX_ATTACHMENTS_PER_TASK);
});

test('detach preserves revisioned audit metadata and collects a shared blob only after its last reference', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(0);
  await f.create('one');
  await f.create('two');
  const p = attachment('one', bytes);
  await ok(f.upload(bytes));
  const a = await ok(f.command('attach-one', 'task.attach', p));
  const b = await ok(f.command('attach-two', 'task.attach', { ...p, taskId: 'two' }));
  const path = f.blobPath(p.sha256);
  assert.deepEqual(readdirSync(join(f.root, 'blobs')).sort(), ['.tmp', p.sha256.slice(0, 2)].sort());
  assert.deepEqual(readdirSync(join(f.root, 'blobs', p.sha256.slice(0, 2))), [p.sha256]);
  const getBytes = async a => {
    const res = await f.api(contentRoute(a));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), '0');
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  };
  await getBytes(a);
  await refused(f.command('wrong-task', 'task.detach', { ...detach(a), taskId: 'two' }), 404, 'not_found');
  await refused(f.command('stale', 'task.detach', { ...detach(a), expectedRevision: 0 }), 409, 'stale_revision');
  for (const reason of ['', null, 'x'.repeat(2001)]) await refused(f.command('bad-reason', 'task.detach', { ...detach(a), reason }), 400, 'invalid_attachment');
  const d = await ok(f.command('detach-one', 'task.detach', { ...detach(a), reason: 'Superseded' }));
  assert.equal(d.revision, a.revision + 1);
  assert.equal(d.state, 'detached');
  assert.equal(d.detachReason, 'Superseded');
  assert.deepEqual(d.detachedBy, { type: 'user', id: 'owner' });
  assert.ok(d.detachedAt);
  assert.deepEqual(await ok(f.command('detach-one', 'task.detach', { ...detach(a), reason: 'Superseded' })), d);
  await refused(f.command('repeat', 'task.detach', detach(d)), 409, 'attachment_already_detached');
  assert.deepEqual((await ok(f.api('/v1/task_attachments?taskId=one'))).items, []);
  assert.deepEqual((await ok(f.api('/v1/task_attachments?taskId=one&status=detached'))).items, [d]);
  assert.deepEqual((await ok(f.api('/v1/task_attachments?taskId=two&status=active'))).items, [b]);
  assert.deepEqual((await ok(f.api('/v1/task_attachments?taskId=two&status='))).items, []);
  assert.deepEqual(await ok(f.api(`/v1/task_attachments/${d.id}`)), d);
  assert.deepEqual((await ok(f.api('/v1/snapshot'))).collections.task_attachment.sort((a, b) => a.id.localeCompare(b.id)),
    [b, d].sort((a, b) => a.id.localeCompare(b.id)));
  const events = (await ok(f.api('/v1/events'))).items.filter(e => e.entityId === a.id);
  assert.deepEqual(events.map(e => [e.type, e.causation, e.data]), [['task_attachment.attach', 'attach-one', a], ['task_attachment.detach', 'detach-one', d]]);
  await refused(f.api(contentRoute(a)), 410, 'attachment_detached');
  assert.ok(existsSync(path));
  await getBytes(b);
  await ok(f.command('detach-two', 'task.detach', detach(b)));
  assert.equal(existsSync(path), false);
  await refused(f.api(contentRoute(b)), 410, 'attachment_detached');
  assert.deepEqual(await ok(f.upload(bytes)), { sha256: p.sha256, size: 0, existed: false });
  const fresh = await ok(f.command('attach-fresh', 'task.attach', p));
  assert.notEqual(fresh.id, a.id);
  await getBytes(fresh);
});

test('active records report a missing or wrong-sized blob and an open reader survives detach', async t => {
  const f = await fixture(t), bytes = Buffer.from('test content');
  const p = attachment('one', bytes);
  await f.create('one');
  await ok(f.upload(bytes));
  const a = await ok(f.command('attach', 'task.attach', p));
  const path = f.blobPath(p.sha256);
  writeFileSync(path, 'corrupt');
  await refused(f.api(contentRoute(a)), 500, 'blob_size_mismatch');
  assert.equal((await ok(f.upload(bytes))).existed, false);
  assert.deepEqual(readFileSync(path), bytes);
  unlinkSync(path);
  await refused(f.api(contentRoute(a)), 404, 'blob_missing');
  await ok(f.upload(bytes));
  const { stream } = f.store.blobs.openReadStream(p.sha256);
  await ok(f.command('detach', 'task.detach', detach(a)));
  assert.equal(existsSync(path), false);
  assert.deepEqual(await buffer(stream), bytes);
});

test('a verified retry atomically replaces a same-size corrupted blob', async t => {
  const f = await fixture(t), bytes = Buffer.from('correct'), corrupted = Buffer.from('corrupt');
  const p = attachment('one', bytes);
  await f.create('one');
  await ok(f.upload(bytes));
  const a = await ok(f.command('attach', 'task.attach', p));
  const path = f.blobPath(p.sha256), originalInode = statSync(path).ino;
  writeFileSync(path, corrupted);
  assert.equal(statSync(path).size, bytes.length);
  assert.deepEqual(await ok(f.upload(bytes)), { sha256: p.sha256, size: bytes.length, existed: false });
  assert.notEqual(statSync(path).ino, originalInode);
  const res = await f.api(contentRoute(a));
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  assert.equal((await ok(f.upload(bytes))).existed, true);
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('attachment routes reject query filters on upload and exact reads, and invalid collection scopes', async t => {
  const f = await fixture(t), bytes = Buffer.from('query restrictions'), p = attachment('one', bytes);
  await f.create('one');
  await refused(f.api(`${blobRoute(p.sha256)}?foo=1`, { method: 'PUT', body: bytes }), 400, 'invalid_query');
  assert.equal(existsSync(f.blobPath(p.sha256)), false);
  await ok(f.upload(bytes));
  const a = await ok(f.command('attach', 'task.attach', p));
  for (const path of [`/v1/task_attachments/${a.id}?taskId=one`, '/v1/task_attachments?taskId=one&taskId=two', '/v1/task_attachments?taskId=']) {
    await refused(f.api(path), 400, 'invalid_query');
  }
  assert.deepEqual(f.store.query('task_attachment', { taskId: undefined }).items, [a]);
  assert.deepEqual((await ok(f.api('/v1/task_attachments?taskId=one'))).items, [a]);
});

test('receipt preflight returns only presence for the exact actor and key', async t => {
  const f = await fixture(t), bytes = Buffer.from('receipt fixture');
  const p = attachment((await f.create('receipt-task')).id, bytes);
  await ok(f.upload(bytes));
  for (const key of ['.', '..', '.;', '..;', '/?#\\', '%2E']) {
    const path = attachmentReceiptPath(key);
    assert.deepEqual(await ok(f.api(path)), { state: 'absent' }, key);
    await ok(f.command(key, 'task.attach', p));
    assert.deepEqual(await ok(f.api(path)), { state: 'recorded' }, key);
    await refused(f.api(`${path}?taskId=${p.taskId}`), 400, 'invalid_query');
  }
  await refused(f.api(attachmentReceiptPath('bad key')), 400, 'invalid_key');
});

test('authority separates human operators, approval sessions, idle nodes and accepted interactive work', async t => {
  const f = await fixture(t), bytes = Buffer.from('evidence');
  const p = attachment('one', bytes);
  await f.create('one');
  await f.create('two');
  const { nodeToken: node, operatorToken: operator } = await ok(f.post('/v1/node-bootstrap', { key: 'node', id: 'node', name: 'Node', mode: 'localUser' }));
  const { token: approvals } = await ok(f.post('/v1/grants/ui-session', { terminalId: 'human-terminal' }, operator));
  const attachAs = (key, token, changes) => f.command(key, 'task.attach', { ...p, ...changes }, token);
  await refused(f.upload(bytes, { token: '' }), 401, 'unauthorised');
  await refused(f.upload(bytes, { headers: { Origin: 'http://example.com' } }), 403, 'origin_not_allowed');
  for (const token of [approvals, node]) {
    await refused(f.upload(bytes, { token }), 403, 'forbidden');
    await refused(attachAs('unscoped', token), 403, 'forbidden');
    await refused(f.api(attachmentReceiptPath('create-one'), { token }), 403, 'forbidden');
  }
  for (const token of [f.owner, operator]) {
    await ok(f.upload(bytes, { token }));
    const created = await ok(attachAs(`human-${token === f.owner ? 'root' : 'operator'}`, token));
    assert.deepEqual((await ok(f.api('/v1/task_attachments?taskId=one', { token }))).items, [created]);
    const allowed = await f.api(contentRoute(created), { token });
    assert.equal(allowed.status, 200);
    assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), bytes);
    await refused(f.api(contentRoute(created), { token: approvals }), 403, 'forbidden');
    await refused(f.api('/v1/task_attachments', { token: approvals }), 403, 'forbidden');
    await refused(f.command(`denied-detach-${created.id}`, 'task.detach', detach(created), approvals), 403, 'forbidden');
    await ok(f.command(`detach-${created.id}`, 'task.detach', detach(created), token));
  }

  await ok(f.command('enrol-agent', 'agent.enrol', { id: 'agent', nodeId: 'node', name: 'Agent', directory: '/work' }));
  await ok(f.command('agent-bind', 'agent.attach', { id: 'agent', expectedBindingRevision: 0, conversationId: 'ses_agent', directory: '/work', bindingId: 'binding' }));
  const e = await ok(f.command('request', 'execution.request', { id: 'execution', taskId: 'one', taskRevision: 1, targetAgentId: 'agent', instructions: 'Work' }));
  await refused(f.upload(bytes, { token: node }), 403, 'forbidden');
  const accepted = await ok(f.command('admit', 'execution.admit', { id: e.id, expectedRevision: e.revision, bindingId: 'binding', runId: 'run' }, node));
  await ok(f.upload(bytes, { token: node }));
  assert.deepEqual(await ok(f.api(attachmentReceiptPath('create-one'), { token: node })), { state: 'absent' });
  const nodeAttachment = await ok(attachAs('node-attach', node));
  assert.deepEqual(await ok(f.api(attachmentReceiptPath('node-attach'), { token: node })), { state: 'recorded' });
  assert.deepEqual(await ok(f.api(attachmentReceiptPath('node-attach'))), { state: 'absent' });
  assert.deepEqual(nodeAttachment.uploadedBy, { type: 'node', id: 'node' });
  await refused(attachAs('wrong-task', node, { taskId: 'two' }), 403, 'forbidden');
  await refused(f.command('node-detach', 'task.detach', detach(nodeAttachment), node), 403, 'forbidden');
  await ok(f.command('cancel', 'execution.cancel', { id: accepted.id, expectedRevision: accepted.revision, reason: 'No longer needed' }));
  await refused(f.upload(bytes, { token: node }), 403, 'forbidden');
  await refused(attachAs('cancelled-attach', node), 403, 'forbidden');
  const read = await f.api(contentRoute(nodeAttachment), { token: node });
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
});

test('accepted headless, deleted or missing agents, monitors and local occurrences grant no attachment writes', async t => {
  const f = await fixture(t), bytes = Buffer.from('authorized upload required'), p = attachment('one', bytes);
  await f.create('one');
  await ok(f.upload(bytes));
  const { nodeToken: node } = await ok(f.post('/v1/node-bootstrap', { key: 'node', id: 'node', name: 'Node', mode: 'localUser' }));
  const legacy = await ok(f.command('register-headless', 'agent.register', { id: 'legacy-headless', nodeId: 'node', name: 'Legacy', mode: 'headless' }, node));
  assert.equal(legacy.headlessSetupId, undefined);
  const interactive = await ok(f.command('register-interactive', 'agent.register', { id: 'interactive', nodeId: 'node', name: 'Interactive', mode: 'interactive' }, node));
  f.store.save('agent', { ...legacy, id: 'managed', headlessSetupId: 'setup' });
  f.store.save('agent', { ...interactive, id: 'managed-marker', headlessSetupId: 'setup' });
  f.store.save('agent', { ...interactive, id: 'deleted', deletedAt: new Date().toISOString() });
  for (const [label, targetAgentId, extra] of [
    ['legacy headless', legacy.id], ['managed worker', 'managed'], ['managed marker on interactive row', 'managed-marker'],
    ['deleted agent', 'deleted'], ['missing agent', 'missing'],
    ['standing monitor', interactive.id, { monitor: {} }], ['local occurrence', interactive.id, { localOccurrence: true }],
  ]) {
    // Use one accepted execution at a time so a permitted execution cannot
    // mask a wrong decision in another case, or vice versa.
    f.store.save('execution', { id: 'run', revision: 1, taskId: 'one', targetNodeId: 'node', targetAgentId, state: 'accepted', ...extra });
    await refused(f.upload(bytes, { token: node }), 403, 'forbidden');
    await refused(f.command('refused-attach', 'task.attach', p, node), 403, 'forbidden');
    assert.equal(f.store.all('task_attachment').length, 0, label);
  }
});

test('maintenance fences attachment writes while metadata and content remain readable', async t => {
  const f = await fixture(t), bytes = Buffer.from('before maintenance');
  const p = attachment('one', bytes);
  await f.create('one');
  await ok(f.upload(bytes));
  const a = await ok(f.command('attach', 'task.attach', p));
  writeFileSync(f.maintenanceFile, '{}');
  await refused(f.upload(Buffer.from('during maintenance')), 503, 'maintenance');
  await refused(f.command('attach-during', 'task.attach', p), 503, 'maintenance');
  await refused(f.command('detach-during', 'task.detach', detach(a)), 503, 'maintenance');
  assert.deepEqual((await ok(f.api('/v1/task_attachments'))).items, [a]);
  const res = await f.api(contentRoute(a));
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
});

test('backend upgrade identity excludes blob files and preserves schema 2', async t => {
  const f = await fixture(t), unit = { role: 'backend', statePath: f.root };
  const ownerFile = join(f.root, 'owner.json');
  writeFileSync(ownerFile, JSON.stringify({ token: f.owner }));
  const before = serviceIdentity(unit);
  assert.deepEqual(before.files, [ownerFile]);
  assert.equal(before.schema, 2);
  const bytes = Buffer.from('never a private identity fingerprint input');
  await f.create('one');
  await ok(f.upload(bytes));
  await ok(f.command('attach', 'task.attach', attachment('one', bytes)));
  assert.ok(existsSync(f.blobPath(sha(bytes))));
  const after = serviceIdentity(unit);
  assert.deepEqual(after, before);
  assert.equal(identityFingerprint(after), identityFingerprint(before));
});

test('rolling back detach leaves the blob intact; attachment events do not overwrite existing task projections', async t => {
  const root = rootDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = await fixture(t, { database: ':memory:', blobDirectory: root }), bytes = Buffer.from('still attached');
  const task = await f.create('one');
  await ok(f.upload(bytes));
  const p = attachment('one', bytes, { id: task.id });
  const a = await ok(f.command('attach', 'task.attach', p));
  const owner = f.store.authenticate(f.owner);
  assert.throws(() => f.store.transaction(() => {
    f.store.command(owner, { key: 'detach', action: 'task.detach', payload: detach(a) });
    throw new Error('abort transaction');
  }), /abort transaction/);
  const blobPath = join(root, p.sha256.slice(0, 2), p.sha256);
  assert.deepEqual(readFileSync(blobPath), bytes);
  assert.deepEqual(f.store.get('task_attachment', a.id), a);
  await ok(f.command('detach', 'task.detach', detach(a)));
  assert.equal(existsSync(blobPath), false);

  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: f.store.instance });
  t.after(() => journal.close());
  journal.consume(f.store.events());
  assert.deepEqual(journal.cached('task').map(record => record.entity), [task]);
});

test('operator CLI attaches by reference and native ID, downloads atomically and detaches with shared blob GC', async t => {
  const f = await fixture(t), task = await f.create('task-id');
  const { operatorToken } = await ok(f.post('/v1/node-bootstrap', { key: 'node', id: 'node', name: 'Operator', mode: 'localUser' }));
  const context = join(f.root, 'operator.json');
  writeFileSync(context, JSON.stringify({ url: f.origin, token: operatorToken }), { mode: 0o600 });
  const exec = promisify(execFile);
  const run = (...args) => exec(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, 'native', 'task', ...args, '--context', context],
    { cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root }, timeout: 10000 });
  const cli = async (...args) => JSON.parse((await run(...args)).stdout);
  const refuse = (code, ...args) => assert.rejects(run(...args), error => JSON.parse(error.stderr).code === code);
  const bytes = Buffer.alloc(65539, 0xfb), src = join(f.root, 'source.bin'), dest = join(f.root, 'out.bin'), symlink = join(f.root, 'link.bin');
  writeFileSync(src, bytes); symlinkSync(src, symlink);
  const first = await cli('attach', 'REL-1', '--file', src, '--key', 'first');
  const same = await cli('attach', task.id, '--file', src, '--key', 'second', '--name', 'second.bin', '--mime', 'application/x-test');
  assert.equal(first.name, 'source.bin'); assert.equal(same.mimeType, 'application/x-test'); assert.equal(first.sha256, same.sha256);
  await refuse('invalid_attachment', 'attach', task.id, '--file', symlink, '--key', 'symlink');
  await refuse('invalid_attachment', 'attach', task.id, '--file', src, '--key', 'bad-mime', '--mime', 'text/plain;x=y');
  const page = await cli('attachments', 'REL-1', '--limit', '1', '--status', 'active');
  const next = await cli('attachments', task.id, '--limit', '1', '--status', 'active', '--cursor', page.nextCursor);
  assert.deepEqual(new Set([...page.items, ...next.items].map(a => a.id)), new Set([first.id, same.id]));
  assert.equal((await cli('download', 'REL-1', first.id, '--output', dest)).sha256, sha(bytes));
  assert.deepEqual(readFileSync(dest), bytes); assert.equal(statSync(dest).mode & 0o777, 0o600);
  writeFileSync(dest, 'untouched');
  await refuse('file_exists', 'download', 'REL-1', first.id, '--output', dest);
  await refuse('invalid_output', 'download', 'REL-1', first.id, '--output', f.root, '--force');
  await refuse('invalid_output', 'download', 'REL-1', first.id, '--output', symlink, '--force');
  assert.equal(readFileSync(dest, 'utf8'), 'untouched');
  const blob = f.blobPath(first.sha256);
  writeFileSync(blob, Buffer.alloc(bytes.length, 0x41));
  await refuse('blob_digest_mismatch', 'download', 'REL-1', first.id, '--output', dest, '--force');
  assert.equal(readFileSync(dest, 'utf8'), 'untouched');
  assert.ok(!readdirSync(f.root).some(name => name.startsWith('.relay-download-')));
  writeFileSync(blob, bytes);
  await cli('download', 'REL-1', first.id, '--output', dest, '--force');
  assert.deepEqual(readFileSync(dest), bytes);
  for (const [record, keep] of [[first, true], [same, false]]) {
    assert.equal((await cli('detach', 'REL-1', record.id, '--revision', `${record.revision}`, '--key', `remove-${record.id}`, '--reason', 'Fixture cleanup')).state, 'detached');
    assert.equal(existsSync(blob), keep);
    await refuse('attachment_detached', 'download', task.id, record.id, '--output', dest, '--force');
  }
  assert.deepEqual((await cli('attachments', task.id)).items, []);
  assert.equal((await cli('attachments', task.id, '--status', 'detached')).items.length, 2);
  const changed = Buffer.from('changed operator input');
  const put = f.store.blobs.putStream;
  let uploads = 0;
  f.store.blobs.putStream = (...args) => { uploads++; return put.apply(f.store.blobs, args); };
  try {
    assert.deepEqual(await cli('attach', 'REL-1', '--file', src, '--key', 'first'), first);
    assert.deepEqual((await cli('attachments', task.id)).items, []);
    assert.ok(!existsSync(blob));
    writeFileSync(src, changed);
    await refuse('operation_conflict', 'attach', task.id, '--file', src, '--key', 'first');
    await refuse('operation_conflict', 'attach', task.id, '--file', src, '--key', `create-${task.id}`);
    assert.equal(uploads, 0);
    assert.ok(!existsSync(blob) && !existsSync(f.blobPath(sha(changed))));
    assert.deepEqual((await cli('attachments', task.id)).items, []);
  } finally { f.store.blobs.putStream = put; }
});

test('CLI upload hashes and sends the pinned fd even if its path is replaced, including an empty file', async t => {
  const f = await fixture(t), bytes = Buffer.from([0x00, 0xfa, 0x2c]);
  await f.create('task');
  const realApi = nativeBackendClient({ url: f.origin, token: f.owner });
  const src = join(f.root, 'original.bin'); writeFileSync(src, bytes);
  const api = (method, path, data) => {
    if (path === '/v1/task-identity?value=REL-1' && !existsSync(`${src}.previous`)) {
      renameSync(src, `${src}.previous`); writeFileSync(src, 'substitute');
    }
    return realApi(method, path, data);
  };
  api.uploadBlob = realApi.uploadBlob;
  const record = await attachTaskFile(api, { taskRef: 'REL-1', filePath: src, key: 'pinned' });
  assert.equal(record.sha256, sha(bytes)); assert.deepEqual(readFileSync(f.blobPath(record.sha256)), bytes);
  writeFileSync(src, '');
  const empty = await attachTaskFile(api, { taskRef: 'REL-1', filePath: src, key: 'empty' });
  assert.equal(empty.size, 0); assert.equal(empty.sha256, sha(''));
  const output = join(f.root, 'empty.bin');
  await downloadTaskAttachment(realApi, { taskRef: 'REL-1', attachmentId: empty.id, outputPath: output });
  assert.equal(statSync(output).size, 0);
});

test('CLI validates idempotency keys before upload and detects source growth or shrinkage', async t => {
  const f = await fixture(t), original = Buffer.alloc(131073, 0x43), source = join(f.root, 'source.bin');
  const task = await f.create('task'), api = nativeBackendClient({ url: f.origin, token: f.owner });
  const opts = { taskRef: 'REL-1', filePath: source, key: 'attachment-key' };
  writeFileSync(source, original);
  for (const key of ['bad key', 'trailing ', 'line\nbreak', 'control\x7fkey', 'x'.repeat(129)]) {
    await assert.rejects(attachTaskFile(api, { ...opts, key }), { code: 'invalid_key', status: 400 });
    await refused(f.command(key, 'task.attach', attachment(task.id, original)), 400, 'invalid_key');
  }
  assert.equal(f.store.blobs.stat(sha(original)), null);
  for (const size of [original.length + 1, original.length - 1]) {
    writeFileSync(source, original);
    const between = async (method, path, body) => {
      if (path.startsWith('/v1/task-identity?')) truncateSync(source, size);
      return api(method, path, body);
    };
    between.uploadBlob = () => assert.fail('Changed source must not start upload');
    await assert.rejects(attachTaskFile(between, opts), { code: 'blob_size_mismatch', status: 400 });
    writeFileSync(source, original);
    const during = (...args) => api(...args);
    during.uploadBlob = (...args) => { truncateSync(source, size); return api.uploadBlob(...args); };
    await assert.rejects(attachTaskFile(during, opts), { code: 'blob_size_mismatch', status: 400 });
  }
  writeFileSync(source, original);
  const after = (...args) => api(...args);
  after.uploadBlob = async (_hash, stream) => {
    assert.deepEqual(await buffer(stream), original);
    truncateSync(source, original.length + 1);
  };
  await assert.rejects(attachTaskFile(after, opts), { code: 'blob_size_mismatch', status: 400 });
  assert.equal(f.store.blobs.stat(sha(original)), null);
  assert.deepEqual(f.store.all('task_attachment'), []);
});

test('download leaves a racing destination intact, and bad content headers never open a temporary file', async t => {
  const f = await fixture(t), task = await f.create('task'), bytes = Buffer.from('evidence');
  await ok(f.upload(bytes));
  const record = await ok(f.command('attach', 'task.attach', attachment(task.id, bytes)));
  const realApi = nativeBackendClient({ url: f.origin, token: f.owner }), dest = join(f.root, 'dest');
  const opts = { taskRef: task.id, attachmentId: record.id, outputPath: dest };
  const stream = new Readable({ read() { writeFileSync(dest, 'concurrent'); this.push(bytes); this.push(null); } });
  const api = (...args) => realApi(...args);
  api.downloadAttachment = async () => ({ stream, sha256: record.sha256, size: record.size });
  await assert.rejects(downloadTaskAttachment(api, opts), { code: 'file_exists', status: 409 });
  assert.equal(readFileSync(dest, 'utf8'), 'concurrent');
  const mismatch = new Readable({ read() { assert.fail('Stream must not be read when headers disagree'); } });
  api.downloadAttachment = async () => ({ stream: mismatch, sha256: sha('wrong'), size: record.size });
  await assert.rejects(downloadTaskAttachment(api, { ...opts, force: true }), { code: 'blob_digest_mismatch', status: 502 });
  assert.equal(mismatch.destroyed, true);
  const interrupted = Error('upstream download failed');
  api.downloadAttachment = async () => ({ sha256: record.sha256, size: record.size, stream: new Readable({ read() {
    const tmp = readdirSync(f.root).find(name => name.startsWith('.relay-download-'));
    unlinkSync(join(f.root, tmp));
    this.destroy(interrupted);
  } }) });
  await assert.rejects(downloadTaskAttachment(api, { ...opts, force: true }), error => error === interrupted);
  assert.equal(readFileSync(dest, 'utf8'), 'concurrent');
  assert.ok(!readdirSync(f.root).some(name => name.startsWith('.relay-download-')));
});

test('download refuses unsafe parent modes and publishes only in the pinned directory inode', async t => {
  const f = await fixture(t), task = await f.create('task'), bytes = Buffer.from('verified download');
  await ok(f.upload(bytes));
  const record = await ok(f.command('attach', 'task.attach', attachment(task.id, bytes)));
  const realApi = nativeBackendClient({ url: f.origin, token: f.owner });
  const opts = { taskRef: task.id, attachmentId: record.id };
  const api = (...args) => realApi(...args);
  for (const mode of [0o775, 0o777]) {
    const parent = join(f.root, `unsafe-${mode}`); mkdirSync(parent); chmodSync(parent, mode);
    api.downloadAttachment = () => assert.fail('Unsafe directory must fail before downloading');
    for (const force of [false, true]) await assert.rejects(downloadTaskAttachment(api, { ...opts, outputPath: join(parent, 'out'), force }),
      { code: 'invalid_output', status: 400 });
  }
  for (const mode of [0o700, 0o755]) for (const force of [false, true]) {
    const parent = join(f.root, `safe-${mode}-${force}`), moved = `${parent}-moved`;
    mkdirSync(parent); chmodSync(parent, mode);
    if (force) writeFileSync(join(parent, 'out'), 'replace me');
    api.downloadAttachment = async () => ({ sha256: record.sha256, size: record.size, stream: new Readable({ read() {
      renameSync(parent, moved); mkdirSync(parent, { mode: 0o700 });
      writeFileSync(join(parent, 'out'), 'unrelated');
      this.push(bytes); this.push(null);
    } }) });
    await downloadTaskAttachment(api, { ...opts, outputPath: join(parent, 'out'), force });
    assert.deepEqual(readFileSync(join(moved, 'out')), bytes);
    assert.equal(readFileSync(join(parent, 'out'), 'utf8'), 'unrelated');
    assert.deepEqual(readdirSync(moved), ['out']);
  }
  api.downloadAttachment = async () => ({ sha256: record.sha256, size: record.size, stream: new Readable({ read() {
    const tmp = join(f.root, readdirSync(f.root).find(name => name.startsWith('.relay-download-')));
    renameSync(tmp, `${tmp}.original`); writeFileSync(tmp, 'replacement');
    this.push(bytes); this.push(null);
  } }) });
  const outputPath = join(f.root, 'replaced-temp-output');
  await assert.rejects(downloadTaskAttachment(api, { ...opts, outputPath }), { code: 'invalid_output', status: 400 });
  assert.ok(!existsSync(outputPath));
  const replacement = readdirSync(f.root).find(name => name.startsWith('.relay-download-') && !name.endsWith('.original'));
  assert.equal(readFileSync(join(f.root, replacement), 'utf8'), 'replacement');
});

test('binary clients preserve early errors, reject redirects and malformed responses, and abort stalled transfers', { timeout: 5000 }, async t => {
  let state = 'early', seen, redirectHits = 0;
  const bytes = Buffer.from('verified'), digest = sha(bytes);
  const listener = createServer((req, res) => {
    seen = req.headers;
    if (req.url === '/redirected') redirectHits++;
    if (state === 'early') res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"code":"blob_too_large","message":"Rejected early"}');
    if (state === 'redirect') res.writeHead(302, { Location: '/redirected' }).end();
    if (state === 'invalid') res.writeHead(403, { 'Content-Type': 'text/html' }).end('<h1>Forbidden</h1>');
    if (state === 'oversized-error') res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'forbidden', message: 'x'.repeat(65536) }));
    if (state === 'bad-headers') res.writeHead(200, { 'Content-Length': String(bytes.length), 'X-Content-SHA256': 'x'.repeat(64) }).end(bytes);
    if (state === 'bad-upload-receipt') {
      req.resume(); req.on('end', () => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ sha256: digest, size: 0 })));
    }
    if (state === 'slow-body') { res.writeHead(200, { 'Content-Length': String(bytes.length), 'X-Content-SHA256': digest }); res.write(bytes.subarray(0, 1)); }
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => { listener.closeAllConnections(); return new Promise(resolve => listener.close(resolve)); });
  const api = nativeBackendClient({ url: `http://127.0.0.1:${listener.address().port}`, token: 'base', ingressKey: 'ingress',
    cloudflareAccess: { clientId: 'fixture-id', clientSecret: 'fixture-secret' } }).withToken('scoped');
  const stubborn = new Readable({ read() {} });
  await assert.rejects(api.uploadBlob(digest, stubborn, { size: bytes.length }), { code: 'blob_too_large', status: 413, message: 'Rejected early' });
  assert.equal(stubborn.destroyed, true);
  assert.equal(seen.authorization, 'Bearer scoped'); assert.equal(seen['x-api-key'], 'ingress');
  assert.equal(seen['cf-access-client-id'], 'fixture-id'); assert.equal(seen['cf-access-client-secret'], 'fixture-secret');
  assert.equal(seen['content-type'], 'application/octet-stream'); assert.equal(seen['content-length'], `${bytes.length}`);
  state = 'redirect'; await assert.rejects(api.downloadAttachment('task', 'attachment'), { code: 'access_authentication_required', status: 401 });
  assert.equal(redirectHits, 0);
  for (state of ['invalid', 'oversized-error', 'bad-headers']) await assert.rejects(api.downloadAttachment('task', 'attachment'), { code: 'invalid_backend_response', status: 502 });
  state = 'bad-upload-receipt';
  await assert.rejects(api.uploadBlob(digest, Readable.from([bytes]), { size: bytes.length }), { code: 'invalid_backend_response', status: 502 });
  state = 'stall';
  const stalled = new Readable({ read() {} });
  await assert.rejects(api.uploadBlob(digest, stalled, { size: bytes.length, timeoutMs: 50 }), { code: 'request_timeout', status: 504 });
  assert.equal(stalled.destroyed, true);
  state = 'slow-body';
  const controller = new AbortController(), { stream } = await api.downloadAttachment('task', 'attachment', { signal: controller.signal });
  const reading = buffer(stream);
  controller.abort(); await assert.rejects(reading, { code: 'request_aborted', status: 499 });
});

test('the CLI bridge streams through exact execution scope and fences read-only, foreign, stale and inactive calls', async t => {
  const f = await fixture(t), task = await f.create('assigned'), foreign = await f.create('foreign'), bytes = Buffer.alloc(220003, 0xb7);
  const workspace = join(f.root, 'workspace'), state = join(workspace, 'node-state'), config = join(workspace, 'node-config');
  mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(config, { mode: 0o700 });
  await ok(f.upload(bytes));
  const brief = await ok(f.command('brief', 'task.attach', attachment(task.id, bytes)));
  const foreignBrief = await ok(f.command('foreign-brief', 'task.attach', attachment(foreign.id, bytes)));
  const { nodeToken } = await ok(f.post('/v1/node-bootstrap', { key: 'node', id: 'node', name: 'Surface', mode: 'localUser' }));
  const api = nativeBackendClient({ url: f.origin, token: nodeToken });
  const { dev, ino } = statSync(workspace);
  const worker = { agentId: 'agent', sessionId: 'ses_agent', bindingId: 'binding', bindingRevision: 1, token: 'fixture-worker',
    socketPath: join(state, 'node.sock'), directory: workspace, directoryIdentity: { dev, ino } };
  const headless = { ...worker, token: 'fixture-headless', headlessSetupId: 'headless' };
  const legacyHeadless = { ...worker, token: 'fixture-legacy-headless', mode: 'headless' };
  await ok(f.command('enrol', 'agent.enrol', { id: worker.agentId, nodeId: 'node', name: 'Agent', directory: workspace }));
  await ok(f.command('bind', 'agent.attach', { id: worker.agentId, expectedBindingRevision: 0, conversationId: worker.sessionId, directory: workspace, bindingId: worker.bindingId }));
  const assignment = await ok(f.command('request', 'execution.request', { id: 'exec', taskId: task.id, taskRevision: task.revision, targetAgentId: worker.agentId, instructions: 'Bounded attachment check' }));
  const execution = await ok(f.command('admit', 'execution.admit', { id: assignment.id, expectedRevision: assignment.revision, bindingId: worker.bindingId, runId: 'run' }, nodeToken));
  const work = { id: execution.id, execution, state: 'observing', bindingId: worker.bindingId, nativeConversationId: worker.sessionId,
    interaction: { revision: 'input-rev', inputIds: ['steering'] }, invocation: { messageId: 'source' } };
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: f.store.instance });
  journal.save(work);
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:agent', JSON.stringify({ state: 'active', bindingId: worker.bindingId, generation: 1 }));
  let maintenance = false, resolvedBinding;
  const service = await startNodeService({ journal, socketPath: worker.socketPath, workers: [worker, headless, legacyHeadless], api,
    resolveBinding: async () => resolvedBinding, maintenance: () => maintenance });
  t.after(async () => { await service.close(); journal.close(); });
  const context = join(state, 'worker.json'); writeFileSync(context, JSON.stringify(worker), { mode: 0o600 });
  const nodeConfig = join(config, 'node.json'); writeFileSync(nodeConfig, '{}', { mode: 0o600 });
  const scope = { executionId: execution.id, runId: execution.runId, sourceMessageId: work.invocation.messageId, inputRevision: work.interaction.revision };
  const executionSource = { ...scope, id: scope.sourceMessageId };
  const base = { directory: workspace, stateDirectory: config, sessionId: worker.sessionId, workerContextFile: context };
  const run = (...args) => runRelayCli({ ...base, executionSource, args: ['native', 'task', ...args] });
  const cli = async (...args) => { const result = await run(...args); assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.operatorContextUsed, false); return JSON.parse(result.stdout); };
  assert.deepEqual((await cli('attachments', 'REL-1')).items, [brief]);
  const output = join(workspace, 'from-worker.bin');
  assert.equal((await cli('download', task.id, brief.id, '--output', output)).sha256, sha(bytes));
  assert.deepEqual(readFileSync(output), bytes);
  const deliverable = join(workspace, 'deliverable.bin'), resultBytes = Buffer.from('worker output'); writeFileSync(deliverable, resultBytes);
  const attached = await cli('attach', 'REL-1', '--file', 'deliverable.bin', '--key', 'worker-deliverable');
  assert.deepEqual(attached.uploadedBy, { type: 'node', id: 'node' });
  assert.deepEqual(readFileSync(f.blobPath(attached.sha256)), resultBytes);
  const refusedCli = await run('attach', foreign.id, '--file', deliverable, '--key', 'foreign');
  assert.equal(refusedCli.exitCode, 1); assert.equal(JSON.parse(refusedCli.stderr).code, 'execution_cli_scope');
  await assert.rejects(run('detach', task.id, brief.id, '--key', 'detach-worker', '--revision', '1'), { code: 'execution_cli_scope', status: 403 });
  const scoped = nativeWorkerApi(worker, scope);
  await t.test('the execution CLI retries a detached attachment from its journal or backend receipt without uploading', async () => {
    const key = '..', file = 'detached-worker.bin', path = join(workspace, file);
    const before = Buffer.from('worker replay evidence'), changed = Buffer.from('changed worker evidence');
    writeFileSync(path, before);
    const args = ['attach', task.id, '--file', file, '--key', key];
    const route = attachmentReceiptPath(key);
    assert.deepEqual(await scoped('GET', route), { state: 'absent' });
    const historical = await cli(...args);
    const blob = f.blobPath(historical.sha256);
    await ok(f.command('detach-worker-replay', 'task.detach', detach(historical)));
    assert.ok(!existsSync(blob));
    const put = f.store.blobs.putStream;
    let uploads = 0;
    f.store.blobs.putStream = (...putArgs) => { uploads++; return put.apply(f.store.blobs, putArgs); };
    try {
      assert.deepEqual(await cli(...args), historical);
      const scopedKey = `execution-cli:${digest([execution.id, execution.runId, key])}`;
      journal.db.prepare('DELETE FROM outbox WHERE key=?').run(scopedKey);
      assert.deepEqual(await scoped('GET', route), { state: 'recorded' });
      assert.deepEqual(await cli(...args), historical);
      writeFileSync(path, changed);
      const conflict = await run(...args);
      assert.equal(conflict.exitCode, 1);
      assert.equal(JSON.parse(conflict.stderr).code, 'operation_conflict');
      await assert.rejects(scoped('POST', '/v1/commands', { key, action: 'task.attach', payload: attachment(task.id, changed, { name: file }) }),
        { code: 'operation_conflict', status: 409 });
      const list = (await cli('attachments', task.id)).items;
      assert.deepEqual(new Set(list.map(a => a.id)), new Set([brief.id, attached.id]));
      assert.ok(!existsSync(blob) && !existsSync(f.blobPath(sha(changed))));
      assert.equal(uploads, 0);
    } finally { f.store.blobs.putStream = put; }
  });
  await t.test('execution file operations are confined to the authorised workspace, excluding Relay state', async () => {
    const outside = join(f.root, 'outside.bin'); writeFileSync(outside, 'untouched');
    symlinkSync(f.root, join(workspace, 'escape'));
    for (const [path, code] of [['../outside.bin', 'execution_path_outside_workspace'], ['/etc/passwd', 'execution_path_outside_workspace'],
      [outside, 'execution_path_outside_workspace'], ['escape/outside.bin', 'execution_path_outside_workspace'],
      [nodeConfig, 'execution_path_forbidden'], [context, 'execution_path_forbidden']]) {
      for (const args of [['attach', 'REL-1', '--file', path, '--key', 'blocked'], ['download', 'REL-1', brief.id, '--output', path, '--force']]) {
        const rejected = await run(...args);
        assert.equal(rejected.exitCode, 1); assert.equal(JSON.parse(rejected.stderr).code, code, path);
      }
    }
    assert.equal(readFileSync(outside, 'utf8'), 'untouched'); assert.equal(readFileSync(nodeConfig, 'utf8'), '{}');
    const mismatch = await runRelayCli({ ...base, directory: f.root, executionSource, args: ['native', 'task', 'attach', 'REL-1', '--file', deliverable, '--key', 'wrong-root'] });
    assert.equal(JSON.parse(mismatch.stderr).code, 'execution_workspace_mismatch');
    const narrower = join(workspace, 'narrower'); mkdirSync(narrower, { mode: 0o700 });
    const within = await runRelayCli({ ...base, directory: narrower, executionSource, args: ['native', 'task', 'download', 'REL-1', brief.id, '--output', 'narrower.bin'] });
    assert.equal(within.exitCode, 0, within.stderr); assert.deepEqual(readFileSync(join(narrower, 'narrower.bin')), bytes);
    const env = { PATH: process.env.PATH, HOME: workspace, XDG_CONFIG_HOME: join(workspace, 'xdg-config'), RELAY_NATIVE_CONTEXT: context,
      RELAY_CLI_EXECUTION_ID: scope.executionId, RELAY_CLI_RUN_ID: scope.runId, RELAY_CLI_SOURCE_ID: scope.sourceMessageId,
      RELAY_CLI_INPUT_REVISION: scope.inputRevision };
    const exec = promisify(execFile), cliFile = new URL('../src/cli.mjs', import.meta.url).pathname;
    const direct = (args, overrides) => exec(process.execPath, [cliFile, 'native', 'task', ...args], { cwd: workspace, env: { ...env, ...overrides } });
    const xdg = join(env.XDG_CONFIG_HOME, 'herdr-relay'); mkdirSync(xdg, { recursive: true });
    const secret = join(xdg, 'operator.json'); writeFileSync(secret, '{}');
    await assert.rejects(direct(['attach', 'REL-1', '--file', secret, '--key', 'xdg-forbidden']), error => JSON.parse(error.stderr).code === 'execution_path_forbidden');
    await direct(['download', 'REL-1', brief.id, '--output', 'enrolled-root.bin']);
    assert.deepEqual(readFileSync(join(workspace, 'enrolled-root.bin')), bytes);
    const oldContext = join(state, 'legacy-worker.json'); writeFileSync(oldContext, JSON.stringify({ ...worker, directory: undefined, directoryIdentity: undefined }), { mode: 0o600 });
    await assert.rejects(direct(['download', 'REL-1', brief.id, '--output', 'no-root.bin'], { RELAY_NATIVE_CONTEXT: oldContext }),
      error => JSON.parse(error.stderr).code === 'execution_workspace_required');
  });
  await t.test('execution attach and download reject symlinked workspace roots, symlinked ancestors and replaced root inodes', async () => {
    for (const change of ['root-symlink', 'ancestor-symlink', 'replacement-inode', 'active-subdirectory-symlink']) {
      const ancestor = join(f.root, change), directory = join(ancestor, 'root');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, 'payload.bin'), 'not uploaded');
      const { dev, ino } = statSync(directory), directoryIdentity = { dev, ino }, workerContextFile = join(state, `${change}.json`);
      writeFileSync(workerContextFile, JSON.stringify({ ...worker, directory, directoryIdentity }), { mode: 0o600 });
      let active = directory;
      if (change === 'replacement-inode') {
        renameSync(directory, `${directory}-old`); mkdirSync(directory, { mode: 0o700 });
        writeFileSync(join(directory, 'payload.bin'), 'replacement must not be uploaded');
        assert.notEqual(statSync(directory).ino, ino);
      } else if (change === 'active-subdirectory-symlink') {
        active = join(directory, 'link');
        symlinkSync(directory, active);
      } else {
        const replaced = change === 'root-symlink' ? directory : ancestor;
        renameSync(replaced, `${replaced}-old`); symlinkSync(`${replaced}-old`, replaced);
      }
      for (const args of [['attach', 'REL-1', '--file', 'payload.bin', '--key', change], ['download', 'REL-1', brief.id, '--output', 'blocked.bin']]) {
        const result = await runRelayCli({ ...base, directory: active, workerContextFile, executionSource, args: ['native', 'task', ...args] });
        assert.equal(result.exitCode, 1); assert.equal(JSON.parse(result.stderr).code, 'execution_workspace_mismatch', change);
      }
      assert.equal(existsSync(join(active, 'blocked.bin')), false);
    }
    const oldContext = join(state, 'legacy-root-worker.json');
    writeFileSync(oldContext, JSON.stringify({ ...worker, directoryIdentity: undefined }), { mode: 0o600 });
    const legacy = await runRelayCli({ ...base, workerContextFile: oldContext, executionSource,
      args: ['native', 'task', 'download', 'REL-1', brief.id, '--output', 'legacy-root.bin'] });
    assert.equal(legacy.exitCode, 0, legacy.stderr);
  });
  await t.test('execution uploads refuse a hard link to Relay state while explicit operator uploads allow it', async () => {
    const alias = join(workspace, 'alias.json'); linkSync(nodeConfig, alias);
    assert.equal(statSync(alias).nlink, 2);
    const failed = await run('attach', 'REL-1', '--file', alias, '--key', 'hard-link-denied');
    assert.equal(failed.exitCode, 1); assert.equal(JSON.parse(failed.stderr).code, 'execution_path_forbidden');
    assert.equal(f.store.blobs.stat(sha('{}')), null);
    const otherTask = await f.create('operator-hard-links'), operatorContextFile = join(f.root, 'owner.json');
    writeFileSync(operatorContextFile, JSON.stringify({ url: f.origin, token: f.owner }), { mode: 0o600 });
    const allowed = await runRelayCli({ directory: workspace, operatorContextFile,
      args: ['native', 'task', 'attach', otherTask.id, '--file', alias, '--key', 'operator-hard-link'] });
    assert.equal(allowed.exitCode, 0, allowed.stderr); assert.equal(JSON.parse(allowed.stdout).sha256, sha('{}'));
  });
  await t.test('execution metadata reads cannot reveal another task’s attachments', async () => {
    for (const path of ['/v1/task_attachments', `/v1/task_attachments?taskId=${foreign.id}`, `/v1/task_attachments/${foreignBrief.id}`]) {
      await assert.rejects(scoped('GET', path), { code: 'execution_cli_scope', status: 403 });
    }
    const enrolled = nativeWorkerApi(worker, { readOnly: true });
    assert.deepEqual((await enrolled('GET', `/v1/task_attachments?taskId=${foreign.id}`)).items, [foreignBrief]);
    assert.deepEqual(await enrolled('GET', `/v1/task_attachments/${foreignBrief.id}`), foreignBrief);
  });
  await assert.rejects(scoped.downloadAttachment(foreign.id, foreignBrief.id), { code: 'execution_cli_scope', status: 403 });
  const up = (client, taskId = task.id) => client.uploadBlob(sha(resultBytes), Readable.from([resultBytes]), { size: resultBytes.length, taskId });
  await t.test('duplicate Authorization header fields are refused before binary routing', async () => {
    const query = new URLSearchParams({ ...scope, taskId: task.id, id: brief.id });
    for (const [method, path] of [['GET', `/work/task-attachment-content?${query}`], ['PUT', '/work/blob']]) {
      const response = await new Promise((resolve, reject) => {
        const req = request({ method, path, socketPath: worker.socketPath, agent: false,
          headers: ['Host', 'node', 'Authorization', `Bearer ${worker.token}`, 'Authorization', 'Bearer unexpected'] }, resolve);
        req.on('error', reject); req.end();
      });
      assert.equal(response.statusCode, 401);
      assert.equal(JSON.parse((await buffer(response)).toString()).code, 'unauthorised');
    }
  });
  await t.test('aborting a UNIX socket upload clears the backend temp file and leaves the node serving', { timeout: 5000 }, async test => {
    const entered = Promise.withResolvers(), completed = Promise.withResolvers();
    const putStream = f.store.blobs.putStream;
    f.store.blobs.putStream = function (hash, stream, options) {
      const result = putStream.call(this, hash, stream, options);
      entered.resolve();
      result.then(() => completed.resolve(true), () => completed.resolve(false));
      return result;
    };
    const payload = Buffer.from('a distinct upload aborted before all bytes reached the backend'), hash = sha(payload);
    const req = request({ method: 'PUT', socketPath: worker.socketPath, path: '/work/blob', agent: false, signal: test.signal, headers: {
      Authorization: `Bearer ${worker.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length),
      'X-Relay-Sha256': hash, 'X-Relay-Execution-Id': scope.executionId, 'X-Relay-Run-Id': scope.runId,
      'X-Relay-Source-Message-Id': scope.sourceMessageId, 'X-Relay-Input-Revision': scope.inputRevision, 'X-Relay-Task-Id': task.id,
    } });
    req.on('error', entered.reject);
    try {
      req.write(payload.subarray(0, 12));
      await entered.promise;
      assert.ok(readdirSync(f.tmp).some(name => name.startsWith(hash)));
      req.destroy();
      assert.equal(await completed.promise, false);
      assert.deepEqual(readdirSync(f.tmp), []);
      assert.equal(f.store.blobs.stat(hash), null);
    } finally {
      req.destroy();
      f.store.blobs.putStream = putStream;
    }
    assert.deepEqual(await buffer((await scoped.downloadAttachment(task.id, brief.id)).stream), bytes);
    assert.equal((await scoped.uploadBlob(hash, Readable.from([payload]), { size: payload.length, taskId: task.id })).sha256, hash);
  });
  await assert.rejects(up(scoped, foreign.id), { code: 'execution_cli_scope', status: 403 });
  await assert.rejects(scoped('POST', '/v1/commands', { key: 'raw-detach', action: 'task.detach', payload: detach(brief) }), { code: 'execution_cli_scope', status: 403 });
  await assert.rejects(up(nativeWorkerApi(worker, { ...scope, inputRevision: 'stale' })), { code: 'stale_input_revision', status: 403 });
  await assert.rejects(nativeWorkerApi(worker, { ...scope, inputRevision: 'stale' }).downloadAttachment(task.id, brief.id), { code: 'stale_input_revision', status: 403 });
  await assert.rejects(up(nativeWorkerApi(headless, scope)), { code: 'execution_source_required', status: 403 });
  await assert.rejects(nativeWorkerApi(headless, scope).downloadAttachment(task.id, brief.id), { code: 'execution_source_required', status: 403 });
  await t.test('headless mode without a setup ID and explicitly non-interactive bindings cannot use execution CLI scope', async () => {
    const deny = async client => {
      await assert.rejects(up(client), { code: 'execution_source_required', status: 403 });
      await assert.rejects(client.downloadAttachment(task.id, brief.id), { code: 'execution_source_required', status: 403 });
      await assert.rejects(client('GET', '/v1/info'), { code: 'execution_source_required', status: 403 });
    };
    await deny(nativeWorkerApi(legacyHeadless, scope));
    resolvedBinding = { interactive: false };
    try { await deny(scoped); }
    finally { resolvedBinding = undefined; }
  });
  for (const update of [{ execution: { ...execution, cancellationRequested: true } }, { staged: { kind: 'result' } },
    { execution: { ...execution, monitor: {} } }, { execution: { ...execution, localOccurrence: true } }]) {
    journal.save({ ...work, ...update });
    await assert.rejects(up(scoped), { code: 'execution_source_required', status: 403 });
    await assert.rejects(scoped.downloadAttachment(task.id, brief.id), { code: 'execution_source_required', status: 403 });
  }
  journal.save(work);
  maintenance = true;
  await assert.rejects(up(scoped), { code: 'maintenance', status: 503 });
  await assert.rejects(scoped('POST', '/v1/commands', { key: 'blocked-attach', action: 'task.attach', payload: attachment(task.id, bytes) }), { code: 'maintenance', status: 503 });
  for (const [action, payload] of [['comment.create', { taskId: task.id, body: 'Do not publish' }], ['task.update', { id: task.id }], ['execution.progress', { id: execution.id }]]) {
    await assert.rejects(scoped('POST', '/v1/commands', { key: `blocked-${action}`, action, payload }), { code: 'maintenance', status: 503 });
  }
  assert.equal((await cli('attachments', 'REL-1')).items.length, 2);
  assert.equal((await cli('download', 'REL-1', brief.id, '--output', 'maintenance.bin')).sha256, sha(bytes));
  const blockedAttach = await run('attach', 'REL-1', '--file', deliverable, '--key', 'blocked-cli-attach');
  assert.equal(blockedAttach.exitCode, 1); assert.equal(JSON.parse(blockedAttach.stderr).code, 'maintenance');
  assert.deepEqual(await buffer((await scoped.downloadAttachment(task.id, brief.id)).stream), bytes);
  const query = new URLSearchParams({ ...scope, taskId: task.id, id: brief.id });
  await assert.rejects(callDownloadStream(worker, `/work/task-attachment-content?${query}&id=${brief.id}`), { code: 'invalid_query', status: 400 });
  const agentReadSource = { id: 'approved-notice', authority: 'agent_read' };
  const readCli = (...args) => runRelayCli({ ...base, agentReadSource, args: ['native', 'task', ...args] });
  const list = await readCli('attachments', 'REL-1');
  assert.equal(list.exitCode, 0, list.stderr); assert.equal(list.authority, 'enrolled_read_only');
  assert.equal(JSON.parse(list.stdout).items.length, 2);
  for (const action of ['attach', 'detach', 'download']) await assert.rejects(readCli(action, 'REL-1'), { code: 'agent_cli_read_only', status: 403 });
  const read = nativeWorkerApi(worker, { readOnly: true });
  await assert.rejects(read('GET', '/v1/task-attachment-receipts/worker-deliverable'), { code: 'forbidden', status: 403 });
  await assert.rejects(scoped('GET', '/v1/task-attachment-receipts/worker-deliverable?filter=x'), { code: 'invalid_query', status: 400 });
  assert.deepEqual(await read('GET', `/v1/task_attachments/${brief.id}`), brief);
  await assert.rejects(read('GET', `/v1/task_attachments/${brief.id}?taskId=${task.id}`), { code: 'invalid_query', status: 400 });
  await assert.rejects(read('GET', '/v1/task_attachments?arbitrary=parameter'), { code: 'invalid_query', status: 400 });
  await assert.rejects(up(read), { code: 'agent_cli_read_only', status: 403 });
  await assert.rejects(read.downloadAttachment(task.id, brief.id), { code: 'agent_cli_read_only', status: 403 });
  await assert.rejects(call({ ...worker, token: 'bad-token' }, 'POST', '/agent/native-api', {}), { code: 'unauthorised', status: 401 });
});

test('native board loads attachment metadata only from capable backends and renders a sanitised attachment tab', async t => {
  const f = await fixture(t), task = await f.create('board-task'), bytes = Buffer.alloc(12595, 0xab);
  await ok(f.upload(bytes));
  const record = await ok(f.command('board-attach', 'task.attach', attachment(task.id, bytes, { id: "att$(id)'x;rm", name: 'brief.bin' })));
  const api = nativeBackendClient({ url: f.origin, token: f.owner }), board = nativeBoard(api);
  const detail = await board.detailTask({ taskId: task.id });
  assert.deepEqual(detail.attachments, [record]);
  const older = nativeBoard(async (method, path, ...rest) => {
    assert.ok(!path.startsWith('/v1/task_attachments'));
    const result = await api(method, path, ...rest);
    return path === '/v1/info' ? { ...result, features: { ...result.features, taskAttachments: false } } : result;
  });
  assert.equal(Object.hasOwn(await older.detailTask({ taskId: task.id }), 'attachments'), false);
  const rendered = render(React.createElement(TaskBoardInkApp, { read: board.read, detailTask: async () => ({ ...detail,
    attachments: [{ ...record, name: 'brief\x1b[31m.bin', uploadedBy: { type: 'node', id: 'agent\x1b[2J' } }] }),
    interval: 60000, width: 120, height: 30 }));
  t.after(() => rendered.unmount());
  const send = async key => { rendered.stdin.write(key); await delay(60); };
  await delay(150); await send('j'); await send('\r');
  assert.match(rendered.lastFrame(), /Attachments: 1/);
  assert.match(rendered.lastFrame(), /Comments · Attachments · Activity/);
  for (let step = 0; step < 3; step++) await send('\t');
  const frame = rendered.lastFrame();
  assert.match(frame, /\[Attachments\]/);
  assert.match(frame, /brief\.bin · 12\.3 KiB · att\$\(id\)'x;rm · sha256:[0-9a-f]{12}/);
  assert.match(frame, /Uploaded by node:agent/);
  assert.ok(frame.includes(String.raw`herdr-relay native task download --output <path> -- 'REL-1' 'att$(id)'\''x;rm'`), frame);
  assert.doesNotMatch(frame, /\x1b\[(?:31m|2J)/);
  const context = join(f.root, 'owner.json'), output = join(f.root, 'quoted.bin');
  writeFileSync(context, JSON.stringify({ url: f.origin, token: f.owner }), { mode: 0o600 });
  const { stdout } = await promisify(execFile)(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname,
    'native', 'task', 'download', '--context', context, '--output', output, '--', 'REL-1', record.id], { cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root } });
  assert.equal(JSON.parse(stdout).id, record.id);
  assert.deepEqual(readFileSync(output), bytes);
});
