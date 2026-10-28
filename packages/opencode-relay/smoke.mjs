// Real OpenCode service, deterministic local model. No user credentials/config.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode } from '@opencode/client';
import { RelayRuntime } from './rpc.mjs';
import { NativeOpenCodeV2, observeV2, checkV2Version } from './native.mjs';
import { startBackend } from '../../src/backend-service.mjs';
import { nativeBackendClient } from '../../src/backend-client.mjs';
import { NodeJournal } from '../../src/node-journal.mjs';
import { tickNode } from '../../src/node-execution.mjs';
import { startNodeService } from '../../src/node-service.mjs';
import { call } from '../../src/client.mjs';
import { tickAutomation } from '../../src/node-automation.mjs';
import { launchOwnedV2 } from './owned-runtime.mjs';
import { HumanProposals } from './human-proposals.mjs';
import { digest } from '../../src/protocol.mjs';
import { provisionOwnedV2 } from './provision.mjs';

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const binary = process.env.RELAY_V2_BINARY ?? join(packageDirectory, 'node_modules/.bin/opencode2');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
const runtimeVersion = checkV2Version(version.replace(/^opencode v/, ''));
const root = mkdtempSync(join(tmpdir(), 'relay-v2-'));
const workspace = join(root, 'workspace');
const config = join(root, 'config/opencode');
mkdirSync(workspace);
mkdirSync(config, { recursive: true });
let child;
let backend, nodeService, journal;
let owned;
let nodeDaemon;
let nodeLog = '';
let provisioned;
let humanTui;
let initiatorRuntime, initiatorDaemon;
let humanRuntime;
let transportProxy;
let humanProposalInput;
let log = '';
const sanitise = text => text.replace(/server password \S+/g, 'server password [redacted]');
let requests = 0;
let toolCalls = 0;
let workerToolMode = null;
let workerToolCalls = 0;
let holdModel = false;
const advertisedTools = new Set();
const model = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  requests++;
  if (holdModel) {
    res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders();
    res.write(': disposable held model stream\n\n');
    return;
  }
  const content = 'RELAY_V2_FIXTURE_OK';
  for (const item of input.tools ?? []) advertisedTools.add(item.function?.name);
  const lastUser = input.messages.findLastIndex(message => message.role === 'user');
  const alreadyCalled = input.messages.slice(lastUser + 1).some(message => message.role === 'tool');
  const agentQuestion = String(input.messages[lastUser]?.content ?? '').includes('Relay agent question');
  const escalate = process.argv.includes('--escalate');
  const humanPrompt = String(input.messages[lastUser]?.content ?? '').includes('human answer fixture');
  const name = humanPrompt ? 'relay_answer' : agentQuestion ? (escalate ? 'relay_agent_forward' : 'relay_agent_answer') : workerToolMode === 'question' ? 'relay_work_ask' : workerToolMode === 'result' ? 'relay_work_submit' : 'relay_status';
  const tool = input.tools?.find(item => item.function?.name.endsWith(name));
  const callTool = tool && !alreadyCalled;
  let agentQuestionInput;
  if (agentQuestion) {
    const match = String(input.messages[lastUser].content).match(/Question (\S+), revision (\d+),/);
    agentQuestionInput = { id: match?.[1], expectedRevision: Number(match?.[2]), key: 'agent-answer',
      ...(escalate ? { reason: 'Region requires the human decision' } : { body: 'South Africa North' }) };
  }
  const argumentsText = humanPrompt ? JSON.stringify(humanProposalInput) : agentQuestion ? JSON.stringify(agentQuestionInput) : workerToolMode === 'question' ? JSON.stringify({ key: 'region', prompt: 'Which region?', humanRequired: !process.argv.includes('--mesh') }) :
    workerToolMode === 'result' ? JSON.stringify({ key: 'result', candidate: 'sha256:fixture', summary: 'Prepared for South Africa North' }) : '{}';
  if (callTool && workerToolMode) workerToolCalls++;
  if (callTool) toolCalls++;
  res.setHeader('Content-Type', input.stream ? 'text/event-stream' : 'application/json');
  const base = { id: 'chatcmpl-relay', created: 1, model: 'fixture' };
  if (input.stream) {
    const delta = callTool ? { role: 'assistant', tool_calls: [{ index: 0, id: `relay-fixture-call-${requests}`, type: 'function', function: { name: tool.function.name, arguments: argumentsText } }] } : { role: 'assistant', content };
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: callTool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } else res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});

