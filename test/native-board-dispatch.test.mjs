import assert from 'node:assert/strict';
import test from 'node:test';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { nativeBoard } from '../src/native-board.mjs';
import { NativeDecisionJournal } from '../src/native-decision-journal.mjs';
import { digest } from '../src/protocol.mjs';

async function fixture(t) {
  const backend = await startBackend({ database: ':memory:' });
  const api = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const command = (key, action, payload) => api('POST', '/v1/commands', { key, action, payload });
  await command('node', 'node.enrol', { id: 'node', name: 'Destination' });
  await command('agent', 'agent.enrol', { id: 'agent', nodeId: 'node', name: 'Worker', directory: '/work' });
  await command('task', 'task.create', { id: 'task', title: 'Bounded work', description: 'Read the real task context' });
  const journal = new NativeDecisionJournal(); t.after(async () => { journal.close(); await backend.close(); });
  return { backend, api, command, journal, board: nativeBoard(api, { decisionJournal: journal }) };
}

test('native board requests execution with exact handover and retains human responsibility, even when the enrolled receiver is offline', async t => {
  const f = await fixture(t);
  const input = { taskId: 'task', expectedRevision: 1, key: 'send-once', payload: { targetAgentId: 'agent', instructions: 'Read docs/handover.md. Do not deploy.' } };
  const result = await f.board.dispatchTask(input);
  assert.equal(result.state, 'recorded'); assert.equal(result.execution.state, 'requested');
  assert.match(result.execution.instructions, /Read docs\/handover.md/);
  assert.equal(f.backend.store.get('task', 'task').responsibleUserId, 'owner');
  assert.equal(f.backend.store.get('task', 'task').assigneeAgentId, undefined);
  assert.deepEqual((await f.board.dispatchTask(input)).execution, result.execution);
  assert.equal(f.backend.store.all('execution').length, 1);
});

test('lost handover acknowledgement is retained in Inbox and cannot create another execution', async t => {
  const f = await fixture(t); let lose = true;
  const api = async (method, path, body) => {
    const result = await f.api(method, path, body);
    if (body?.action === 'execution.request' && lose) { lose = false; throw Error('Lost acknowledgement'); }
    return result;
  };
  const board = nativeBoard(api, { decisionJournal: f.journal });
  const input = { taskId: 'task', expectedRevision: 1, key: 'send-once', payload: { targetAgentId: 'agent', instructions: 'Bounded check' } };
  await assert.rejects(board.dispatchTask(input), /Lost acknowledgement/);
  await assert.rejects(board.dispatchTask({ ...input, key: 'new-key' }), { code: 'decision_pending' });
  const item = (await board.read()).inbox.find(item => item.kind === 'publication');
  await board.decideInbox({ item, key: 'ignored' });
  assert.equal(f.backend.store.all('execution').length, 1); assert.equal(f.journal.pending().length, 0);
});

test('a stale task preview cannot silently dispatch newer task content', async t => {
  const f = await fixture(t);
  await f.command('edit', 'task.update', { id: 'task', expectedRevision: 1, changes: { description: 'Changed' } });
  await assert.rejects(f.board.dispatchTask({ taskId: 'task', expectedRevision: 1, key: 'stale', payload: { targetAgentId: 'agent', instructions: 'Check' } }), { code: 'stale_revision' });
  assert.equal(f.backend.store.all('execution').length, 0);
});

test('Schedule detail displays safe failure diagnostics instead of hiding them behind native_failed', async t => {
  const f = await fixture(t);
  const credential = await f.api('POST', '/v1/node-credentials', { nodeId: 'node', key: 'diagnostic-node' });
  const node = f.api.withToken(credential.token), intendedAt = new Date().toISOString();
  await f.command('schedule', 'schedule.install', { id: 'job', definition: { nodeId: 'node', targetAgentId: 'agent', instructions: 'Check', at: intendedAt, enabled: true } });
  const failure = { stage: 'context', code: 'scheduled_execution_missing', message: 'Backend execution admission was missing before native context preparation.' };
  await node('POST', '/v1/commands', { key: 'failed', action: 'schedule.fail', payload: { id: `occurrence_${digest(['job', intendedAt])}`,
    scheduleId: 'job', definitionRevision: 1, intendedAt, reason: 'native_failed', evidence: 'Exact native terminal fixture', failure } });
  const detail = await f.board.detailRoutine({ scheduleId: 'job' });
  assert.match(detail.runs[0].summary, /Backend execution admission was missing/);
  assert.deepEqual(detail.runs[0].failure, failure);
});

test('human handback previews and withdraws the exact assignment, returns Todo and preserves human ownership', async t => {
  const f = await fixture(t);
  const run = await f.board.dispatchTask({ taskId: 'task', expectedRevision: 1, key: 'send', payload: { targetAgentId: 'agent', instructions: 'Bounded task' } });
  const preview = await f.board.prepareHandback({ taskId: 'task' });
  assert.equal(preview.executionId, run.execution.id); assert.equal(preview.alreadyHuman, false);
  const handback = f.board.handbackTask;
  const input = { ...preview, key: 'take-back', reason: 'I will finish this myself' };
  const result = await handback(input);
  assert.equal(result.execution.state, 'cancelled'); assert.equal(result.execution.administrativeDisposition.nativeProcessTerminationClaimed, false);
  const task = f.backend.store.get('task', 'task'); assert.equal(task.status, 'todo'); assert.equal(task.responsibleUserId, 'owner');
  const snapshot = await f.board.read(); assert.equal(snapshot.tasks[0].attentionLabel, 'With you'); assert.equal(snapshot.tasks[0].executionAgentId, undefined);
  assert.deepEqual(await handback(input), result); assert.equal(f.backend.store.all('execution').length, 1);
  assert.equal((await f.board.prepareHandback({ taskId: 'task' })).alreadyHuman, true);
});

