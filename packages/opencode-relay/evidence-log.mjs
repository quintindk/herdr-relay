import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readSync, realpathSync, renameSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const { O_RDONLY, O_WRONLY, O_RDWR, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_CREAT, O_EXCL, O_APPEND } = constants;
const fdPath = (fd, name = '') => `/proc/self/fd/${fd}${name ? `/${name}` : ''}`;
const blocked = () => { throw Error('Unsafe evidence path'); };
const uid = process.getuid?.();
const sameInode = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const privateFile = entry => entry.isFile() && (uid === undefined || entry.uid === uid) &&
  (entry.mode & 0o7777) === 0o600 && entry.nlink === 1;
const creationFlags = O_CREAT | O_EXCL | O_NOFOLLOW;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function openDirectory(parent) {
  const fd = openSync(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const { mode, uid: owner } = fstatSync(fd);
    const allowed = ((uid === undefined || owner === uid) && (mode & 0o022) === 0) ||
      ((uid === undefined || owner === uid || owner === 0) && (mode & 0o1000) !== 0);
    if (!allowed || realpathSync(fdPath(fd)) !== parent) blocked();
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

function openExisting(path, access = O_RDONLY) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return null;
  if (!privateFile(entry)) blocked();
  const fd = openSync(path, access | O_NOFOLLOW | O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameInode(entry, opened)) blocked();
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

function assertCurrent(path, fd) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry || !privateFile(entry) || !sameInode(entry, fstatSync(fd))) blocked();
}