try {
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  writeFileSync(join(config, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json', update: 'disable', share: 'disabled',
    plugins: [{ package: packageDirectory, options: { humanProposals: process.argv.includes('--proposals') } }],
    model: 'relay-fixture/fixture', compaction: { auto: false },
    providers: { 'relay-fixture': { package: '@ai-sdk/openai-compatible',
      settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'disposable-fixture' },
      models: { fixture: { name: 'Relay fixture', limit: { context: 8192, output: 256 } } } } },
  }), { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: root, TERM: 'xterm-256color',
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache') };
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-16000); });
  let origin;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`V2 exited: ${sanitise(log)}`);
    origin = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (origin && /server password \S+/.test(log)) break;
    await delay(200);
  }
  assert.ok(origin, `V2 did not report an origin: ${sanitise(log)}`);
  const password = log.match(/server password (\S+)/)?.[1];
  assert.ok(password, 'Private server authentication was not reported');
  const client = OpenCode.make({ baseUrl: origin,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
    fetch: (url, options) => fetch(url, { ...options, signal: options?.signal ?? AbortSignal.timeout(15000) }) });
  const info = await client.server.info();
  assert.equal(info.version, runtimeVersion);
  const location = { directory: workspace };
  const session = await client.session.create({ location, title: 'Relay disposable runtime verification', model: { providerID: 'relay-fixture', id: 'fixture' } });
  const rpc = client.rpc(RelayRuntime);
  const status = await rpc.inspect({}, { location });
  assert.equal(status.directory, workspace);
  assert.ok(status.tools.includes('relay_status'));
  if (process.argv.includes('--proposals')) {
    assert.ok(status.tools.includes('relay_answer'));
    assert.deepEqual(await client.rpc(HumanProposals).list({ sessionId: session.id }, { location }), { items: [] });
  }
  await assert.rejects(rpc.inspect({ unexpected: true }, { location }));
  await assert.rejects(rpc.notify({ clientId: 'invalid', sessionId: session.id }, { location }));
  const native = new NativeOpenCodeV2(client, { sessionId: session.id, projectId: session.projectID,
    directory: workspace, createdAt: session.time.created });
  const before = await native.snapshot();
  assert.equal(before.idle, true);
  const id = 'msg_relay_runtime_verification';
  const prompt = 'Return the fixture acknowledgement.';
  const invocation = { messageId: id, prompt, priorMessageIds: before.messages.map(message => message.id) };
  const receipt = await native.send(invocation);
  assert.equal(receipt.id, id);
  let messages;
  for (let i = 0; i < 150; i++) {
    messages = (await client.message.list({ sessionID: session.id, order: 'asc', limit: 100 })).data;
    if (messages.some(message => message.id === id) && messages.some(message => message.type === 'idle')) break;
    await delay(200);
  }
  assert.equal(messages.filter(message => message.id === id && message.type === 'user' && message.text === prompt).length, 1, JSON.stringify(messages));
  const terminal = messages.findLast(message => message.type === 'idle');
  assert.equal(terminal?.outcome, 'succeeded', JSON.stringify(messages));
  assert.ok(messages.some(message => message.type === 'assistant' && message.content.some(part => part.type === 'text' && part.text.includes('RELAY_V2_FIXTURE_OK'))));
  assert.equal(toolCalls, 1, `Fixture must invoke the registered read-only tool: ${JSON.stringify([...advertisedTools])}`);
  const toolResult = messages.flatMap(message => message.content ?? []).find(part => part.type === 'tool' && part.name === 'relay_status');
  assert.equal(toolResult?.state.status, 'completed', JSON.stringify(toolResult));
  assert.equal(observeV2(await native.snapshot(), invocation).outcome, 'succeeded');
  assert.equal((await client.session.get({ sessionID: session.id })).location.directory, workspace);
  let backendWorkflow = false;
  let offlineAutomation = false;
  let ownedRuntime = false;
  if (process.argv.includes('--owned')) {
    owned = await launchOwnedV2({ directory: join(root, 'owned'), executable: binary, workspace,
      config: JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8')) });
    owned.verify();
    const exact = await owned.client.session.create({ location, title: 'Owned v2 lifecycle smoke', model: { providerID: 'relay-fixture', id: 'fixture' } });
    await owned.client.session.prompt({ sessionID: exact.id, id: 'msg_owned_probe', text: 'Return fixture acknowledgement.' });
    for (let i = 0; i < 150; i++) {
      const snapshot = await owned.client.message.list({ sessionID: exact.id, order: 'asc', limit: 100 });
      if (snapshot.data.some(message => message.type === 'idle' && message.outcome === 'succeeded')) break;
      await delay(100);
    }
    const ownedMessages = (await owned.client.message.list({ sessionID: exact.id, order: 'asc', limit: 100 })).data;
    assert.ok(ownedMessages.some(message => message.type === 'idle' && message.outcome === 'succeeded'));
    holdModel = true;
    const interrupted = await owned.client.session.create({ location, title: 'Owned interruption smoke', model: { providerID: 'relay-fixture', id: 'fixture' } });
    await owned.client.session.prompt({ sessionID: interrupted.id, id: 'msg_owned_interrupt', text: 'Wait on the fixture stream.' });
    for (let i = 0; i < 100; i++) {
      if ((await owned.client.session.active())[interrupted.id]) break;
      await delay(100);
    }
    await owned.interrupt(interrupted.id);
    let interruptedMessages;
    for (let i = 0; i < 150; i++) {
      interruptedMessages = (await owned.client.message.list({ sessionID: interrupted.id, order: 'asc', limit: 100 })).data;
      if (interruptedMessages.some(message => message.type === 'idle' && message.outcome === 'interrupted')) break;
      await delay(100);
    }
    assert.ok(interruptedMessages.some(message => message.type === 'idle' && message.outcome === 'interrupted'));
    holdModel = false;
    await owned.stop(); await owned.stop(); ownedRuntime = true;
  }
  let managedProvisioning = false;
  if (process.argv.includes('--provision')) {
    const args = { stateDirectory: root, bindingId: 'managed-probe', agentId: 'managed-agent', executable: binary,
      workspace, config: JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8')), workerContextFile: join(root, 'unused-worker.json') };
    provisioned = await provisionOwnedV2(args);
    const repeated = await provisionOwnedV2(args);
    assert.equal(provisioned.identity.sessionId, repeated.identity.sessionId);
    await provisioned.native.verify();
    await provisioned.runtime.stop();
    const previousIdentity = provisioned.identity;
    provisioned = await provisionOwnedV2({ ...args, resume: true });
    assert.deepEqual(provisioned.identity, previousIdentity);
    assert.equal(provisioned.runtime.descriptor.generation, 2);
    assert.equal(provisioned.runtime.descriptor.history.length, 1);
    const crashed = provisioned.runtime.descriptor;
    process.kill(-crashed.pid, 'SIGKILL');
    for (let i = 0; i < 100; i++) {
      try { provisioned.runtime.verify(); } catch { break; }
      await delay(100);
    }
    provisioned = await provisionOwnedV2({ ...args, resume: true });
    assert.deepEqual(provisioned.identity, previousIdentity);
    assert.equal(provisioned.runtime.descriptor.generation, 3);
    await provisioned.runtime.stop();
    managedProvisioning = true;
  }
  if (process.argv.includes('--backend')) {
    backend = await startBackend({ database: join(root, 'backend.sqlite') });
    const ownerToken = backend.store.bootstrap().token;
    const ownerApi = nativeBackendClient({ url: backend.origin, token: ownerToken });
    const command = (api, key, action, payload) => api('POST', '/v1/commands', { key, action, payload });
    await command(ownerApi, 'enrol', 'node.enrol', { id: 'node', name: 'Disposable node' });
    const credential = await ownerApi('POST', '/v1/node-credentials', { nodeId: 'node', key: 'credential' });
    const api = nativeBackendClient({ url: backend.origin, token: credential.token });
    await command(api, 'register', 'agent.register', { id: 'worker', nodeId: 'node', name: 'Worker', mode: 'headless', directory: workspace });
    const meshProbe = process.argv.includes('--mesh');
    if (meshProbe) {
      const initiatorDirectory = join(root, 'initiator-node'); mkdirSync(initiatorDirectory);
      const initiatorContext = join(initiatorDirectory, `worker-${digest('initiator')}.json`);
      const runtimeConfig = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8'));
      runtimeConfig.plugins = [{ package: packageDirectory, options: { workerContextFile: initiatorContext } }];
      initiatorRuntime = await launchOwnedV2({ directory: join(root, 'initiator-runtime'), executable: binary, workspace, config: runtimeConfig });
      const originSession = await initiatorRuntime.client.session.create({ location, title: 'Initiating agent', model: { providerID: 'relay-fixture', id: 'fixture' } });
      const nodeConfig = join(root, 'initiator-config.json');
      await command(ownerApi, 'enrol-origin', 'node.enrol', { id: 'initiator-node', name: 'Initiator node' });
      const originCredential = await ownerApi('POST', '/v1/node-credentials', { nodeId: 'initiator-node', key: 'credential-origin' });
      const originApi = nativeBackendClient({ url: backend.origin, token: originCredential.token });
      await command(originApi, 'register-origin', 'agent.register', { id: 'initiator', nodeId: 'initiator-node', name: 'Initiator', mode: 'interactive' });
      writeFileSync(nodeConfig, JSON.stringify({ nodeId: 'initiator-node', stateDirectory: initiatorDirectory,
        backend: { url: backend.origin, token: originCredential.token }, bindings: [{ id: 'origin-binding', agentId: 'initiator', harness: 'opencode-v2',
          reserved: true, url: initiatorRuntime.descriptor.origin, authFile: join(root, 'initiator-runtime/auth.json'),
          identity: { sessionId: originSession.id, projectId: originSession.projectID, directory: workspace, createdAt: originSession.time.created } }] }), { mode: 0o600 });
      initiatorDaemon = spawn(process.execPath, [join(packageDirectory, '../../src/node-cli.mjs'), '--config', nodeConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
      let originLog = '';
      initiatorDaemon.stdout.on('data', chunk => { originLog += chunk; }); initiatorDaemon.stderr.on('data', chunk => { originLog += chunk; });
      for (let i = 0; i < 100 && !originLog.includes('"state":"running"'); i++) {
        if (initiatorDaemon.exitCode !== null) throw new Error(originLog);
        await delay(100);
      }
      assert.match(originLog, /"state":"running"/);
    }
    await command(ownerApi, 'task', 'task.create', { id: 'task', title: 'Native backend smoke' });
    await command(ownerApi, 'request', 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1,
      targetAgentId: 'worker', instructions: 'Return the fixture acknowledgement.', reviewPolicy: 'human',
      ...(meshProbe ? { originAgentId: 'initiator' } : {}) });
    const daemonProbe = process.argv.includes('--daemon');
    const nodeDirectory = join(root, 'node-state');
    mkdirSync(nodeDirectory);
    journal = new NodeJournal(join(nodeDirectory, 'node.sqlite'), { nodeId: 'node', instanceId: backend.store.instance });
    const socketPath = join(nodeDirectory, 'node.sock');
    const workerContextFile = join(nodeDirectory, `worker-${digest('worker')}.json`);
    const workerContext = { socketPath, sessionId: session.id, agentId: 'worker', token: 'disposable-worker' };
    if (!daemonProbe) nodeService = await startNodeService({ journal, socketPath, workers: [workerContext] });
    const workerDriven = process.argv.includes('--worker-tools');
    if (workerDriven) {
      if (!process.argv.includes('--owned-node')) writeFileSync(workerContextFile, JSON.stringify(workerContext), { mode: 0o600 });
      const configuration = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8'));
      configuration.plugins = [{ package: packageDirectory, options: { workerContextFile } }];
      writeFileSync(join(config, 'opencode.json'), JSON.stringify(configuration), { mode: 0o600 });
      await client.location.reload();
      const reloaded = await rpc.inspect({}, { location });
      assert.ok(reloaded.tools.includes('relay_work_ask'));
      for (const name of ['relay_task_inspect', 'relay_task_comments', 'relay_task_relations']) assert.ok(reloaded.tools.includes(name), `${name} must load`);
      workerToolMode = 'question';
    }
    const resolveBinding = async () => ({ id: 'binding', identity: { sessionId: session.id }, native, observe: observeV2 });
    if (daemonProbe) {
      assert.ok(workerDriven, 'Daemon smoke requires worker tools');
      const authFile = join(root, 'native-auth.json');
      writeFileSync(authFile, JSON.stringify({ password }), { mode: 0o600 });
    const nodeConfig = join(root, 'node-config.json');
      const ownedNode = process.argv.includes('--owned-node');
      const ownedConfig = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8'));
      ownedConfig.plugins = [];
      writeFileSync(nodeConfig, JSON.stringify({ nodeId: 'node', stateDirectory: nodeDirectory,
        backend: { url: backend.origin, token: credential.token }, bindings: [ownedNode ? {
          id: 'binding', agentId: 'worker', harness: 'opencode-v2-owned', reserved: true,
          executable: binary, directory: workspace, config: ownedConfig, retireOnCompletion: process.argv.includes('--retire'),
        } : { id: 'binding', agentId: 'worker',
          harness: 'opencode-v2', reserved: true, url: origin, authFile,
          identity: { sessionId: session.id, projectId: session.projectID, directory: workspace, createdAt: session.time.created } }] }), { mode: 0o600 });
      nodeDaemon = spawn(process.execPath, [join(packageDirectory, '../../src/node-cli.mjs'), '--config', nodeConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
      nodeDaemon.stdout.on('data', chunk => { nodeLog = (nodeLog + chunk).slice(-4000); });
      nodeDaemon.stderr.on('data', chunk => { nodeLog = (nodeLog + chunk).slice(-4000); });
      for (let i = 0; i < 100 && !nodeLog.includes('"state":"running"'); i++) {
        if (nodeDaemon.exitCode !== null) throw new Error(nodeLog);
        await delay(100);
      }
      assert.match(nodeLog, /"state":"running"/);
    }
    const step = async () => daemonProbe ? delay(150) : tickNode(journal, api, resolveBinding);
    // Deterministic controller acts as the worker connector for this transport
    // smoke. A real model invoking the worker CLI is a separate acceptance gate.
    for (let i = 0; i < 150 && !journal.work('execution')?.invocation; i++) await step();
    let work = journal.work('execution');
    if (!workerDriven) await call({ socketPath, token: 'disposable-worker' }, 'POST', '/work/ask', { executionId: 'execution', runId: work.execution.runId,
      key: 'region', payload: { prompt: 'Which region?', humanRequired: true } });
    for (let i = 0; i < 150; i++) {
      await step();
      if (['waiting', 'continuation_ready'].includes((await ownerApi('GET', '/v1/executions/execution')).state)) break;
      await delay(100);
    }
    const question = (await ownerApi('GET', '/v1/questions')).items[0];
    assert.ok(question);
    if (process.argv.includes('--restart-node')) {
      assert.ok(daemonProbe, 'Restart probe requires daemon');
      const original = journal.work('execution').invocation;
      const exited = once(nodeDaemon, 'exit'); nodeDaemon.kill('SIGTERM'); await exited;
      nodeLog = '';
      nodeDaemon = spawn(process.execPath, [join(packageDirectory, '../../src/node-cli.mjs'), '--config', join(root, 'node-config.json')],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [nodeDaemon.stdout, nodeDaemon.stderr]) stream.on('data', chunk => { nodeLog = (nodeLog + chunk).slice(-4000); });
      for (let i = 0; i < 100 && !nodeLog.includes('"state":"running"'); i++) {
        if (nodeDaemon.exitCode !== null) throw new Error(nodeLog);
        await delay(100);
      }
      assert.match(nodeLog, /"state":"running"/);
      assert.deepEqual(journal.work('execution').invocation, original);
    }
    if (workerDriven) workerToolMode = 'result';
    if (meshProbe && !process.argv.includes('--escalate')) {
      for (let i = 0; i < 150; i++) {
        const answered = await ownerApi('GET', `/v1/questions/${question.id}`);
        if (answered.status === 'answered') break;
        await step();
      }
      const answer = await ownerApi('GET', `/v1/questions/${question.id}`);
      assert.equal(answer.answer?.author.type, 'agent');
      assert.equal(answer.answer?.author.id, 'initiator');
    }
    if (meshProbe && process.argv.includes('--escalate')) {
      for (let i = 0; i < 150; i++) {
        if ((await ownerApi('GET', `/v1/questions/${question.id}`)).addressedTo.type === 'user') break;
        await step();
      }
      assert.equal((await ownerApi('GET', `/v1/questions/${question.id}`)).routing.length, 1);
    }
    if (process.argv.includes('--human-inbox') || process.argv.includes('--chat-answer')) {
      const ownerFile = join(root, 'human-owner.json');
      writeFileSync(ownerFile, JSON.stringify({ url: backend.origin, token: ownerToken }), { mode: 0o600 });
      const clientConfig = join(root, 'human-client/opencode');
      mkdirSync(clientConfig, { recursive: true });
      const evidenceFile = join(root, 'human-inbox.jsonl');
      writeFileSync(join(clientConfig, 'cli.json'), JSON.stringify({ plugins: [{ package: packageDirectory,
        options: { evidenceFile, ownerContextFile: ownerFile, notificationSessionId: session.id } }] }));
      const switchConfirmation = process.argv.includes('--switch-confirmation');
      const confirmationGate = join(root, 'confirmation-gate');
      const switchTrigger = join(root, 'switch-trigger');
      if (switchConfirmation) {
        const other = await client.session.create({ location, title: 'Disposable switch target' });
        writeFileSync(join(clientConfig, 'cli.json'), JSON.stringify({ plugins: [
          { package: packageDirectory, options: { evidenceFile, ownerContextFile: ownerFile } },
          { package: join(packageDirectory, 'smoke-switch-tui.mjs'), options: {
            trigger: switchTrigger, gate: confirmationGate, originalSessionId: session.id, otherSessionId: other.id } },
        ] }));
      }
      let humanOrigin = origin, humanSessionId = session.id, humanPassword = password;
      if (process.argv.includes('--chat-answer')) {
        const humanConfig = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8'));
        humanConfig.plugins = [{ package: packageDirectory, options: { humanProposals: true } }];
        humanRuntime = await launchOwnedV2({ directory: join(root, 'human-runtime'), executable: binary, workspace, config: humanConfig });
        const humanSession = await humanRuntime.client.session.create({ location, title: 'Human proposal source', model: { providerID: 'relay-fixture', id: 'fixture' } });
        const currentQuestion = await ownerApi('GET', `/v1/questions/${question.id}`);
        humanProposalInput = { id: question.id, expectedRevision: currentQuestion.revision, body: 'South Africa North' };
        await humanRuntime.client.session.prompt({ sessionID: humanSession.id, id: 'msg_human_fixture', text: 'human answer fixture: Use South Africa North.' });
        for (let i = 0; i < 100; i++) {
          const proposals = await humanRuntime.client.rpc(HumanProposals).list({ sessionId: humanSession.id }, { location });
          if (proposals.items.length) break;
          await delay(100);
        }
        assert.equal((await humanRuntime.client.rpc(HumanProposals).list({ sessionId: humanSession.id }, { location })).items.length, 1);
        humanOrigin = humanRuntime.descriptor.origin; humanSessionId = humanSession.id;
        humanPassword = JSON.parse(readFileSync(join(root, 'human-runtime/auth.json'), 'utf8')).password;
      }
      humanTui = spawn('python3', [join(packageDirectory, 'pty-client.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
      let diagnostics = '';
      humanTui.stdout.on('data', () => {}); humanTui.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
      const reloadConfirmation = process.argv.includes('--reload-confirmation');
      const transportConfirmation = process.argv.includes('--transport-confirmation');
      if (transportConfirmation) {
        const upstream = humanOrigin;
        transportProxy = createServer((req, res) => {
          const forwarded = httpRequest(new URL(req.url, upstream), { method: req.method, headers: req.headers }, incoming => {
            res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
            res.on('close', () => incoming.destroy());
          });
          forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
          req.pipe(forwarded);
          res.on('close', () => forwarded.destroy());
        });
        transportProxy.listen(0, '127.0.0.1');
        await once(transportProxy, 'listening');
        humanOrigin = `http://127.0.0.1:${transportProxy.address().port}`;
      }
      humanTui.stdin.end(JSON.stringify({ args: [binary, '--server', humanOrigin, '--session', humanSessionId, workspace], cwd: workspace,
        env: { ...env, OPENCODE_PASSWORD: humanPassword, XDG_CONFIG_HOME: join(root, 'human-client') },
        evidenceFile, inbox: !process.argv.includes('--chat-answer'), proposals: process.argv.includes('--chat-answer'),
        ...(reloadConfirmation || transportConfirmation || switchConfirmation ? { confirmationGate, expectRefused: true } : {}), redact: [humanPassword, ownerToken] }));
      if (reloadConfirmation || transportConfirmation || switchConfirmation) {
        assert.ok(!process.argv.includes('--chat-answer'), 'Reload confirmation probe uses keyboard inbox');
        for (let i = 0; i < 300; i++) {
          if (existsSync(evidenceFile) && readFileSync(evidenceFile, 'utf8').includes('"type":"inbox_confirm"')) break;
          await delay(100);
        }
        assert.ok(readFileSync(evidenceFile, 'utf8').includes('"type":"inbox_confirm"'));
        if (reloadConfirmation) {
          const previous = (await rpc.inspect({}, { location })).generation;
          await client.location.reload({ location });
          assert.notEqual((await rpc.inspect({}, { location })).generation, previous);
        } else if (transportConfirmation) {
          const count = readFileSync(evidenceFile, 'utf8').split('connection_context_invalidated').length;
          transportProxy.closeAllConnections();
          for (let i = 0; i < 200; i++) {
            if (readFileSync(evidenceFile, 'utf8').split('connection_context_invalidated').length > count) break;
            await delay(100);
          }
          assert.ok(readFileSync(evidenceFile, 'utf8').split('connection_context_invalidated').length > count,
            'TUI must observe a new server connection after transport drop');
        }
        if (switchConfirmation) writeFileSync(switchTrigger, 'switch');
        else writeFileSync(confirmationGate, 'ready');
      }
      const [code] = await once(humanTui, 'exit');
      assert.equal(code, 0, diagnostics);
      const events = readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      if (!process.argv.includes('--chat-answer') && !switchConfirmation) assert.ok(events.some(event =>
        event.type === 'human_inbox_notification' && event.questions > 0), 'Human TUI must receive its pending-question notification');
      assert.ok(events.some(event => event.type === (reloadConfirmation || transportConfirmation || switchConfirmation ? 'human_decision_refused' : 'human_decision')),
        `Human inbox did not resolve: ${JSON.stringify(events)} ${diagnostics}`);
      if (reloadConfirmation || transportConfirmation || switchConfirmation) {
        const current = await ownerApi('GET', `/v1/questions/${question.id}`);
        assert.equal(current.status, 'open', 'Stale confirmation must not answer');
        await command(ownerApi, 'answer-after-refused-probe', 'question.answer', { id: current.id, expectedRevision: current.revision, body: 'South Africa North' });
      }
      assert.equal((await ownerApi('GET', `/v1/questions/${question.id}`)).answer.body, 'South Africa North');
    } else if (!meshProbe) await command(ownerApi, 'answer', 'question.answer', { id: question.id, expectedRevision: question.revision, body: 'South Africa North' });
    for (let i = 0; i < 150; i++) {
      await step();
      work = journal.work('execution');
      if (work.execution.answerQuestionId && work.invocation) break;
      await delay(100);
    }
    assert.equal(work.answer?.body, 'South Africa North');
    if (!workerDriven) await call({ socketPath, token: 'disposable-worker' }, 'POST', '/work/submit', { executionId: 'execution', runId: work.execution.runId,
      key: 'result', payload: { candidate: 'sha256:fixture', summary: 'Prepared for South Africa North' } });
    let reviewed;
    for (let i = 0; i < 150; i++) {
      await step();
      reviewed = await ownerApi('GET', '/v1/executions/execution');
      if (reviewed.state === 'in_review') break;
      await delay(100);
    }
    assert.equal(reviewed.state, 'in_review');
    if (process.argv.includes('--review-tui')) {
      const ownerFile = join(root, 'review-owner.json');
      writeFileSync(ownerFile, JSON.stringify({ url: backend.origin, token: ownerToken }), { mode: 0o600 });
      const clientConfig = join(root, 'review-client/opencode'); mkdirSync(clientConfig, { recursive: true });
      const evidenceFile = join(root, 'review-inbox.jsonl');
      writeFileSync(join(clientConfig, 'cli.json'), JSON.stringify({ plugins: [{ package: packageDirectory,
        options: { evidenceFile, ownerContextFile: ownerFile, notificationSessionId: session.id } }] }));
      humanTui = spawn('python3', [join(packageDirectory, 'pty-client.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
      let diagnostics = '';
      humanTui.stdout.on('data', () => {}); humanTui.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
      humanTui.stdin.end(JSON.stringify({ args: [binary, '--server', origin, '--session', session.id, workspace], cwd: workspace,
        env: { ...env, OPENCODE_PASSWORD: password, XDG_CONFIG_HOME: join(root, 'review-client') }, evidenceFile,
        review: true, redact: [password, ownerToken] }));
      const [code] = await once(humanTui, 'exit'); assert.equal(code, 0, diagnostics);
      assert.ok(readFileSync(evidenceFile, 'utf8').includes('"type":"human_decision"'), diagnostics);
      assert.ok(readFileSync(evidenceFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
        .some(event => event.type === 'human_inbox_notification' && event.reviews > 0), 'Human TUI must receive its pending-review notification');
    }
    const accepted = process.argv.includes('--review-tui') ? await ownerApi('GET', '/v1/executions/execution') :
      await command(ownerApi, 'accept', 'execution.review', { id: reviewed.id, expectedRevision: reviewed.revision,
        candidate: reviewed.result.candidate, decision: 'accept', reason: 'Deterministic smoke verified' });
    assert.equal(accepted.state, 'completed');
    if (process.argv.includes('--retire')) {
      assert.ok(process.argv.includes('--owned-node'), 'Retirement smoke requires owned node binding');
      const key = 'retired-binding:binding';
      for (let i = 0; i < 100; i++) {
        const retirement = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
        if (retirement && JSON.parse(retirement.value).state === 'retired') break;
        await step();
      }
      assert.equal(JSON.parse(journal.db.prepare('SELECT value FROM settings WHERE key=?').get(key).value).state, 'retired');
    }
    const task = await ownerApi('GET', '/v1/tasks/task');
    assert.equal((await command(ownerApi, 'complete', 'task.update', { id: task.id, expectedRevision: task.revision, changes: { status: 'done' } })).status, 'done');
    if (daemonProbe) {
      const advertisedNode = await ownerApi('GET', '/v1/nodes/node');
      assert.equal(advertisedNode.machine?.hostname, hostname(), 'Daemon must publish its own reported machine label');
      assert.equal(advertisedNode.machine?.platform, process.platform);
    }
    backendWorkflow = true;
    if (workerDriven) assert.equal(workerToolCalls, (meshProbe ? 3 : 2) + (process.argv.includes('--chat-answer') ? 1 : 0), 'Expected question, answer and submission calls');
    if (process.argv.includes('--scheduled-ask')) {
      assert.ok(workerDriven && daemonProbe, 'Scheduled clarification smoke requires daemon/worker tools');
      workerToolMode = 'question';
      let scheduleTarget;
      for (let i = 0; i < 100; i++) {
        scheduleTarget = await ownerApi('GET', '/v1/agents/worker');
        if (scheduleTarget.conversationId) break;
        await delay(100);
      }
      assert.ok(scheduleTarget.conversationId, 'Exact schedule requires an advertised conversation');
      await command(ownerApi, 'schedule-ask', 'schedule.install', { id: 'clarify-job', definition: {
        nodeId: 'node', ...(process.argv.includes('--folder') ? { targetFolder: workspace } :
          { targetAgentId: 'worker', targetConversationId: scheduleTarget.conversationId }), instructions: 'Clarify region then prepare report.',
        at: new Date(Date.now() + 2500).toISOString(), enabled: true, reviewPolicy: 'none',
      } });
      let scheduledQuestion;
      for (let i = 0; i < 200; i++) {
        const questions = (await ownerApi('GET', '/v1/questions?status=open')).items;
        scheduledQuestion = questions.find(q => q.taskId.startsWith('task_occurrence_'));
        if (scheduledQuestion) break;
        await step();
      }
      assert.ok(scheduledQuestion, 'Scheduled worker must ask through native tool');
      workerToolMode = 'result';
      await command(ownerApi, 'scheduled-answer', 'question.answer', { id: scheduledQuestion.id,
        expectedRevision: scheduledQuestion.revision, body: 'South Africa North' });
      let occurrence;
      for (let i = 0; i < 200; i++) {
        occurrence = (await ownerApi('GET', '/v1/occurrences')).items.find(item => item.scheduleId === 'clarify-job');
        if (occurrence) break;
        await step();
      }
      assert.equal(occurrence?.state, 'completed');
      assert.equal((await ownerApi('GET', `/v1/tasks/${scheduledQuestion.taskId}`)).status, 'done');
    }
    if (process.argv.includes('--monitor')) {
      assert.ok(workerDriven && daemonProbe, 'Monitor smoke requires daemon/worker tools');
      workerToolMode = 'result';
      await command(ownerApi, 'monitor-task', 'task.create', { id: 'monitor-task', title: 'Standing monitor' });
      const start = Date.now(), end = start + 9000;
      await command(ownerApi, 'monitor-request', 'execution.request', { id: 'monitor-execution', taskId: 'monitor-task', taskRevision: 1,
        targetAgentId: 'worker', instructions: 'Report one bounded monitoring check.', reviewPolicy: 'none',
        monitor: { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), intervalSec: 1 } });
      for (let i = 0; i < 200; i++) {
        const execution = await ownerApi('GET', '/v1/executions/monitor-execution');
        if (execution.state === 'cancelled') break;
        await step();
      }
      assert.equal((await ownerApi('GET', '/v1/executions/monitor-execution')).state, 'cancelled');
      assert.ok((await ownerApi('GET', '/v1/monitor_results')).items.length >= 2);
      assert.equal((await ownerApi('GET', '/v1/tasks?limit=100')).items.filter(task => task.id === 'monitor-task').length, 1);
    }
    if (process.argv.includes('--offline')) {
      assert.ok(workerDriven, 'Offline smoke requires worker tools');
      const clock = Date.now();
      const intendedAt = new Date(clock + (daemonProbe ? 5000 : 1000)).toISOString();
      await command(ownerApi, 'schedule', 'schedule.install', { id: 'offline', definition: {
        nodeId: 'node', targetAgentId: 'worker', instructions: 'Return a fixture report while disconnected.', at: intendedAt,
        enabled: true, reviewPolicy: 'none',
      } });
      if (daemonProbe) {
        for (let i = 0; i < 100; i++) {
          if ((await ownerApi('GET', '/v1/schedules/offline')).appliedRevision === 1) break;
          await delay(100);
        }
        assert.equal((await ownerApi('GET', '/v1/schedules/offline')).appliedRevision, 1);
      } else {
        await journal.poll(api);
        await tickAutomation(journal, resolveBinding, clock);
        await journal.flush(api);
      }
      const backendOrigin = backend.origin;
      await backend.close(); backend = null;
      // No backend client is passed to automation. The installed job executes
      // through real v2 worker tools while the shared HTTP service is stopped.
      for (let i = 0; i < 150; i++) {
        if (daemonProbe) await delay(150);
        else await tickAutomation(journal, resolveBinding, clock + 1000);
        if (journal.db.prepare("SELECT 1 FROM occurrences WHERE state='completed'").get()) break;
        await delay(100);
      }
      assert.equal(journal.db.prepare("SELECT COUNT(*) AS n FROM occurrences WHERE state='completed'").get().n, 1,
        JSON.stringify({ nodeLog, works: journal.works().map(work => ({ id: work.id, state: work.state, observation: work.observation })),
          occurrences: journal.db.prepare('SELECT state FROM occurrences').all() }));
      backend = await startBackend({ database: join(root, 'backend.sqlite'), port: Number(new URL(backendOrigin).port) });
      if (!daemonProbe) await journal.flush(api);
      let occurrences;
      for (let i = 0; i < 100; i++) {
        occurrences = (await ownerApi('GET', '/v1/occurrences')).items;
        if (occurrences.length) break;
        await delay(150);
      }
      assert.equal(occurrences.length, 1);
      assert.equal(occurrences[0].state, 'completed');
      if (!daemonProbe) await journal.flush(api);
      assert.equal((await ownerApi('GET', '/v1/occurrences')).items.length, 1);
      offlineAutomation = true;
    }
  }
  let tuiVerified = false;
  const decisionProbe = process.argv.includes('--decision');
  if (process.argv.includes('--tui') || decisionProbe) {
    const sessionB = await client.session.create({ location, title: 'Second Relay pane', model: { providerID: 'relay-fixture', id: 'fixture' } });
    if (decisionProbe) {
      await client.session.prompt({ sessionID: sessionB.id, id: 'msg_relay_v2_second', text: 'Disposable confirmation source.' });
      for (let i = 0; i < 150; i++) {
        if ((await client.message.list({ sessionID: sessionB.id, order: 'desc', limit: 10 })).data.some(message => message.type === 'idle')) break;
        await delay(200);
      }
    }
    const runTui = async (sessionID, index) => {
      const evidenceFile = join(root, `tui-${index}.jsonl`);
      // Each terminal has isolated CLI configuration, but shares the same server.
      const clientConfig = join(root, `client-${index}/opencode`);
      mkdirSync(clientConfig, { recursive: true });
      writeFileSync(join(clientConfig, 'cli.json'), JSON.stringify({ plugins: [{ package: packageDirectory, options: { evidenceFile } }] }));
      const tui = spawn('python3', [join(packageDirectory, 'pty-client.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
      let diagnostics = '';
      tui.stdout.on('data', () => {});
      tui.stderr.on('data', chunk => { diagnostics += chunk; });
      tui.stdin.end(JSON.stringify({ args: [binary, '--server', origin, '--session', sessionID, workspace],
        cwd: workspace, env: { ...env, OPENCODE_PASSWORD: password, XDG_CONFIG_HOME: join(root, `client-${index}`) },
        evidenceFile, columns: 180, decision: decisionProbe, redact: [password] }));
      const [code] = await once(tui, 'exit');
      assert.equal(code, 0, diagnostics);
      let events;
      try { events = readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
      catch { throw new Error(`TUI did not load: ${diagnostics}`); }
      assert.ok(events.some(event => event.type === 'attachment_sidebar' && event.sessionId === sessionID && ['attached', 'not_attached', 'pending'].includes(event.state)),
        `Sidebar attachment status missing: ${JSON.stringify(events)} ${diagnostics}`);
      assert.ok(events.some(event => event.type === 'attachment_sidebar_rendered' && event.sessionId === sessionID),
        `Sidebar was not mounted: ${JSON.stringify(events)} ${diagnostics}`);
      if (decisionProbe) {
        assert.ok(events.some(event => event.type === 'decision' && event.sessionId === sessionID && event.decision === 'confirmed' &&
          event.authority === 'unverified_client_local'), `Diagnostic confirmation missing: ${JSON.stringify(events)} ${diagnostics}`);
      } else {
        assert.ok(events.some(event => event.type === 'rpc' && event.sessionId === sessionID), `TUI RPC missing: ${JSON.stringify(events)} ${diagnostics}`);
        assert.ok(events.some(event => event.type === 'notification' && event.sessionId === sessionID), `TUI notification missing: ${JSON.stringify(events)}`);
      }
      return events;
    };
    const results = await Promise.allSettled([runTui(session.id, 1), runTui(sessionB.id, 2)]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const [a, b] = results.map(result => result.value);
    assert.notEqual(a[0].clientId, b[0].clientId);
    assert.ok(a.every(event => !event.sessionId || event.sessionId === session.id));
    assert.ok(b.every(event => !event.sessionId || event.sessionId === sessionB.id));
    if (process.argv.includes('--reconnect')) {
      const generation = (await rpc.inspect({}, { location })).generation;
      const currentConfig = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8'));
      currentConfig.plugins[0].options.reloadProbe = 'next-generation';
      writeFileSync(join(config, 'opencode.json'), JSON.stringify(currentConfig));
      await client.location.reload({ location });
      assert.notEqual((await rpc.inspect({}, { location })).generation, generation);
      const c = await runTui(sessionB.id, 3);
      const d = await runTui(session.id, 4);
      assert.notEqual(c[0].clientId, b[0].clientId);
      assert.notEqual(d[0].clientId, a[0].clientId);
      assert.ok(c.every(event => !event.sessionId || event.sessionId === sessionB.id));
      assert.ok(d.every(event => !event.sessionId || event.sessionId === session.id));
    }
    tuiVerified = true;
  }
  console.log(JSON.stringify({ runtime: version, plugin: '2.1.0', client: '2.1.0',
    serverPluginLoaded: true, readOnlyToolRegistered: true, readOnlyToolExecuted: true, typedRpc: true,
    exactPromptObserved: true, terminalOutcome: terminal.outcome, model: 'local deterministic fixture',
    modelRequests: requests, realModel: false, tuiVerified, diagnosticConfirmation: decisionProbe,
    humanAuthorityVerified: false, backendWorkflow, workerToolCalls, offlineAutomation, ownedRuntime,
    nodeDaemon: process.argv.includes('--daemon'), managedProvisioning,
    humanInboxTui: process.argv.includes('--human-inbox'), twoNodeProcesses: process.argv.includes('--mesh'),
    naturalChatProposalTui: process.argv.includes('--chat-answer'),
    scheduledClarification: process.argv.includes('--scheduled-ask'), folderTargeting: process.argv.includes('--folder'),
    nodeRestart: process.argv.includes('--restart-node'), clientReconnect: process.argv.includes('--reconnect'), standingMonitoring: process.argv.includes('--monitor'),
    staleConfirmationRefused: process.argv.includes('--reload-confirmation') || process.argv.includes('--transport-confirmation') || process.argv.includes('--switch-confirmation'),
    paneSwitchRoundTrip: process.argv.includes('--switch-confirmation'),
    transportReconnect: process.argv.includes('--transport-confirmation'),
    ownedNode: process.argv.includes('--owned-node'), acceptanceRetirement: process.argv.includes('--retire') }, null, 2));
} catch (error) {
  console.error(sanitise(log));
  throw error;
} finally {
  if (initiatorDaemon && initiatorDaemon.exitCode === null) { const exited = once(initiatorDaemon, 'exit'); initiatorDaemon.kill('SIGTERM'); await exited; }
  await initiatorRuntime?.stop();
  await humanRuntime?.stop();
  if (humanTui && humanTui.exitCode === null) { const exited = once(humanTui, 'exit'); humanTui.kill('SIGTERM'); await exited; }
  if (transportProxy) {
    transportProxy.closeAllConnections();
    await new Promise(resolve => transportProxy.close(resolve));
  }
  if (nodeDaemon && nodeDaemon.exitCode === null) {
    const exited = once(nodeDaemon, 'exit'); nodeDaemon.kill('SIGTERM');
    const timer = setTimeout(() => nodeDaemon.kill('SIGKILL'), 20000);
    await exited; clearTimeout(timer);
  }
  if (process.argv.includes('--owned-node') && journal) {
    const ownedConfig = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8'));
    ownedConfig.plugins = [];
    const managed = join(root, 'node-state/managed', digest('binding'), 'runtime');
    try {
      const runtime = await launchOwnedV2({ directory: managed, executable: binary, workspace,
        config: { ...ownedConfig, plugins: [{ package: `${packageDirectory}/`, options: {
          workerContextFile: join(root, 'node-state', `worker-${digest('worker')}.json`) } }] } });
      await runtime.stop();
    } catch (error) {
      // A verified stopped descriptor is already retired. Never resume just for cleanup.
      const descriptor = JSON.parse(readFileSync(join(managed, 'runtime.json'), 'utf8'));
      if (descriptor.state !== 'stopped') throw error;
    }
  }
  await owned?.stop();
  await provisioned?.runtime.stop();
  await nodeService?.close(); journal?.close(); await backend?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    process.kill(-child.pid, 'SIGTERM');
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    await exited;
    clearTimeout(timer);
  }
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
