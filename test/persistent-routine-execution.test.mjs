import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { routineTargetAdmission } from '../src/routines.mjs';
import { admitRoutineExecution, assertRoutineTask } from '../src/routine-execution.mjs';
import { taskOrigins } from '../src/task-origin.mjs';
import { publish } from '../src/paperclip.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-folder-execution-'));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const config = { companyId: 'company', machineId: 'machine', session: 'default', socketPath: '/herdr.sock', bridgeDirectories: ['/twd'] };
  const scope = { companyId: 'company', machineId: 'machine', session: 'default', socketPath: '/herdr.sock', directory: '/twd' };
  const body = { title: 'Inbox', description: 'Read only', projectId: null, parentIssueId: null, assigneeAgentId: 'router' };
  const schedule = store.saveOperation({ id: 'routine:folder', runId: '', created: true, state: 'active', persistentScope: scope,
    router: { agentId: 'router', marker: 'router-marker', scope }, routineId: 'native', triggerId: 'trigger', body,
    authority: { kind: 'operator' }, request: { companyId: 'company', targetDirectory: '/twd', relayReviewPolicy: 'human', cron: '0 * * * *', timezone: 'Africa/Johannesburg' } });
  const routine = { id: 'native', companyId: 'company', ...body,
    triggers: [{ id: 'trigger', routineId: 'native', kind: 'schedule', cronExpression: '0 * * * *', timezone: 'Africa/Johannesburg' }] };
  const tasks = new Map(), occurrences = [];
  const f = { store, config, schedule, routine, tasks, occurrences };
  f.restart = () => { store.close(); store = new Store(path); f.store = store; };
  f.chat = id => {
    const binding = store.register({ id, companyId: 'company', agentId: `observed-${id}`, harness: 'opencode',
      delivery: 'pull', instanceId: digest(['machine', 'default']), conversationId: id }).binding;
    const observed = store.saveOperation({ id: `herdr-agent:${id}`, runId: '', agentId: binding.config.agentId, marker: id, availability: 'present',
      identity: { companyId: 'company', machineId: 'machine', session: 'default', harness: 'opencode', sessionKind: 'id', conversationId: id },
      placement: { directory: '/twd', terminalId: id } });
    const bridge = store.saveOperation({ id: `opencode-bridge:${id}`, runId: '', state: 'armed', ready: true, epoch: id,
      sessionCreatedAt: 123, tokenHash: id, lastSeen: new Date().toISOString(),
      identity: { bindingId: id, observedId: observed.id, conversationId: id, directory: '/twd', terminalId: id } });
    return { binding, observed, bridge };
  };
  f.occurrence = id => {
    const task = { id, identifier: id, companyId: 'company', ...body, parentId: null,
      originKind: 'routine_execution', originId: 'native', originRunId: `occurrence-${id}` };
    tasks.set(id, task);
    occurrences.push({ id: task.originRunId, companyId: 'company', routineId: 'native', source: 'schedule', triggerId: 'trigger', linkedIssueId: id });
    return { companyId: 'company', agentId: 'router', taskId: id, runId: `backend-${id}` };
  };
  f.api = async (method, path) => {
    assert.equal(method, 'GET');
    if (path === '/api/routines/native') return structuredClone(routine);
    if (path === '/api/routines/native/runs?limit=200') return structuredClone(occurrences);
    const task = tasks.get(path.slice('/api/issues/'.length));
    assert.ok(task, path); return structuredClone(task);
  };
  f.admit = input => admitRoutineExecution(store, f.api, input, { observationConfig: config });
  f.offline = chat => store.saveOperation({ ...chat.observed, availability: 'offline' });
  f.settle = run => {
    store.acknowledge(run.id); store.cancel(run.id);
    store.settle(run.id, { outcome: 'cancelled', evidence: 'Verified fixture turn ended' });
  };
  return f;
}