test('lost human handback reply reconciles the original key without withdrawing a later assignment', async t => {
  const f = await fixture(t);
  await f.board.dispatchTask({ taskId: 'task', expectedRevision: 1, key: 'send', payload: { targetAgentId: 'agent', instructions: 'Check' } });
  let lose = true;
  const board = nativeBoard(async (method, path, body) => {
    const result = await f.api(method, path, body);
    if (body?.action === 'execution.handback' && lose) { lose = false; throw Error('Lost handback reply'); }
    return result;
  }, { decisionJournal: f.journal });
  const input = { ...await board.prepareHandback({ taskId: 'task' }), key: 'take-back', reason: 'Human takeover' };
  await assert.rejects(board.handbackTask(input), /Lost handback reply/);
  assert.equal(f.journal.pending().length, 1);
  const task = f.backend.store.get('task', 'task');
  await f.board.dispatchTask({ taskId: 'task', expectedRevision: task.revision, key: 'later-run', payload: { targetAgentId: 'agent', instructions: 'Another explicit task turn' } });
  await board.handbackTask(input);
  assert.equal(f.journal.pending().length, 0);
  assert.equal(f.backend.store.all('execution').filter(e => e.state === 'requested').length, 1);
  await assert.rejects(board.handbackTask({ ...input, reason: 'Changed confirmation' }), { code: 'decision_conflict' });
});

test('handback refuses submitted results and outstanding children and fences task revisions atomically', async t => {
  const f = await fixture(t);
  const { execution } = await f.board.dispatchTask({ taskId: 'task', expectedRevision: 1, key: 'send', payload: { targetAgentId: 'agent', instructions: 'Check' } });
  const preview = await f.board.prepareHandback({ taskId: 'task' });
  f.backend.store.save('execution', { ...execution, state: 'in_review', result: { candidate: 'submitted' } });
  await assert.rejects(f.board.prepareHandback({ taskId: 'task' }), { code: 'review_required' });
  f.backend.store.save('execution', execution);
  f.backend.store.save('execution', { id: 'child', revision: 1, parentExecutionId: execution.id, state: 'requested' });
  await assert.rejects(f.board.prepareHandback({ taskId: 'task' }), { code: 'child_work_pending' });
  f.backend.store.save('execution', { id: 'child', revision: 2, parentExecutionId: execution.id, state: 'completed' });
  const task = f.backend.store.get('task', 'task'); f.backend.store.save('task', { ...task, revision: task.revision + 1 });
  await assert.rejects(f.board.handbackTask({ ...preview, key: 'stale', reason: 'Take back' }), { code: 'stale_handback' });
  await assert.rejects(f.command('atomic-fence', 'execution.handback', { id: execution.id, expectedRevision: execution.revision, taskRevision: preview.expectedRevision, reason: 'Old preview' }), { code: 'stale_revision' });
  f.backend.store.save('task', { ...task, revision: task.revision + 2, status: 'done' });
  await assert.rejects(f.board.prepareHandback({ taskId: 'task' }), { code: 'task_terminal' });
  await assert.rejects(f.command('closed-task', 'execution.handback', { id: execution.id, expectedRevision: execution.revision, taskRevision: task.revision + 2, reason: 'Do not reopen' }), { code: 'task_terminal' });
  assert.equal(f.backend.store.get('task', 'task').status, 'done');
});

test('human handback supersedes unanswered questions without answering them or claiming native success', async t => {
  const f = await fixture(t);
  await f.command('attach', 'agent.attach', { id: 'agent', expectedBindingRevision: 0, conversationId: 'session', directory: '/work', bindingId: 'binding' });
  const { execution } = await f.board.dispatchTask({ taskId: 'task', expectedRevision: 1, key: 'send', payload: { targetAgentId: 'agent', instructions: 'Check' } });
  const credential = await f.api('POST', '/v1/node-credentials', { nodeId: 'node', key: 'handback-node' }), node = f.api.withToken(credential.token);
  const admitted = await node('POST', '/v1/commands', { key: 'admit', action: 'execution.admit', payload: { id: execution.id, expectedRevision: execution.revision, bindingId: 'binding', runId: 'run' } });
  await node('POST', '/v1/commands', { key: 'question', action: 'question.ask', payload: { id: 'question', executionId: admitted.id, expectedRevision: admitted.revision, prompt: 'Which region?', humanRequired: true } });
  await f.board.handbackTask({ ...await f.board.prepareHandback({ taskId: 'task' }), key: 'take-back', reason: 'I am handling it' });
  const question = f.backend.store.get('question', 'question');
  assert.equal(question.status, 'superseded'); assert.equal(question.answer, undefined);
  const result = f.backend.store.get('execution', execution.id);
  assert.equal(result.result, undefined); assert.equal(result.administrativeDisposition.successfulCompletionClaimed, false);
});
