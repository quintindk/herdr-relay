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
