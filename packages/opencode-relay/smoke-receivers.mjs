// Isolated real native API/tools/node daemon, deterministic local model. Never
// adopts user chats, credentials, services or cron definitions.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchOwnedV2 } from './owned-runtime.mjs';
import { startBackend } from '../../src/backend-service.mjs';
import { nativeBackendClient } from '../../src/backend-client.mjs';
import { enrolInteractive, launchInteractive } from '../../src/native-enrol.mjs';
import { NodeJournal } from '../../src/node-journal.mjs';
import { workerConnection } from './worker-context.mjs';
import { call } from '../../src/client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync('/tmp/opencode/relay-receivers-smoke-');
const workspace = join(root, 'workspace'), state = join(root, 'node');
mkdirSync(workspace); mkdirSync(state);
const binary = process.env.RELAY_V2_BINARY ?? join(here, 'node_modules/.bin/opencode2');
const tuiOnly = process.argv.includes('--tui-only');
let runtime, backend, daemon, journal, log = '', requests = 0;
const wait = async (label, check, timeout = 100000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (daemon && daemon.exitCode !== null) throw Error(`Daemon exited: ${log}`);
    const value = await check();
    if (value) return value;
    await delay(200);
  }
  throw Error(`Timed out: ${label}. State retained: ${root}. Node: ${log}`);
};
const model = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  const last = input.messages.findLastIndex(m => m.role === 'user');
  const tools = input.messages.slice(last + 1).filter(m => m.role === 'tool');
  const name = tools.length === 0 ? 'relay_work_read' : tools.length === 1 ? 'relay_work_submit' : null;
  const tool = name && input.tools?.find(t => t.function?.name.endsWith(name));
  const args = name === 'relay_work_submit' ? { key: 'submit', candidate: 'receiver-fixture', summary: 'Persistent receiver native-tool smoke passed.' } : {};
  requests++;
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests}`, type: 'function', function: {
    name: tool.function.name, arguments: JSON.stringify(args),
  } }] } : { role: 'assistant', content: 'RECEIVER_SMOKE_OK' };
  const base = { id: `chatcmpl-${requests}`, created: 1, model: 'fixture', object: 'chat.completion.chunk' };
  res.setHeader('content-type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
const stopDaemon = async () => {
  if (!daemon || daemon.exitCode !== null) return;
  const exited = once(daemon, 'exit'); daemon.kill('SIGTERM');
  const timer = setTimeout(() => daemon.kill('SIGKILL'), 15000);
  try { const [code] = await exited; assert.equal(code, 0, log); }
  finally { clearTimeout(timer); daemon = null; }
};
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const ownerToken = backend.store.bootstrap().token;
  const owner = nativeBackendClient({ url: backend.origin, token: ownerToken });
  runtime = await launchOwnedV2({ directory: join(root, 'runtime'), executable: binary, workspace, config: {
    plugins: [{ package: here, options: { workerDirectory: state } }], model: 'receiver-fixture/fixture', compaction: { auto: false },
    providers: { 'receiver-fixture': { package: '@ai-sdk/openai-compatible', settings: {
      baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'disposable-fixture',
    }, models: { fixture: { name: 'Fixture', limit: { context: 8192, output: 256 } } } } },
  } });
  const firstSession = await runtime.client.session.create({ location: { directory: workspace }, title: 'First receiving chat' });
  const password = JSON.parse(readFileSync(join(root, 'runtime/auth.json'))).password;
  const dependencies = { discover: async () => ({ url: runtime.descriptor.origin, auth: { type: 'basic', username: 'opencode', password } }), makeClient: () => runtime.client };
  const input = { api: owner, backend: { url: backend.origin }, configFile: join(state, 'node.json'), directory: workspace };
  const first = await enrolInteractive({ ...input, sessionId: firstSession.id, reserved: true, transport: 'tools', name: 'Wright fixture' }, dependencies);
  journal = new NodeJournal(join(state, 'node.sqlite'), { nodeId: first.nodeId, instanceId: backend.store.instance });
  const startDaemon = async () => {
    log = '';
    daemon = spawn(process.execPath, [join(here, '../../src/node-cli.mjs'), '--config', input.configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-8000); });
    await wait('node ready', () => log.includes('"state":"running"'));
  };
  await startDaemon();
  await owner('POST', '/v1/commands', { key: 'persistent-cron', action: 'schedule.install', payload: { id: 'persistent-cron', definition: {
    nodeId: first.nodeId, targetAgentId: first.agentId, instructions: 'Call relay_work_read then relay_work_submit. Finish immediately after submission.',
    cron: '* * * * *', enabled: !tuiOnly, reviewPolicy: 'none', timezone: 'Africa/Johannesburg',
  } } });
  const occurrence = count => wait(`published cron firing ${count}`, async () => {
    const page = await owner('GET', '/v1/occurrences');
    const items = page.items.filter(o => o.scheduleId === 'persistent-cron');
    assert.ok(items.every(o => o.state === 'completed'), JSON.stringify(items));
    return items.length >= count && items;
  });
  const initial = tuiOnly ? [] : await occurrence(1);
  if (!tuiOnly) {
    assert.equal(journal.work(initial[0].id).nativeConversationId, first.sessionId);
    console.error('PASS: first real cron firing completed through native worker tools.');
  }
  const second = await launchInteractive({ ...input, agentId: first.agentId, key: 'fresh-chat' }, dependencies);
  assert.equal(second.agentId, first.agentId); assert.equal(second.nodeId, first.nodeId); assert.equal(second.generation, 2);
  await wait('hot receiver update', async () => (await owner('GET', `/v1/agents/${first.agentId}`)).availability === 'available');
  if (!tuiOnly) {
    const next = await occurrence(2);
    const replacementOccurrence = next.find(o => o.id !== initial[0].id);
    assert.equal(journal.work(replacementOccurrence.id).nativeConversationId, second.sessionId);
    assert.equal(journal.work(initial[0].id).nativeConversationId, first.sessionId);
  }
  assert.equal((await owner('GET', '/v1/schedules/persistent-cron')).revision, 1);
  const connection = workerConnection({ workerDirectory: state }, second.sessionId);
  for (const [operation, revision] of [['pause', 1], ['resume', 2], ['pause', 3]]) {
    const result = await call(connection, 'POST', `/agent/schedule-${operation}`, { key: `new-chat-${operation}-${revision}`,
      payload: { id: 'persistent-cron', expectedRevision: revision } });
    assert.equal(result.state, 'recorded');
  }
  await wait('pause applied', async () => (await owner('GET', '/v1/schedules/persistent-cron')).appliedRevision === 4);
  const oldConnection = workerConnection({ workerDirectory: state }, first.sessionId);
  await assert.rejects(call(oldConnection, 'POST', '/agent/schedule-resume', { key: 'stale-resume',
    payload: { id: 'persistent-cron', expectedRevision: 4 } }), { code: 'receiver_replaced' });
  await stopDaemon(); await startDaemon();
  await wait('restarted receiver', async () => (await call(connection, 'POST', '/agent/status', {})).receivingHere);
  if (!tuiOnly) assert.equal((await owner('GET', '/v1/occurrences')).items.length, 2);
  let keyboardCommands = false;
  if (process.argv.includes('--tui') || tuiOnly) {
    const ownerFile = join(root, 'owner.json');
    // Recover the existing isolated owner's token from the test input closure,
    // never from a user installation or a backend credential database.
    const ownerContext = { url: backend.origin, token: ownerToken };
    writeFileSync(ownerFile, JSON.stringify(ownerContext), { mode: 0o600 });
    const info = await runtime.client.server.info();
    const registration = join(root, 'service.json');
    writeFileSync(registration, JSON.stringify({ id: 'receiver-smoke', pid: info.pid, version: info.version,
      url: runtime.descriptor.origin, password }), { mode: 0o600 });
    for (const kind of ['attach', 'enrol']) {
      const session = await runtime.client.session.create({ location: { directory: workspace }, title: `Human ${kind} fixture` });
      const directory = join(root, `tui-${kind}`), configuration = join(directory, 'config/opencode');
      mkdirSync(configuration, { recursive: true });
      const evidenceFile = join(directory, 'evidence.jsonl');
      const newChatTrigger = join(directory, 'new-chat');
      const driverPackage = join(directory, 'new-chat-plugin');
      mkdirSync(driverPackage);
      writeFileSync(join(driverPackage, 'package.json'), JSON.stringify({ name: 'relay-new-chat-fixture', type: 'module',
        exports: { './tui': './tui.mjs' } }));
      writeFileSync(join(driverPackage, 'tui.mjs'), `export { default } from ${JSON.stringify(join(here, 'smoke-new-chat-tui.mjs'))};\n`);
      writeFileSync(join(configuration, 'cli.json'), JSON.stringify({ plugins: [{ package: here, options: {
        ownerContextFile: ownerFile, nativeNodeConfigFile: input.configFile, nativeServiceRegistration: registration, evidenceFile,
      } }, ...(kind === 'attach' ? [{ package: driverPackage, options: { trigger: newChatTrigger } }] : [])] }), { mode: 0o600 });
      const tui = spawn('python3', [join(here, 'pty-client.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
      let diagnostics = '';
      tui.stdout.on('data', () => {}); tui.stderr.on('data', chunk => { diagnostics += chunk; });
      tui.stdin.end(JSON.stringify({ args: [binary, '--server', runtime.descriptor.origin, '--session', session.id, workspace],
        cwd: workspace, env: { PATH: process.env.PATH, HOME: directory, TERM: 'xterm-256color',
          XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'), XDG_STATE_HOME: join(directory, 'state'),
          OPENCODE_PASSWORD: password }, evidenceFile, [kind]: true, autoNewChat: kind === 'attach', newChatTrigger,
        timeoutSeconds: 45, redact: [password, ownerToken] }));
      await once(tui, 'exit');
      assert.ok(existsSync(evidenceFile), diagnostics);
      const events = readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const receipt = events.find(e => e.type === 'receiver_attached');
      assert.ok(receipt, diagnostics);
      assert.equal(receipt.sessionId, session.id);
      if (kind === 'attach') {
        assert.equal(receipt.agentId, first.agentId); assert.equal(receipt.generation, 3);
        const automatic = events.filter(e => e.type === 'receiver_attached')[1];
        assert.ok(automatic, diagnostics);
        assert.equal(automatic.agentId, first.agentId); assert.equal(automatic.generation, 4);
        assert.notEqual(automatic.sessionId, receipt.sessionId);
        assert.equal((await owner('GET', `/v1/agents/${first.agentId}`)).conversationId, automatic.sessionId);
        await owner('POST', '/v1/commands', { key: 'auto-new-chat-probe', action: 'schedule.install', payload: { id: 'auto-new-chat', definition: {
          nodeId: first.nodeId, targetAgentId: first.agentId, instructions: 'Read and submit the fixture.',
          at: new Date(Date.now() + 2000).toISOString(), enabled: true, reviewPolicy: 'none',
        } } });
        const published = await wait('automatic new-chat schedule admission', async () =>
          (await owner('GET', '/v1/occurrences')).items.find(o => o.scheduleId === 'auto-new-chat'));
        assert.equal(journal.work(published.id).nativeConversationId, automatic.sessionId);
        assert.equal((await owner('GET', '/v1/schedules/persistent-cron')).revision, 4);
        console.error('PASS: new-chat Home/creation/selection automatically attached and received subsequent scheduled work.');
      }
      else assert.notEqual(receipt.agentId, first.agentId);
      console.error(`PASS: /relay-${kind} published from an actual TUI keyboard confirmation.`);
    }
    assert.equal((await owner('GET', '/v1/nodes')).items.length, 1);
    assert.equal((await owner('GET', '/v1/agents')).items.length, 2);
    keyboardCommands = true;
  }
  console.log(JSON.stringify({ passed: true, runtime: (await runtime.client.server.info()).version, realNativeTools: true,
    model: 'deterministic fixture', physicalMachines: 1, actualHuman: false, stableAgentId: first.agentId, stableNodeId: first.nodeId,
    conversations: [first.sessionId, second.sessionId], cronFirings: tuiOnly ? 0 : 2, realMinuteTicks: !tuiOnly, nodeHotAttachment: true,
    replacementChatScheduleManagement: true, staleCredentialRefused: true, restartPreservedReceiver: true,
    keyboardEnrolAndAttach: keyboardCommands, automaticTuiNewChat: keyboardCommands, state: root }, null, 2));
} finally {
  await stopDaemon(); journal?.close(); await runtime?.stop(); await backend?.close();
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
}
