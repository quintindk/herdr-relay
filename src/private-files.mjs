import { writeFileSync, renameSync, linkSync, unlinkSync, existsSync, openSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, requireValue } from './protocol.mjs';

export function readPrivateJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { requireValue(false, 'invalid_private_context', 'Cannot read a valid private JSON context. Its contents are not included in diagnostics'); }
}

export function writePrivateJson(path, value, exclusive = false) {
  const temporary = `${path}.${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true });
  try { if (exclusive) linkSync(temporary, path); else renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function createPrivateJson(path, value) {
  try { writePrivateJson(path, value, true); return true; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { requireValue(false, 'configuration_conflict', 'Existing private file is not valid JSON'); }
    requireValue(digest(existing) === digest(value), 'configuration_conflict', 'Refuse replacing a different private configuration');
    return false;
  }
}
