// Combined real Paperclip + real OpenCode model, run inside the isolated image.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { provisionAgent } from '../src/provisioning.mjs';
import { stopRuntime } from '../src/runtimes.mjs';

const base = 'http://127.0.0.1:3100';
const authSource = process.env.OPENCODE_SMOKE_AUTH ?? '/tmp/relay-model-auth.json';
const root = mkdtempSync(join(tmpdir(), 'relay-combined-'));
const home = join(root, 'home');
const workspace = join(root, 'workspace');
mkdirSync(workspace);
mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
mkdirSync(join(home, '.config/opencode'), { recursive: true });
copyFileSync(authSource, join(home, '.local/share/opencode/auth.json'));
chmodSync(join(home, '.local/share/opencode/auth.json'), 0o600);
writeFileSync(join(home, '.config/opencode/opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json',
  model: 'github-copilot/gpt-6-astra', share: 'disabled', autoupdate: false, plugin: [], compaction: { auto: false },
  permission: { bash: 'allow', edit: 'allow', task: 'deny', question: 'deny', external_directory: 'allow' } }));
Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
  XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache') });
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function until(fn) {
  for (let i = 0; i < 720; i++) { const value = await fn(); if (value) return value; await delay(250); }
  throw new Error('Combined live scenario deadline');
}
let service;
let provisioned;
try {
  await api('POST', '/api/adapters/install', { packageName: '/relay', isLocalPath: true });
  const company = await api('POST', '/api/companies', { name: `Relay live native ${Date.now()}` });
  const directory = join(root, 'relay');
  service = await startService({ directory, paperclipUrl: base });
  provisioned = await provisionAgent(service.store, directory, api, { key: 'live-worker', bindingId: 'live-worker',
    companyId: company.id, harness: 'opencode', directory: workspace });
  const task = await api('POST', `/api/companies/${company.id}/issues`, { title: 'Ask region then return fixture subnet',
    assigneeAgentId: provisioned.agentId, description: `This is a bounded coordination test. First read task interactions through Relay. If no answered region question exists, write "Which Azure region?" to ${join(root, 'question.md')}, ask through Relay work ask, and finish this turn. Do not submit on that first turn. Once an answer exists, write a JSON result containing region from the answer and subnetId "fixture://subnet/app" to ${join(root, 'result.md')}. Submit through Relay with candidate fixture:combined-subnet and finish. Do not delegate or provision real resources.` });
  const enable = enabled => api('PATCH', `/api/agents/${provisioned.agentId}`, { runtimeConfig: { heartbeat: { enabled,
    wakeOnDemand: enabled, intervalSec: 0, maxConcurrentRuns: 1 } } });
  await enable(true);
  const first = await api('POST', `/api/agents/${provisioned.agentId}/heartbeat/invoke`, { payload: { taskId: task.id, issueId: task.id } });
  assert.ok(first.id);
  const waiting = await until(() => service.store.runs().find(run => run.settlement?.outcome === 'waiting'));
  await until(async () => (await api('GET', `/api/heartbeat-runs/${first.id}`)).status === 'succeeded');
  await api('POST', `/api/issues/${task.id}/interactions/${waiting.waiting.interactionId}/respond`, {
    answers: [{ questionId: 'answer', optionIds: ['text'], otherText: 'southafricanorth' }],
  });
  const completed = await until(() => service.store.runs().find(run => run.id !== waiting.id && run.settlement?.outcome === 'completed' && run.publication.state === 'recorded'));
  await enable(false);
  await until(async () => (await api('GET', `/api/heartbeat-runs/${completed.request.runId}`)).status === 'succeeded');
  assert.equal(completed.conversationId, waiting.conversationId);
  assert.ok(completed.result.summary.includes('southafricanorth'));
  assert.ok(completed.result.summary.includes('fixture://subnet/app'));
  const comments = await api('GET', `/api/issues/${task.id}/comments`);
  const receipt = comments.filter(comment => comment.body.includes(`herdr-relay:${completed.id}:`));
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].authorAgentId, provisioned.agentId);
  assert.equal(receipt[0].createdByRunId, completed.request.runId);
  await stopRuntime(service.store, provisioned.runtimeKey);
  console.log(JSON.stringify({ backend: 'Paperclip 2026.1001.0', nativeHarness: 'OpenCode 1.18.34',
    model: 'github-copilot/gpt-6-astra', integratedProvisioning: true, nativeQuestionTurn: true,
    automaticNativeContinuation: true, sameConversation: true, answerUsed: true, attributedResultCount: 1,
    ownedRuntimeRetired: true }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, runs: service?.store.runs().map(run => ({ id: run.id,
    native: run.native, waiting: run.waiting?.state, settlement: run.settlement })) }));
  throw error;
} finally {
  if (provisioned && service?.store.operation(`runtime:${provisioned.runtimeKey}`)?.state !== 'retired') {
    const runtime = service.store.operation(`runtime:${provisioned.runtimeKey}`);
    try {
      const descriptor = JSON.parse(readFileSync(join(runtime.directory, 'runtime.json'), 'utf8'));
      const start = readFileSync(`/proc/${descriptor.ownerPid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
      if (start === descriptor.ownerStart) process.kill(-descriptor.ownerPid, 'SIGTERM');
    } catch {}
    await delay(1000);
  }
  await service?.close();
  rmSync(root, { recursive: true, force: true });
  // The default is a disposable copied fixture credential, not the user's source.
  if (!process.env.OPENCODE_SMOKE_AUTH) rmSync(authSource, { force: true });
}
