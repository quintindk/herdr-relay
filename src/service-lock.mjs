import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { RelayError } from './protocol.mjs';

export function serviceLock(directory) {
  const path = join(directory, 'service-lock.sqlite');
  for (let attempt = 0; attempt < 10; attempt++) {
    const db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    try {
      // This database contains no state. Its exclusive transaction is an OS-backed
      // process lock released automatically on crash, before socket cleanup begins.
      db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
      return () => db.close();
    } catch (error) {
      db.close();
      if (error.errcode !== 5 && error.errcode !== 6) throw error;
      // Concurrent first-open can leave both contenders holding transient reader
      // locks. Close before retrying so neither retains an upgrade dependency.
      if (attempt < 9) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + process.pid % 11);
    }
  }
  throw new RelayError('already_running', 'Relay state directory is already owned', 409);
}
