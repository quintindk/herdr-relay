// Run inside the isolated evaluation container. Owns only the Paperclip child
// process it starts, while Relay remains alive across that child's restart.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';

const directory = mkdtempSync(join(tmpdir(), 'relay-recovery-'));
const base = 'http://127.0.0.1:3100';
const dataDir = join(directory, 'paperclip');
let child;
let service;
let logs = '';
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function until(fn, attempts = 240) {
  for (let i = 0; i < attempts; i++) {
    const value = await fn();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Recovery condition did not settle. Server log: ${logs.slice(-3000)}`);
}
async function start(first = false) {
  child = spawn('paperclipai', first
    ? ['onboard', '--yes', '--no-install-service', '--data-dir', dataDir]
    : ['run', '--data-dir', dataDir], {
    env: { ...process.env, PAPERCLIP_RUNNER_ENABLED: 'false' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-10000); });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Paperclip exited: ${logs}`);
    try { return await api('GET', '/api/health'); } catch { return false; }
  });
}
async function stop(crash = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  // Crash the application host only. Its embedded database remains available.
  process.kill(crash ? child.pid : -child.pid, 'SIGKILL');
  await exited;
}
try {
  await start(true);
  const backendContextFile = join(directory, 'backend.json');
  writeFileSync(backendContextFile, JSON.stringify({ localTrusted: true }), { mode: 0o600 });
  service = await startService({ directory: join(directory, 'relay'), paperclipUrl: base, backendContextFile });
  const operator = { socketPath: service.socketPath, token: service.token };
  const contextFile = join(directory, 'operator.json');
  writeFileSync(contextFile, JSON.stringify(operator), { mode: 0o600 });
  await api('POST', '/api/adapters/install', { packageName: '/relay', isLocalPath: true });
  const company = await api('POST', '/api/companies', { name: `Relay recovery ${Date.now()}` });
  const agent = await api('POST', `/api/companies/${company.id}/agents`, {
    name: 'Recovery fixture', adapterType: 'herdr_relay',
    adapterConfig: { relayContextFile: contextFile, bindingId: 'recovery', bindingRevision: 1, timeoutSec: 300 },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } },
  });
  const registration = await call(operator, 'POST', '/bindings', {
    id: 'recovery', companyId: company.id, agentId: agent.id, harness: 'opencode',
    instanceId: 'manual-fixture', conversationId: 'existing-recovery-fixture',
  });
  const worker = { socketPath: service.socketPath, token: registration.token };
  const issue = await api('POST', `/api/companies/${company.id}/issues`, { title: 'Recover in-flight Relay work', assigneeAgentId: agent.id });
  const enable = enabled => api('PATCH', `/api/agents/${agent.id}`, {
    runtimeConfig: { heartbeat: { enabled, wakeOnDemand: enabled, intervalSec: 0, maxConcurrentRuns: 1 } },
  });
  await enable(true);
  const heartbeat = await api('POST', `/api/agents/${agent.id}/heartbeat/invoke`, { reason: 'relay_recovery_smoke', payload: { taskId: issue.id, issueId: issue.id } });
  const run = await until(async () => (await call(worker, 'GET', '/runs'))[0]);
  await enable(false);
  await until(async () => {
    try { return await call(worker, 'GET', `/runs/${run.id}/task`); } catch { return false; }
  });
  await call(worker, 'POST', `/runs/${run.id}/acknowledge`, {});
  assert.equal((await api('GET', `/api/heartbeat-runs/${heartbeat.id}`)).status, 'running');
  await stop(true);
  assert.equal(service.store.run(run.id).nativeState, 'claimed');
  // Pinned Paperclip legacy-controller leases last 60 seconds. Let the crashed
  // host's lease expire before exercising startup orphan reconciliation.
  await delay(61000);
  await start();
  const after = await until(async () => {
    const value = await api('GET', `/api/heartbeat-runs/${heartbeat.id}`);
    return value.status !== 'running' ? value : false;
  });
  // Native work is still reserved despite the host's terminal run status.
  assert.equal(service.store.run(run.id).nativeState, 'claimed');
  await call(worker, 'POST', `/runs/${run.id}/submit`, { key: 'first', summary: 'Result survived Paperclip host restart', candidate: 'fixture:recovery' });
  await delay(1000);
  const comments = await api('GET', `/api/issues/${issue.id}/comments`);
  assert.equal(after.status, 'failed');
  assert.equal(after.errorCode, 'process_lost');
  assert.equal(comments.filter(comment => comment.body.includes(`herdr-relay:${run.id}:`)).length, 0);
  await call(operator, 'POST', `/runs/${run.id}/settle`, { outcome: 'completed', evidence: 'Deterministic worker finished and all fixture effects are known' });
  const recovery = await until(async () => {
    const operation = await call(operator, 'POST', '/backend/recover', { runId: run.id });
    return operation.state === 'recorded' ? operation : false;
  });
  const replacement = { id: recovery.replacementId };
  await until(async () => {
    const backend = await api('GET', `/api/heartbeat-runs/${replacement.id}`);
    if (['failed', 'cancelled', 'timed_out'].includes(backend.status)) throw new Error(`Replacement failed: ${JSON.stringify(backend)}`);
    return service.store.run(run.id).publication.state === 'recorded';
  });
  const recovered = await until(async () => {
    const value = await api('GET', `/api/heartbeat-runs/${replacement.id}`);
    return ['succeeded', 'failed', 'cancelled'].includes(value.status) ? value : false;
  });
  assert.equal(recovered.status, 'succeeded', JSON.stringify(recovered));
  const receipts = (await api('GET', `/api/issues/${issue.id}/comments`)).filter(comment => comment.body.includes(`herdr-relay:${run.id}:`));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].authorAgentId, agent.id);
  assert.equal(receipts[0].createdByRunId, replacement.id);
  console.log(JSON.stringify({ paperclipVersion: '2026.1001.0', nativeHarness: false,
    originalRunId: heartbeat.id, statusAfterRestart: after.status, errorCode: after.errorCode,
    relayRunCount: service.store.runs().length, nativeState: service.store.run(run.id).nativeState,
    publicationState: service.store.run(run.id).publication.state,
    replacementRunId: replacement.id, replacementStatus: recovered.status,
    resultReceipts: receipts.length, correctReplacementAttribution: true,
  }, null, 2));
} finally {
  await stop();
  await service?.close();
}
