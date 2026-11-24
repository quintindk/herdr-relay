import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, createReadStream, createWriteStream, fstatSync, fsyncSync, linkSync, lstatSync, openSync, read, realpathSync, renameSync, statSync, unlinkSync, write } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RelayError, requireValue, validKey } from './protocol.mjs';
import { withinRoots } from './interactive-contract.mjs';
import { validateAttachmentName, validateAttachmentSize, validateMimeType } from './task-attachments.mjs';
import { attachmentReceiptPath } from './attachment-transport.mjs';

export async function resolveTaskId(api, value) {
  requireValue(typeof value === 'string' && value, 'invalid_request', 'Task ID or reference required');
  const result = await api('GET', `/v1/task-identity?value=${encodeURIComponent(value)}`);
  if (result.state === 'resolved' && result.matches?.[0]?.task?.id) return result.matches[0].task.id;
  if (result.state === 'ambiguous') throw new RelayError('task_reference_ambiguous', 'Task reference matches more than one task; use an exact task ID', 409);
  if (result.state === 'not_found') throw new RelayError('not_found', 'Unknown task ID or reference', 404);
  throw new RelayError('invalid_backend_response', 'Invalid task identity response', 502);
}

async function requireAttachments(api) {
  requireValue((await api('GET', '/v1/info')).features?.taskAttachments, 'backend_upgrade_required', 'Backend must support task attachments', 409);
}

