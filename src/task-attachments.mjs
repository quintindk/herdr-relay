import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, createReadStream, createWriteStream, fchmodSync, fstatSync, lstatSync, mkdirSync,
  openSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough, Readable, Transform, finished } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { now, requireValue } from './protocol.mjs';

export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TASK = 100;

export function validateSha256(value) {
  requireValue(typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value),
    'invalid_attachment', 'Attachment SHA-256 must be 64 lowercase hexadecimal characters');
  return value;
}

export function validateAttachmentName(value) {
  requireValue(typeof value === 'string' && value.length >= 1 && value.length <= 255 && value.trim() === value &&
    !value.startsWith('.') && !/[/\\\x00-\x1f\x7f]/.test(value), 'invalid_attachment', 'Attachment name must be a single safe filename');
  return value;
}

export function validateMimeType(value = 'application/octet-stream') {
  requireValue(typeof value === 'string' && value.length >= 1 && value.length <= 128 &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.exec(value)?.[0] === value,
  'invalid_attachment', 'Attachment MIME type must be a bare type/subtype');
  return value;
}

function validateSize(value, maxBytes) {
  requireValue(!(typeof value === 'number' && value > maxBytes), 'blob_too_large', 'Attachment exceeds the size limit', 413);
  requireValue(Number.isSafeInteger(value) && value >= 0, 'invalid_attachment', 'Attachment size must be a non-negative integer');
  return value;
}

export const validateAttachmentSize = value => validateSize(value, MAX_ATTACHMENT_BYTES);

function blobVerifier(sha256, expectedSize, maxBytes) {
  const hash = createHash('sha256');
  let bytes = 0;
  return {
    add(chunk) {
      bytes += chunk.length;
      requireValue(bytes <= maxBytes, 'blob_too_large', 'Attachment exceeds the size limit', 413);
      requireValue(expectedSize === undefined || bytes <= expectedSize, 'blob_size_mismatch', 'Blob size does not match the expected size');
      hash.update(chunk);
    },
    verify() {
      requireValue(expectedSize === undefined || bytes === expectedSize, 'blob_size_mismatch', 'Blob size does not match the expected size');
      requireValue(hash.digest('hex') === sha256, 'blob_digest_mismatch', 'Blob content does not match the expected SHA-256');
      return bytes;
    },
  };
}

function lstat(path) {
  try { return lstatSync(path, { throwIfNoEntry: false }); }
  catch (error) {
    requireValue(error.code !== 'ELOOP' && error.code !== 'ENOTDIR', 'blob_invalid', 'Blob path has an invalid directory component', 500);
    throw error;
  }
}

function checkPrivateEntry(entry, type) {
  const mode = type === 'dir' ? 0o700 : 0o600;
  requireValue(!entry.isSymbolicLink() && (type === 'dir' ? entry.isDirectory() : entry.isFile()) &&
    (typeof process.getuid !== 'function' || entry.uid === process.getuid()) && (entry.mode & 0o7777) === mode,
  'blob_invalid', `Blob ${type === 'dir' ? 'directory' : 'file'} must have mode 0${mode.toString(8)}, be owned by the backend and not be a symlink`, 500);
  return entry;
}

function assertPrivateEntry(path, type, { optional = false } = {}) {
  const entry = lstat(path);
  if (!entry && optional) return null;
  requireValue(entry, 'blob_invalid', 'Required blob directory or file is missing', 500);
  return checkPrivateEntry(entry, type);
}