test('folder occurrence waits offline then dispatches once to the unique enrolled chat with stable backend identity', async t => {
  const f = fixture(t), input = f.occurrence('first');
  await assert.rejects(f.admit(input), { code: 'routine_target_busy' });
  assert.deepEqual(f.store.runs(), []);
  assert.equal(f.store.operation(`routine-task:${digest(['company', 'first'])}`), null);
  const chat = f.chat('chat-a');
  const run = await f.admit(input);
  assert.equal(run.request.bindingId, chat.binding.id);
  assert.equal(run.request.agentId, 'router');
  assert.notEqual(run.request.agentId, chat.binding.config.agentId);
  assertRoutineTask(f.store, chat.binding.id, 'first');
  const receipt = f.store.operation(`routine-task:${digest(['company', 'first'])}`);
  assert.equal(receipt.relayRunId, run.id);
  assert.equal(receipt.routingAgentId, 'router');
  assert.equal(taskOrigins(f.store)[0].request.origin.conversationId, 'chat-a');
  assert.equal((await f.admit(input)).id, run.id);
  assert.equal(f.store.runs().length, 1);
});

test('new chats inherit future occurrences but never an old admitted turn', async t => {
  const f = fixture(t), old = f.chat('old'), first = f.occurrence('first');
  const run = await f.admit(first);
  f.offline(old); const next = f.chat('new');
  const second = f.occurrence('second');
  await assert.rejects(f.admit(second), { code: 'routine_target_busy' });
  assert.equal((await f.admit(first)).id, run.id);
  assert.equal((await f.admit(first)).request.bindingId, old.binding.id);
  f.settle(run);
  const following = await f.admit(second);
  assert.equal(following.request.bindingId, next.binding.id);
  assert.equal(following.request.agentId, run.request.agentId);
  assert.equal(f.store.operation(f.schedule.id).routineId, 'native');
  assert.equal(f.store.operation(f.schedule.id).state, 'active');
  await assert.rejects(f.admit({ ...first, runId: 'another-wake' }), { code: 'routine_occurrence_reserved' });
  assert.equal(f.store.runs().length, 2);
});

test('coordinator restart retains the timer, routing agent and immutable delivered occurrence', async t => {
  const f = fixture(t), old = f.chat('old'), first = f.occurrence('first');
  const run = await f.admit(first);
  f.store.acknowledge(run.id);
  f.store.beginNative(run.id, 'Read inbox', []);
  const promptId = f.store.run(run.id).invocation.messageId;
  f.restart(); f.offline(old); f.chat('new');
  assert.equal((await f.admit(first)).invocation.messageId, promptId);
  assert.equal((await f.admit(first)).request.bindingId, 'old');
  assert.equal(f.store.operation(f.schedule.id).router.agentId, 'router');
  await assert.rejects(f.admit(f.occurrence('next')), { code: 'routine_target_busy' });
  f.store.cancel(run.id);
  f.store.settle(run.id, { outcome: 'cancelled', evidence: 'Fixture verified original turn was aborted' });
  assert.equal((await f.admit({ companyId: 'company', agentId: 'router', taskId: 'next', runId: 'backend-next' })).request.bindingId, 'new');
});

test('busy and ambiguous folder chats leave the occurrence unclaimed', async t => {
  const f = fixture(t), first = f.chat('first'), input = f.occurrence('pending');
  f.store.saveOperation({ ...first.bridge, ready: false });
  await assert.rejects(f.admit(input), { code: 'routine_target_busy' });
  f.store.saveOperation(first.bridge); f.chat('second');
  await assert.rejects(f.admit(input), { code: 'routine_target_busy' });
  assert.deepEqual(f.store.runs(), []);
  assert.equal(f.store.operation(`routine-task:${digest(['company', 'pending'])}`), null);
});

test('ordinary dispatch cannot spoof a router agent or select a folder target', t => {
  const f = fixture(t), chat = f.chat('chat');
  assert.throws(() => f.store.dispatch({ bindingId: chat.binding.id, bindingRevision: 1,
    companyId: 'company', agentId: 'router', taskId: 'unknown', runId: 'spoofed' }), { code: 'identity_mismatch' });
  assert.equal(routineTargetAdmission(f.store, chat.binding).ready, true);
});

