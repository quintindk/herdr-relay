#!/usr/bin/env node
import { backup, DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireValue } from './protocol.mjs';

try {
  process.umask(0o077);
  const { values } = parseArgs({ options: { database: { type: 'string' }, output: { type: 'string' } } });
  requireValue(values.database && values.output, 'invalid_request', 'Use --database PATH --output NEW_PATH');
  const source = resolve(values.database), destination = resolve(values.output);
  requireValue(existsSync(source) && !existsSync(destination) && source !== destination, 'backup_conflict', 'Existing source and new destination required');
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, destination); chmodSync(destination, 0o600); }
  finally { db.close(); }
  const check = new DatabaseSync(destination, { readOnly: true });
  try { requireValue(check.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'backup_invalid', 'Backup integrity check failed'); }
  finally { check.close(); }
  console.log(JSON.stringify({ state: 'verified', backup: destination }));
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'backup_failed', message: error.message })); process.exitCode = 1;
}
