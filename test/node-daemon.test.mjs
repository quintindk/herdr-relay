import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startBackend } from '../src/backend-service.mjs';

test('real node daemon starts, stops, restarts offline from pinned identity and preserves its journal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-daemon-'));
  const state = join(root, 'node'); mkdirSync(state);
  let backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const owner = backend.store.authenticate(backend.store.bootstrap().token);
  backend.store.command(owner, { key: 'node', action: 'node.enrol', payload: { id: 'node', name: 'Node' } });
  const token = backend.store.enrolCredential(owner, 'node', 'credential').token;
  const configPath = join(root, 'node.json');
  writeFileSync(configPath, JSON.stringify({ nodeId: 'node', stateDirectory: state, backend: { url: backend.origin, token }, bindings: [] }), { mode: 0o600 });
  let child;
  const launch = async () => {
    child = spawn(process.execPath, [resolve('src/node-cli.mjs'), '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    for (let i = 0; i < 100 && !log.includes('"state":"running"'); i++) {
      if (child.exitCode !== null) throw new Error(log);
      await delay(25);
    }
    assert.match(log, /"state":"running"/);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  };
  try {
    await launch();
    assert.ok(existsSync(join(state, 'node.sqlite')));
    await stop();
    assert.equal(existsSync(join(state, 'node.sock')), false);
    await backend.close(); backend = null;
    await launch();
    await stop();
  } finally { await stop(); await backend?.close(); rmSync(root, { recursive: true, force: true }); }
});
