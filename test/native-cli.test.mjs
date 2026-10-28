import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { digest } from '../src/protocol.mjs';
const exec = promisify(execFile);
const cli = (...args) => exec(process.execPath, ['src/cli.mjs', 'native', ...args], { timeout: 15000 });

async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/native-cli-');
  const backend = await startBackend({ database: ':memory:' });
  const context = join(root, 'owner.json');
  const config = { url: backend.origin, token: backend.store.bootstrap().token };
  writeFileSync(context, JSON.stringify(config), { mode: 0o600 });
  t.after(async () => { await backend.close(); rmSync(root, { recursive: true, force: true }); });
  let sequence = 0;
  return { root, api: nativeBackendClient(config), context, backend, token: config.token,
    file(payload) { const file = join(root, `payload-${++sequence}.json`); writeFileSync(file, JSON.stringify(payload)); return file; },
    async run(...args) { return JSON.parse((await cli(...args, '--context', context)).stdout); } };
}

test('native CLI exposes native task creation, comments, edits and manual completion without legacy Relay', async t => {
  const f = await fixture(t);
  const create = ['task', 'create', '--key', 'create', '--file', f.file({ id: 'task', title: 'CLI native task' })];
  assert.equal((await f.run(...create)).revision, 1);
  assert.equal((await f.run(...create)).revision, 1);
  const edit = await f.run('task', 'edit', '--key', 'edit', '--file', f.file({ id: 'task', expectedRevision: 1, changes: { status: 'in_progress' } }));
  assert.equal(edit.status, 'in_progress');
  await f.run('task', 'comment', '--key', 'comment', '--file', f.file({ id: 'comment', taskId: 'task', body: 'Verified via CLI' }));
  const done = await f.run('task', 'complete', 'task', '--revision', String(edit.revision), '--key', 'done');
  assert.equal(done.status, 'done');
  assert.equal((await f.run('task', 'inspect', 'task')).status, 'done');
  assert.equal((await f.run('task', 'list', '--limit', '1')).items.length, 1);
  assert.equal((await f.run('comment', 'list')).items[0].body, 'Verified via CLI');
  assert.equal((await f.api('GET', '/v1/comments')).items[0].body, 'Verified via CLI');
  assert.equal((await f.api('GET', '/v1/executions')).items.length, 0, 'Human task status must not fabricate an execution receipt');
});

test('native CLI cannot turn a node credential into operator authority', async t => {
  const f = await fixture(t);
  await f.api('POST', '/v1/commands', { key: 'node', action: 'node.enrol', payload: { id: 'node', name: 'Node' } });
  const credential = await f.api('POST', '/v1/node-credentials', { nodeId: 'node', key: 'credential' });
  const context = join(f.root, 'node.json');
  writeFileSync(context, JSON.stringify({ url: f.backend.origin, token: credential.token }), { mode: 0o600 });
  await assert.rejects(cli('task', 'create', '--context', context, '--key', 'forbidden', '--file', f.file({ id: 'forbidden', title: 'No authority' })), /forbidden/);
  assert.equal((await f.run('task', 'list')).items.length, 0);
});

test('native CLI schedules and execution requests retain backend revisions, explicit activation and native authority', async t => {
  const f = await fixture(t);
  const owner = f.backend.store.authenticate(f.token);
  const store = f.backend.store;
  store.command(owner, { key: 'node', action: 'node.enrol', payload: { id: 'node', name: 'Node' } });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  store.command(node, { key: 'agent', action: 'agent.register', payload: { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'interactive' } });
  store.command(node, { key: 'ad', action: 'agent.advertise', payload: { id: 'agent', expectedRevision: 1, availability: 'available', conversationId: 'exact-chat' } });
  const schedule = await f.run('schedule', 'create', '--key', 'schedule', '--file', f.file({ id: 'job', definition: {
    nodeId: 'node', targetAgentId: 'agent', targetConversationId: 'exact-chat', cron: '* * * * *', enabled: false, instructions: 'Check only' } }));
  assert.equal(schedule.definition.enabled, false);
  assert.equal(schedule.appliedRevision, 0);
  const resumed = await f.run('schedule', 'resume', 'job', '--revision', '1', '--key', 'resume');
  assert.equal(resumed.definition.enabled, true);
  assert.equal(resumed.appliedRevision, 0, 'CLI cannot acknowledge on the node behalf');
  await assert.rejects(f.run('schedule', 'pause', 'job', '--revision', '1', '--key', 'stale'), /stale_revision/);
  const paused = await f.run('schedule', 'pause', 'job', '--revision', '2', '--key', 'pause');
  assert.equal(paused.definition.enabled, false);
  assert.equal((await f.run('schedule', 'list')).items.length, 1);
  const settingsArgs = ['schedule', 'result-notifications', 'job', '--revision', '3', '--inbox', 'true', '--requester', 'false', '--key', 'result-settings'];
  const settings = await f.run(...settingsArgs);
  assert.deepEqual(settings.definition.runResultNotifications, { inbox: true, requester: false });
  assert.equal(settings.definition.enabled, false); assert.equal(settings.revision, 4);
  assert.deepEqual(await f.run(...settingsArgs), settings);
  await assert.rejects(f.run('schedule', 'result-notifications', 'job', '--revision', '4', '--inbox', 'true', '--requester', 'maybe', '--key', 'bad-settings'), /invalid_request/);
  const task = await f.run('task', 'create', '--key', 'task', '--file', f.file({ id: 'task', title: 'Execution task' }));
  const execution = await f.run('execution', 'request', '--key', 'request', '--file', f.file({ id: 'execution', taskId: task.id,
    taskRevision: task.revision, targetAgentId: 'agent', instructions: 'Bounded test', reviewPolicy: 'none' }));
  assert.equal(execution.state, 'requested');
  await f.run('execution', 'cancel', execution.id, '--revision', String(execution.revision), '--reason', 'Test cancelled', '--key', 'cancel');
  assert.equal((await f.run('execution', 'inspect', execution.id)).cancellationRequested, true);
});

