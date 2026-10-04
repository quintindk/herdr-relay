import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { RelayError } from './protocol.mjs';

export function serviceLock(directory) {
  const path = join(directory, 'service-lock.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  try {
    // This database contains no state. Its exclusive transaction is an OS-backed
    // process lock released automatically on crash, before socket cleanup begins.
    db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    if (error.errcode === 5 || error.errcode === 6) throw new RelayError('already_running', 'Relay state directory is already owned', 409);
    throw error;
  }
  return () => db.close();
}