// On Linux this pins name resolution to an already verified directory inode,
// even if its live path is replaced or renamed before the next syscall.
const fdPath = (fd, name) => name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`;
const sameEntry = (a, b) => Boolean(a && a.dev === b.dev && a.ino === b.ino);
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function checkCreationParent(entry) {
  requireValue(entry && entry.isDirectory() && !entry.isSymbolicLink() &&
    (typeof process.getuid !== 'function' || entry.uid === process.getuid()) && (entry.mode & 0o077) === 0,
  'blob_invalid', 'Blob directory parent must be a private directory owned by the backend', 500);
  return entry;
}

function openCreationParent(path, recursive) {
  const expected = lstat(path);
  if (!expected && recursive) {
    const fd = openPrivateDirectory(path, { create: true, recursive: true });
    requireValue(fd !== null, 'blob_invalid', 'Blob directory parent is missing', 500);
    return fd;
  }
  checkCreationParent(expected);
  let fd;
  try {
    fd = openSync(path, directoryFlags);
    requireValue(sameEntry(expected, checkCreationParent(fstatSync(fd))), 'blob_invalid', 'Blob directory parent was replaced', 500);
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    requireValue(!['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code), 'blob_invalid', 'Blob directory parent was replaced', 500);
    throw error;
  }
}

function openPrivateDirectory(path, { create = false, recursive = false, parentFd } = {}) {
  if (create && parentFd === undefined) {
    const fd = openCreationParent(dirname(path), recursive);
    try { return openPrivateDirectory(basename(path), { create, parentFd: fd }); }
    finally { closeSync(fd); }
  }
  if (parentFd !== undefined) path = fdPath(parentFd, path);
  let expected = assertPrivateEntry(path, 'dir', { optional: true });
  let created = false, parent;
  if (!expected && create) {
    parent = checkCreationParent(fstatSync(parentFd));
    // Non-recursive mkdir tells us whether this exact directory was created.
    // Never change the mode if we lost creation to another caller.
    try { mkdirSync(path, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    expected = created ? lstat(path) : assertPrivateEntry(path, 'dir', { optional: true });
  }
  if (!expected) return null;
  let fd;
  try {
    fd = openSync(path, directoryFlags);
    if (created) {
      const entry = fstatSync(fd);
      requireValue(sameEntry(expected, entry) && (typeof process.getuid !== 'function' || entry.uid === process.getuid()),
        'blob_invalid', 'New blob directory was replaced during creation', 500);
      // Clear only inherited setgid on the pinned, newly created directory.
      if ((parent.mode & 0o2000) !== 0 && (entry.mode & 0o7777) === 0o2700) {
        checkCreationParent(fstatSync(parentFd));
        fchmodSync(fd, 0o700);
      }
    }
    checkPrivateEntry(fstatSync(fd), 'dir');
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error.code === 'ENOENT') return null;
    requireValue(error.code !== 'ELOOP' && error.code !== 'ENOTDIR', 'blob_invalid', 'Blob directory must not be a symlink or another file type', 500);
    throw error;
  }
}

function unlinkIfPresent(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function openPrivateBlob(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return { fd, entry: checkPrivateEntry(fstatSync(fd), 'file') };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error.code === 'ENOENT') return null;
    requireValue(error.code !== 'ELOOP', 'blob_invalid', 'Blob must not be a symlink', 500);
    throw error;
  }
}

export class FilesystemBlobStore {
  #rootFd;
  #tmpFd;
  #activeWrites = 0;
  #closed = false;

  constructor(blobDirectory) {
    this.blobDirectory = resolve(blobDirectory);
    this.tmpDirectory = join(this.blobDirectory, '.tmp');
    try {
      this.#rootFd = openPrivateDirectory(this.blobDirectory, { create: true, recursive: true }) ?? undefined;
      this.#assertDirectories();
      this.#tmpFd = openPrivateDirectory('.tmp', { create: true, parentFd: this.#rootFd }) ?? undefined;
      this.#assertDirectories(true);
      for (const name of readdirSync(fdPath(this.#tmpFd))) {
        const path = fdPath(this.#tmpFd, name);
        if (lstat(path)?.isFile()) unlinkIfPresent(path);
      }
    } catch (error) { this.close(); throw error; }
  }

  close() {
    this.#closed = true;
    // A shutdown may close the HTTP sockets before the write pipelines settle.
    // Keep the original temp directory pinned until their cleanup has run.
    if (!this.#activeWrites) this.#closeDirectories();
  }

  #closeDirectories() {
    const tmp = this.#tmpFd, root = this.#rootFd;
    this.#tmpFd = undefined;
    this.#rootFd = undefined;
    try { if (tmp !== undefined) closeSync(tmp); }
    finally { if (root !== undefined) closeSync(root); }
  }

  #assertDirectories(write = false) {
    requireValue(!this.#closed && this.#rootFd !== undefined, 'blob_invalid', 'Blob directory is not open', 500);
    const root = checkPrivateEntry(fstatSync(this.#rootFd), 'dir');
    requireValue(sameEntry(assertPrivateEntry(this.blobDirectory, 'dir'), root),
      'blob_invalid', 'Blob directory was replaced after startup', 500);
    if (write) {
      requireValue(this.#tmpFd !== undefined, 'blob_invalid', 'Blob temporary directory is not open', 500);
      const tmp = checkPrivateEntry(fstatSync(this.#tmpFd), 'dir');
      requireValue(sameEntry(assertPrivateEntry(fdPath(this.#rootFd, '.tmp'), 'dir'), tmp),
        'blob_invalid', 'Blob temporary directory was replaced after startup', 500);
    }
  }

  #openShard(shardName, { create = false } = {}) {
    return openPrivateDirectory(shardName, { create, parentFd: this.#rootFd });
  }

  #assertShard(shardName, fd) {
    requireValue(sameEntry(assertPrivateEntry(fdPath(this.#rootFd, shardName), 'dir'), checkPrivateEntry(fstatSync(fd), 'dir')),
      'blob_invalid', 'Blob shard directory was replaced during upload', 500);
  }

  pathFor(sha256) {
    validateSha256(sha256);
    return join(this.blobDirectory, sha256.slice(0, 2), sha256);
  }

  stat(sha256) {
    validateSha256(sha256);
    this.#assertDirectories();
    const fd = this.#openShard(sha256.slice(0, 2));
    if (fd === null) return null;
    try {
      const entry = assertPrivateEntry(fdPath(fd, sha256), 'file', { optional: true });
      return entry ? { size: entry.size } : null;
    } finally { closeSync(fd); }
  }

  async putStream(sha256, readable, { expectedSize, maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
    validateSha256(sha256);
    if (expectedSize !== undefined) validateSize(expectedSize, maxBytes);
    this.#assertDirectories(true);
    this.stat(sha256);
    const shard = sha256.slice(0, 2);
    const verifier = blobVerifier(sha256, expectedSize, maxBytes);
    const tmp = fdPath(this.#tmpFd, `${sha256}-${randomUUID()}`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.#activeWrites++;
    let tempEntry, writer, renamed = false;
    try {
      tempEntry = fstatSync(fd);
      fchmodSync(fd, 0o600);
      checkPrivateEntry(fstatSync(fd), 'file');
      writer = createWriteStream(tmp, { fd });
      // Do not let pipeline destroy the HTTP socket on validation failure. The
      // caller must still be able to send an error before closing the request.
      const input = new PassThrough();
      const stopWatching = finished(readable, { readable: true, writable: false }, error => {
        if (error) input.destroy(error);
      });
      try {
        const writing = pipeline(input, new Transform({ transform(chunk, encoding, callback) {
          try { verifier.add(chunk); } catch (error) { return callback(error); }
          callback(null, chunk);
        } }), writer);
        readable.pipe(input);
        await writing;
      } finally {
        readable.unpipe(input);
        stopWatching();
      }
      this.#assertDirectories(true);
      const size = verifier.verify();
      const shardFd = this.#openShard(shard, { create: true });
      requireValue(shardFd !== null, 'blob_invalid', 'Blob shard directory is missing', 500);
      try {
        const path = fdPath(shardFd, sha256);
        if (assertPrivateEntry(path, 'file', { optional: true })?.size === size) {
          const existing = openPrivateBlob(path);
          if (existing) {
            const hash = createHash('sha256');
            let bytes = 0;
            if (size && existing.entry.size === size) {
              for await (const chunk of createReadStream(path, { fd: existing.fd, end: size - 1 })) {
                bytes += chunk.length;
                hash.update(chunk);
              }
            } else closeSync(existing.fd);
            // Recheck the live directory identities and the file entry after
            // hashing. All file access still goes through the pinned shard.
            this.#assertDirectories(true);
            this.#assertShard(shard, shardFd);
            const current = assertPrivateEntry(path, 'file', { optional: true });
            if (bytes === size && hash.digest('hex') === sha256 && sameEntry(current, existing.entry) &&
              current.size === size && current.mtimeMs === existing.entry.mtimeMs && current.ctimeMs === existing.entry.ctimeMs) {
              return { sha256, size, existed: true };
            }
          }
        }
        this.#assertShard(shard, shardFd);
        requireValue(sameEntry(assertPrivateEntry(tmp, 'file'), tempEntry), 'blob_invalid', 'Temporary blob file was replaced', 500);
        renameSync(tmp, path);
        renamed = true;
        return { sha256, size, existed: false };
      } finally { closeSync(shardFd); }
    } finally {
      try {
        if (!writer) closeSync(fd);
        if (!renamed && tempEntry && sameEntry(lstat(tmp), tempEntry)) unlinkIfPresent(tmp);
      } finally {
        this.#activeWrites--;
        if (this.#closed && !this.#activeWrites) this.#closeDirectories();
      }
    }
  }

  openReadStream(sha256) {
    validateSha256(sha256);
    this.#assertDirectories();
    const fd = this.#openShard(sha256.slice(0, 2));
    requireValue(fd !== null, 'blob_missing', 'Attachment blob is missing', 404);
    try {
      const path = fdPath(fd, sha256);
      requireValue(assertPrivateEntry(path, 'file', { optional: true }), 'blob_missing', 'Attachment blob is missing', 404);
      // Open now, not on the next tick: an authorised download keeps its open
      // descriptor even if the last reference is detached during the transfer.
      const opened = openPrivateBlob(path);
      requireValue(opened, 'blob_missing', 'Attachment blob is missing', 404);
      return { stream: createReadStream(path, { fd: opened.fd }), size: opened.entry.size };
    } finally { closeSync(fd); }
  }

  removeIfExists(sha256) {
    validateSha256(sha256);
    this.#assertDirectories(true);
    const fd = this.#openShard(sha256.slice(0, 2));
    if (fd === null) return;
    try {
      const path = fdPath(fd, sha256);
      if (assertPrivateEntry(path, 'file', { optional: true })) unlinkIfPresent(path);
    } finally { closeSync(fd); }
  }
}

export class MemoryBlobStore {
  #blobs = new Map();

  close() {}

  stat(sha256) {
    const bytes = this.#blobs.get(validateSha256(sha256));
    return bytes ? { size: bytes.length } : null;
  }

  async putStream(sha256, readable, { expectedSize, maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
    validateSha256(sha256);
    if (expectedSize !== undefined) validateSize(expectedSize, maxBytes);
    const verifier = blobVerifier(sha256, expectedSize, maxBytes);
    const chunks = [];
    for await (const data of readable.iterator({ destroyOnReturn: false })) {
      const chunk = Buffer.from(data);
      verifier.add(chunk);
      chunks.push(chunk);
    }
    const size = verifier.verify();
    const existed = this.stat(sha256)?.size === size;
    if (!existed) this.#blobs.set(sha256, Buffer.concat(chunks, size));
    return { sha256, size, existed };
  }

  openReadStream(sha256) {
    const bytes = this.#blobs.get(validateSha256(sha256));
    requireValue(bytes, 'blob_missing', 'Attachment blob is missing', 404);
    return { stream: Readable.from(bytes.length ? [Buffer.from(bytes)] : []), size: bytes.length };
  }

  removeIfExists(sha256) { this.#blobs.delete(validateSha256(sha256)); }
}

function acceptedInteractiveExecution(store, actor, taskId) {
  return actor.type === 'node' && store.all('execution').some(e => {
    if (e.targetNodeId !== actor.id || e.state !== 'accepted' || e.cancellationRequested || e.monitor || e.localOccurrence ||
      (taskId !== undefined && e.taskId !== taskId) || !e.targetAgentId) return false;
    const agent = store.get('agent', e.targetAgentId, false, true);
    return Boolean(agent && !agent.deletedAt && agent.mode === 'interactive' && !agent.headlessSetupId);
  });
}

export function canNodeAttachToTask(store, actor, taskId) {
  return taskId !== undefined && acceptedInteractiveExecution(store, actor, taskId);
}

const isAttachmentOwner = (store, actor) => actor.type === 'user' && actor.id === store.owner && actor.scope?.kind !== 'grant_approval';

export function authoriseBlobUpload(store, actor) {
  requireValue(isAttachmentOwner(store, actor) || acceptedInteractiveExecution(store, actor),
    'forbidden', 'Owner or node with an accepted interactive execution required', 403);
}

export function authoriseAttachmentRead(store, actor) {
  requireValue(isAttachmentOwner(store, actor) || actor.type === 'node', 'forbidden', 'Owner or node credential required', 403);
}

const fields = (value, allowed, required) => requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)),
'invalid_attachment', 'Missing or unsupported attachment fields');

const validateId = (value, field) => requireValue(typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f]/.test(value),
  'invalid_attachment', `${field} must be a bounded identity`);

export function applyTaskAttachment(store, actor, action, p, { created, changed }) {
  if (action === 'task.attach') {
    fields(p, ['id', 'taskId', 'name', 'sha256', 'size', 'mimeType'], ['taskId', 'name', 'sha256', 'size']);
    if (p.id !== undefined) validateId(p.id, 'Attachment ID');
    validateId(p.taskId, 'Task ID');
    store.get('task', p.taskId);
    requireValue(isAttachmentOwner(store, actor) || canNodeAttachToTask(store, actor, p.taskId),
      'forbidden', 'Owner or node with an accepted interactive execution on this task required', 403);
    const name = validateAttachmentName(p.name), sha256 = validateSha256(p.sha256), size = validateAttachmentSize(p.size), mimeType = validateMimeType(p.mimeType);
    requireValue(store.all('task_attachment').filter(a => a.taskId === p.taskId && a.state === 'active').length < MAX_ATTACHMENTS_PER_TASK,
      'attachment_limit', 'Task has reached its active attachment limit', 409);
    const blob = store.blobs.stat(sha256);
    requireValue(blob, 'blob_not_found', 'Upload the attachment blob before attaching it');
    requireValue(blob.size === size, 'blob_size_mismatch', 'Blob size does not match the attachment size');
    return created('task_attachment', { id: p.id ?? `attachment_${randomUUID()}`, taskId: p.taskId, name, sha256, size, mimeType,
      state: 'active', uploadedBy: { type: actor.type, id: actor.id } });
  }
  requireValue(action === 'task.detach', 'unsupported_operation', 'Unknown attachment operation');
  store.ownerOnly(actor);
  requireValue(isAttachmentOwner(store, actor), 'forbidden', 'Owner credential required', 403);
  fields(p, ['id', 'taskId', 'expectedRevision', 'reason'], ['id', 'taskId', 'expectedRevision']);
  validateId(p.id, 'Attachment ID');
  const attachment = store.get('task_attachment', p.id);
  requireValue(attachment.taskId === p.taskId, 'not_found', 'Unknown task attachment', 404);
  store.revision(attachment, p.expectedRevision);
  requireValue(attachment.state === 'active', 'attachment_already_detached', 'Attachment is already detached', 409);
  if (p.reason !== undefined) requireValue(typeof p.reason === 'string' && p.reason.trim() && p.reason.length <= 2000,
    'invalid_attachment', 'Detach reason must contain 1..2000 characters');
  const detached = changed('task_attachment', attachment, { state: 'detached', detachedAt: now(), detachedBy: { type: actor.type, id: actor.id },
    ...(p.reason !== undefined ? { detachReason: p.reason } : {}) });
  store.afterCommit.push(() => {
    const stillReferenced = store.all('task_attachment').some(a => a.state === 'active' && a.sha256 === attachment.sha256);
    if (!stillReferenced) store.blobs.removeIfExists(attachment.sha256);
  });
  return detached;
}
