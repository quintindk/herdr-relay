// Run against the isolated Paperclip container. Exercises actual interaction
// creation, response and a bounded continuation through the installed adapter.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';

const base = process.env.PAPERCLIP_URL ?? 'http://127.0.0.1:3100';
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function until(fn) {
  for (let i = 0; i < 240; i++) { const value = await fn(); if (value) return value; await delay(250); }
  throw new Error('Question smoke condition did not settle');
}
const directory = mkdtempSync(join(tmpdir(), 'relay-questions-'));
const service = await startService({ directory, paperclipUrl: base });
const operator = { socketPath: service.socketPath, token: service.token };
const contextFile = join(directory, 'operator.json');
writeFileSync(contextFile, JSON.stringify(operator), { mode: 0o600 });
try {
  await api('POST', '/api/adapters/install', { packageName: '/relay', isLocalPath: true });
  const company = await api('POST', '/api/companies', { name: `Relay questions ${Date.now()}` });
  const agent = await api('POST', `/api/companies/${company.id}/agents`, { name: 'Question worker', adapterType: 'herdr_relay',
    adapterConfig: { relayContextFile: contextFile, bindingId: 'worker' },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
  const registration = await call(operator, 'POST', '/bindings', { id: 'worker', companyId: company.id, agentId: agent.id,
    harness: 'opencode', instanceId: 'fixture', conversationId: 'existing-question-conversation' });
  const worker = { socketPath: service.socketPath, token: registration.token };
  const issue = await api('POST', `/api/companies/${company.id}/issues`, { title: 'Clarify region then finish', assigneeAgentId: agent.id });
  await api('PATCH', `/api/agents/${agent.id}`, { runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 } } });
  const first = await api('POST', `/api/agents/${agent.id}/heartbeat/invoke`, { payload: { taskId: issue.id, issueId: issue.id } });
  const run = await until(() => service.store.runs()[0]);
  await call(worker, 'POST', `/runs/${run.id}/acknowledge`, {});
  await call(worker, 'POST', `/runs/${run.id}/ask`, { key: 'region', question: 'Which Azure region?' });
  await until(() => service.store.run(run.id).waiting.state === 'recorded');
  await call(operator, 'POST', `/runs/${run.id}/settle`, { outcome: 'waiting', evidence: 'Deterministic question turn ended' });
  await until(async () => (await api('GET', `/api/heartbeat-runs/${first.id}`)).status === 'succeeded');
  const interactionId = service.store.run(run.id).waiting.interactionId;
  const interaction = (await api('GET', `/api/issues/${issue.id}/interactions`)).find(item => item.id === interactionId);
  assert.equal(interaction.status, 'pending');
  await api('POST', `/api/issues/${issue.id}/interactions/${interactionId}/respond`, {
    answers: [{ questionId: 'answer', optionIds: ['text'], otherText: 'southafricanorth' }],
  });
  const continuation = await until(() => service.store.runs().find(candidate => candidate.id !== run.id));
  assert.equal(continuation.conversationId, run.conversationId);
  const answers = await until(async () => {
    try { return await call(worker, 'GET', `/runs/${continuation.id}/interactions`); } catch { return false; }
  });
  assert.ok(JSON.stringify(answers).includes('southafricanorth'));
  await call(worker, 'POST', `/runs/${continuation.id}/acknowledge`, {});
  await call(worker, 'POST', `/runs/${continuation.id}/submit`, { key: 'answer', summary: 'Used southafricanorth', candidate: 'fixture:region' });
  await until(() => service.store.run(continuation.id).publication.state === 'recorded');
  await call(operator, 'POST', `/runs/${continuation.id}/settle`, { outcome: 'completed', evidence: 'Deterministic continuation ended' });
  await until(async () => (await api('GET', `/api/heartbeat-runs/${continuation.request.runId}`)).status === 'succeeded');
  await api('PATCH', `/api/agents/${agent.id}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
  console.log(JSON.stringify({ backend: 'Paperclip 2026.1001.0', nativeHarness: false, questionCount: 1,
    boundedWaitingRun: true, automaticContinuation: true, sameConversation: true, answerReadThroughRelay: true }, null, 2));
} finally { await service.close(); }
