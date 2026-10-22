#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { BackendStore } from './backend-store.mjs';
import { startBackend } from './backend-service.mjs';
import { requireValue } from './protocol.mjs';
import { serviceLock } from './service-lock.mjs';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  'state-dir': { type: 'string' }, config: { type: 'string' }, port: { type: 'string' }, user: { type: 'string' },
} });
try {
  requireValue(['init', 'serve'].includes(positionals[0]) && values['state-dir'], 'invalid_request',
    'Usage: node src/backend-cli.mjs init|serve --state-dir DIR [--config FILE] [--port PORT] [--user ID]');
  const directory = resolve(values['state-dir']);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = join(directory, 'backend.sqlite');
  const userId = values.user ?? 'owner';
  if (positionals[0] === 'init') {
    const path = join(directory, 'owner.json');
    requireValue(!existsSync(path), 'already_bootstrapped', 'Owner context already exists');
    const store = new BackendStore(database, { userId });
    try {
      const credential = store.bootstrap();
      writeFileSync(path, `${JSON.stringify({ protocol: 'relay/0.2', userId, token: credential.token })}\n`, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ state: 'initialised', database, ownerContext: path }));
    } finally { store.close(); }
  } else {
    const config = values.config ? JSON.parse(readFileSync(resolve(values.config), 'utf8')) : {};
    requireValue(Object.keys(config).every(key => key === 'ingressKeys') &&
      (config.ingressKeys === undefined || Array.isArray(config.ingressKeys) && config.ingressKeys.length > 0 &&
      config.ingressKeys.every(key => typeof key === 'string' && key.length >= 16)), 'invalid_config', 'Only ingressKeys are supported');
    const port = Number(values.port ?? 3210);
    requireValue(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid_config', 'Invalid port');
    const unlock = serviceLock(directory);
    let backend;
    try { backend = await startBackend({ database, userId, port, ingressKeys: config.ingressKeys, maintenanceFile: join(directory, 'maintenance.json') }); }
    catch (error) { unlock(); throw error; }
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void backend.close().finally(unlock).then(() => { process.exitCode = 0; });
    };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    console.log(JSON.stringify({ state: 'listening', origin: backend.origin, protocol: 'relay/0.2' }));
  }
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'backend_failed', message: error.message }));
  process.exitCode = 1;
}
