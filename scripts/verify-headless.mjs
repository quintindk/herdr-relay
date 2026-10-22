// Disposable native backend/node and real OpenCode. No user services, credentials,
// inboxes or schedules are used. The local model deterministically submits results.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { createNodeBundle, joinNode } from '../src/native-onboarding.mjs';
import { provisionOwnedV2 } from '../packages/opencode-relay/provision.mjs';
import { digest } from '../src/protocol.mjs';

process.umask(0o077);
const execute = promisify(execFile), root = mkdtempSync('/tmp/opencode/relay-headless-smoke-');
const workspace = join(root, 'twd'), state = join(root, 'node');
mkdirSync(workspace); mkdirSync(state);
const cli = resolve('src/cli.mjs'), configFile = join(state, 'node.json');
let backend, daemon, log = '', runtime, requests = 0;
const model = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body); requests++;
  const lastUser = input.messages.findLastIndex(m => m.role === 'user');
  const called = input.messages.slice(lastUser + 1).some(m => m.role === 'tool');
  const tool = input.tools?.find(t => t.function?.name.endsWith('relay_work_submit'));
  const call = tool && !called;
  const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${requests}`, type: 'function',
    function: { name: tool.function.name, arguments: JSON.stringify({ key: 'fixture-result', candidate: 'headless-fixture', summary: 'Fixture inbox inspected. No changes.' }) } }] }
    : { role: 'assistant', content: 'Fixture finished.' };
  const base = { id: 'headless-fixture', created: 1, model: 'fixture', object: 'chat.completion.chunk' };
  res.setHeader('content-type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
const wait = async (label, check) => {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (daemon && (daemon.exitCode !== null || daemon.signalCode !== null)) throw Error(`Fixture node exited during ${label}: ${log}`);
    try { const result = await check(); if (result) return result; } catch {}
    await delay(100);
  }
  throw Error(`Timed out: ${label}. Fixture state: ${root}. Node log: ${log}`);
};
const stopNode = async () => {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  const child = daemon; daemon = null;
  const ended = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try { const [code] = await ended; assert.equal(code, 0); } finally { clearTimeout(timer); }
};
const startNode = async () => {
  log = ''; daemon = spawn(process.execPath, [resolve('src/node-cli.mjs'), '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-4000); });
  await wait('node startup', () => log.includes('"state":"running"'));
};
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const command = (key, action, payload) => owner('POST', '/v1/commands', { key, action, payload });
  const bundleFile = join(root, 'fixture.bundle.json');
  await createNodeBundle({ api: owner, output: bundleFile, key: 'headless-fixture', name: 'Fixture Surface', url: backend.origin, mode: 'localUser' });
  await joinNode({ bundleFile, configFile });
  const nodeBefore = JSON.parse(readFileSync(configFile, 'utf8'));
  const manifest = { key: 'inbox-sweep', name: 'inbox-sweep', directory: workspace,
    executable: process.env.RELAY_V2_BINARY ?? resolve('packages/opencode-relay/node_modules/.bin/opencode2'),
    config: { model: 'headless-fixture/fixture', compaction: { auto: false }, permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'relay_work_submit', resource: '*', effect: 'allow' },
      { action: 'relay_work_read', resource: '*', effect: 'allow' },
    ], providers: { 'headless-fixture': { package: '@ai-sdk/openai-compatible', settings: {
      baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only' },
    models: { fixture: { name: 'Fixture', limit: { context: 8192, output: 512 } } } } } },
    schedule: { id: 'inbox-sweep-weekdays', instructions: 'Inspect only the disposable fixture inbox and submit a result.',
      cron: '0 7-18 * * 1-5', timezone: 'Africa/Johannesburg', reviewPolicy: 'none' } };
  const file = join(root, 'manifest.json'), scheduleOutput = join(root, 'schedule.json');
  writeFileSync(file, JSON.stringify(manifest));
  const args = [cli, 'headless', 'provision', '--file', file, '--config', configFile, '--schedule-output', scheduleOutput];
  const plan = JSON.parse((await execute(process.execPath, args)).stdout);
  assert.equal(plan.state, 'headless_plan'); assert.equal(requests, 0);
  const configured = JSON.parse((await execute(process.execPath, [...args, '--apply'])).stdout);
  assert.equal(configured.runtimeStarted, false); assert.equal(configured.scheduleInstalled, false);
  const config = JSON.parse(readFileSync(configFile, 'utf8')), entry = config.bindings[0];
  assert.deepEqual(config.backend, nodeBefore.backend);
  const input = { stateDirectory: state, bindingId: entry.id, agentId: entry.agentId, executable: entry.executable,
    workspace, config: entry.config, workerContextFile: join(state, `worker-${digest(entry.agentId)}.json`) };
  await startNode();
  await wait('headless availability', async () => (await owner('GET', `/v1/agents/${entry.agentId}`)).availability === 'available');
  runtime = await provisionOwnedV2(input);
  const sessionId = runtime.identity.sessionId, pid = runtime.runtime.descriptor.pid;
  assert.equal(requests, 0);
  const template = JSON.parse(readFileSync(scheduleOutput, 'utf8'));
  let schedule = await command('create-schedule', 'schedule.install', template);
  for (let run = 0; run < 2; run++) {
    const { cron, ...definition } = template.definition;
    schedule = await command(`fixture-run-${run}`, 'schedule.install', { id: schedule.id, expectedRevision: schedule.revision,
      definition: { ...definition, enabled: true, at: new Date(Date.now() + 1500).toISOString() } });
    await wait(`completed headless occurrence ${run}`, async () => {
      const list = await owner('GET', '/v1/occurrences');
      return list.items.filter(o => o.scheduleId === schedule.id && o.state === 'completed').length === run + 1;
    });
    if (run === 0) {
      await stopNode();
      const retry = JSON.parse((await execute(process.execPath, [...args, '--apply'])).stdout);
      assert.equal(retry.state, 'existing'); assert.equal(retry.agentId, configured.agentId);
      await startNode();
      const reused = await provisionOwnedV2(input);
      assert.equal(reused.identity.sessionId, sessionId); assert.equal(reused.runtime.descriptor.pid, pid);
    }
  }
  schedule = await command('restore-disabled-cron', 'schedule.install', { ...template, expectedRevision: schedule.revision });
  await wait('disabled cron acknowledged', async () => (await owner('GET', `/v1/schedules/${schedule.id}`)).appliedRevision === schedule.revision);
  await stopNode();
  await runtime.runtime.stop();
  await startNode();
  runtime = await provisionOwnedV2({ ...input, resume: true });
  assert.equal(runtime.identity.sessionId, sessionId); assert.notEqual(runtime.runtime.descriptor.pid, pid);
  assert.equal((await owner('GET', '/v1/agents')).items.length, 1);
  assert.equal((await owner('GET', '/v1/schedules')).items.length, 1);
  assert.equal((await owner('GET', `/v1/schedules/${schedule.id}`)).definition.enabled, false);
  console.log(JSON.stringify({ passed: true, publicCli: true, realOpenCodeHeadless: true, interactiveClients: 0,
    scheduledExecutionsCompleted: 2, nodeRestartReusedRuntimeAndSession: true, idleRuntimeRestartReusedSession: true,
    singleDurableAgentAndSchedule: true, scheduleDisabledAtEnd: true, paperclipUsed: false, userServicesTouched: false,
    fixture: root }, null, 2));
} finally {
  await stopNode();
  if (runtime) await runtime.runtime.stop();
  if (backend) await backend.close();
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
}
