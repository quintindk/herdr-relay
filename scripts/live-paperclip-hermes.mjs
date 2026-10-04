// Opt-in combined host Hermes + container Paperclip test. The isolated container
// shares only this fixture directory so its adapter can reach Relay's Unix socket.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startService } from '../src/service.mjs';
import { provisionAgent } from '../src/provisioning.mjs';
import { stopRuntime } from '../src/runtimes.mjs';

const sourceHome = homedir();
const install = process.env.HERMES_SMOKE_INSTALL ?? join(sourceHome, '.hermes/hermes-agent');
const root = mkdtempSync('/tmp/opencode/relay-live-hermes-');
const home = join(root, 'home'), hh = join(home, '.hermes'), workspace = join(root, 'workspace');
mkdirSync(workspace);
const installKey = createHash('sha256').update(install).digest('hex').slice(0, 16);
const installDir = join(hh, 'installs', installKey);
mkdirSync(installDir, { recursive: true });
copyFileSync(join(sourceHome, '.hermes/installs', installKey, 'facts.json'), join(installDir, 'facts.json'));
symlinkSync(join(sourceHome, '.hermes/installs', installKey, 'environments'), join(installDir, 'environments'));
copyFileSync(join(sourceHome, '.hermes/auth.json'), join(hh, 'auth.json'));
chmodSync(join(hh, 'auth.json'), 0o600);
writeFileSync(join(hh, 'config.yaml'), `model:\n  default: gpt-6-astra\n  provider: copilot\nterminal:\n  backend: local\n  cwd: ${workspace}\n`);
const container = `relay-live-hermes-${randomUUID().slice(0, 8)}`;
const repository = fileURLToPath(new URL('..', import.meta.url));
const base = 'http://127.0.0.1:3100';
// Refuse to collide with another Paperclip installation on the host network.
try { await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) }); throw new Error('Port 3100 already serves HTTP'); }
catch (error) { if (error.message === 'Port 3100 already serves HTTP') throw error; }
let service, provisioned, started = false;
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function until(fn) {
  for (let i = 0; i < 720; i++) { const value = await fn(); if (value) return value; await delay(250); }
  throw new Error('Combined Hermes scenario deadline');
}
try {
  execFileSync('docker', ['run', '-d', '--init', '--network', 'host', '--name', container,
    '-v', `${root}:${root}`, '-v', `${repository}:/relay:ro`, 'retinue-evaluation:2026-10-03']);
  started = true;
  execFileSync('docker', ['exec', '-d', '-e', 'PAPERCLIP_RUNNER_ENABLED=false', container,
    'paperclipai', 'onboard', '--yes', '--no-install-service', '--data-dir', '/home/node/live-hermes-state']);
  await until(async () => { try { return await api('GET', '/api/health'); } catch { return false; } });
  await api('POST', '/api/adapters/install', { packageName: '/relay', isLocalPath: true });
  const company = await api('POST', '/api/companies', { name: `Relay live Hermes ${Date.now()}` });
  Object.assign(process.env, { HOME: home, HERMES_HOME: hh, HERMES_RUNTIME_DIR: join(sourceHome, '.hermes/tools'),
    HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONPATH: install, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache') });
  const directory = join(root, 'relay');
  service = await startService({ directory, paperclipUrl: base });
  provisioned = await provisionAgent(service.store, directory, api, { key: 'hermes-live', companyId: company.id,
    bindingId: 'hermes-live', harness: 'hermes', directory: workspace,
    model: { providerID: 'copilot', modelID: 'gpt-6-astra' } });
  const task = await api('POST', `/api/companies/${company.id}/issues`, { title: 'Hermes question and continuation',
    assigneeAgentId: provisioned.agentId,
    description: `Read Relay task interactions. If no region answer exists, write a question to ${join(root, 'question.md')}, ask which Azure region through Relay work ask and end this turn without submitting. When an answer exists, write JSON with the answered region and subnetId "fixture://hermes/subnet" to ${join(root, 'result.md')}. Submit through Relay with candidate fixture:hermes-live. Do not delegate or create real resources.` });
  await api('PATCH', `/api/agents/${provisioned.agentId}`, { runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 } } });
  const first = await api('POST', `/api/agents/${provisioned.agentId}/heartbeat/invoke`, { payload: { taskId: task.id, issueId: task.id } });
  assert.ok(first.id);
  const waiting = await until(() => service.store.runs().find(run => run.settlement?.outcome === 'waiting'));
  await until(async () => (await api('GET', `/api/heartbeat-runs/${first.id}`)).status === 'succeeded');
  await api('POST', `/api/issues/${task.id}/interactions/${waiting.waiting.interactionId}/respond`, {
    answers: [{ questionId: 'answer', optionIds: ['text'], otherText: 'southafricanorth' }],
  });
  const completed = await until(() => service.store.runs().find(run => run.id !== waiting.id && run.settlement?.outcome === 'completed' && run.publication.state === 'recorded'));
  assert.equal(completed.conversationId, waiting.conversationId);
  assert.ok(completed.result.summary.includes('southafricanorth'));
  await api('PATCH', `/api/agents/${provisioned.agentId}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
  await until(async () => (await api('GET', `/api/heartbeat-runs/${completed.request.runId}`)).status === 'succeeded');
  const receipts = (await api('GET', `/api/issues/${task.id}/comments`)).filter(comment => comment.body.includes(`herdr-relay:${completed.id}:`));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].authorAgentId, provisioned.agentId);
  assert.equal(receipts[0].createdByRunId, completed.request.runId);
  await stopRuntime(service.store, provisioned.runtimeKey);
  console.log(JSON.stringify({ backend: 'Paperclip 2026.1001.0', nativeHarness: 'Hermes 0.21.5+2164.gfdec926',
    model: 'copilot/gpt-6-astra', integratedProvisioning: true, nativeQuestionTurn: true,
    automaticNativeContinuation: true, sameConversation: true, answerUsed: true,
    attributedResultCount: 1, ownedRuntimeRetired: true }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, runs: service?.store.runs().map(run => ({ id: run.id, native: run.native, waiting: run.waiting?.state })) }));
  throw error;
} finally {
  const runtimes = service?.store.db.prepare("SELECT data FROM operations WHERE id LIKE 'runtime:%'").all().map(row => JSON.parse(row.data)) ?? [];
  for (const runtime of runtimes.filter(runtime => runtime.state !== 'retired')) {
    try {
      const descriptor = JSON.parse(readFileSync(join(runtime.directory, 'runtime.json'), 'utf8'));
      const start = readFileSync(`/proc/${descriptor.ownerPid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
      if (start === descriptor.ownerStart) process.kill(-descriptor.ownerPid, 'SIGTERM');
    } catch {}
    await delay(1000);
  }
  await service?.close();
  if (started) execFileSync('docker', ['stop', container]);
  rmSync(root, { recursive: true, force: true });
}