test('folder results publish under the stable backend agent while preserving selected-chat review origin', async t => {
  const f = fixture(t); f.chat('current'); const run = await f.admit(f.occurrence('report'));
  f.store.acknowledge(run.id);
  f.store.submit(run.id, { key: 'result', candidate: 'digest', summary: 'Read-only findings' });
  let posts = 0;
  const published = await publish(f.store, run.id, 'backend-token', async (caller, token, method, path, body) => {
    assert.equal(caller.request.agentId, 'router'); assert.equal(token, 'backend-token');
    assert.equal(method, 'POST'); assert.equal(path, '/api/issues/report/comments');
    assert.match(body.body, /Read-only findings/); posts++;
    return { id: 'comment' };
  });
  assert.equal(published.publication.state, 'recorded'); assert.equal(posts, 1);
  assert.equal(taskOrigins(f.store)[0].request.origin.conversationId, 'current');
  assert.equal(taskOrigins(f.store)[0].request.relayReviewPolicy, 'human');
});

test('supported duplicate wakes of a reported occurrence become no-ops rather than another native run', async t => {
  const f = fixture(t); f.chat('chat'); const input = f.occurrence('done'); const run = await f.admit(input);
  f.store.acknowledge(run.id); f.store.submit(run.id, { key: 'out', candidate: 'digest', summary: 'Reported' });
  f.store.publication(run.id, { state: 'recorded' }); f.store.settle(run.id, { outcome: 'completed', evidence: 'Verified finish' });
  const result = await f.admit({ ...input, runId: 'withdrawal-wake', reportedOccurrenceNoop: true });
  assert.equal(result.skipped, true); assert.equal(result.relayRunId, run.id);
  assert.equal(f.store.runs().length, 1);
});

for (const mode of ['cancelled', 'scope', 'foreign', 'body', 'trigger', 'receipt']) {
  test(`persistent occurrence refuses ${mode} provenance changes`, async t => {
    const f = fixture(t); f.chat('chat'); const input = f.occurrence('task');
    if (mode === 'cancelled') f.store.saveOperation({ ...f.schedule, cancellationRequested: true });
    if (mode === 'scope') f.config.bridgeDirectories = [];
    if (mode === 'foreign') f.tasks.get('task').companyId = 'foreign';
    if (mode === 'body') f.routine.description = 'changed';
    if (mode === 'trigger') f.routine.triggers[0].cronExpression = '* * * * *';
    if (mode === 'receipt') f.occurrences[0].linkedIssueId = 'another-task';
    await assert.rejects(f.admit(input));
    assert.deepEqual(f.store.runs(), []);
  });
}

test('atomic claim rolls back when dispatch fails and no later wake can steal a committed claim', async t => {
  const f = fixture(t); const chat = f.chat('chat'); const input = f.occurrence('task');
  const original = f.store.save;
  f.store.save = () => { throw new Error('simulated commit failure'); };
  await assert.rejects(f.admit(input), /simulated commit failure/);
  f.store.save = original;
  assert.deepEqual(f.store.runs(), []);
  assert.equal(f.store.operation(`routine-task:${digest(['company', 'task'])}`), null);
  const run = await f.admit(input);
  assert.equal(run.request.bindingId, chat.binding.id);
  await assert.rejects(f.admit({ ...input, runId: 'different-run' }), { code: 'routine_occurrence_reserved' });
});

test('an occurrence receipt cannot be reused for a different task after its first turn settles', async t => {
  const f = fixture(t); f.chat('chat'); const first = f.occurrence('first');
  const run = await f.admit(first); f.settle(run);
  const second = f.occurrence('second');
  f.tasks.get('second').originRunId = f.tasks.get('first').originRunId;
  f.occurrences.pop(); f.occurrences[0].linkedIssueId = 'second';
  await assert.rejects(f.admit(second), { code: 'routine_occurrence_reserved' });
  assert.equal(f.store.runs().length, 1);
  assert.equal(f.store.operation(`routine-task:${digest(['company', 'second'])}`), null);
});
