#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { requireValue } from '../src/protocol.mjs';
import { serviceLock } from '../src/service-lock.mjs';
import { planTaskIdentityMigration, migrateTaskIdentity } from '../src/task-identity-migration.mjs';

try {
  const { values } = parseArgs({ options: { 'state-dir': { type: 'string' }, backup: { type: 'string' }, apply: { type: 'boolean' } } });
  requireValue(values['state-dir'], 'invalid_request', 'Usage: migrate-task-references --state-dir DIR [--apply --backup NEW_SQLITE]');
  requireValue(values.apply || !values.backup, 'invalid_request', '--backup is only valid with --apply');
  const directory = resolve(values['state-dir']), database = join(directory, 'backend.sqlite');
  let result;
  if (values.apply) {
    requireValue(existsSync(database), 'migration_state_missing', 'An existing initialised backend database is required');
    requireValue(!existsSync(join(directory, 'maintenance.json')), 'maintenance', 'Resolve the existing service maintenance operation before migrating task references');
    const unlock = serviceLock(directory);
    try { result = migrateTaskIdentity(database, { backup: values.backup }); }
    finally { unlock(); }
  } else result = planTaskIdentityMigration(database);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'migration_failed', message: error.message }));
  process.exitCode = 1;
}
