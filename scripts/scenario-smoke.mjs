// End-to-end integration scenarios against isolated real Paperclip. Worker
// reasoning and external inbox/Azure data are deterministic fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { candidate } from '../src/candidate.mjs';

const base = process.env.PAPERCLIP_URL ?? 'http://127.0.0.1:3100';
const root = mkdtempSync(join(tmpdir(), 'relay-scenarios-'));
const evidence = { backend: 'Paperclip 2026.1001.0', nativeHarness: false, scenarios: [] };
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function until(fn) {
  for (let i = 0; i < 240; i++) { const value = await fn(); if (value) return value; await delay(250); }
  throw new Error('Scenario condition did not settle');
}
const backendContextFile = join(root, 'backend.json');
writeFileSync(backendContextFile, JSON.stringify({ localTrusted: true }), { mode: 0o600 });
const service = await startService({ directory: join(root, 'relay'), paperclipUrl: base, backendContextFile });
const operator = { socketPath: service.socketPath, token: service.token };
const operatorFile = join(root, 'operator.json');
writeFileSync(operatorFile, JSON.stringify(operator), { mode: 0o600 });
const agents = [];
const enable = (agent, enabled) => api('PATCH', `/api/agents/${agent.id}`, {
  runtimeConfig: { heartbeat: { enabled, wakeOnDemand: enabled, intervalSec: 0, maxConcurrentRuns: 1 } },
});
async function createAgent(company, id, options = {}) {
  const agent = await api('POST', `/api/companies/${company.id}/agents`, { name: id, adapterType: 'herdr_relay',
    adapterConfig: { relayContextFile: operatorFile, bindingId: id },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
  agents.push(agent);
  const registration = await call(operator, 'POST', '/bindings', { id, companyId: company.id, agentId: agent.id,
    harness: 'opencode', instanceId: 'scenario-fixture', conversationId: `conversation-${id}`, ...options });
  assert.equal(agent.reportsTo, null);
  return { ...agent, bindingId: id, connection: { socketPath: service.socketPath, token: registration.token } };
}
async function invoke(agent, task) {
  await enable(agent, true);
  const heartbeat = await api('POST', `/api/agents/${agent.id}/heartbeat/invoke`, { payload: { taskId: task.id, issueId: task.id } });
  assert.ok(heartbeat.id, JSON.stringify(heartbeat));
  const run = await until(() => service.store.runs(agent.bindingId).find(run => run.request.runId === heartbeat.id));
  await enable(agent, false);
  await until(async () => { try { return await call(agent.connection, 'GET', `/runs/${run.id}/task`); } catch { return false; } });
  await call(agent.connection, 'POST', `/runs/${run.id}/acknowledge`, {});
  return run;
}
async function finish(agent, run, summary, id) {
  await call(agent.connection, 'POST', `/runs/${run.id}/submit`, { key: 'result', summary, candidate: id });
  await until(() => service.store.run(run.id).publication.state === 'recorded');
  await call(operator, 'POST', `/runs/${run.id}/settle`, { outcome: 'completed', evidence: 'Scenario fixture native work finished' });
  await until(async () => (await api('GET', `/api/heartbeat-runs/${run.request.runId}`)).status === 'succeeded');
}
async function cancel(run) {
  await call(operator, 'POST', `/runs/${run.id}/cancel`, {});
  await call(operator, 'POST', `/runs/${run.id}/settle`, { outcome: 'cancelled', evidence: 'Scenario fixture stopped its bounded work' });
}
try {
  await api('POST', '/api/adapters/install', { packageName: '/relay', isLocalPath: true });
  const company = await api('POST', '/api/companies', { name: `Relay full scenarios ${Date.now()}` });
  const driver = await createAgent(company, 'daily-driver');
  const monitor = await createAgent(company, 'monitor', { lifetime: 'service' });
  const project = await createAgent(company, 'project');
  const brief = await api('POST', `/api/companies/${company.id}/issues`, { title: 'Monitor fixture inbox during window', assigneeAgentId: monitor.id });
  await enable(monitor, true);
  const startsAt = new Date().toISOString();
  await call(operator, 'POST', '/schedules', { key: 'window', bindingId: monitor.bindingId, taskId: brief.id,
    startsAt, endsAt: new Date(Date.now() + 120000).toISOString(), intervalSec: 60 });
  const monitorRun = await until(() => service.store.runs(monitor.bindingId)[0]);
  assert.equal(service.store.operation('schedule:window').request.taskId, monitorRun.request.taskId);
  await call(operator, 'POST', '/schedules/stop', { key: 'window' });
  await enable(monitor, false);
  await call(monitor.connection, 'POST', `/runs/${monitorRun.id}/acknowledge`, {});
  for (const [index, summary] of ['Irrelevant fixture newsletter', 'Human must confirm budget', 'Project demo needs an update'].entries()) {
    const event = { source: 'fixture-inbox', eventId: `message-${index}`, cursor: String(index + 1),
      expectedCursor: index === 0 ? null : String(index), recipient: driver.bindingId, summary, reference: `fixture://inbox/${index}` };
    const first = await call(monitor.connection, 'POST', '/events', event);
    assert.equal((await call(monitor.connection, 'POST', '/events', event)).id, first.id);
  }
  assert.equal((await call(driver.connection, 'GET', '/inbox')).length, 3);
  await finish(monitor, monitorRun, 'Processed three fixture events', 'fixture:cursor-3');
  const driverTask = await api('POST', `/api/companies/${company.id}/issues`, { title: 'Triage fixture events', assigneeAgentId: driver.id });
  const driverRun = await invoke(driver, driverTask);
  const humanTask = await call(driver.connection, 'POST', `/runs/${driverRun.id}/mutate`, { key: 'human-event', kind: 'task.create',
    payload: { title: 'Confirm demo budget', assigneeUserId: 'local-board' } });
  const projectTask = await call(driver.connection, 'POST', `/runs/${driverRun.id}/mutate`, { key: 'project-event', kind: 'task.create',
    payload: { title: 'Update demo project', assigneeAgentId: project.id } });
  assert.equal(humanTask.receipt.assigneeUserId, 'local-board');
  const projectRun = await invoke(project, projectTask.receipt);
  await finish(project, projectRun, 'Project update fixture completed', 'fixture:project');
  await finish(driver, driverRun, 'Human action and project result presented', 'fixture:triage');
  evidence.scenarios.push({ name: 'monitoring', sourceEvents: 3, duplicateEvents: 0, tasksCreated: 2,
    humanOwnedTask: true, independentProjectResult: true, boundedScheduleStopped: true });

  const demo = await createAgent(company, 'demo');
  const provider = await createAgent(company, 'landing-zone');
  const demoTask = await api('POST', `/api/companies/${company.id}/issues`, { title: 'Deploy demo with provider subnet', assigneeAgentId: demo.id });
  const demoRun = await invoke(demo, demoTask);
  const subnet = (await call(demo.connection, 'POST', `/runs/${demoRun.id}/mutate`, { key: 'subnet-request', kind: 'task.create',
    payload: { title: 'Vend fixture subnet', assigneeAgentId: provider.id } })).receipt;
  const providerRun = await invoke(provider, subnet);
  await call(provider.connection, 'POST', `/runs/${providerRun.id}/ask`, { key: 'region', question: 'Which region?', addresseeAgentId: demo.id });
  await until(() => service.store.run(providerRun.id).waiting.state === 'recorded');
  await call(operator, 'POST', `/runs/${providerRun.id}/settle`, { outcome: 'waiting', evidence: 'Provider question turn ended' });
  await until(async () => (await api('GET', `/api/heartbeat-runs/${providerRun.request.runId}`)).status === 'succeeded');
  const interaction = service.store.run(providerRun.id).waiting.interactionId;
  await call(demo.connection, 'POST', `/runs/${demoRun.id}/mutate`, { key: 'region-answer', kind: 'question.answer',
    taskId: subnet.id, interactionId: interaction,
    payload: { answers: [{ questionId: 'answer', optionIds: ['text'], otherText: 'southafricanorth' }] } });
  const providerContinuation = await invoke(provider, subnet);
  const answers = await call(provider.connection, 'GET', `/runs/${providerContinuation.id}/interactions`);
  assert.ok(JSON.stringify(answers).includes('southafricanorth'));
  const fakeSubnet = '/subscriptions/fixture/resourceGroups/demo/providers/Microsoft.Network/virtualNetworks/demo/subnets/app';
  await finish(provider, providerContinuation, JSON.stringify({ id: fakeSubnet, region: 'southafricanorth' }), 'fixture:subnet');
  const comments = await api('GET', `/api/issues/${subnet.id}/comments`);
  assert.ok(comments.some(comment => comment.body.includes(fakeSubnet)));
  await finish(demo, demoRun, `Verified fixture subnet ${fakeSubnet}`, 'fixture:demo');
  assert.equal(service.store.binding(provider.bindingId).lifecycleState, undefined);
  evidence.scenarios.push({ name: 'subnet-request', independentAgents: true, clarification: true, fakeResource: true,
    resultVerified: true, providerPreserved: true });

  const graphTask = await api('POST', `/api/companies/${company.id}/issues`, { title: 'Update graph with reviewed candidate' });
  const worker = await createAgent(company, 'graph-worker', { lifetime: 'task', taskId: graphTask.id,
    controllerBindingId: driver.bindingId, worktreeKey: 'graph' });
  const repository = join(root, 'repository');
  execFileSync('git', ['init', '-q', repository]);
  writeFileSync(join(repository, 'graph.json'), '{"nodes":[]}\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Relay Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Relay Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  // Fixture-only author environment, never mutates Git configuration.
  Object.assign(process.env, { GIT_AUTHOR_NAME: gitEnv.GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL: gitEnv.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: gitEnv.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: gitEnv.GIT_COMMITTER_EMAIL });
  execFileSync('git', ['-C', repository, 'add', '.']);
  execFileSync('git', ['-C', repository, 'commit', '-qm', 'Initial fixture'], { env: gitEnv });
  const worktree = join(root, 'graph-worker');
  await call(operator, 'POST', '/resources/worktree', { key: 'graph', repository, path: worktree, branch: 'graph-worker', bindingId: worker.bindingId });
  await api('PATCH', `/api/issues/${graphTask.id}`, { assigneeAgentId: worker.id });
  const firstAttempt = await invoke(worker, graphTask);
  writeFileSync(join(worktree, 'graph.json'), '{"nodes":["first"]}\n');
  const firstCandidate = candidate(worktree).id;
  await finish(worker, firstAttempt, 'First graph candidate', firstCandidate);
  await api('PATCH', `/api/issues/${graphTask.id}`, { assigneeAgentId: driver.id });
  const firstReview = await invoke(driver, graphTask);
  const requestReview = { runId: firstAttempt.id, candidate: firstCandidate, action: 'request', reviewerUserId: 'local-board' };
  const reviewReceipt = await call(driver.connection, 'POST', `/runs/${firstReview.id}/review`, requestReview);
  await api('POST', `/api/issues/${graphTask.id}/interactions/${reviewReceipt.review.interactionId}/reject`, { reason: 'Use final node name' });
  await call(driver.connection, 'POST', `/runs/${firstReview.id}/review`, { ...requestReview, action: 'inspect' });
  await cancel(firstReview);
  await until(async () => (await api('GET', `/api/heartbeat-runs/${firstReview.request.runId}`)).status !== 'running');
  const reviewRecovery = await api('GET', `/api/issues/${graphTask.id}/recovery-actions`);
  if (reviewRecovery.active) await api('POST', `/api/issues/${graphTask.id}/recovery-actions/resolve`, {
    actionId: reviewRecovery.active.id, outcome: 'restored', sourceIssueStatus: 'todo',
    executionReconciliation: { runId: firstReview.request.runId, providerStopped: true, actionOutcome: 'completed',
      outcomeEvidence: 'The deterministic review fixture stopped. Its sole effect was the recorded candidate rejection.' },
  });
  await api('PATCH', `/api/issues/${graphTask.id}`, { assigneeAgentId: worker.id });
  const corrected = await invoke(worker, graphTask);
  writeFileSync(join(worktree, 'graph.json'), '{"nodes":["final"]}\n');
  const finalCandidate = candidate(worktree).id;
  await finish(worker, corrected, 'Corrected graph and verified JSON', finalCandidate);
  await api('PATCH', `/api/issues/${graphTask.id}`, { assigneeAgentId: driver.id });
  const finalReview = await invoke(driver, graphTask);
  await assert.rejects(call(driver.connection, 'POST', `/runs/${finalReview.id}/review`, { ...requestReview, action: 'accept' }), { code: 'stale_candidate' });
  assert.deepEqual(JSON.parse(readFileSync(join(worktree, 'graph.json'), 'utf8')), { nodes: ['final'] });
  const finalised = await call(operator, 'POST', '/resources/finalise', { key: 'graph', runId: corrected.id, candidate: finalCandidate, message: 'Update reviewed graph' });
  const finalRequest = { runId: corrected.id, candidate: finalCandidate, action: 'request', reviewerUserId: 'local-board' };
  const finalReceipt = await call(driver.connection, 'POST', `/runs/${finalReview.id}/review`, finalRequest);
  await api('POST', `/api/issues/${graphTask.id}/interactions/${finalReceipt.review.interactionId}/accept`, {});
  writeFileSync(join(worktree, 'keep.txt'), 'Untracked work must survive');
  const accepted = await call(driver.connection, 'POST', `/runs/${finalReview.id}/review`, { ...finalRequest, action: 'inspect' });
  assert.equal(accepted.review.status, 'accepted');
  assert.ok(existsSync(worktree));
  assert.equal(service.store.operation(`retirement:${corrected.id}`).reason, 'dirty_cleanup_blocked');
  rmSync(join(worktree, 'keep.txt'));
  await call(driver.connection, 'POST', `/runs/${finalReview.id}/retire`, { runId: corrected.id });
  assert.equal(existsSync(worktree), false);
  assert.equal(service.store.binding(worker.bindingId).lifecycleState, 'retired');
  assert.equal(service.store.binding(driver.bindingId).lifecycleState, undefined);
  assert.equal(execFileSync('git', ['-C', repository, 'rev-parse', 'graph-worker'], { encoding: 'utf8' }).trim(), finalised.commit);
  await call(driver.connection, 'POST', `/runs/${finalReview.id}/mutate`, { key: 'complete-graph', kind: 'task.update', payload: { status: 'done' } });
  assert.equal((await api('GET', `/api/issues/${graphTask.id}`)).status, 'done');
  await cancel(finalReview);
  evidence.scenarios.push({ name: 'worktree-review', corrections: true, staleAcceptanceRejected: true,
    candidateVerified: true, committedBeforeAcceptance: true, dirtyCleanupBlocked: true,
    acceptedStatePreserved: true, workerRetired: true, worktreeRemoved: true, commitRetained: true, backendTaskDone: true });
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const agent of agents) { try { await enable(agent, false); } catch {} }
  await service.close();
  rmSync(root, { recursive: true, force: true });
}
