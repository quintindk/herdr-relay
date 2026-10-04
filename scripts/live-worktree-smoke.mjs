// Combined real Paperclip/OpenCode/Git test inside the isolated evaluation image.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { provisionAgent } from '../src/provisioning.mjs';
import { candidate } from '../src/candidate.mjs';
import { call } from '../src/client.mjs';
import { digest } from '../src/protocol.mjs';

const base = 'http://127.0.0.1:3100';
const root = mkdtempSync(join(tmpdir(), 'relay-live-graph-'));
const home = join(root, 'home'), repository = join(root, 'repository'), worktree = join(root, 'worker');
mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
mkdirSync(join(home, '.config/opencode'), { recursive: true });
const authSource = process.env.OPENCODE_SMOKE_AUTH ?? '/tmp/relay-model-auth.json';
copyFileSync(authSource, join(home, '.local/share/opencode/auth.json'));
chmodSync(join(home, '.local/share/opencode/auth.json'), 0o600);
writeFileSync(join(home, '.config/opencode/opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json',
  model: 'github-copilot/gpt-6-astra', autoupdate: false, share: 'disabled', plugin: [], compaction: { auto: false },
  permission: { bash: 'allow', edit: 'allow', task: 'deny', question: 'deny', external_directory: 'allow' } }));
Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
  XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'),
  GIT_AUTHOR_NAME: 'Relay Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Relay Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
