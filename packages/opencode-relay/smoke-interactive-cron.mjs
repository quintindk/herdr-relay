// Real model, real TUIs, external reserved bindings. Never adopts the user's chat.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchOwnedV2 } from './owned-runtime.mjs';
import { NativeOpenCodeV2 } from './native.mjs';
import { startBackend } from '../../src/backend-service.mjs';
import { nativeBackendClient } from '../../src/backend-client.mjs';
import { NodeJournal } from '../../src/node-journal.mjs';
import { digest } from '../../src/protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const binary = process.env.RELAY_V2_BINARY ?? join(here, 'node_modules/.bin/opencode2');
const modelId = process.env.RELAY_SMOKE_MODEL ?? 'qwen/qwen3.8-27b';
const modelUrl = process.env.RELAY_SMOKE_MODEL_URL ?? 'http://127.0.0.1:1234/v1';
const root = mkdtempSync('/tmp/opencode/relay-interactive-cron-');
const workspace = join(root, 'workspace');
const state = join(root, 'node');
mkdirSync(workspace); mkdirSync(state);
const configFile = join(root, 'node.json');
const finishTuis = join(root, 'finish-tuis');
const runtimes = [], tuis = [];
let backend, journal, daemon, nodeLog = '', releaseHuman, runtimeVersion;
let held = false;
const humanGate = new Promise(resolve => { releaseHuman = resolve; });
const progress = message => console.error(message);
const waitFor = async (label, check, timeout = 180000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (daemon && daemon.exitCode !== null) throw new Error(`Node exited: ${nodeLog}`);
    const result = await check();
    if (result) return result;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}. Node log: ${nodeLog}. State retained: ${root}`);
};
// Hold only the first synthetic human turn, so busy admission is deterministic.
// All responses still come from the actual local model, not a fixture model.
const proxy = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (!held) { held = true; await humanGate; }
    const upstream = await fetch(`${modelUrl}${req.url.replace(/^\/v1/, '')}`, {
      method: req.method, headers: { 'content-type': 'application/json' }, body,
      signal: AbortSignal.timeout(180000),
    });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch { res.writeHead(502); res.end('Local model transport failed'); }
});

try {
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const command = (key, action, payload) => owner('POST', '/v1/commands', { key, action, payload });
  await command('enrol', 'node.enrol', { id: 'interactive-node', name: 'Disposable interactive cron node' });
  const credential = await owner('POST', '/v1/node-credentials', { nodeId: 'interactive-node', key: 'credential' });
  const permissions = [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'relay_work_read', resource: '*', effect: 'allow' },
    { action: 'relay_work_submit', resource: '*', effect: 'allow' },
  ];
  const entries = [];
  for (const agentId of ['chat-a', 'chat-b']) {
    const directory = join(root, agentId);
    const workerContextFile = join(state, `worker-${digest(agentId)}.json`);
    const runtime = await launchOwnedV2({ directory, executable: binary, workspace, config: {
      plugins: [{ package: here, options: { workerContextFile } }],
      model: `local-smoke/${modelId}`, compaction: { auto: false },
      providers: { 'local-smoke': { package: '@ai-sdk/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${proxy.address().port}/v1`, apiKey: 'local-only' },
        models: { [modelId]: { name: modelId, limit: { context: 8192, output: 1024 } } } } },
    } });
    runtimes.push(runtime);
    const version = (await runtime.client.server.info()).version;
    if (runtimeVersion) assert.equal(version, runtimeVersion);
    runtimeVersion = version;
    const session = await runtime.client.session.create({ location: { directory: workspace },
      title: `Interactive cron ${agentId}`, model: { providerID: 'local-smoke', id: modelId } });
    entries.push({ id: `binding-${agentId}`, agentId, mode: 'interactive', harness: 'opencode-v2', reserved: true,
      url: runtime.descriptor.origin, authFile: join(directory, 'auth.json'), sessionPermissions: permissions,
      identity: { sessionId: session.id, projectId: session.projectID, directory: workspace, createdAt: session.time.created } });
    const evidenceFile = join(directory, 'tui.jsonl');
    const clientConfig = join(directory, 'client/opencode'); mkdirSync(clientConfig, { recursive: true });
    writeFileSync(join(clientConfig, 'cli.json'), JSON.stringify({ plugins: [{ package: here, options: { evidenceFile } }] }));
    const password = JSON.parse(readFileSync(join(directory, 'auth.json'), 'utf8')).password;
    const tui = spawn('python3', [join(here, 'pty-client.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostics = '';
    tui.stdout.on('data', () => {}); tui.stderr.on('data', chunk => { diagnostics += chunk; });
    tui.stdin.end(JSON.stringify({ args: [binary, '--server', runtime.descriptor.origin, '--session', session.id, workspace],
      cwd: workspace, env: { PATH: process.env.PATH, HOME: join(directory, 'home'), TERM: 'xterm-256color',
        XDG_CONFIG_HOME: join(directory, 'client'), XDG_DATA_HOME: join(directory, 'home/.local/share'), OPENCODE_PASSWORD: password },
      evidenceFile, passiveUntil: finishTuis, timeoutSeconds: 600, redact: [password] }));
    tuis.push({ process: tui, evidenceFile, sessionId: session.id, diagnostics: () => diagnostics });
    await waitFor('attached TUI RPC', () => {
      assert.equal(tui.exitCode, null, diagnostics);
      return existsSync(evidenceFile) && readFileSync(evidenceFile, 'utf8').includes('"type":"notification"');
    }, 45000);
  }
  journal = new NodeJournal(join(state, 'node.sqlite'), { nodeId: 'interactive-node', instanceId: backend.store.instance });
  const stopNode = async () => {
    if (!daemon || daemon.exitCode !== null) return;
    const exited = once(daemon, 'exit'); daemon.kill('SIGTERM');
    const timer = setTimeout(() => daemon.kill('SIGKILL'), 20000);
    try { const [code] = await exited; assert.equal(code, 0, nodeLog); }
    finally { clearTimeout(timer); daemon = null; }
  };
  const startNode = async bindings => {
    await stopNode();
    writeFileSync(configFile, JSON.stringify({ nodeId: 'interactive-node', stateDirectory: state,
      backend: { url: backend.origin, token: credential.token }, bindings }), { mode: 0o600 });
    nodeLog = '';
    daemon = spawn(process.execPath, [join(here, '../../src/node-cli.mjs'), '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => { nodeLog = (nodeLog + chunk).slice(-8000); });
    await waitFor('node start', () => nodeLog.includes('"state":"running"'), 30000);
  };
  const localOccurrences = id => journal.db.prepare('SELECT data FROM occurrences WHERE schedule_id=?').all(id).map(row => JSON.parse(row.data));
  const installed = id => waitFor(`${id} installed`, async () => (await owner('GET', `/v1/schedules/${id}`)).appliedRevision === 1);
  const completed = id => waitFor(`${id} completed`, async () => {
    const occurrence = localOccurrences(id).find(value => value.state === 'completed');
    const failure = localOccurrences(id).find(value => value.state === 'failed');
    assert.ok(!failure, JSON.stringify(failure));
    if (!occurrence) return false;
    const published = await owner('GET', `/v1/occurrences/${occurrence.id}`).catch(error => { if (error.status !== 404) throw error; });
    return published?.state === 'completed' && occurrence;
  });
  const instructions = 'Perform only this smoke check. Call relay_work_read, then relay_work_submit with a key and candidate derived from the execution ID and summary "Interactive cron smoke passed." Finish immediately after successful submission. Do not use any other tools.';
  await startNode(entries);
  await waitFor('advertised chat', async () => (await owner('GET', '/v1/agents/chat-a')).conversationId === entries[0].identity.sessionId);
  const nativeA = new NativeOpenCodeV2(runtimes[0].client, entries[0].identity);
  await runtimes[0].client.session.prompt({ sessionID: entries[0].identity.sessionId, id: 'msg_interactive_human_probe',
    text: 'Reply with HUMAN_PROBE_OK. Do not call tools. This is a synthetic human-turn test, not a Relay assignment.' });
  await waitFor('held human turn', () => held);
  await command('exact', 'schedule.install', { id: 'interactive-exact', definition: {
    nodeId: 'interactive-node', targetAgentId: 'chat-a', targetConversationId: entries[0].identity.sessionId,
    instructions, at: new Date(Date.now() + 2000).toISOString(), timezone: 'Africa/Johannesburg', enabled: true, reviewPolicy: 'none',
  } });
  await installed('interactive-exact');
  await waitFor('busy occurrence pending', () => localOccurrences('interactive-exact').some(value => value.state === 'pending'));
  await delay(2500);
  assert.equal(journal.works().length, 0, 'Busy human turn must not admit scheduled work');
  assert.equal((await nativeA.snapshot()).messages.filter(value => value.type === 'user').length, 1);
  releaseHuman();
  const exact = await completed('interactive-exact');
  assert.equal(journal.work(exact.id).nativeConversationId, entries[0].identity.sessionId);
  progress('PASS: busy exact chat deferred, then completed through real model worker tools.');

  await startNode([entries[0]]);
  await command('folder', 'schedule.install', { id: 'interactive-folder', definition: {
    nodeId: 'interactive-node', targetFolder: workspace, instructions, cron: '* * * * *',
    timezone: 'Africa/Johannesburg', enabled: true, reviewPolicy: 'none',
  } });
  await installed('interactive-folder');
  const first = await completed('interactive-folder');
  assert.equal(journal.work(first.id).nativeConversationId, entries[0].identity.sessionId);
  progress('PASS: first folder cron completed in chat A.');
  const before = journal.works().length;
  await startNode([]);
  const pending = await waitFor('offline folder occurrence', () => localOccurrences('interactive-folder').find(value => value.state === 'pending'));
  assert.equal(journal.works().length, before);
  await startNode(entries);
  await delay(2500);
  assert.equal(journal.works().length, before, 'Ambiguous folder must not pick an idle chat');
  assert.equal(localOccurrences('interactive-folder').find(value => value.id === pending.id).admission.reason, 'target_unavailable_or_ambiguous');
  progress('PASS: absent and ambiguous folder bindings deferred without a prompt.');
  await startNode([entries[1]]);
  const second = await waitFor('replacement folder completion', async () => {
    const occurrence = localOccurrences('interactive-folder').find(value => value.id === pending.id);
    assert.notEqual(occurrence.state, 'failed', JSON.stringify(occurrence));
    if (occurrence.state !== 'completed') return false;
    const published = await owner('GET', `/v1/occurrences/${pending.id}`).catch(error => { if (error.status !== 404) throw error; });
    return published?.state === 'completed' && occurrence;
  });
  assert.equal(journal.work(second.id).nativeConversationId, entries[1].identity.sessionId);
  assert.equal(journal.work(first.id).nativeConversationId, entries[0].identity.sessionId);
  const schedule = await owner('GET', '/v1/schedules/interactive-folder');
  await command('pause', 'schedule.pause', { id: schedule.id, expectedRevision: schedule.revision });
  await waitFor('pause applied', async () => (await owner('GET', `/v1/schedules/${schedule.id}`)).appliedRevision === 2);
  await startNode([entries[1]]);
  await delay(2500);
  assert.equal(journal.works().length, before + 1, 'Node restart must not replay settled work');
  assert.equal(JSON.parse(journal.db.prepare('SELECT data FROM schedules WHERE id=?').get(schedule.id).data).state, 'paused');
  const receipts = [];
  for (const [occurrence, index] of [[exact, 0], [first, 0], [second, 1]]) {
    const work = journal.work(occurrence.id);
    const messages = (await new NativeOpenCodeV2(runtimes[index].client, entries[index].identity).snapshot()).messages;
    const start = messages.findIndex(value => value.id === work.invocation.messageId);
    const end = messages.findIndex((value, offset) => offset > start && value.type === 'idle');
    const turn = messages.slice(start, end + 1);
    assert.equal(messages.filter(value => value.id === work.invocation.messageId).length, 1);
    assert.equal(turn.at(-1).outcome, 'succeeded');
    const tools = turn.flatMap(value => value.content ?? []).filter(value => value.type === 'tool');
    for (const name of ['relay_work_read', 'relay_work_submit']) assert.ok(tools.some(value => value.name === name && value.state.status === 'completed'), `${name}: ${JSON.stringify(tools)}`);
    receipts.push({ id: occurrence.id, scheduleId: occurrence.scheduleId, intendedAt: occurrence.intendedAt,
      conversationId: work.nativeConversationId, bindingId: work.bindingId, nativeOutcome: work.observation.outcome,
      localState: work.state, backendState: (await owner('GET', `/v1/occurrences/${occurrence.id}`)).state,
      tools: tools.map(value => ({ name: value.name, state: value.state.status })) });
  }
  for (const tui of tuis) assert.equal(tui.process.exitCode, null, tui.diagnostics());
  await stopNode();
  const result = { verifiedOn: new Date().toISOString(), runtime: `OpenCode ${runtimeVersion}`, backend: 'native relay/0.2 isolated instance',
    model: modelId, realModel: true, agentMode: 'interactive', nodeBinding: 'opencode-v2', relayOwnedRuntime: false,
    syntheticTuiInput: true, attachedTuis: tuis.length, busyExactDeferred: true, absentFolderDeferred: true,
    ambiguousFolderDeferred: true, folderFutureChatReplacement: true, admittedTargetPreserved: true,
    settledWorkNotReplayedOnRestart: true, pauseApplied: true, receipts,
    limitations: ['Synthetic input, not actual human approval.', 'No atomic protection against concurrent human input.',
      'No physical reboot, remote node or backend disconnection certification.', 'Exact-chat replacement refusal remains fixture-tested.'],
  };
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(result, null, 2));
  if (process.env.RELAY_SMOKE_EVIDENCE) writeFileSync(resolve(process.env.RELAY_SMOKE_EVIDENCE), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, privateState: root }, null, 2));
} finally {
  releaseHuman();
  writeFileSync(finishTuis, 'done');
  for (const tui of tuis) {
    if (tui.process.exitCode === null) await once(tui.process, 'exit');
  }
  if (daemon && daemon.exitCode === null) {
    const exited = once(daemon, 'exit'); daemon.kill('SIGTERM');
    const timer = setTimeout(() => daemon.kill('SIGKILL'), 20000);
    try { await exited; } finally { clearTimeout(timer); daemon = null; }
  }
  journal?.close();
  for (const runtime of runtimes) {
    // Only these disposable test services are controlled here, never a user service.
    for (const sessionId of Object.keys(await runtime.client.session.active())) await runtime.interrupt(sessionId);
    await waitFor('disposable runtime idle for cleanup', async () => Object.keys(await runtime.client.session.active()).length === 0, 30000);
    await runtime.stop();
  }
  await backend?.close();
  proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve));
}
