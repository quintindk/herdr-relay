import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { launchRuntime, stopRuntime } from '../src/runtimes.mjs';
import { OpenCode } from '../src/opencode.mjs';
import { provisionAgent } from '../src/provisioning.mjs';
import { resumeRuntime } from '../src/resume.mjs';

const sourceAuth = join(homedir(), '.local/share/opencode/auth.json');
const root = mkdtempSync(join(process.env.OPENCODE_SMOKE_TMP ?? tmpdir(), 'relay-owned-smoke-'));
const home = join(root, 'home');
const workspace = join(root, 'workspace');
mkdirSync(workspace);
mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
mkdirSync(join(home, '.config/opencode'), { recursive: true });
copyFileSync(sourceAuth, join(home, '.local/share/opencode/auth.json'));
chmodSync(join(home, '.local/share/opencode/auth.json'), 0o600);
writeFileSync(join(home, '.config/opencode/opencode.json'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json', model: 'github-copilot/gpt-6-astra', autoupdate: false, share: 'disabled', plugin: [],
  permission: { bash: 'allow', task: 'deny', question: 'deny', external_directory: 'allow' }, compaction: { auto: false },
}));
Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
  XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache') });
let service;
let runtime;
let native;
async function until(fn) {
  for (let i = 0; i < 900; i++) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error('Managed runtime smoke deadline');
}
try {
  const directory = join(root, 'relay');
  service = await startService({ directory, paperclipUrl: 'http://paperclip.test', api: async () => ({ companyId: 'company',
    title: 'Cancellation fixture', description: 'After acknowledging, run sleep 120 in the terminal. Do not run it in the background. This fixture will cancel your turn. Do not submit.' }) });
  const agents = [];
  const operatorApi = async (method, path, body) => {
    if (method === 'GET') return path.startsWith('/api/agents/') ? agents[0] : agents;
    if (method === 'PATCH') { agents[0] = { ...agents[0], ...body }; return agents[0]; }
    const agent = { id: 'agent', companyId: 'company', ...body };
    agents.push(agent);
    return agent;
  };
  const provisionInput = { key: 'owned', companyId: 'company', bindingId: 'owned-worker', harness: 'opencode', directory: workspace };
  const provisioned = await provisionAgent(service.store, directory, operatorApi, provisionInput);
  assert.equal((await provisionAgent(service.store, directory, operatorApi, provisionInput)).agentId, provisioned.agentId);
  assert.equal(agents.length, 1);
  const runtimeKey = provisioned.runtimeKey;
  runtime = service.store.operation(`runtime:${runtimeKey}`);
  assert.equal((await launchRuntime(service.store, directory, { key: runtimeKey, directory: workspace })).nonce, runtime.nonce);
  const config = { url: `http://127.0.0.1:${runtime.port}`, directory: workspace,
    authFile: join(runtime.directory, 'auth.json'), exclusive: true, runtimeKey };
  native = new OpenCode({ opencode: config, conversationId: 'pending' });
  const session = await native.request('GET', `/session/${provisioned.conversationId}`);
  config.projectID = session.projectID;
  config.sessionCreatedAt = session.time.created;
  native.sessionId = session.id;
  native.path = `/session/${session.id}`;
  const operator = { socketPath: service.socketPath, token: service.token };
  const run = await call(operator, 'POST', '/runs', { bindingId: 'owned-worker', bindingRevision: 1, companyId: 'company',
    agentId: 'agent', runId: 'backend', taskId: 'task' });
  await call(operator, 'POST', `/runs/${run.id}/attach`, { token: 'fixture-token' });
  await until(async () => {
    const snapshot = await native.snapshot();
    return snapshot.messages.some(message => message.parts.some(part => part.type === 'tool' && part.state?.status === 'running' &&
      JSON.stringify(part.state.input).includes('sleep 120')));
  });
  await assert.rejects(stopRuntime(service.store, runtimeKey), { code: 'runtime_busy' });
  await call(operator, 'POST', `/runs/${run.id}/cancel`, {});
  await until(() => service.store.run(run.id).nativeState === 'settled');
  const completed = service.store.run(run.id);
  assert.equal(completed.settlement.outcome, 'cancelled');
  assert.ok(completed.interruption);
  assert.equal((await native.verify()).id, session.id);
  await stopRuntime(service.store, runtimeKey);
  await stopRuntime(service.store, runtimeKey);
  const resumeInput = { key: 'resume-owned', bindingId: 'owned-worker', revision: 1, runtimeKey: 'resumed-owned' };
  const resumed = await resumeRuntime(service.store, directory, operatorApi, resumeInput);
  assert.equal(resumed.conversationId, session.id);
  assert.equal(resumed.revision, 2);
  assert.equal((await resumeRuntime(service.store, directory, operatorApi, resumeInput)).revision, 2);
  runtime = service.store.operation('runtime:resumed-owned');
  await stopRuntime(service.store, 'resumed-owned');
  console.log(JSON.stringify({ realModel: 'github-copilot/gpt-6-astra', ownedRuntime: true,
    duplicateLaunchPrevented: true, provisionedAgentCount: agents.length, activeStopRejected: true, cancellationObserved: true,
    conversationPreservedBeforeRetirement: true, retirementVerified: true, managedResumeVerified: true }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, runs: service?.store.runs().map(run => ({ native: run.native, interruption: run.interruption })) }));
  if (native) {
    const snapshot = await native.snapshot();
    console.error(JSON.stringify({ idle: snapshot.idle, messages: snapshot.messages.map(message => ({ info: message.info,
      tools: message.parts.filter(part => part.type === 'tool').map(part => ({ status: part.state?.status })) })) }));
  }
  throw error;
} finally {
  // Clean up only this fixture's verified owner if an assertion failed.
  if (runtime && service?.store.operation(runtime.id)?.state !== 'retired') {
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
