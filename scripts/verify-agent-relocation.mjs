// Disposable native service/backend/node only. No user chats, credentials,
// repositories, systemd services or scheduled business work are modified.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { createNodeBundle, joinNode } from '../src/native-onboarding.mjs';
import { enrolInteractive } from '../src/native-enrol.mjs';
import { launchOwnedV2 } from '../packages/opencode-relay/owned-runtime.mjs';
import { workerConnection } from '../packages/opencode-relay/worker-context.mjs';
import { call } from '../src/client.mjs';

process.umask(0o077);
const root = mkdtempSync('/tmp/opencode/relay-agent-relocation-'), state = join(root, 'node'), shared = join(root, 'shared');
mkdirSync(state); mkdirSync(shared);
const packageDirectory = resolve(process.env.RELAY_PACKAGE_DIRECTORY ?? '.'), execute = promisify(execFile);
const environment = { ...process.env, HERDR_ENV: '0' };
for (const name of Object.keys(environment)) if (/^(?:OPENCODE_|RELAY_CLI_)/.test(name)) delete environment[name];
const gitEnvironment = { ...environment, GIT_AUTHOR_NAME: 'Relay Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Relay Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
let runtime, backend, daemon, log = '', modelTurns = 0;
const model = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body), last = input.messages.findLastIndex(message => message.role === 'user');
  const called = input.messages.slice(last + 1).some(message => message.role === 'tool');
  if (!called) modelTurns++;
  const tool = !called && input.tools.find(tool => tool.function.name.endsWith('relay_attachment_status'));
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'check-attachment', type: 'function', function: { name: tool.function.name, arguments: '{}' } }] }
    : { role: 'assistant', content: 'RELOCATION_FIXTURE_OK' };
  const base = { id: 'relocation-fixture', created: 1, model: 'fixture', object: 'chat.completion.chunk' };
  res.setHeader('content-type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
const wait = async (label, check) => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (daemon?.exitCode !== null && daemon?.exitCode !== undefined) throw Error(`Fixture node exited: ${log}`);
    const result = await check(); if (result) return result;
    await delay(100);
  }
  throw Error(`Timed out: ${label}. Fixture: ${root}. Node log: ${log}`);
};
const stopNode = async () => {
  if (!daemon || daemon.exitCode !== null) return;
  const child = daemon; daemon = null; const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
};
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const { startBackend } = await import(pathToFileURL(join(packageDirectory, 'src/backend-service.mjs')));
  backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const api = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const bundleFile = join(root, 'node.bundle.json');
  await createNodeBundle({ api, output: bundleFile, key: 'relocation-node', name: 'Fixture Evo', url: backend.origin, mode: 'localUser' });
  const joined = await joinNode({ bundleFile, configFile: join(state, 'node.json') });
  runtime = await launchOwnedV2({ directory: join(root, 'runtime'), workspace: shared,
    executable: process.env.RELAY_V2_BINARY ?? resolve('packages/opencode-relay/node_modules/.bin/opencode2'),
    config: { plugins: [{ package: join(packageDirectory, 'packages/opencode-relay'), options: { workerDirectory: state } }],
      model: 'relocation-fixture/fixture', permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'relay_attachment_status', resource: '*', effect: 'allow' }],
      providers: { 'relocation-fixture': { package: '@ai-sdk/openai-compatible', settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture' },
        models: { fixture: { name: 'Fixture', limit: { context: 8192, output: 256 } } } } } } });
  const client = runtime.client, nativePid = (await client.server.info()).pid;
  const password = JSON.parse(readFileSync(join(root, 'runtime/auth.json'))).password;
  const registration = join(root, 'registration.json');
  writeFileSync(registration, JSON.stringify({ url: runtime.descriptor.origin, password, version: (await client.server.info()).version, pid: nativePid }));
  const dependencies = { discover: async () => ({ url: runtime.descriptor.origin, auth: { type: 'basic', username: 'opencode', password } }), makeClient: () => client };
  const roles = [];
  for (const name of ['blender', 'unity']) {
    const target = join(root, name); mkdirSync(target);
    execFileSync('git', ['init', '-q', '--initial-branch=main', target], { env: gitEnvironment });
    execFileSync('git', ['-C', target, 'commit', '-q', '--allow-empty', '-m', `${name} fixture`], { env: gitEnvironment });
    const session = await client.session.create({ location: { directory: shared }, title: name });
    const enrolment = await enrolInteractive({ api, backend: { url: backend.origin }, configFile: joined.configFile,
      directory: shared, sessionId: session.id, name, reserved: true, transport: 'tools' }, dependencies);
    const schedule = await api('POST', '/v1/commands', { key: `schedule-${name}`, action: 'schedule.install', payload: { id: `schedule-${name}`,
      definition: { nodeId: joined.nodeId, targetAgentId: enrolment.agentId, instructions: 'Fixture only, must remain paused', cron: '* * * * *', timezone: 'Africa/Johannesburg', enabled: false } } });
    await client.session.move({ sessionID: session.id, directory: target });
    const moved = await wait('native workspace move applied', async () => {
      const current = await client.session.get({ sessionID: session.id }); return current.location.directory === target && current;
    });
    await wait('native workspace move idle', async () => !(await client.session.active())[session.id]);
    assert.equal(moved.id, session.id); assert.equal(moved.time.created, session.time.created); assert.equal(moved.location.directory, target);
    roles.push({ name, target, session, enrolment, schedule, moved });
  }
  log = ''; daemon = spawn(process.execPath, [join(packageDirectory, 'src/node-cli.mjs'), '--config', joined.configFile], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-6000); });
  await wait('node startup', () => log.includes('"state":"running"'));
  const nodePid = daemon.pid;
  for (const role of roles) {
    const args = ['native', 'agent', 'relocate', '--agent', role.enrolment.agentId, '--session', role.session.id, '--generation', '1',
      '--from-directory', shared, '--directory', role.target, '--config', joined.configFile, '--context', joined.operatorContextFile, '--service-registration', registration];
    const run = async extra => JSON.parse((await execute(process.execPath, [join(packageDirectory, 'src/cli.mjs'), ...args, ...extra], { env: environment })).stdout);
    const preview = await run([]); assert.equal(preview.state, 'relocation_preview');
    const applied = await run(['--apply', '--preview-hash', preview.previewHash, '--key', `move-${role.name}`]);
    assert.equal(applied.agentId, role.enrolment.agentId); assert.equal(applied.generation, 2);
    await wait('hot-loaded moved receiver', async () => {
      const connection = workerConnection({ workerDirectory: state }, role.session.id);
      const status = await call(connection, 'POST', '/agent/status', {}); return status.receivingHere && status.agentId === role.enrolment.agentId;
    });
    const session = await client.session.get({ sessionID: role.session.id });
    assert.equal(session.time.created, role.session.time.created); assert.deepEqual(session.model, role.moved.model);
    assert.deepEqual(session.permissions, role.moved.permissions);
    const schedule = await api('GET', `/v1/schedules/${role.schedule.id}`);
    assert.deepEqual(schedule.definition, role.schedule.definition); assert.equal(schedule.revision, role.schedule.revision);
    await run(['--apply', '--preview-hash', preview.previewHash, '--key', `move-${role.name}`]);
    assert.equal((await api('GET', `/v1/agents/${role.enrolment.agentId}`)).bindingRevision, 2);
  }
  assert.equal(modelTurns, 0, 'Relocation must not start or replay a model turn');
  for (const role of roles) {
    await client.session.prompt({ sessionID: role.session.id, text: 'Bounded fixture check: call relay_attachment_status only, then stop.' });
    await client.session.wait({ sessionID: role.session.id });
    const transcript = await client.session.context({ sessionID: role.session.id });
    assert.ok(transcript.some(message => message.type === 'assistant' && message.content.some(part => part.type === 'tool' && part.name === 'relay_attachment_status' && part.state.status === 'completed')));
  }
  assert.equal(modelTurns, 2); assert.equal(daemon.pid, nodePid); assert.equal((await client.server.info()).pid, nativePid);
  assert.equal(backend.store.all('agent').length, 2);
  console.log(JSON.stringify({ passed: true, runtime: (await client.server.info()).version, actualNativeSessionMoves: 2,
    sameAgentsAndRootChats: true, distinctProjects: roles.every(role => role.moved.projectID !== role.session.projectID),
    originalModelAndPermissionsPreserved: true, scheduleDefinitionsPreserved: true, receivingAfterRelocation: true,
    noModelTurnDuringRelocation: true, originalKeyRetryIdempotent: true, nodeAndOpenCodeNotRestarted: true,
    nativeStatusToolAfterRelocation: true, userServicesTouched: false, userChatsTouched: false, fixture: root }, null, 2));
} finally {
  await stopNode();
  if (runtime) { await wait('fixture native idle for cleanup', async () => Object.keys(await runtime.client.session.active()).length === 0); await runtime.stop(); }
  if (backend) await backend.close();
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
}