function withLock(dirFd, lockName, fn) {
  const path = fdPath(dirFd, lockName);
  try { closeSync(openSync(path, O_WRONLY | creationFlags, 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const check = openExisting(path, O_RDWR);
  if (check === null) blocked();
  let identity;
  try { identity = fstatSync(check); } finally { closeSync(check); }

  const deadline = performance.now() + 1000;
  for (;;) {
    let db;
    try {
      db = new DatabaseSync(path);
      // No database pages are written. The kernel releases the lock on exit,
      // including SIGKILL, without replacing the inode or leaving a journal.
      db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
    }
    catch (error) {
      // Close before retrying to release any transient read lock.
      db?.close();
      if (error.errcode !== 5 && error.errcode !== 6) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      Atomics.wait(waitCell, 0, 0, Math.min(10 + process.pid % 11, remaining));
      continue;
    }
    try {
      const entry = lstatSync(path, { throwIfNoEntry: false });
      if (!sameInode(identity, entry) || !privateFile(entry)) blocked();
      fn();
      return true;
    } finally {
      try { db.exec('ROLLBACK'); } catch { /* Closing also releases the lock. */ }
      db.close();
    }
  }
}

function readTail(fd, size, budget) {
  const offset = Math.max(0, size - budget), buffer = Buffer.alloc(size - offset);
  let read = 0;
  while (read < buffer.length) {
    const bytes = readSync(fd, buffer, read, buffer.length - read, offset + read);
    if (!bytes) break;
    read += bytes;
  }
  return { offset, buffer: buffer.subarray(0, read) };
}

function repairTail(path, fd, size, maxBytes) {
  if (!size) return size;
  const last = Buffer.alloc(1);
  if (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 10) return size;
  const { buffer, offset } = readTail(fd, size, maxBytes);
  const newline = buffer.lastIndexOf(10), cut = newline < 0 ? 0 : offset + newline + 1;
  assertCurrent(path, fd);
  ftruncateSync(fd, cut);
  return fstatSync(fd).size;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function isValidJsonObjectLine(line) {
  if (!line.length) return false;
  try {
    const parsed = JSON.parse(utf8.decode(line));
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch { return false; }
}

function boundArchive(dirFd, archiveName, maxBytes) {
  const path = fdPath(dirFd, archiveName), fd = openExisting(path);
  if (fd === null) return;
  try {
    const size = fstatSync(fd).size, { offset, buffer } = readTail(fd, size, maxBytes + 1);
    const lines = [];
    let start = offset ? buffer.indexOf(10) + 1 : 0, kept = 0;
    if (!offset || start) for (let end = buffer.indexOf(10, start); end >= 0; end = buffer.indexOf(10, start)) {
      if (isValidJsonObjectLine(buffer.subarray(start, end))) {
        const line = buffer.subarray(start, end + 1);
        lines.push(line); kept += line.length;
      }
      start = end + 1;
    }
    if (!offset && size <= maxBytes && kept === size) return;
    let first = 0;
    while (kept > maxBytes) kept -= lines[first++].length;

    const temp = fdPath(dirFd, `.relay-evidence-${randomUUID()}.tmp`);
    const output = openSync(temp, O_WRONLY | creationFlags, 0o600);
    try {
      writeFileSync(output, Buffer.concat(lines.slice(first), kept));
      assertCurrent(temp, output); assertCurrent(path, fd);
      renameSync(temp, path);
    } finally {
      try { if (sameInode(fstatSync(output), lstatSync(temp, { throwIfNoEntry: false }))) unlinkSync(temp); }
      finally { closeSync(output); }
    }
  } finally { closeSync(fd); }
}

function appendEvidence(dirFd, name, line, bytes, maxBytes) {
  const active = fdPath(dirFd, name), archiveName = `${name}.1`, archive = fdPath(dirFd, archiveName);
  let archived = openExisting(archive), current;
  try {
    current = openExisting(active, O_RDWR | O_APPEND);
    if (current !== null) {
      const size = repairTail(active, current, fstatSync(current).size, maxBytes);
      if (size + bytes > maxBytes) {
        assertCurrent(active, current);
        if (archived === null) { if (lstatSync(archive, { throwIfNoEntry: false })) blocked(); }
        else assertCurrent(archive, archived);
        renameSync(active, archive);
        closeSync(current); current = null;
        boundArchive(dirFd, archiveName, maxBytes);
      } else if (archived !== null && fstatSync(archived).size > maxBytes) boundArchive(dirFd, archiveName, maxBytes);
    } else if (archived !== null) boundArchive(dirFd, archiveName, maxBytes);
    current ??= openSync(active, O_WRONLY | O_APPEND | creationFlags, 0o600);
    assertCurrent(active, current);
    writeFileSync(current, line);
  } finally {
    try { if (current != null) closeSync(current); }
    finally { if (archived !== null) closeSync(archived); }
  }
}

export function createEvidenceRecorder(evidenceFile, { clientId, maxBytes = MAX_EVIDENCE_BYTES } = {}) {
  if (!evidenceFile) return () => {};
  const clockTimes = new Map();
  let lastRenderedSession = Symbol('not recorded'), lastAttachment;
  return event => {
    try {
      const { type, sessionId, state, slot, time } = event;
      const attachment = type === 'attachment_sidebar' ? JSON.stringify([sessionId, state]) : undefined;
      if (type === 'attachment_sidebar_rendered' && lastRenderedSession === sessionId ||
          type === 'status_clock_rendered' && clockTimes.has(slot) && clockTimes.get(slot) === time ||
          type === 'attachment_sidebar' && lastAttachment === attachment) return;

      const line = `${JSON.stringify({ ...event, clientId })}\n`, bytes = Buffer.byteLength(line);
      if (!Number.isSafeInteger(maxBytes) || bytes > maxBytes) return;
      const path = resolve(evidenceFile), name = basename(path), dirFd = openDirectory(dirname(path));
      try {
        if (!withLock(dirFd, `.${name}.lock`, () => appendEvidence(dirFd, name, line, bytes, maxBytes))) return;
      } finally { closeSync(dirFd); }

      if (type === 'attachment_sidebar_rendered') lastRenderedSession = sessionId;
      if (type === 'status_clock_rendered') clockTimes.set(slot, time);
      if (type === 'attachment_sidebar') lastAttachment = attachment;
    } catch { /* Opt-in evidence must never disrupt the TUI. */ }
  };
}
