// Run inside the isolated evaluation image with this repository mounted at /relay.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';

const base = process.env.PAPERCLIP_URL ?? 'http://127.0.0.1:3100';
const evidence = { adapter: 'herdr_relay', nativeHarness: false, checks: [] };
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function until(fn) {
  for (let i = 0; i < 240; i++) {
    const result = await fn();
    if (result) return result;
    await delay(250);
  }
  throw new Error('Smoke condition did not settle');
}

const directory = mkdtempSync(join(tmpdir(), 'relay-smoke-'));
const service = await startService({ directory, paperclipUrl: base });
const operator = { socketPath: service.socketPath, token: service.token };
const contextFile = join(directory, 'operator.json');
writeFileSync(contextFile, JSON.stringify(operator), { mode: 0o600 });
try {
  const installed = await api('POST', '/api/adapters/install', { packageName: '/relay', isLocalPath: true });
  evidence.checks.push({ check: 'external package installed', type: installed.type ?? installed.adapter?.type });
  const company = await api('POST', '/api/companies', { name: `Relay smoke ${Date.now()}` });
  for (const harness of ['opencode', 'hermes']) {
    const bindingId = `smoke-${harness}`;
    const agent = await api('POST', `/api/companies/${company.id}/agents`, {
      name: `Relay ${harness}`, adapterType: 'herdr_relay',
      adapterConfig: { relayContextFile: contextFile, bindingId, bindingRevision: 1, timeoutSec: 30 },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } },
    });
    const registration = await call(operator, 'POST', '/bindings', {
      id: bindingId, agentId: agent.id, companyId: company.id, harness,
      instanceId: 'manual-fixture', conversationId: `existing-${harness}-fixture`,
    });
    const worker = { socketPath: service.socketPath, token: registration.token };
    const issue = await api('POST', `/api/companies/${company.id}/issues`, { title: `Relay ${harness} receipt fixture`, assigneeAgentId: agent.id });
    await api('PATCH', `/api/agents/${agent.id}`, { runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 } } });
    const heartbeat = await api('POST', `/api/agents/${agent.id}/heartbeat/invoke`, {
      reason: 'relay_adapter_smoke', payload: { taskId: issue.id, issueId: issue.id },
    });
    const run = await until(async () => (await call(worker, 'GET', '/runs'))[0]);
    await api('PATCH', `/api/agents/${agent.id}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
    const task = await until(async () => {
      try { return await call(worker, 'GET', `/runs/${run.id}/task`); } catch { return null; }
    });
    assert.equal(task.id, issue.id);
    await call(worker, 'POST', `/runs/${run.id}/acknowledge`, {});
    const payload = { key: 'first', summary: 'Deterministic Relay adapter smoke submission', candidate: 'fixture:v1' };
    await call(worker, 'POST', `/runs/${run.id}/submit`, payload);
    await call(worker, 'POST', `/runs/${run.id}/submit`, payload);
    await until(async () => (await call(worker, 'GET', `/runs/${run.id}`)).publication.state === 'recorded');
    const before = await api('GET', `/api/heartbeat-runs/${heartbeat.id}`);
    assert.equal(before.status, 'running');
    await call(operator, 'POST', `/runs/${run.id}/settle`, { outcome: 'completed', evidence: 'Deterministic fixture has finished its explicit CLI protocol' });
    const end = await until(async () => {
      const current = await api('GET', `/api/heartbeat-runs/${heartbeat.id}`);
      return ['succeeded', 'failed', 'cancelled'].includes(current.status) ? current : null;
    });
    assert.equal(end.status, 'succeeded', JSON.stringify(end));
    const comments = await api('GET', `/api/issues/${issue.id}/comments`);
    const receipts = comments.filter(comment => comment.body.includes(`herdr-relay:${run.id}:`));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].authorAgentId, agent.id);
    assert.equal(receipts[0].createdByRunId, heartbeat.id);
    assert.equal((await api('GET', `/api/agents/${agent.id}`)).reportsTo, null);
    evidence.checks.push({ check: `${harness} configured binding`, companyId: company.id, agentId: agent.id, runId: heartbeat.id,
      relayRunId: run.id, issueId: issue.id, commentId: receipts[0].id,
      adapterRun: end.status, heldUntilSettlement: true, receiptCount: receipts.length });
  }
  console.log(JSON.stringify(evidence, null, 2));
} finally { await service.close(); }
