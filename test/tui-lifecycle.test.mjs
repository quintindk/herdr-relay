import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { bootstrapNode } from '../src/node-bootstrap.mjs';
import { nativeBoard } from '../src/native-board.mjs';
import { NativeDecisionJournal } from '../src/native-decision-journal.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { NativeReceivers } from '../src/native-receivers.mjs';
import { inspectDatabase, assertInteractiveUpgradeCompatibility } from '../src/upgrade-safety.mjs';

async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/tui-lifecycle-'), database = join(root, 'backend.sqlite');
  const backend = await startBackend({ database }), store = backend.store, ownerToken = store.bootstrap().token;
  const owner = store.authenticate(ownerToken), actors = {}, apis = {}, tokens = {};
  const command = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  for (const id of ['local', 'remote']) {
    const bundle = bootstrapNode(store, owner, { key: id, id, name: id, mode: 'roots', roots: [root] });
    actors[id] = store.authenticate(bundle.nodeToken); actors[`${id}Operator`] = store.authenticate(bundle.operatorToken);
    apis[id] = nativeBackendClient({ url: backend.origin, token: bundle.operatorToken }); tokens[id] = bundle.operatorToken; tokens[`${id}Node`] = bundle.nodeToken;
  }
  const directory = join(root, 'workspace');
  for (const [id, nodeId] of [['agent', 'local'], ['remote-agent', 'remote']]) {
    command(owner, `enrol-${id}`, 'agent.enrol', { id, nodeId, name: id === 'agent' ? 'Archive me' : 'Remote', directory });
    command(owner, `attach-${id}`, 'agent.attach', { id, directory, conversationId: `ses_${id}`, bindingId: `binding-${id}`, expectedBindingRevision: 0 });
  }
  const journal = new NativeDecisionJournal(), api = apis.local;
  const board = nativeBoard(api, { decisionJournal: journal });
  const f = { root, database, backend, store, owner, actors, apis, tokens, directory, command, journal, api, board };
  f.schedule = (id = 'schedule', extra = {}) => ({ id, definition: { nodeId: 'local', targetAgentId: 'agent', intent: 'job',
    cron: '0 9 * * 1-5', timezone: 'Africa/Johannesburg', instructions: 'Inspect the existing fixture only', reviewPolicy: 'human', enabled: false, ...extra } });
  f.remove = (key = 'delete-agent', actor = owner) => command(actor, key, 'agent.delete', { id: 'agent',
    expectedRevision: store.get('agent', 'agent').revision, reason: 'Remove unused fixture enrolment' });
  f.work = () => {
    command(owner, 'task', 'task.create', { id: 'task', title: 'Keep this work' });
    return command(owner, 'execution', 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1,
      targetAgentId: 'agent', instructions: 'No native execution in this fixture' });
  };
  t.after(async () => { journal.close(); await backend.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('inactive-agent deletion retains identity and history, frees the directory and cannot be revived by old advertisements', async t => {
  const f = await fixture(t), before = f.store.get('agent', 'agent');
  assert.throws(() => f.remove('node', f.actors.local), { code: 'forbidden' });
  assert.throws(() => f.remove('remote', f.actors.remoteOperator), { code: 'operator_scope_mismatch' });
  const preview = await f.board.prepareAgentDelete({ agentId: 'agent' });
  assert.equal(preview.eligible, true);
  const result = await f.board.deleteAgent({ ...preview, key: 'delete', reason: 'Remove unused enrolment' });
  assert.ok(result.agent.deletedAt); assert.equal(result.agent.deletion.nativeProcessTerminationClaimed, false);
  assert.equal(result.agent.bindingId, before.bindingId); assert.equal(result.agent.conversationId, before.conversationId);
  assert.deepEqual(result.agent.standingGrant, before.standingGrant);
  assert.equal(f.store.get('agent', 'agent', false), null);
  assert.throws(() => f.store.get('agent', 'agent'), { code: 'agent_deleted' });
  assert.equal(f.store.all('agent').some(agent => agent.id === 'agent'), false);
  assert.equal(f.store.query('agent').items.some(agent => agent.id === 'agent'), false);
  assert.equal(f.store.snapshot().collections.agent.find(agent => agent.id === 'agent').deletedAt, result.agent.deletedAt);
  assert.equal((await f.api('GET', '/v1/agents/agent')).deletedAt, result.agent.deletedAt);
  const advertised = f.command(f.actors.local, 'old-advertisement', 'agent.advertise', { id: 'agent', expectedRevision: before.revision,
    availability: 'available', bindingRevision: before.bindingRevision, conversationId: before.conversationId });
  assert.deepEqual(advertised, result.agent);
  assert.throws(() => f.command(f.owner, 'reuse-id', 'agent.enrol', { id: 'agent', nodeId: 'local', directory: f.directory, name: before.name }), { code: 'identity_conflict' });
  assert.equal(f.command(f.owner, 'new-id', 'agent.enrol', { id: 'fresh-agent', nodeId: 'local', directory: f.directory, name: before.name }).id, 'fresh-agent');
  assert.throws(() => f.command(f.owner, 'schedule-deleted', 'schedule.install', f.schedule()), { code: 'agent_deleted' });
  assert.equal((await f.board.read()).agents.some(agent => agent.id === 'agent'), false);
});

test('fresh presence, stale revisions and work added after the preview prevent agent deletion', async t => {
  const f = await fixture(t), original = f.store.get('agent', 'agent');
  f.command(f.actors.local, 'online', 'agent.advertise', { id: 'agent', expectedRevision: original.revision, availability: 'available',
    conversationId: original.conversationId, bindingRevision: original.bindingRevision });
  assert.equal((await f.board.prepareAgentDelete({ agentId: 'agent' })).eligible, false);
  assert.throws(() => f.remove(), { code: 'agent_in_use' });
  const online = f.store.get('agent', 'agent');
  f.command(f.actors.local, 'offline', 'agent.advertise', { id: 'agent', expectedRevision: online.revision, availability: 'offline',
    conversationId: online.conversationId, bindingRevision: online.bindingRevision });
  const preview = await f.board.prepareAgentDelete({ agentId: 'agent' });
  f.work();
  await assert.rejects(f.board.deleteAgent({ ...preview, key: 'racing-work', reason: 'Do not discard work' }), { code: 'agent_in_use' });
  assert.equal(f.journal.inspect('racing-work'), null);
  assert.equal(f.store.get('execution', 'execution').state, 'requested');
  assert.throws(() => f.command(f.owner, 'stale', 'agent.delete', { id: 'agent', expectedRevision: original.revision, reason: 'Stale preview' }), { code: 'stale_revision' });
});

for (const [kind, data] of [
  ['execution', { id: 'review', targetAgentId: 'agent', state: 'in_review' }],
  ['question', { id: 'question', status: 'open', addressedTo: { type: 'agent', id: 'agent' } }],
  ['schedule', { id: 'paused', definition: { nodeId: 'local', targetAgentId: 'agent', enabled: false } }],
  ['provision_grant', { id: 'permission', requesterAgentId: 'agent', state: 'active' }],
  ['headless_grant', { id: 'permission', requesterAgentId: 'agent', state: 'active' }],
  ['review_grant', { id: 'permission', reviewerAgentId: 'agent', state: 'active' }],
  ['provision_request', { id: 'preparation', agentId: 'agent', state: 'blocked', admission: { state: 'reserved' } }],
  ['grant_request', { id: 'request', operation: { requesterAgentId: 'agent' }, state: 'awaiting_approval' }],
  ['message', { id: 'message', recipient: { agentId: 'agent' }, state: 'uncertain' }],
]) test(`agent deletion refuses live ${kind} references without changing them`, async t => {
  const f = await fixture(t), record = f.store.save(kind, { ...data, revision: 1 });
  const preview = await f.board.prepareAgentDelete({ agentId: 'agent' });
  assert.equal(preview.eligible, false); assert.ok(preview.blockers.some(blocker => blocker.ids.includes(data.id)));
  assert.throws(() => f.remove(), { code: 'agent_in_use' });
  assert.deepEqual(f.store.get(kind, data.id), record);
});

test('lost deletion replies reconcile the original receipt despite the now-hidden agent', async t => {
  const f = await fixture(t); let lose = true;
  const api = async (...args) => { const result = await f.api(...args); if (lose && args[2]?.action === 'agent.delete') { lose = false; throw Error('Lost committed deletion'); } return result; };
  const board = nativeBoard(api, { decisionJournal: f.journal }), preview = await board.prepareAgentDelete({ agentId: 'agent' });
  const input = { ...preview, key: 'lost', reason: 'Unused agent' };
  await assert.rejects(board.deleteAgent(input), /Lost committed/);
  assert.equal(f.journal.pending()[0].key, input.key);
  await assert.rejects(board.deleteAgent({ ...input, reason: 'Changed confirmation' }), { code: 'decision_conflict' });
  assert.equal((await board.deleteAgent(input)).agent.id, 'agent'); assert.equal(f.journal.pending().length, 0);
  assert.equal(f.store.get('agent', 'agent', true, true).revision, preview.expectedRevision + 1);
});

test('uncertain creation and rename receipts remain reconcilable after later cancellation and agent deletion', async t => {
  const f = await fixture(t); let loseCreate = true, loseRename = true;
  const api = async (...args) => {
    const result = await f.api(...args);
    if (args[2]?.action === 'schedule.install' && loseCreate) { loseCreate = false; throw Error('Lost create'); }
    if (args[2]?.action === 'agent.rename' && loseRename) { loseRename = false; throw Error('Lost rename'); }
    return result;
  };
  const board = nativeBoard(api, { decisionJournal: f.journal });
  const preview = await board.prepareScheduleCreate({ payload: f.schedule() }), scheduleInput = { ...preview, key: 'create-lost' };
  const rename = { ...(await board.prepareAgentRename({ agentId: 'agent' })), key: 'rename-lost', name: 'Historical name' };
  await assert.rejects(board.createSchedule(scheduleInput), /Lost create/);
  await assert.rejects(board.renameAgent(rename), /Lost rename/);
  f.command(f.owner, 'cancel', 'schedule.cancel', { id: 'schedule', expectedRevision: 1, reason: 'Remove future ticks' });
  f.command(f.actors.local, 'ack', 'schedule.acknowledge', { id: 'schedule', expectedRevision: 2 });
  f.remove();
  assert.equal((await board.createSchedule(scheduleInput)).schedule.revision, 1);
  assert.equal((await board.renameAgent(rename)).agent.name, 'Historical name');
  const attachment = await f.api('POST', '/v1/commands', { key: 'attach-agent', action: 'agent.attach', payload: {
    id: 'agent', directory: f.directory, conversationId: 'ses_agent', bindingId: 'binding-agent', expectedBindingRevision: 0 } });
  assert.equal(attachment.bindingId, 'binding-agent');
  assert.equal(f.store.get('schedule', 'schedule').cancelled, true); assert.equal(f.store.get('agent', 'agent', false), null);
  assert.equal(f.journal.pending().length, 0);
});

test('unknown or stale presence is not treated as an active receiving chat, but fresh available/busy presence is protected', async t => {
  const f = await fixture(t), agent = f.store.get('agent', 'agent');
  f.command(f.actors.local, 'unreachable', 'agent.advertise', { id: agent.id, expectedRevision: agent.revision,
    availability: 'unknown', conversationId: agent.conversationId, bindingRevision: agent.bindingRevision });
  assert.equal((await f.board.prepareAgentDelete({ agentId: agent.id })).eligible, true);
  const unknown = f.store.get('agent', agent.id);
  f.store.save('agent', { ...unknown, availability: 'busy', lastSeenAt: new Date(Date.now() - 60000).toISOString() });
  assert.equal((await f.board.prepareAgentDelete({ agentId: agent.id })).eligible, true);
  f.store.save('agent', { ...unknown, availability: 'busy' });
  assert.equal((await f.board.prepareAgentDelete({ agentId: agent.id })).eligible, false);
});

test('a real node excludes a deleted configured binding before native authentication and retains that fence offline', async t => {
  const f = await fixture(t), state = join(f.root, 'node-state'), config = join(f.root, 'node.json'); f.remove();
  writeFileSync(config, JSON.stringify({ identityVersion: 2, nodeId: 'local', stateDirectory: state,
    backend: { url: f.backend.origin, token: f.tokens.localNode }, bindings: [{ id: 'deleted-binding', agentId: 'agent', harness: 'opencode-v2',
      reserved: true, url: 'http://127.0.0.1:1', authFile: join(f.root, 'must-not-read.json'), identity: { sessionId: 'ses_agent', directory: f.directory } }] }), { mode: 0o600 });
  const start = async () => {
    const child = spawn(process.execPath, ['src/node-cli.mjs', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
    try {
      for (let i = 0; i < 100 && !output.includes('"state":"running"'); i++) { if (child.exitCode !== null) throw Error(output); await delay(20); }
      assert.match(output, /"bindings":0/);
      assert.deepEqual(inspectDatabase(join(state, 'node.sqlite'), 'node').agentDeletionRecords, ['agent']);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGTERM');
        const timeout = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timeout);
      }
    }
  };
  await start(); await f.backend.close(); await start();
});

test('deleted-agent snapshots fence node receivers, preserve local records and prevent an unsafe downgrade', async t => {
  const f = await fixture(t), path = join(f.root, 'node.sqlite');
  const journal = new NodeJournal(path, { nodeId: 'local', instanceId: f.store.instance }), receivers = new NativeReceivers(journal);
  t.after(() => journal.close());
  const enrolment = receivers.enrol({ id: 'agent', name: 'Archive me', directory: f.directory, transport: 'tools' });
  const binding = { id: 'binding', agentId: 'agent', receiverGeneration: 1, identity: { sessionId: 'ses_agent' } };
  receivers.put('native-binding:binding', binding); receivers.put('receiver:agent', { state: 'active', bindingId: 'binding', generation: 1 });
  const original = receivers.get('receiver:agent'); f.remove();
  journal.reconcileSnapshot(f.store.snapshot());
  assert.equal(receivers.isDeleted('agent'), true); assert.deepEqual(receivers.list('enrolment'), []);
  assert.deepEqual(receivers.get('enrolment:agent'), enrolment); assert.deepEqual(receivers.get('receiver:agent'), original);
  assert.throws(() => receivers.enrol({ id: 'agent', name: 'Do not overwrite', directory: f.directory, transport: 'tools' }), { code: 'agent_deleted' });
  assert.deepEqual(receivers.get('enrolment:agent'), enrolment);
  assert.deepEqual(receivers.loadableBindings(), []); assert.equal(receivers.resolve('agent'), null);
  assert.deepEqual(receivers.resolve('agent', { bindingId: binding.id }), binding, 'Historical evidence remains inspectable');
  assert.throws(() => journal.assertReceiver(binding), { code: 'agent_deleted' });
  for (const [database, role] of [[f.database, 'backend'], [path, 'node']]) {
    const identity = inspectDatabase(database, role);
    assert.deepEqual(identity.agentDeletionRecords, ['agent']);
    assert.throws(() => assertInteractiveUpgradeCompatibility(identity, { compatibility: {} }), { code: 'upgrade_agent_deletion_protocol_required' });
    assert.doesNotThrow(() => assertInteractiveUpgradeCompatibility(identity, { compatibility: { agentDeletion: 1 } }));
  }
});

test('manual schedule creation is scoped, previewed, paused by default and supports existing interactive agents or reminders', async t => {
  const f = await fixture(t), candidates = await f.board.prepareScheduleCreation();
  assert.deepEqual(candidates.nodes.map(node => node.id), ['local']); assert.deepEqual(candidates.agents.map(agent => agent.id), ['agent']);
  const preview = await f.board.prepareScheduleCreate({ payload: f.schedule() });
  assert.equal(preview.nextRuns.length, 3); assert.equal(f.store.all('schedule').length, 0);
  const created = await f.board.createSchedule({ ...preview, key: 'create' });
  assert.equal(created.schedule.revision, 1); assert.equal(created.schedule.appliedRevision, 0); assert.equal(created.schedule.definition.enabled, false);
  assert.equal(f.store.all('execution').length, 0);
  const routine = (await f.board.read()).routines[0]; assert.equal(routine.enabled, false); assert.equal(routine.state, 'change_pending');
  const resume = await f.board.prepareScheduleChange({ scheduleId: 'schedule', operation: 'resume' });
  assert.equal((await f.board.changeSchedule({ ...resume, key: 'resume' })).schedule.definition.enabled, true);
  const pause = await f.board.prepareScheduleChange({ scheduleId: 'schedule', operation: 'pause' });
  assert.equal((await f.board.changeSchedule({ ...pause, key: 'pause' })).schedule.definition.enabled, false);
  const reminder = f.schedule('reminder', { intent: 'reminder', reviewPolicy: 'none' }); delete reminder.definition.targetAgentId;
  const reminderPreview = await f.board.prepareScheduleCreate({ payload: reminder });
  assert.equal((await f.board.createSchedule({ ...reminderPreview, key: 'reminder' })).schedule.definition.intent, 'reminder');
});

test('schedule creation rejects invalid input, reused IDs, out-of-scope targets and unapproved headless workers before publication', async t => {
  const f = await fixture(t);
  f.command(f.actors.local, 'worker', 'agent.register', { id: 'worker', nodeId: 'local', name: 'Headless', mode: 'headless', directory: f.directory });
  for (const payload of [f.schedule('bad id'), f.schedule('bad-cron', { cron: 'not cron' }), f.schedule('bad-zone', { timezone: 'Mars/Nowhere' }),
    f.schedule('blank', { instructions: ' ' }), f.schedule('headless', { targetAgentId: 'worker' }),
    f.schedule('remote', { nodeId: 'remote', targetAgentId: 'remote-agent' }), f.schedule('unsupported', { targetFolder: f.directory })]) {
    await assert.rejects(f.board.prepareScheduleCreate({ payload }));
  }
  assert.equal(f.journal.pending().length, 0); assert.equal(f.store.all('schedule').length, 0);
  const preview = await f.board.prepareScheduleCreate({ payload: f.schedule() });
  await f.board.createSchedule({ ...preview, key: 'create' });
  await assert.rejects(f.board.prepareScheduleCreate({ payload: f.schedule() }), { code: 'schedule_exists' });
  const cancel = await f.board.prepareScheduleChange({ scheduleId: 'schedule' });
  await f.board.changeSchedule({ ...cancel, key: 'delete', reason: 'No longer needed' });
  await assert.rejects(f.board.prepareScheduleCreate({ payload: f.schedule() }), { code: 'schedule_exists' });
});

test('schedule deletion keeps runs and admitted work, and lost replies remain reconcilable after agent deletion', async t => {
  const f = await fixture(t); f.command(f.owner, 'schedule', 'schedule.install', f.schedule());
  f.store.save('occurrence', { id: 'past', scheduleId: 'schedule', intendedAt: '2026-01-01T07:00:00Z', state: 'completed', revision: 1 });
  const work = f.work(); let lose = true;
  const api = async (...args) => { const result = await f.api(...args); if (lose && args[2]?.action === 'schedule.cancel') { lose = false; throw Error('Lost cancel reply'); } return result; };
  const board = nativeBoard(api, { decisionJournal: f.journal }), preview = await board.prepareScheduleChange({ scheduleId: 'schedule' });
  const input = { ...preview, key: 'delete-schedule', reason: 'Remove recurring trigger' };
  await assert.rejects(board.changeSchedule(input), /Lost cancel reply/);
  assert.equal(f.store.get('schedule', 'schedule').cancelled, true); assert.deepEqual(f.store.get('execution', 'execution'), work);
  assert.equal(f.store.get('occurrence', 'past').state, 'completed');
  assert.equal((await f.board.read()).routines[0].cancelled, true);
  f.store.save('execution', { ...work, state: 'completed' });
  assert.throws(() => f.remove(), { code: 'agent_in_use' });
  f.command(f.actors.local, 'cancel-ack', 'schedule.acknowledge', { id: 'schedule', expectedRevision: f.store.get('schedule', 'schedule').revision });
  f.remove();
  assert.equal((await board.changeSchedule(input)).state, 'recorded'); assert.equal(f.journal.pending().length, 0);
  assert.equal(f.store.get('schedule', 'schedule').revision, preview.expectedRevision + 1);
});

test('node operators cannot create or change schedules outside their node/workspace and node credentials cannot impersonate the human', async t => {
  const f = await fixture(t), payload = f.schedule();
  assert.throws(() => f.command(f.actors.remoteOperator, 'remote-create', 'schedule.install', payload), { code: 'operator_scope_mismatch' });
  assert.throws(() => f.command(f.actors.local, 'node-create', 'schedule.install', payload), { code: 'forbidden' });
  f.command(f.owner, 'outside', 'agent.enrol', { id: 'outside', nodeId: 'local', name: 'Outside', directory: '/outside' });
  assert.throws(() => f.command(f.actors.localOperator, 'outside-create', 'schedule.install', f.schedule('outside', { targetAgentId: 'outside' })), { code: 'operator_scope_mismatch' });
  f.command(f.owner, 'create', 'schedule.install', payload);
  assert.throws(() => f.command(f.actors.remoteOperator, 'remote-cancel', 'schedule.cancel', { id: payload.id, expectedRevision: 1, reason: 'No' }), { code: 'operator_scope_mismatch' });
});

test('uncertain schedule creation retries only its exact confirmation and does not create another schedule', async t => {
  const f = await fixture(t); let lose = true;
  const api = async (...args) => { const result = await f.api(...args); if (lose && args[2]?.action === 'schedule.install') { lose = false; throw Error('Lost create reply'); } return result; };
  const board = nativeBoard(api, { decisionJournal: f.journal }), preview = await board.prepareScheduleCreate({ payload: f.schedule() });
  const input = { ...preview, key: 'create' };
  await assert.rejects(board.createSchedule(input), /Lost create reply/);
  await assert.rejects(board.createSchedule({ ...input, definition: { ...input.definition, enabled: true } }), { code: 'decision_conflict' });
  await assert.rejects(board.prepareScheduleCreate({ payload: f.schedule() }), { code: 'decision_pending' });
  assert.equal((await board.createSchedule(input)).schedule.revision, 1); assert.equal(f.store.all('schedule').length, 1);
});

test('older backends expose no lifecycle controls and cannot receive lifecycle publications', async t => {
  const f = await fixture(t);
  const board = nativeBoard(async (...args) => args[1] === '/v1/info' ? { ...(await f.api(...args)), features: {} } : f.api(...args), { decisionJournal: f.journal });
  assert.equal((await board.read()).agentDeletionAvailable, false); assert.equal((await board.read()).scheduleManagementAvailable, false);
  await assert.rejects(board.prepareAgentDelete({ agentId: 'agent' }), { code: 'backend_upgrade_required' });
  await assert.rejects(board.prepareScheduleCreation(), { code: 'backend_upgrade_required' });
  assert.equal(f.journal.pending().length, 0);
});

test('real TUI keyboard input creates a paused cron, deletes it and removes the now-unreferenced inactive agent', async t => {
  if (process.platform === 'win32') { t.skip('Requires POSIX PTY'); return; }
  const f = await fixture(t), context = join(f.root, 'operator.json');
  // This disposable owning node acknowledges cancellation only. No job is run.
  const acknowledgements = setInterval(() => {
    for (const schedule of f.store.all('schedule')) if (schedule.cancelled && schedule.appliedRevision !== schedule.revision)
      f.command(f.actors.local, `ack:${schedule.id}:${schedule.revision}`, 'schedule.acknowledge', { id: schedule.id, expectedRevision: schedule.revision });
  }, 20);
  acknowledgements.unref(); t.after(() => clearInterval(acknowledgements));
  writeFileSync(context, JSON.stringify({ url: f.backend.origin, token: f.tokens.local,
    scope: f.actors.localOperator.scope, nodeId: 'local', instanceId: f.store.instance }), { mode: 0o600 });
  const result = await promisify(execFile)('python3', ['test/tui-lifecycle-pty.py', process.execPath, 'src/cli.mjs', context, f.root], {
    timeout: 25000, env: { ...process.env, CI: 'true', CONTINUOUS_INTEGRATION: 'true', GITHUB_ACTIONS: 'true' },
  });
  assert.equal(JSON.parse(result.stdout).realTuiKeyboard, true);
  const schedule = f.store.get('schedule', 'pty-job');
  assert.equal(schedule.cancelled, true); assert.equal(schedule.definition.enabled, false); assert.equal(schedule.definition.targetAgentId, 'agent');
  assert.equal(f.store.all('execution').length, 0);
  assert.ok(f.store.get('agent', 'agent', true, true).deletedAt);
});
