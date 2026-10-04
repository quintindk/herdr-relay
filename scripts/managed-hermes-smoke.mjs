import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { launchRuntime, stopRuntime } from '../src/runtimes.mjs';
import { Hermes } from '../src/hermes.mjs';
import { call } from '../src/client.mjs';

const sourceHome = homedir();
const install = process.env.HERMES_SMOKE_INSTALL ?? join(sourceHome, '.hermes/hermes-agent');
const root = mkdtempSync(join(process.env.HERMES_SMOKE_TMP ?? tmpdir(), 'relay-owned-hermes-'));
const home = join(root, 'home');
const hh = join(home, '.hermes');
const workspace = join(root, 'workspace');
mkdirSync(workspace);
const installKey = createHash('sha256').update(install).digest('hex').slice(0, 16);
const installDir = join(hh, 'installs', installKey);
mkdirSync(installDir, { recursive: true });
copyFileSync(join(sourceHome, '.hermes/installs', installKey, 'facts.json'), join(installDir, 'facts.json'));
symlinkSync(join(sourceHome, '.hermes/installs', installKey, 'environments'), join(installDir, 'environments'));
copyFileSync(join(sourceHome, '.hermes/auth.json'), join(hh, 'auth.json'));
chmodSync(join(hh, 'auth.json'), 0o600);
writeFileSync(join(hh, 'config.yaml'), `model:\n  default: gpt-6-astra\n  provider: copilot\nterminal:\n  backend: local\n  cwd: ${workspace}\n`);
Object.assign(process.env, { HOME: home, HERMES_HOME: hh, HERMES_RUNTIME_DIR: join(sourceHome, '.hermes/tools'),
  HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONPATH: install, XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache') });
let service;
let runtime;
let native;
async function until(fn) {
  for (let i = 0; i < 900; i++) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error('Managed Hermes smoke deadline');
}
try {
  const directory = join(root, 'relay');
  service = await startService({ directory, paperclipUrl: 'http://paperclip.test', api: async () => ({ companyId: 'company',
    title: 'Cancellation fixture', description: 'After acknowledgement run sleep 120 as a foreground terminal command. Do not submit or delegate. Cancellation will interrupt this fixture.' }) });
  runtime = await launchRuntime(service.store, directory, { key: 'owned', directory: workspace, harness: 'hermes' });
  const config = { url: `ws://127.0.0.1:${runtime.port}/api/ws`, authFile: join(runtime.directory, 'gateway-token'),
    directory: workspace, runtimeId: 'pending', epoch: 'pending', exclusive: true, runtimeKey: 'owned' };
  native = new Hermes({ hermes: config, conversationId: 'pending' });
  const session = await native.request('session.create', { cwd: workspace, title: 'Relay owned Hermes cancellation', model: 'gpt-6-astra', provider: 'copilot' });
  config.runtimeId = session.session_id;
  config.epoch = (await native.request('session.events.since', { last_seen: 0 })).epoch;
  native.sessionId = session.stored_session_id;
  const operator = { socketPath: service.socketPath, token: service.token };
  await call(operator, 'POST', '/bindings', { id: 'worker', companyId: 'company', agentId: 'agent', harness: 'hermes',
    instanceId: runtime.nonce, conversationId: session.stored_session_id, delivery: 'hermes', hermes: config });
  const run = await call(operator, 'POST', '/runs', { bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  await call(operator, 'POST', `/runs/${run.id}/attach`, { token: 'fixture-token' });
  await until(() => service.store.run(run.id).deliveryState === 'acknowledged');
  await delay(5000);
  await assert.rejects(stopRuntime(service.store, 'owned'), { code: 'runtime_busy' });
  await call(operator, 'POST', `/runs/${run.id}/cancel`, {});
  await until(() => service.store.run(run.id).nativeState === 'settled');
  assert.equal(service.store.run(run.id).settlement.outcome, 'cancelled');
  assert.ok(service.store.run(run.id).interruption);
  assert.equal((await native.snapshot()).session.session_id, session.session_id);
  await stopRuntime(service.store, 'owned');
  console.log(JSON.stringify({ realModel: 'copilot/gpt-6-astra', ownedHermesRuntime: true,
    cancellationObserved: true, conversationPreservedBeforeRetirement: true, retirementVerified: true }, null, 2));
} catch (error) {
  if (native) {
    try {
      const snapshot = await native.snapshot();
      console.error(JSON.stringify({ idle: snapshot.idle, rows: snapshot.session.messages.map(message => ({ role: message.role, rowId: message.row_id, text: message.role === 'assistant' ? message.text : undefined })),
        terminals: snapshot.events.events.filter(event => event.type === 'message.complete').map(event => ({ seq: event.seq, payload: event.payload })) }));
    } catch {}
  }
  console.error(JSON.stringify({ error: error.message, runs: service?.store.runs().map(run => ({ native: run.native, interruption: run.interruption })) }));
  throw error;
} finally {
  if (runtime && service?.store.operation('runtime:owned')?.state !== 'retired') {
    try {
      const descriptor = JSON.parse(readFileSync(join(runtime.directory, 'runtime.json'), 'utf8'));
      const start = readFileSync(`/proc/${descriptor.ownerPid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
      if (start === descriptor.ownerStart) process.kill(-descriptor.ownerPid, 'SIGTERM');
    } catch {}
    await delay(1000);
  }
  await service?.close();
  rmSync(root, { recursive: true, force: true });
}
