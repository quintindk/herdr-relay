// Opt-in real-model acceptance. Reuses the existing authenticated OpenCode service,
// but creates private workspaces, sessions, backend, node and task records. It never
// copies a provider credential store or assigns work to an existing enrolled agent.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { nativeConnection, enrolInteractive } from '../src/native-enrol.mjs';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { NativeDecisionJournal } from '../src/native-decision-journal.mjs';
import { nativeBoard } from '../src/native-board.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { RelayRuntime } from '../packages/opencode-relay/rpc.mjs';
import { inspectCollaboration } from './collaboration-evidence.mjs';

const { values } = parseArgs({ options: { 'real-model': { type: 'boolean' }, inspect: { type: 'string' }, session: { type: 'string' }, package: { type: 'string' }, timeout: { type: 'string' } } });
if (values.inspect) {
  const { client } = await nativeConnection({});
  const evidence = await inspectCollaboration(client, values.inspect);
  const outcome = { ...evidence, reinspectedExistingRun: true, modelDispatchesDuringInspection: 0 };
  writeFileSync(join(evidence.privateEvidence, 'verification.json'), JSON.stringify(outcome, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(outcome, null, 2));
  process.exit(0);
}
assert.ok(values['real-model'] && values.session, 'Explicit opt-in required: --real-model --session EXISTING_MODEL_SOURCE_SESSION');
const seconds = Number(values.timeout ?? 600);
assert.ok(Number.isInteger(seconds) && seconds >= 30 && seconds <= 3600, 'Use a 30-3600 second job budget');
process.umask(0o077);
const packageDirectory = resolve(values.package ?? fileURLToPath(new URL('../', import.meta.url)));
const { client, url } = await nativeConnection({});
const source = await client.session.get({ sessionID: values.session });
assert.ok(source.model?.providerID && source.model.id, 'The source session must have a resolved authenticated model');
const model = { providerID: source.model.providerID, id: source.model.id, ...(source.model.variant ? { variant: source.model.variant } : {}) };
const root = mkdtempSync('/tmp/opencode/relay-collaboration-real-'), state = join(root, 'node');
mkdirSync(state);
const workspaces = { a: join(root, 'coordinator'), b: join(root, 'reviewer') };
const sessions = [], enrolled = {};
let backend, daemon, journal, decisions, log = '', outcome;
const startedAt = Date.now();
const wait = async (label, inspect) => {
  while (Date.now() - startedAt < (seconds + 30) * 1000) {
    if (daemon && daemon.exitCode !== null) throw Error(`Test node exited: ${log}`);
    const result = await inspect();
    if (result) return result;
    await delay(250);
  }
  throw Error(`Timed out waiting for ${label}. Private evidence: ${root}`);
};
const stop = async () => {
  if (!daemon || daemon.exitCode !== null) return;
  const exited = once(daemon, 'exit'); daemon.kill('SIGTERM');
  const timer = setTimeout(() => daemon.kill('SIGKILL'), 15000);
  try { await exited; } finally { clearTimeout(timer); }
};

try {
  const wrapper = join(root, 'plugin'); mkdirSync(wrapper);
  writeFileSync(join(wrapper, 'package.json'), JSON.stringify({ name: 'relay-collaboration-acceptance', type: 'module', exports: { '.': './index.mjs' } }));
  writeFileSync(join(wrapper, 'index.mjs'), `import candidate from ${JSON.stringify(join(packageDirectory, 'packages/opencode-relay/server.mjs'))};\n` +
    'export default { ...candidate, id: "relay.collaboration.acceptance" };\n');
  for (const workspace of Object.values(workspaces)) {
    mkdirSync(workspace);
    for (const skill of ['herdr-relay', 'relay-work']) {
      const directory = join(workspace, '.opencode/skills', skill); mkdirSync(directory, { recursive: true });
      copyFileSync(join(packageDirectory, 'skills', skill, 'SKILL.md'), join(directory, 'SKILL.md'));
    }
    writeFileSync(join(workspace, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json',
      plugins: ['-herdr.relay.server', { package: wrapper, options: { workerDirectory: state } }],
      compaction: { auto: false }, snapshots: false,
    }, null, 2));
  }
  const input = join(workspaces.b, 'manifest.json'), rules = join(workspaces.b, 'rules.md'), output = join(workspaces.a, 'repaired.json');
  const suffix = randomBytes(5).toString('hex');
  const original = { version: 1, services: [{ name: `api-${suffix}`, port: 443, replicas: 2, enabled: true },
    { name: `worker-${suffix}`, port: 8443, replicas: 0, enabled: true }] };
  writeFileSync(input, JSON.stringify(original, null, 2));
  writeFileSync(rules, 'Every enabled service requires an integer replica count of at least one. Preserve version, service names, ports and enabled flags. Do not add services. Make the smallest repair.\n');
  backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const command = (key, action, payload) => owner('POST', '/v1/commands', { key, action, payload });
  const coordination = ['relay_work_read', 'relay_work_submit', 'relay_work_ask', 'relay_delegate', 'relay_children', 'relay_wait_children',
    'relay_task_list', 'relay_task_inspect', 'relay_task_comments', 'relay_task_relations', 'relay_cli', 'relay_cli_help', 'relay_questions', 'relay_agent_answer'];
  for (const [id, workspace] of Object.entries(workspaces)) {
    const permissions = [{ action: '*', resource: '*', effect: 'deny' },
      // Core tools normalise in-location resources to relative paths. External
      // access has a separate check, so constrain the directory boundary there.
      ...['read', 'grep', 'glob'].map(action => ({ action, resource: '*', effect: 'allow' })),
      ...Object.values(workspaces).flatMap(directory => [directory, `${directory}/*`].map(resource => ({ action: 'external_directory', resource, effect: 'allow' }))),
      { action: 'skill', resource: '*', effect: 'allow' },
      ...coordination.map(action => ({ action, resource: '*', effect: 'allow' })),
      ...(id === 'a' ? ['edit', 'write', 'patch'].flatMap(action => [output, 'repaired.json'].map(resource => ({ action, resource, effect: 'allow' }))) : [])];
    const session = await client.session.create({ location: { directory: workspace }, title: `Relay collaboration acceptance ${id}`, model,
      metadata: { relayCollaborationAcceptance: root } });
    sessions.push(session.id);
    await client.session.update({ sessionID: session.id, permissions });
    enrolled[id] = await enrolInteractive({ api: owner, backend: { url: backend.origin }, configFile: join(state, 'node.json'),
      directory: workspace, sessionId: session.id, name: `Acceptance ${id}`, reserved: true, transport: 'tools', key: `acceptance-${id}` });
    assert.equal(enrolled[id].nativeUrl, url, 'Native service changed during test preparation');
  }
  daemon = spawn(process.execPath, [join(packageDirectory, 'src/node-cli.mjs'), '--config', join(state, 'node.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-8000); });
  await wait('private node readiness', () => log.includes('"state":"running"'));
  for (const [id, workspace] of Object.entries(workspaces)) {
    const status = await client.rpc(RelayRuntime).attachment({ sessionId: enrolled[id].sessionId }, { location: { directory: workspace } });
    assert.equal(status.agentId, enrolled[id].agentId, 'Test location is using the wrong Relay connector');
    assert.equal(status.state, 'attached');
  }
  journal = new NodeJournal(join(state, 'node.sqlite'), { nodeId: enrolled.a.nodeId, instanceId: backend.store.instance });
  decisions = new NativeDecisionJournal();
  const task = await command('root-task', 'task.create', { id: 'collaboration-acceptance', title: 'Review, repair and independently verify a release manifest' });
  const board = nativeBoard(owner, { decisionJournal: decisions });
  const sent = await board.dispatchTask({ taskId: task.id, expectedRevision: task.revision, key: 'one-human-handover', payload: {
    targetAgentId: enrolled.a.agentId, allowDelegation: true,
    collaboration: { peerAgentIds: [enrolled.b.agentId], maxRounds: 2, timeoutSeconds: seconds },
    instructions: `Work with the selected peer as an independent reviewer. The release manifest is ${input}; validation rules are ${rules}. ` +
      `Obtain the peer's independent assessment, write the smallest repaired manifest to ${output}, and obtain a fresh independent peer verification of the repaired file. ` +
      `Use the peer outcomes to produce the final report with the repaired file as candidate. Only the coordinator writes the repaired file. ` +
      `Keep all work within these private test files. No deployment, network changes or other side effects.`,
  } });
  const execution = await wait('actual two-agent work and coordinator completion', async () => {
    const humanQuestion = backend.store.all('question').find(question => question.status === 'open' && question.addressedTo.type === 'user');
    assert.ok(!humanQuestion, `The self-contained job requested an extra human decision: ${humanQuestion?.prompt}`);
    const current = await owner('GET', `/v1/executions/${sent.execution.id}`);
    if (['failed', 'cancelled', 'rejected'].includes(current.state)) throw Error(`Collaborative job ended ${current.state}: ${JSON.stringify(current.settlement ?? current.cancellationReason)}`);
    return current.state === 'completed' ? current : null;
  });
  outcome = await inspectCollaboration(client, root);
  writeFileSync(join(root, 'verification.json'), JSON.stringify(outcome, null, 2));
  console.log(JSON.stringify(outcome, null, 2));
} catch (error) {
  const evidence = { passed: false, realModels: true, model, stage: 'collaboration_acceptance', code: error.code ?? error.name,
    message: String(error.message).slice(0, 2000), privateEvidence: root, nodeLog: log };
  if (backend) evidence.executions = backend.store.all('execution').map(e => ({ id: e.id, state: e.state, targetAgentId: e.targetAgentId,
    parentExecutionId: e.parentExecutionId, cancellationReason: e.cancellationReason, settlement: e.settlement }));
  writeFileSync(join(root, 'failure.json'), JSON.stringify(evidence, null, 2));
  console.error(JSON.stringify(evidence, null, 2)); process.exitCode = 1;
} finally {
  // Only test-created sessions are interrupted/archived. The source session and
  // all existing Relay enrolments/assignments remain untouched.
  for (const sessionID of sessions) {
    try { await client.session.interrupt({ sessionID }); } catch {}
  }
  await stop(); journal?.close(); decisions?.close(); await backend?.close();
  for (const sessionID of sessions) {
    try { await client.session.update({ sessionID, archived: true }); } catch {}
  }
}