test('native work CLI delegates to exact scoped credentials and stages without claiming settlement', async t => {
  const root = mkdtempSync('/tmp/opencode/native-cli-worker-');
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  journal.save({ id: 'execution', state: 'observing', execution: { id: 'execution', state: 'accepted', targetAgentId: 'agent', runId: 'run' } });
  const socketPath = join(root, 'node.sock');
  const service = await startNodeService({ journal, socketPath, workers: [{ agentId: 'agent', token: 'worker-token' }] });
  t.after(async () => { await service.close(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  const context = join(root, 'worker.json');
  writeFileSync(context, JSON.stringify({ socketPath, token: 'worker-token' }), { mode: 0o600 });
  const common = ['--context', context, '--execution', 'execution', '--run', 'run'];
  assert.equal(JSON.parse((await cli('work', 'read', ...common)).stdout).execution.id, 'execution');
  const result = join(root, 'result.json'); writeFileSync(result, JSON.stringify({ candidate: 'candidate', summary: 'Done' }));
  const staged = JSON.parse((await cli('work', 'submit', ...common, '--key', 'result', '--file', result)).stdout);
  assert.equal(staged.state, 'staged'); assert.equal(staged.nativeSettlementRequired, true);
  assert.equal(journal.work('execution').state, 'observing');
  await assert.rejects(cli('work', 'read', ...common.slice(0, -1), 'wrong-run'), /forbidden/);
});

test('native CLI rejects ignored options, unknown verbs and unsafe pagination without calling a backend', async () => {
  assert.match((await cli('--help')).stdout, /agent enrol.*--here/);
  assert.match((await cli('schedule', 'preview', '--cron', '0 8 * * 1-5')).stdout, /Africa\/Johannesburg/);
  for (const args of [['schedule', 'preview', '--cron', '* * * * *', '--key', 'ignored'],
    ['schedule', 'resume', 'job', '--file', '/missing'], ['board', 'unexpected'],
    ['task', 'list', '--limit', '501', '--context', '/missing'], ['agent', 'enrol', '--here', '--session', 'both', '--context', '/missing']]) {
    await assert.rejects(cli(...args));
  }
});

test('native board and tui alias use the native default context without changing other command authority', async t => {
  const f = await fixture(t), state = join(f.root, 'state');
  const directory = join(state, 'herdr-relay-backend');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const defaultContext = join(directory, 'owner.json');
  writeFileSync(defaultContext, JSON.stringify({ url: f.backend.origin, token: f.token }), { mode: 0o600 });
  const env = { ...process.env, XDG_STATE_HOME: state }; delete env.RELAY_NATIVE_CONTEXT;
  const run = (...args) => exec(process.execPath, ['src/cli.mjs', ...args], { env, timeout: 15000 });
  assert.deepEqual(JSON.parse((await run('native', 'board', '--json')).stdout).inbox, []);
  assert.deepEqual(JSON.parse((await run('tui', '--json')).stdout).inbox, []);
  await assert.rejects(run('native', 'task', 'list'), /Explicit --context/);
  writeFileSync(defaultContext, JSON.stringify({ url: f.backend.origin, token: 'bad-token' }));
  await assert.rejects(run('tui', '--json'), /unauthorised/);
  assert.deepEqual(JSON.parse((await run('tui', '--json', '--context', f.context)).stdout).inbox, []);
});

test('real native CLI TUI displays paused cron and its completed taskless receipt', async t => {
  if (process.platform === 'win32') { t.skip('PTY probe requires POSIX'); return; }
  const f = await fixture(t);
  const store = f.backend.store, owner = store.authenticate(f.token);
  const command = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  command(owner, 'node', 'node.enrol', { id: 'node', name: 'Node' });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  command(node, 'agent', 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
  command(owner, 'job', 'schedule.install', { id: 'visible-pty-job', definition: { nodeId: 'node', targetAgentId: 'agent',
    cron: '* * * * *', enabled: true, instructions: 'Check' } });
  const intendedAt = '2026-10-21T07:38:00.000Z';
  command(node, 'receipt', 'schedule.publish', { id: `occurrence_${digest(['visible-pty-job', intendedAt])}`, scheduleId: 'visible-pty-job',
    definitionRevision: 1, intendedAt, candidate: 'candidate', summary: 'LIVE_CRON_RECEIPT_OK', evidence: 'Fixture native terminal' });
  command(owner, 'pause', 'schedule.pause', { id: 'visible-pty-job', expectedRevision: 1 });
  command(node, 'ack', 'schedule.acknowledge', { id: 'visible-pty-job', expectedRevision: 2 });
  const probe = await exec('python3', ['test/native-board-pty.py', process.execPath, 'src/cli.mjs', f.context, 'visible-pty-job', 'LIVE_CRON_RECEIPT_OK'], { timeout: 20000 });
  assert.deepEqual(JSON.parse(probe.stdout), { cronVisible: true, completedReceiptVisible: true, cleanQuit: true });
});