execFileSync('git', ['init', '-q', repository]);
writeFileSync(join(repository, 'graph.json'), '{"nodes":[]}\n');
execFileSync('git', ['-C', repository, 'add', '.']);
execFileSync('git', ['-C', repository, 'commit', '-qm', 'Initial graph fixture']);
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function until(fn) {
  for (let i = 0; i < 960; i++) { const value = await fn(); if (value) return value; await delay(250); }
  throw new Error('Live graph scenario deadline');
}
const backendContextFile = join(root, 'backend.json');
writeFileSync(backendContextFile, JSON.stringify({ localTrusted: true }), { mode: 0o600 });
let service, worker;
try {
  await until(async () => { try { return await api('GET', '/api/health'); } catch { return false; } });
  await api('POST', '/api/adapters/install', { packageName: '/relay', isLocalPath: true });
  const company = await api('POST', '/api/companies', { name: `Relay live graph ${Date.now()}` });
  service = await startService({ directory: join(root, 'relay'), paperclipUrl: base, backendContextFile });
  const operator = { socketPath: service.socketPath, token: service.token };
  const operatorFile = join(root, 'operator.json');
  writeFileSync(operatorFile, JSON.stringify(operator), { mode: 0o600 });
  const controllerAgent = await api('POST', `/api/companies/${company.id}/agents`, { name: 'Graph controller', adapterType: 'herdr_relay',
    adapterConfig: { relayContextFile: operatorFile, bindingId: 'controller' },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
  const controllerBinding = await call(operator, 'POST', '/bindings', { id: 'controller', companyId: company.id,
    agentId: controllerAgent.id, harness: 'opencode', instanceId: 'deterministic-reviewer', conversationId: 'reviewer-fixture' });
  const controller = { socketPath: service.socketPath, token: controllerBinding.token };
  const task = await api('POST', `/api/companies/${company.id}/issues`, { title: 'Update graph with a native worker',
    description: `Update graph.json to exactly {"nodes":["verified-native-node"]} followed by a newline. Verify the JSON. Write the summary to ${join(root, 'result.md')} outside the worktree. Compute the exact candidate by running node /relay/src/cli.mjs candidate inspect --directory ${worktree} after all edits, then submit using that id. Do not commit, create other deliverables, or delegate. Finish the turn after submission.` });
  worker = await provisionAgent(service.store, join(root, 'relay'), api, { key: 'graph', companyId: company.id, bindingId: 'graph-worker',
    harness: 'opencode', directory: worktree, lifetime: 'task', taskId: task.id, controllerBindingId: 'controller',
    worktreeKey: 'graph', worktree: { repository, path: worktree, branch: 'native-graph' } });
  await api('PATCH', `/api/issues/${task.id}`, { assigneeAgentId: worker.agentId });
  await api('PATCH', `/api/agents/${worker.agentId}`, { runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 } } });
  const heartbeat = await api('POST', `/api/agents/${worker.agentId}/heartbeat/invoke`, { payload: { taskId: task.id, issueId: task.id } });
  assert.ok(heartbeat.id);
  const submitted = await until(() => service.store.runs('graph-worker').find(run => run.settlement?.outcome === 'completed' && run.publication.state === 'recorded'));
  await api('PATCH', `/api/agents/${worker.agentId}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
  await until(async () => (await api('GET', `/api/heartbeat-runs/${heartbeat.id}`)).status === 'succeeded');
  assert.deepEqual(JSON.parse(readFileSync(join(worktree, 'graph.json'), 'utf8')), { nodes: ['verified-native-node'] });
  assert.equal(candidate(worktree).id, submitted.result.candidate);
  const committed = await call(operator, 'POST', '/resources/finalise', { key: 'graph', runId: submitted.id,
    candidate: submitted.result.candidate, message: 'Commit independently verified native graph' });
  assert.equal((await call(operator, 'POST', '/resources/finalise', { key: 'graph', runId: submitted.id,
    candidate: submitted.result.candidate, message: 'Commit independently verified native graph' })).commit, committed.commit);
  await api('PATCH', `/api/issues/${task.id}`, { assigneeAgentId: controllerAgent.id });
  await api('PATCH', `/api/agents/${controllerAgent.id}`, { runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 } } });
  const reviewHeartbeat = await api('POST', `/api/agents/${controllerAgent.id}/heartbeat/invoke`, { payload: { taskId: task.id, issueId: task.id } });
  const reviewer = await until(() => service.store.runs('controller').find(run => run.request.runId === reviewHeartbeat.id));
  await api('PATCH', `/api/agents/${controllerAgent.id}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
  await call(controller, 'POST', `/runs/${reviewer.id}/acknowledge`, {});
  await until(async () => { try { return await call(controller, 'GET', `/runs/${reviewer.id}/task`); } catch { return false; } });
  await call(controller, 'POST', `/runs/${reviewer.id}/reviewer-check`, { runId: submitted.id, candidate: submitted.result.candidate,
    key: 'json-check', command: 'Parse graph.json and compare exact expected node', outcome: 'passed', evidence: 'Independent test process parsed the native-written graph and compared its candidate digest' });
  const review = await call(controller, 'POST', `/runs/${reviewer.id}/review`, { action: 'request', runId: submitted.id,
    candidate: submitted.result.candidate, reviewerUserId: 'local-board' });
  await api('POST', `/api/issues/${task.id}/interactions/${review.review.interactionId}/accept`, {});
  let ignoredCleanupBlocked = false;
  await until(() => {
    const retirement = service.store.operation(`retirement:${submitted.id}`);
    if (retirement?.state === 'blocked') {
      assert.equal(retirement.reason, 'dirty_cleanup_blocked');
      assert.equal(service.store.operation(`runtime:${worker.runtimeKey}`).state, 'retired');
      ignoredCleanupBlocked = true;
      // Only this disposable test owns these harness-generated dependency files.
      // Product cleanup deliberately refuses to make this deletion decision.
      for (const path of ['.gitignore', 'node_modules', 'package-lock.json', 'package.json']) {
        rmSync(join(worktree, '.opencode', path), { recursive: true, force: true });
      }
      assert.equal(candidate(worktree).id, submitted.result.candidate);
    }
    return service.store.binding('graph-worker').lifecycleState === 'retired';
  });
  assert.equal(existsSync(worktree), false);
  assert.equal(service.store.operation(`runtime:${worker.runtimeKey}`).state, 'retired');
  assert.equal(service.store.operation(`retirement:${submitted.id}`).state, 'recorded');
  assert.equal(execFileSync('git', ['-C', repository, 'rev-parse', 'native-graph'], { encoding: 'utf8' }).trim(), committed.commit);
  const comments = await api('GET', `/api/issues/${task.id}/comments`);
  assert.equal(comments.filter(comment => comment.body.includes(`herdr-relay:${submitted.id}:${digest(submitted.result)}`)).length, 1);
  await call(controller, 'POST', `/runs/${reviewer.id}/mutate`, { kind: 'task.update', key: 'complete', payload: { status: 'done' } });
  await call(operator, 'POST', `/runs/${reviewer.id}/cancel`, {});
  await call(operator, 'POST', `/runs/${reviewer.id}/settle`, { outcome: 'cancelled', evidence: 'Independent reviewer fixture finished' });
  console.log(JSON.stringify({ backend: 'Paperclip 2026.1001.0', nativeHarness: 'OpenCode 1.18.34',
    model: 'github-copilot/gpt-6-astra', realNativeGraphEdit: true, candidateIndependentlyVerified: true,
    committedBeforeAcceptance: true, boardAcceptance: true, automaticRuntimeRetirement: true,
    worktreeCleanupAfterFixtureResolution: true, ignoredCleanupBlocked, finalCommitRetained: true, backendTaskDone: true }, null, 2));
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
  rmSync(root, { recursive: true, force: true });
  if (!process.env.OPENCODE_SMOKE_AUTH) rmSync(authSource, { force: true });
}
