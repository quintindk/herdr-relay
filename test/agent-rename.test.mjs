import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { bootstrapNode } from '../src/node-bootstrap.mjs';
import { nativeBoard } from '../src/native-board.mjs';
import { NativeDecisionJournal } from '../src/native-decision-journal.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { NativeReceivers } from '../src/native-receivers.mjs';

async function fixture(t) {
  const root = mkdtempSync(join(process.env.RELAY_TEST_SCRATCH ?? '/tmp/opencode', 'agent-rename-'));
  const backend = await startBackend({ database: ':memory:' });
  const store = backend.store, token = store.bootstrap().token, owner = store.authenticate(token);
  const command = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  const nodes = {}, operators = {}, operatorApis = {};
  for (const id of ['local', 'remote']) {
    const bundle = bootstrapNode(store, owner, { key: id, id, name: id, mode: 'roots', roots: [root] });
    nodes[id] = store.authenticate(bundle.nodeToken); operators[id] = store.authenticate(bundle.operatorToken);
    operatorApis[id] = nativeBackendClient({ url: backend.origin, token: bundle.operatorToken });
  }
  const directory = join(root, 'workspace');
  command(owner, 'enrol', 'agent.enrol', { id: 'agent', nodeId: 'local', name: 'Original', directory });
  command(owner, 'attach', 'agent.attach', { id: 'agent', directory, conversationId: 'ses_keep', bindingId: 'binding-keep', expectedBindingRevision: 0 });
  const api = nativeBackendClient({ url: backend.origin, token }), journal = new NativeDecisionJournal();
  const f = { root, directory, backend, store, owner, nodes, operators, operatorApis, command, api, journal, board: nativeBoard(api, { decisionJournal: journal }) };
  f.rename = (key, name, revision = 0, actor = owner) => command(actor, key, 'agent.rename', { id: 'agent', name, expectedNameRevision: revision });
  t.after(async () => { journal.close(); await backend.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('renaming updates only name metadata and retains agent identity, binding, active work and schedules', async t => {
  const f = await fixture(t);
  f.command(f.owner, 'task', 'task.create', { id: 'task', title: 'Keep work' });
  f.command(f.owner, 'execution', 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1, targetAgentId: 'agent', instructions: 'Keep this assignment' });
  f.command(f.owner, 'schedule', 'schedule.install', { id: 'schedule', definition: { nodeId: 'local', targetAgentId: 'agent',
    cron: '* * * * *', enabled: false, instructions: 'Keep this schedule' } });
  const before = f.store.get('agent', 'agent'), work = f.store.get('execution', 'execution'), schedule = f.store.get('schedule', 'schedule');
  const result = f.rename('rename', 'New name');
  assert.deepEqual(result, { ...before, name: 'New name', nameRevision: 1, revision: before.revision + 1, updatedAt: result.updatedAt });
  assert.deepEqual(f.store.get('execution', 'execution'), work); assert.deepEqual(f.store.get('schedule', 'schedule'), schedule);
  assert.deepEqual(f.rename('rename', 'New name'), result);
  assert.throws(() => f.rename('rename', 'Changed payload'), { code: 'operation_conflict' });
});

test('name revisions ignore heartbeat churn but fence concurrent renames and an old-name ABA cycle', async t => {
  const f = await fixture(t), agent = f.store.get('agent', 'agent');
  f.command(f.nodes.local, 'heartbeat', 'agent.advertise', { id: agent.id, expectedRevision: agent.revision,
    availability: 'available', conversationId: agent.conversationId, bindingRevision: agent.bindingRevision });
  assert.equal(f.rename('first', 'Second').nameRevision, 1);
  const renamed = f.store.get('agent', 'agent');
  f.command(f.nodes.local, 'after-rename', 'agent.advertise', { id: renamed.id, expectedRevision: renamed.revision,
    availability: 'busy', conversationId: renamed.conversationId, bindingRevision: renamed.bindingRevision });
  assert.equal(f.store.get('agent', 'agent').name, 'Second'); assert.equal(f.store.get('agent', 'agent').nameRevision, 1);
  assert.throws(() => f.rename('stale', 'Third'), { code: 'stale_agent_name' });
  assert.equal(f.rename('back', 'Original', 1).nameRevision, 2);
  assert.throws(() => f.rename('old-preview', 'Fourth'), { code: 'stale_agent_name' });
});

test('only the human and the correctly scoped node operator may rename, never node workers or another node operator', async t => {
  const f = await fixture(t);
  assert.throws(() => f.rename('worker', 'No', 0, f.nodes.local), { code: 'forbidden' });
  assert.throws(() => f.rename('remote', 'No', 0, f.operators.remote), { code: 'operator_scope_mismatch' });
  f.command(f.owner, 'outside', 'agent.enrol', { id: 'outside', nodeId: 'local', name: 'Outside', directory: '/outside' });
  assert.throws(() => f.command(f.operators.local, 'outside-rename', 'agent.rename', { id: 'outside', expectedNameRevision: 0, name: 'No' }), { code: 'operator_scope_mismatch' });
  const localBoard = nativeBoard(f.operatorApis.local, { decisionJournal: f.journal });
  const preview = await localBoard.prepareAgentRename({ agentId: 'agent' });
  assert.equal((await localBoard.renameAgent({ ...preview, key: 'local', name: 'Allowed' })).agent.name, 'Allowed');
  await assert.rejects(nativeBoard(f.operatorApis.remote).prepareAgentRename({ agentId: 'agent' }), { code: 'operator_scope_mismatch' });
});

test('rename rejects unsafe names, unexpected fields and conflicting names in the same enrolled workspace', async t => {
  const f = await fixture(t);
  for (const [index, name] of ['', ' ', ' padded', 'trailing ', 'a'.repeat(257), 'line\nname', '\u001b[31mred', 'hidden\u202ename', 'hidden\u0085name', '\u200b', 'hidden\u2060name'].entries())
    assert.throws(() => f.rename(`invalid-${index}`, name), { code: 'invalid_agent_name' });
  assert.throws(() => f.command(f.owner, 'extra', 'agent.rename', { id: 'agent', expectedNameRevision: 0, name: 'Other', directory: '/changed' }), { code: 'invalid_request' });
  assert.throws(() => f.rename('unchanged', 'Original'), { code: 'agent_name_unchanged' });
  f.command(f.owner, 'second', 'agent.enrol', { id: 'second', nodeId: 'local', name: 'Taken', directory: f.directory });
  assert.throws(() => f.rename('duplicate', 'Taken'), { code: 'enrolment_exists' });
  assert.equal(f.rename('unicode', 'Équipe 文書').name, 'Équipe 文書');
});

test('the board previews the raw name and publishes a durable rename without using the decorated node label', async t => {
  const f = await fixture(t), preview = await f.board.prepareAgentRename({ agentId: 'agent' });
  assert.equal(preview.name, 'Original'); assert.equal(preview.expectedNameRevision, 0);
  const result = await f.board.renameAgent({ ...preview, name: 'Docs', key: 'board-rename' });
  assert.equal(result.state, 'recorded'); assert.equal(result.agent.nameRevision, 1);
  const snapshot = await f.board.read();
  assert.equal(snapshot.agentRenamingAvailable, true); assert.equal(snapshot.agents[0].displayName, 'Docs');
  assert.equal(snapshot.agents[0].rawName, 'Docs'); assert.match(snapshot.agents[0].name, /Docs @ local/);
  assert.equal(f.journal.pending().length, 0);
  f.rename('literal-name', 'Interactive Relay chat', 1);
  assert.equal((await f.board.read()).agents[0].displayName, 'Interactive Relay chat', 'An explicit rename is not replaced by the legacy placeholder label');
});

test('lost committed replies retain the original rename in Inbox and retry the same key without another rename', async t => {
  const f = await fixture(t); let lose = true;
  const api = async (...args) => { const result = await f.api(...args); if (lose && args[2]?.action === 'agent.rename') { lose = false; throw Error('Lost committed reply'); } return result; };
  const board = nativeBoard(api, { decisionJournal: f.journal });
  const preview = await board.prepareAgentRename({ agentId: 'agent' }), input = { ...preview, name: 'Docs', key: 'lost-rename' };
  await assert.rejects(board.renameAgent(input), /Lost committed reply/);
  assert.equal(f.store.get('agent', 'agent').nameRevision, 1); assert.equal(f.journal.pending()[0].key, input.key);
  const pending = (await board.read()).inbox[0];
  assert.match(pending.summary, /agent.rename: Docs/);
  await assert.rejects(board.prepareAgentRename({ agentId: 'agent' }), { code: 'decision_pending' });
  await assert.rejects(board.renameAgent({ ...input, name: 'Another' }), { code: 'decision_conflict' });
  assert.equal((await board.decideInbox({ item: await board.detailInbox({ id: pending.id }), key: 'reconcile-original' })).state, 'recorded');
  assert.equal(f.store.get('agent', 'agent').nameRevision, 1); assert.equal(f.journal.pending().length, 0);
});

test('stale previews and unsupported backends fail before storing or publishing a rename', async t => {
  const f = await fixture(t), preview = await f.board.prepareAgentRename({ agentId: 'agent' });
  f.rename('someone-else', 'Their name');
  await assert.rejects(f.board.renameAgent({ ...preview, name: 'Mine', key: 'stale-preview' }), { code: 'stale_agent_name' });
  assert.equal(f.journal.inspect('stale-preview'), null);
  const old = nativeBoard(async (...args) => args[1] === '/v1/info' ? { ...(await f.api(...args)), features: {} } : f.api(...args), { decisionJournal: f.journal });
  await assert.rejects(old.prepareAgentRename({ agentId: 'agent' }), { code: 'backend_upgrade_required' });
});

test('node projections and restart snapshots synchronise local enrolment names without changing receiver state or accepting stale/foreign names', async t => {
  const f = await fixture(t), journal = new NodeJournal(':memory:', { nodeId: 'local', instanceId: f.store.instance });
  t.after(() => journal.close());
  const receivers = new NativeReceivers(journal);
  receivers.enrol({ id: 'agent', directory: f.directory, name: 'Original', transport: 'tools' });
  const receiver = { bindingId: 'keep', generation: 4, state: 'active' }; receivers.put('receiver:agent', receiver);
  const renamed = f.rename('rename', 'Docs');
  const event = (id, data) => ({ id, type: 'agent.rename', entityId: data.id, revision: data.revision, data });
  journal.consume({ items: [event('rename', renamed)], cursor: 'one' });
  assert.equal(receivers.get('enrolment:agent').name, 'Docs'); assert.deepEqual(receivers.receiver('agent'), receiver);
  journal.consume({ items: [event('stale', { ...renamed, revision: renamed.revision - 1, name: 'Stale', nameRevision: 0 })], cursor: 'two' });
  assert.equal(receivers.get('enrolment:agent').name, 'Docs');
  const latest = f.rename('again', 'Documentation', 1);
  journal.reconcileSnapshot({ instanceId: f.store.instance, protocol: 'relay/0.2', cursor: 'snapshot', collections: { agent: [latest] } });
  assert.equal(receivers.get('enrolment:agent').name, 'Documentation');
  journal.consume({ items: [event('foreign', { ...latest, revision: latest.revision + 1, nodeId: 'remote', name: 'Foreign', nameRevision: 3 })], cursor: 'three' });
  assert.equal(receivers.get('enrolment:agent').name, 'Documentation'); assert.deepEqual(receivers.receiver('agent'), receiver);
});

test('headless names are editable without altering their mode, capabilities or setup identity', async t => {
  const f = await fixture(t);
  const original = f.command(f.nodes.local, 'headless', 'agent.register', { id: 'headless', nodeId: 'local', name: 'Old job', mode: 'headless', directory: f.directory, capabilities: ['private-capability'] });
  const result = f.command(f.operators.local, 'rename-headless', 'agent.rename', { id: 'headless', expectedNameRevision: 0, name: 'Reports' });
  assert.equal(result.mode, original.mode); assert.deepEqual(result.capabilities, original.capabilities); assert.equal(result.directory, original.directory);
});

test('an incorrect rename receipt stays pending until the exact original operation can be verified', async t => {
  const f = await fixture(t);
  const api = async (...args) => { const result = await f.api(...args); return args[2]?.action === 'agent.rename' ? { ...result, nameRevision: 99 } : result; };
  const board = nativeBoard(api, { decisionJournal: f.journal }), preview = await board.prepareAgentRename({ agentId: 'agent' });
  const input = { ...preview, key: 'bad-receipt', name: 'Docs' };
  await assert.rejects(board.renameAgent(input), { code: 'invalid_decision_receipt' });
  assert.equal(f.journal.pending()[0].key, input.key); assert.equal(f.store.get('agent', 'agent').nameRevision, 1);
  assert.equal((await f.board.renameAgent(input)).agent.nameRevision, 1); assert.equal(f.journal.pending().length, 0);
});

test('the public CLI TUI renames an agent through real PTY keyboard input and backend publication', async t => {
  if (process.platform === 'win32') { t.skip('Requires POSIX PTY'); return; }
  const f = await fixture(t), context = join(f.root, 'fixture-context.json');
  const token = f.store.issueCredential({ type: 'user', id: 'owner' }).token;
  writeFileSync(context, JSON.stringify({ url: f.backend.origin, token }), { mode: 0o600 });
  const result = await promisify(execFile)('python3', ['test/agent-rename-pty.py', process.execPath, 'src/cli.mjs', context, f.root], {
    timeout: 20000, env: { ...process.env, CI: 'true', CONTINUOUS_INTEGRATION: 'true', GITHUB_ACTIONS: 'true' },
  });
  assert.equal(JSON.parse(result.stdout).confirmed, true);
  const agent = f.store.get('agent', 'agent'); assert.equal(agent.name, 'PTY Documentation'); assert.equal(agent.nameRevision, 1);
  assert.equal(agent.conversationId, 'ses_keep'); assert.equal(agent.bindingId, 'binding-keep'); assert.equal(agent.bindingRevision, 1);
});