const checkKey = key => requireValue(validKey(key), 'invalid_key', 'Explicit --key of 1..128 characters without whitespace or controls required');
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY;
const fdPath = (fd, name) => name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`;
const sameEntry = (left, right) => Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
const workspaceMismatch = (message = 'Execution workspace root and its ancestors must not be symlinks') => new RelayError('execution_workspace_mismatch', message, 403);
const pathChanged = error => ['ELOOP', 'ENOTDIR', 'ENOENT'].includes(error.code);
const segments = path => path.split(sep).filter(Boolean);

// Borrow the starting descriptor. Close every intermediate descriptor, and
// transfer ownership of the final one only if it differs from the start.
function walkDirectories(startFd, parts, verify = () => {}) {
  let fd = startFd;
  try {
    for (const part of parts) {
      const next = openSync(fdPath(fd, part), directoryFlags | constants.O_NOFOLLOW);
      const previous = fd;
      fd = next;
      if (previous !== startFd) closeSync(previous);
      verify(fd);
    }
    return fd;
  } catch (error) {
    if (fd !== startFd) closeSync(fd);
    throw error;
  }
}

function verifyAnchor({ fd, entry, path }) {
  try {
    if (realpathSync(fdPath(fd)) !== path || !sameEntry(fstatSync(fd), entry)) throw workspaceMismatch('Execution workspace root moved or was replaced');
  } catch (error) { if (pathChanged(error)) throw workspaceMismatch(); throw error; }
}

export function openNoFollowDirectory(absPath) {
  requireValue(isAbsolute(absPath), 'execution_workspace_mismatch', 'Execution workspace root must be absolute', 403);
  const path = resolve(absPath), base = openSync('/', directoryFlags);
  let fd = base, keep = false;
  try {
    fd = walkDirectories(base, segments(path));
    const result = { fd, path, entry: fstatSync(fd) };
    verifyAnchor(result);
    keep = true;
    return result;
  } catch (error) { if (pathChanged(error)) throw workspaceMismatch(); throw error; }
  finally {
    try { if (!keep && fd !== base) closeSync(fd); }
    finally { if (!keep || fd !== base) closeSync(base); }
  }
}

function workspaceParent(workspaceRoot, excludedRoots, target, { enrolledRoot, workspaceIdentity } = {}) {
  const outside = () => new RelayError('execution_path_outside_workspace', 'Execution paths must stay inside the workspace and cannot traverse symlinks', 403);
  const resolvedRoot = resolve(workspaceRoot), dest = resolve(resolvedRoot, target), rel = relative(resolvedRoot, dest);
  const excluded = excludedRoots.map(root => {
    const path = resolve(root);
    try {
      const real = realpathSync(path), entry = statSync(real);
      return { paths: [path, real], entry };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      return { paths: [path] };
    }
  });
  const checkExcluded = (path, entry) => requireValue(!excluded.some(root => withinRoots(path, root.paths) || sameEntry(entry, root.entry)),
    'execution_path_forbidden', 'Execution file operations cannot access Relay state or configuration', 403);
  const verify = (fd, leaf) => {
    let path;
    try { path = realpathSync(fdPath(fd)); }
    catch (error) { if (error.code === 'ENOENT') throw outside(); throw error; }
    if (!withinRoots(path, [resolvedRoot])) throw outside();
    checkExcluded(path, fstatSync(fd));
    if (leaf !== undefined) checkExcluded(join(path, leaf));
  };
  let anchor, rootFd, dirFd;
  const close = () => {
    try { if (dirFd !== undefined && dirFd !== rootFd) closeSync(dirFd); }
    finally {
      try { if (rootFd !== undefined && rootFd !== anchor?.fd) closeSync(rootFd); }
      finally { if (anchor) closeSync(anchor.fd); }
    }
  };
  try {
    anchor = openNoFollowDirectory(enrolledRoot ?? workspaceRoot);
    if (workspaceIdentity !== undefined && !sameEntry(anchor.entry, workspaceIdentity)) throw workspaceMismatch('Enrolled execution workspace identity changed');
    if (!withinRoots(resolvedRoot, [anchor.path])) throw workspaceMismatch();
    checkExcluded(anchor.path, anchor.entry);
    try { rootFd = walkDirectories(anchor.fd, segments(relative(anchor.path, resolvedRoot)), fd => checkExcluded(realpathSync(fdPath(fd)), fstatSync(fd))); }
    catch (error) { if (pathChanged(error)) throw workspaceMismatch(); throw error; }
    const root = { fd: rootFd, path: resolvedRoot, entry: fstatSync(rootFd) };
    const verifyRoots = () => { verifyAnchor(anchor); if (rootFd !== anchor.fd) verifyAnchor(root); };
    verifyRoots();
    if (!rel || !withinRoots(dest, [resolvedRoot])) throw outside();
    const parts = segments(rel), name = parts.pop();
    checkExcluded(dest);
    verify(rootFd);
    dirFd = walkDirectories(rootFd, parts, fd => verify(fd));
    verify(dirFd, name);
    verifyRoots();
    return { dirFd, name, dest, close, verify: () => { verifyRoots(); verify(dirFd, name); }, verifyFile: fd => verify(fd) };
  } catch (error) {
    close();
    // Linux reports ENOTDIR for O_DIRECTORY | O_NOFOLLOW on a symlink.
    if (pathChanged(error)) throw outside();
    throw error;
  }
}

// Explicit stream destruction can close a descriptor even with autoClose:false.
// Keep fd ownership with the caller, not with either file stream.
const borrowedFd = { read, write, close(fd, callback) { callback(null); } };
const pinnedRead = (path, fd, options) => createReadStream(path, { fd, start: 0, autoClose: false, fs: borrowedFd, ...options });
async function dispose(stream) {
  if (!stream.closed) {
    const done = new Promise(resolve => stream.once('close', resolve));
    stream.destroy();
    await done;
  }
}

export async function attachTaskFile(api, { taskRef, filePath, key, name, mimeType, workspaceRoot, enrolledRoot, workspaceIdentity, excludedRoots = [] }) {
  await requireAttachments(api);
  checkKey(key);
  requireValue(typeof filePath === 'string' && filePath, 'invalid_request', '--file is required');
  const resolvedPath = resolve(workspaceRoot ?? '.', filePath);
  validateMimeType(mimeType);
  let fd, size, sha256, taskId, attachmentName;
  const parent = workspaceRoot ? workspaceParent(workspaceRoot, excludedRoots, filePath, { enrolledRoot, workspaceIdentity }) : undefined;
  const inputPath = parent ? fdPath(parent.dirFd, parent.name) : resolvedPath;
  const checkLinks = stat => { if (parent) requireValue(stat.nlink === 1, 'execution_path_forbidden', 'Execution uploads refuse multiply linked files', 403); };
  const unchanged = () => {
    const stat = fstatSync(fd);
    checkLinks(stat);
    requireValue(stat.size === size, 'blob_size_mismatch', 'Attachment source size changed');
  };
  try {
    attachmentName = validateAttachmentName(name ?? basename(resolvedPath));
    try { fd = openSync(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (error.code === 'ELOOP') throw new RelayError(parent ? 'execution_path_outside_workspace' : 'invalid_attachment',
        'Attachment source must not be a symlink', parent ? 403 : 400);
      throw error;
    }
    const stat = fstatSync(fd);
    requireValue(stat.isFile(), 'invalid_attachment', 'Attachment source must be a regular file');
    checkLinks(stat);
    parent?.verifyFile(fd);
    size = validateAttachmentSize(stat.size);
    const hash = createHash('sha256'), input = pinnedRead(inputPath, fd);
    let bytes = 0;
    try {
      for await (const chunk of input) {
        bytes += chunk.length;
        requireValue(bytes <= size, 'blob_size_mismatch', 'Attachment source changed while hashing');
        hash.update(chunk);
      }
    } finally { await dispose(input); }
    requireValue(bytes === size, 'blob_size_mismatch', 'Attachment source changed while hashing');
    unchanged();
    sha256 = hash.digest('hex');
    taskId = await resolveTaskId(api, taskRef);
    const receipt = await api('GET', attachmentReceiptPath(key));
    requireValue(['absent', 'recorded'].includes(receipt?.state), 'invalid_backend_response', 'Invalid attachment receipt state', 502);
    parent?.verify();
    parent?.verifyFile(fd);
    unchanged();
    if (receipt.state !== 'recorded') {
      let sentBytes = 0, lastChunk;
      const upload = new Transform({ transform(chunk, encoding, callback) {
        sentBytes += chunk.length;
        if (sentBytes > size) return callback(new RelayError('blob_size_mismatch', 'Attachment source grew while uploading', 400));
        // Do not let the server accept the full Content-Length before EOF has
        // proved there are no more bytes in the pinned source.
        if (sentBytes === size) { lastChunk = chunk; return callback(); }
        callback(null, chunk);
      }, flush(callback) {
        if (sentBytes !== size) return callback(new RelayError('blob_size_mismatch', 'Attachment source shrank while uploading', 400));
        callback(null, lastChunk);
      } });
      const pumping = pipeline(pinnedRead(inputPath, fd), upload).then(() => undefined, error => error);
      const verifyPumping = async () => { const error = await pumping; if (error) throw error; };
      try {
        if (size === 0) await verifyPumping();
        await api.uploadBlob(sha256, upload, { size, taskId });
        await verifyPumping();
      } finally { upload.destroy(); await pumping; }
      parent?.verify();
      parent?.verifyFile(fd);
      unchanged();
    }
  } finally {
    try { if (fd !== undefined) closeSync(fd); }
    finally { parent?.close(); }
  }
  return api('POST', '/v1/commands', { key, action: 'task.attach', payload: { taskId, name: attachmentName, sha256, size,
    ...(mimeType !== undefined ? { mimeType } : {}) } });
}

export async function listTaskAttachments(api, { taskRef, limit, cursor, status }) {
  const taskId = await resolveTaskId(api, taskRef), query = new URLSearchParams({ taskId });
  if (limit !== undefined) {
    requireValue(/^\d+$/.test(limit) && Number(limit) >= 1 && Number(limit) <= 500, 'invalid_query', 'Limit must be 1..500');
    query.set('limit', limit);
  }
  if (cursor !== undefined) query.set('cursor', cursor);
  if (status !== undefined) {
    requireValue(['active', 'detached'].includes(status), 'invalid_query', 'Attachment status must be active or detached');
    query.set('status', status);
  }
  return api('GET', `/v1/task_attachments?${query}`);
}

export async function downloadTaskAttachment(api, { taskRef, attachmentId, outputPath, force = false, workspaceRoot, enrolledRoot, workspaceIdentity, excludedRoots = [] }) {
  requireValue(typeof outputPath === 'string' && outputPath && attachmentId, 'invalid_request', 'Attachment ID and explicit --output are required');
  const taskId = await resolveTaskId(api, taskRef);
  const parent = workspaceRoot ? workspaceParent(workspaceRoot, excludedRoots, outputPath, { enrolledRoot, workspaceIdentity }) : undefined;
  const dest = parent?.dest ?? resolve(outputPath), name = basename(dest);
  let dirFd = parent?.dirFd, stream, tmpPath, tmpEntry;
  try {
    if (dirFd === undefined) {
      try { dirFd = openSync(dirname(dest), directoryFlags); }
      catch (error) {
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw new RelayError('invalid_output', 'Output parent directory must exist', 400);
        throw error;
      }
    }
    const destPath = fdPath(dirFd, name);
    const checkParent = () => {
      parent?.verify();
      const entry = fstatSync(dirFd);
      requireValue(entry.isDirectory() && (typeof process.getuid !== 'function' || entry.uid === process.getuid()) && (entry.mode & 0o022) === 0,
        'invalid_output', 'Output directory must be owned by the current user and not writable by group or others');
    };
    const checkDest = () => {
      const entry = lstatSync(destPath, { throwIfNoEntry: false });
      requireValue(!entry || entry.isFile(), 'invalid_output', 'Output must not be a symlink, directory or special file');
      requireValue(!entry || force === true, 'file_exists', 'Output file already exists; use --force to replace it', 409);
    };
    checkParent(); checkDest();
    const meta = await api('GET', `/v1/task_attachments/${encodeURIComponent(attachmentId)}`);
    requireValue(meta.taskId === taskId, 'not_found', 'Unknown task attachment', 404);
    requireValue(meta.state === 'active', 'attachment_detached', 'Attachment was detached and its content is no longer available', 410);
    const content = await api.downloadAttachment(taskId, attachmentId), { sha256, size } = content;
    stream = content.stream;
    requireValue(sha256 === meta.sha256, 'blob_digest_mismatch', 'Download digest does not match attachment metadata', 502);
    requireValue(size === meta.size, 'blob_size_mismatch', 'Download size does not match attachment metadata', 502);
    checkParent();
    tmpPath = fdPath(dirFd, `.relay-download-${randomUUID()}`);
    const fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let bytes = 0;
    const hash = createHash('sha256');
    const verify = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > size) return callback(new RelayError('blob_size_mismatch', 'Download exceeds attachment size', 502));
      hash.update(chunk);
      callback(null, chunk);
    } });
    try {
      tmpEntry = fstatSync(fd);
      const writer = createWriteStream(tmpPath, { fd, autoClose: false, fs: borrowedFd });
      try { await pipeline(stream, verify, writer); }
      catch (error) {
        if (error.code === 'ECONNRESET' && bytes !== size) throw new RelayError('blob_size_mismatch', 'Download ended before the expected size', 502);
        throw error;
      } finally { await dispose(writer); }
      requireValue(bytes === size, 'blob_size_mismatch', 'Download size does not match attachment metadata', 502);
      requireValue(hash.digest('hex') === sha256, 'blob_digest_mismatch', 'Download content does not match attachment SHA-256', 502);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    checkParent(); checkDest();
    requireValue(sameEntry(lstatSync(tmpPath, { throwIfNoEntry: false }), tmpEntry), 'invalid_output', 'Temporary download file was replaced');
    if (force) renameSync(tmpPath, destPath);
    else {
      try { linkSync(tmpPath, destPath); }
      catch (error) { if (error.code === 'EEXIST') throw new RelayError('file_exists', 'Output file already exists; use --force to replace it', 409); throw error; }
    }
    return { id: meta.id, taskId, name: meta.name, sha256, size, mimeType: meta.mimeType, output: dest };
  } finally {
    stream?.destroy();
    try {
      if (tmpEntry && sameEntry(lstatSync(tmpPath, { throwIfNoEntry: false }), tmpEntry)) {
        try { unlinkSync(tmpPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } finally { if (parent) parent.close(); else if (dirFd !== undefined) closeSync(dirFd); }
  }
}

export async function detachTaskAttachment(api, { taskRef, attachmentId, revision, key, reason }) {
  await requireAttachments(api);
  checkKey(key);
  requireValue(attachmentId && Number.isSafeInteger(revision) && revision > 0, 'invalid_request', 'Exact attachment ID and --revision positive integer are required');
  const taskId = await resolveTaskId(api, taskRef);
  return api('POST', '/v1/commands', { key, action: 'task.detach', payload: { id: attachmentId, taskId, expectedRevision: revision,
    ...(reason !== undefined ? { reason } : {}) } });
}
