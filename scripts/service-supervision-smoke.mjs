import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { systemdUnit } from '../src/installation.mjs';
import { call } from '../src/client.mjs';

const root = mkdtempSync(join(tmpdir(), 'relay-systemd-smoke-'));
const name = `herdr-relay-smoke-${randomUUID().slice(0, 8)}.service`;
const path = join(root, name);
const state = join(root, 'state');
const systemctl = args => execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const pid = () => Number(systemctl(['show', name, '--property=MainPID', '--value']).trim());
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    try { const value = await fn(); if (value) return value; } catch {}
    await delay(100);
  }
  throw new Error('Service supervision smoke deadline');
}
let linked = false;
try {
  writeFileSync(path, systemdUnit({ node: process.execPath, cli: fileURLToPath(new URL('../src/cli.mjs', import.meta.url)),
    stateDirectory: state, paperclipUrl: 'http://127.0.0.1:3100' }));
  systemctl(['link', path]);
  linked = true;
  systemctl(['daemon-reload']);
  systemctl(['start', name]);
  const connection = await until(async () => {
    const context = { socketPath: join(state, 'relay.sock'), token: readFileSync(join(state, 'admin-token'), 'utf8').trim() };
    return (await call(context, 'GET', '/health')).status === 'ok' && context;
  });
  const firstPid = pid();
  assert.ok(firstPid > 1);
  const registration = await call(connection, 'POST', '/bindings', { id: 'fixture', companyId: 'fixture-company', agentId: 'fixture-agent',
    harness: 'opencode', instanceId: 'fixture-instance', conversationId: 'fixture-conversation' });
  systemctl(['kill', '--kill-whom=main', '--signal=SIGKILL', name]);
  await until(async () => pid() > 1 && pid() !== firstPid && (await call(connection, 'GET', '/health')).status === 'ok');
  assert.equal((await call({ ...connection, token: registration.token }, 'GET', '/runs')).length, 0);
  assert.equal((await call(connection, 'GET', '/bindings'))[0].id, 'fixture');
  console.log(JSON.stringify({ systemdSupervision: true, coordinatorKilled: true, automaticRestart: true,
    credentialsPreserved: true, bindingPreserved: true, isolatedUnit: true }, null, 2));
} finally {
  if (linked) {
    try { systemctl(['stop', name]); } catch {}
    try { systemctl(['disable', name]); } catch {}
    try { systemctl(['reset-failed', name]); } catch {}
    systemctl(['daemon-reload']);
  }
  rmSync(root, { recursive: true, force: true });
}
