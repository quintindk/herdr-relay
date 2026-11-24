// Real OpenCode interactive turn and actual Relay CLI, with two isolated node
// identities and a deterministic loopback provider. No live service is adopted.
import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

process.umask(0o077);
const execFile = promisify(exec), packageDirectory = resolve(process.env.RELAY_PACKAGE_DIRECTORY ?? '.');
const load = path => import(pathToFileURL(join(packageDirectory, path)).href);
const { startBackend } = await load('src/backend-service.mjs');
const { nativeBackendClient } = await load('src/backend-client.mjs');
const { createNodeBundle, joinNode } = await load('src/native-onboarding.mjs');
const { startNodeService } = await load('src/node-service.mjs');
const { NodeJournal } = await load('src/node-journal.mjs');
const { tickNode } = await load('src/node-execution.mjs');
const { v2WorkerInstructions } = await load('src/node-worker-instructions.mjs');
const { launchOwnedV2 } = await load('packages/opencode-relay/owned-runtime.mjs');
const { NativeOpenCodeV2, observeV2 } = await load('packages/opencode-relay/native.mjs');
const root = mkdtempSync('/tmp/opencode/relay-task-attachments-');
const workspace = join(root, 'workspace'), scratch = join(workspace, 'scratch'), state = join(root, 'surface');
const downloaded = join(scratch, 'brief.bin'), deliverable = join(scratch, 'deliverable.bin');
mkdirSync(scratch, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const input = Buffer.from(Array.from({ length: 131073 }, (_, index) => (index * 37) % 256));
const expected = Buffer.concat([Buffer.from('relay verified\0'), input]);
const modelRef = { providerID: 'fixture', id: 'fixture' };
let runtime, backend, journal, service, brief, modelError, sessionId, passed = false;
const fixtureStep = [
  () => ['relay_cli', { args: ['native', 'task', 'attachments', 'REL-1'] }],
  () => ['relay_cli', { args: ['native', 'task', 'download', 'REL-1', brief.id, '--output', downloaded] }],
  () => ['shell', { command: `node ${join(workspace, 'verify-brief.cjs')}` }],
  () => ['relay_cli', { args: ['native', 'task', 'attach', 'REL-1', '--file', deliverable, '--key', 'worker-deliverable-v1'] }],
  () => ['relay_work_submit', { key: 'fixture-result', candidate: sha(expected), summary: 'Verified the downloaded brief and attached the binary deliverable.' }],
];
const model = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const { messages, tools } = JSON.parse(body), last = messages.findLastIndex(message => message.role === 'user');
    const step = messages.slice(last + 1).filter(message => message.role === 'tool').length;
    const next = fixtureStep[step]?.();
    if (next) assert.ok(tools?.some(tool => tool.function.name === next[0]), `Missing fixture tool ${next[0]}`);
    const delta = next ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${step}`, type: 'function',
      function: { name: next[0], arguments: JSON.stringify(next[1]) } }] } : { role: 'assistant', content: 'Attachment turn complete.' };
    const base = { id: 'attachment-fixture', created: 1, model: 'fixture', object: 'chat.completion.chunk' };
    res.setHeader('content-type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: next ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch (error) { modelError = error; res.writeHead(400).end(); }
});
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const joinFixtureNode = async (key, name) => {
    const bundleFile = join(root, `${key}.bundle.json`);
    await createNodeBundle({ api: owner, output: bundleFile, key, name, url: backend.origin, mode: 'localUser' });
    return joinNode({ bundleFile, configFile: join(root, key, 'node.json') });
  };
  const evo = await joinFixtureNode('evo', 'Fixture Evo'), surface = await joinFixtureNode('surface', 'Fixture Surface');
  assert.notEqual(evo.nodeId, surface.nodeId);
  const env = { PATH: process.env.PATH, HOME: join(root, 'operator-home'), XDG_CONFIG_HOME: join(root, 'operator-home/config'),
    XDG_STATE_HOME: join(root, 'operator-home/state'), XDG_DATA_HOME: join(root, 'operator-home/data') };
  const cli = async (...args) => JSON.parse((await execFile(process.execPath, [join(packageDirectory, 'src/cli.mjs'), 'native', ...args,
    '--context', evo.operatorContextFile], { cwd: root, env, timeout: 15000 })).stdout);
  const payload = (name, value) => { const path = join(root, `${name}.json`); writeFileSync(path, JSON.stringify(value)); return path; };
  const task = await cli('task', 'create', '--file', payload('task', { id: 'attachment-fixture-task', title: 'Transfer binary files' }), '--key', 'fixture-task');
  assert.equal(task.reference, 'REL-1');
  const source = join(root, 'brief.bin'); writeFileSync(source, input);
  brief = await cli('task', 'attach', 'REL-1', '--file', source, '--key', 'fixture-brief');
  assert.equal(brief.sha256, sha(input)); assert.equal(brief.size, input.length);

  writeFileSync(join(workspace, 'verify-brief.cjs'), `const fs = require('node:fs'), sha = require('node:crypto').createHash;
const bytes = fs.readFileSync(${JSON.stringify(downloaded)});
if (bytes.length !== ${input.length} || sha('sha256').update(bytes).digest('hex') !== ${JSON.stringify(sha(input))}) throw Error('Incorrect fixture brief');
fs.writeFileSync(${JSON.stringify(deliverable)}, Buffer.concat([Buffer.from('relay verified\\0'), bytes]), { flag: 'wx', mode: 0o600 });
console.log('FIXTURE_BRIEF_VERIFIED');
`);
  runtime = await launchOwnedV2({ directory: join(root, 'runtime'), workspace,
    executable: process.env.RELAY_V2_BINARY ?? resolve('packages/opencode-relay/node_modules/.bin/opencode2'),
    config: { plugins: [{ package: join(packageDirectory, 'packages/opencode-relay'), options: { workerDirectory: state } }],
      model: 'fixture/fixture', compaction: { auto: false }, providers: { fixture: { package: '@ai-sdk/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only' },
        models: { fixture: { name: 'Attachment fixture', limit: { context: 32768, output: 512 } } } } } } });
  const session = await runtime.client.session.create({ location: { directory: workspace }, title: 'Fixture Surface worker', model: modelRef });
  sessionId = session.id;
  const agentId = 'fixture-surface-worker', bindingId = 'fixture-worker-binding', socketPath = join(state, 'node.sock');
  const operator = nativeBackendClient(JSON.parse(readFileSync(evo.operatorContextFile, 'utf8')));
  const surfaceOperator = nativeBackendClient(JSON.parse(readFileSync(surface.operatorContextFile, 'utf8')));
  await surfaceOperator('POST', '/v1/commands', { key: 'worker-enrol', action: 'agent.enrol', payload: { id: agentId, nodeId: surface.nodeId, directory: workspace, name: 'Fixture worker' } });
  await surfaceOperator('POST', '/v1/commands', { key: 'worker-bind', action: 'agent.attach', payload: { id: agentId, expectedBindingRevision: 0, conversationId: sessionId, directory: workspace, bindingId } });
  const { dev, ino } = statSync(workspace);
  const worker = { agentId, sessionId, bindingId, bindingRevision: 1, socketPath, directory: workspace,
    directoryIdentity: { dev, ino }, token: 'fixture-worker-token' };
  const workerFile = join(state, 'worker.json');
  writeFileSync(workerFile, JSON.stringify(worker));
  writeFileSync(join(state, 'worker-index.json'), JSON.stringify({ sessions: { [sessionId]: workerFile } }));
  const api = nativeBackendClient(JSON.parse(readFileSync(surface.configFile, 'utf8')).backend);
  const identity = { sessionId, projectId: session.projectID, directory: workspace, createdAt: session.time.created };
  const binding = { id: bindingId, agentId, identity, receiverGeneration: 1, interactive: true, native: new NativeOpenCodeV2(runtime.client, identity),
    observe: observeV2, workerInstructions: v2WorkerInstructions };
  const resolveBinding = async id => id === agentId ? binding : undefined;
  journal = new NodeJournal(join(state, 'node.sqlite'), { nodeId: surface.nodeId, instanceId: backend.store.instance });
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run(`receiver:${agentId}`, JSON.stringify({ state: 'active', bindingId, generation: 1 }));
  service = await startNodeService({ journal, socketPath, workers: [worker], api, resolveBinding });
  const execution = await cli('execution', 'request', '--file', payload('execution', { id: 'attachment-execution', taskId: task.id,
    taskRevision: task.revision, targetAgentId: agentId, reviewPolicy: 'none', instructions: 'List and download the attached brief, verify it and attach the resulting deliverable. Submit the result.' }),
  '--key', 'fixture-dispatch');
  assert.equal(execution.targetNodeId, surface.nodeId);
  const deadline = Date.now() + 45000;
  let current;
  do {
    if (modelError) throw modelError;
    await tickNode(journal, api, resolveBinding);
    current = await operator('GET', `/v1/executions/${execution.id}`);
    if (['completed', 'failed', 'cancelled', 'rejected'].includes(current.state)) break;
    assert.notEqual(journal.work(execution.id)?.recovery?.state, 'blocked', JSON.stringify(journal.work(execution.id)));
    await delay(75);
  } while (Date.now() < deadline);
  const messages = (await runtime.client.message.list({ sessionID: sessionId, order: 'asc', limit: 100 })).data;
  const tools = messages.flatMap(message => message.content?.filter(part => part.type === 'tool') ?? []);
  assert.equal(current.state, 'completed', JSON.stringify({ work: journal.work(execution.id), tools }));
  assert.equal(current.result.candidate, sha(expected));
  assert.deepEqual(tools.map(tool => tool.name), ['relay_cli', 'relay_cli', 'shell', 'relay_cli', 'relay_work_submit']);
  assert.ok(tools.every(tool => tool.state.status === 'completed'), JSON.stringify(tools));
  const cliResults = [0, 1, 3].map(index => JSON.parse(tools[index].state.content[0].text));
  assert.ok(cliResults.every(result => result.exitCode === 0 && !result.operatorContextUsed), JSON.stringify(cliResults));
  assert.equal(JSON.parse(cliResults[0].stdout).items[0].id, brief.id);
  assert.ok(cliResults.every(result => result.authority === 'execution'), JSON.stringify(cliResults));
  assert.deepEqual(readFileSync(downloaded), input); assert.deepEqual(readFileSync(deliverable), expected);
  const result = JSON.parse(cliResults[2].stdout);
  assert.deepEqual(result.uploadedBy, { type: 'node', id: surface.nodeId });
  const output = join(root, 'evo', 'deliverable.bin');
  const downloadedReceipt = await cli('task', 'download', 'REL-1', result.id, '--output', output);
  assert.equal(downloadedReceipt.sha256, sha(expected)); assert.deepEqual(readFileSync(output), expected);
  for (const record of [brief, result]) {
    const blob = join(root, 'blobs', record.sha256.slice(0, 2), record.sha256);
    assert.ok(existsSync(blob));
    const detached = await cli('task', 'detach', 'REL-1', record.id, '--revision', String(record.revision), '--key', `detached-${record.id}`);
    assert.equal(detached.state, 'detached');
    await assert.rejects(operator.downloadAttachment(task.id, record.id), { code: 'attachment_detached', status: 410 });
    assert.ok(!existsSync(blob));
  }
  const summary = { passed: true, runtime: (await runtime.client.server.info()).version, twoNodeOperatorAttachVerified: true, isolatedHostFixture: true,
    workerScopedDownloadAndAttachVerified: true, operatorDownloadDeliverableVerified: true, detachAndBlobGcVerified: true,
    userServicesTouched: false, credentialsCopied: false };
  console.log(JSON.stringify(summary, null, 2));
  passed = true;
} finally {
  if (!passed) console.error(`Isolated fixture retained at ${root}`);
  await runtime?.stop(); await service?.close(); journal?.close(); await backend?.close();
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  if (passed) rmSync(root, { recursive: true, force: true });
}
