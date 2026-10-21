import assert from 'node:assert/strict';
import test from 'node:test';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { nativeBoard } from '../src/native-board.mjs';
import { NativeDecisionJournal } from '../src/native-decision-journal.mjs';
import { buildBoardRows } from '../src/task-board-view.mjs';
import { digest } from '../src/protocol.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t) {
  const backend = await startBackend({ database: ':memory:' });
  const token = backend.store.bootstrap().token, owner = backend.store.authenticate(token);
  let key = 0;
  const command = (actor, action, payload) => backend.store.command(actor, { key: `fixture-${++key}`, action, payload });
  command(owner, 'node.enrol', { id: 'node', name: 'Local node' });
  const node = backend.store.authenticate(backend.store.enrolCredential(owner, 'node', 'credential').token);
  command(node, 'agent.register', { id: 'worker', nodeId: 'node', name: 'Wright', mode: 'interactive' });
  command(node, 'agent.register', { id: 'coordinator', nodeId: 'node', name: 'Coordinator', mode: 'interactive' });
  command(owner, 'task.create', { id: 'task', title: 'Prepare deployment' });
  const e = command(owner, 'execution.request', { id: 'e', taskId: 'task', taskRevision: 1, targetAgentId: 'worker', originAgentId: 'coordinator', instructions: 'Bounded test', reviewPolicy: 'human' });
  command(node, 'execution.admit', { id: 'e', expectedRevision: e.revision, bindingId: 'binding', runId: 'initial' });
  const journal = new NativeDecisionJournal();
  const api = nativeBackendClient({ url: backend.origin, token });
  const board = nativeBoard(api, { decisionJournal: journal });
  t.after(async () => { journal.close(); await backend.close(); });
  return { backend, token, owner, node, api, board, journal, command, get: (kind, id) => backend.store.get(kind, id),
    ask: humanRequired => command(node, 'question.ask', { id: 'q', executionId: 'e', expectedRevision: 2, prompt: 'Which region?', humanRequired }) };
}

test('native Inbox and task detail share exact human actions while worker and responsibility remain separate', async t => {
  const f = await fixture(t); f.ask(true);
  const snapshot = await f.board.read(), task = snapshot.tasks[0];
  assert.equal(task.assigneeUserId, 'owner'); assert.equal(task.assigneeAgentId, null);
  assert.equal(task.executionAgentId, 'worker'); assert.equal(task.attentionLabel, 'Waiting for your answer');
  assert.equal(buildBoardRows(snapshot).find(r => r.type === 'task').owner.includes('Wright'), true);
  assert.equal(snapshot.inbox.length, 1); assert.equal(snapshot.inbox[0].title, 'Prepare deployment');
  const detail = await f.board.detailTask({ taskId: 'task' });
  const item = await f.board.detailInbox({ id: snapshot.inbox[0].id });
  assert.deepEqual(detail.actions[0], item);
  assert.equal((await f.board.inspectTask({ taskId: 'task' })).interactions[0].status, 'pending');
  await assert.rejects(f.board.statusTask({ taskId: 'task', expectedRevision: 2, key: 'no-bypass', payload: { status: 'done' } }), /questions remain open/);
  await f.board.decideInbox({ item, body: 'South Africa North', key: 'answer' });
  const q = f.get('question', 'q');
  assert.equal(q.answer.body, 'South Africa North'); assert.equal(q.answer.author.type, 'user');
  assert.match(q.answer.source.conversationId, /^terminal:/); assert.match(q.answer.source.messageId, /^dialog:/);
  assert.equal((await f.board.read()).tasks[0].attentionLabel, 'Answer recorded: waiting for worker');
  const e = f.get('execution', 'e');
  f.command(f.node, 'execution.continue', { id: 'e', expectedRevision: e.revision, runId: 'continued' });
  f.command(f.node, 'execution.submit', { id: 'e', expectedRevision: e.revision + 1, candidate: 'candidate', summary: 'Prepared configuration', evidence: 'Fixture terminal receipt' });
  const review = (await f.board.read()).inbox[0];
  assert.equal(review.kind, 'review'); assert.equal(review.candidate, 'candidate');
  assert.match(review.rejectEffect, /No revision turn is started/);
  await f.board.decideInbox({ item: review, decision: 'reject', reason: 'Change the region', key: 'reject' });
  assert.equal(f.get('execution', 'e').state, 'rejected'); assert.equal(f.get('task', 'task').status, 'todo');
  assert.equal((await f.board.read()).inbox.length, 0);
  assert.match((await f.board.detailTask({ taskId: 'task' })).activity[0], /Answered: Which region/);
});

test('real native board PTY answers and accepts the exact candidate without OpenCode slash commands', async t => {
  if (process.platform === 'win32') { t.skip('Requires POSIX PTY'); return; }
  const f = await fixture(t); f.ask(true);
  const dir = mkdtempSync(join(tmpdir(), 'relay-native-inbox-pty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const context = join(dir, 'owner.json');
  writeFileSync(context, JSON.stringify({ url: f.backend.origin, token: f.token }), { mode: 0o600 });
  const probe = action => promisify(execFile)('python3', ['test/native-inbox-pty.py', process.execPath, 'src/cli.mjs', context,
    action, action === 'answer' ? 'South Africa North' : 'Exact candidate checked'], { timeout: 20000 });
  assert.equal(JSON.parse((await probe('answer')).stdout).confirmed, true);
  assert.equal(f.get('question', 'q').answer.body, 'South Africa North');
  assert.match(f.get('question', 'q').answer.source.conversationId, /^terminal:/);
  const e = f.get('execution', 'e');
  f.command(f.node, 'execution.continue', { id: 'e', expectedRevision: e.revision, runId: 'continued' });
  f.command(f.node, 'execution.submit', { id: 'e', expectedRevision: e.revision + 1, candidate: 'candidate', summary: 'Prepared configuration', evidence: 'Fixture terminal receipt' });
  assert.equal(JSON.parse((await probe('review')).stdout).confirmed, true);
  assert.equal(f.get('execution', 'e').state, 'completed');
  assert.equal(f.get('execution', 'e').review.reason, 'Exact candidate checked');
  assert.equal(f.get('task', 'task').status, 'done');
});

test('agent questions stay out of the human inbox until forwarded without duplicating identity', async t => {
  const f = await fixture(t); f.ask(false);
  assert.equal((await f.board.read()).inbox.length, 0);
  assert.equal((await f.board.read()).tasks[0].attentionLabel, 'Waiting for coordinator');
  f.command(f.node, 'question.forward', { id: 'q', expectedRevision: 1, agentId: 'coordinator', reason: 'No region was specified' });
  const item = (await f.board.read()).inbox[0];
  assert.equal(item.entityId, 'q'); assert.equal(item.context, 'No region was specified');
});

test('stale decision is refused and requires explicit dismissal before a fresh preview', async t => {
  const f = await fixture(t); f.ask(true);
  const item = (await f.board.read()).inbox[0];
  f.command(f.owner, 'question.answer', { id: 'q', expectedRevision: 1, body: 'Already answered' });
  await assert.rejects(f.board.decideInbox({ item, body: 'Stale answer', key: 'stale' }), { code: 'stale_revision' });
  assert.equal(f.get('question', 'q').answer.body, 'Already answered');
  const pending = f.board.pendingDecisions()[0];
  assert.equal(pending.action, 'dismiss');
  await f.board.decideInbox({ item: pending, key: 'dismiss' });
  assert.equal(f.board.pendingDecisions().length, 0);
});

test('lost answer acknowledgement remains in Inbox and retries the exact authorised command', async t => {
  const f = await fixture(t); f.ask(true);
  let lost = false;
  const api = async (...args) => {
    const result = await f.api(...args);
    if (args[0] === 'POST' && !lost) { lost = true; throw Error('Lost reply'); }
    return result;
  };
  const board = nativeBoard(api, { decisionJournal: f.journal });
  const item = (await board.read()).inbox[0];
  await assert.rejects(board.decideInbox({ item, body: 'Approved region', key: 'lost-answer' }), /Lost reply/);
  assert.equal(f.get('question', 'q').revision, 2);
  const pending = (await board.read()).inbox[0];
  assert.equal(pending.kind, 'publication');
  await board.decideInbox({ item: pending, key: 'retry' });
  assert.equal(f.get('question', 'q').revision, 2);
  assert.equal(board.pendingDecisions().length, 0);
});

test('taskless scheduled reviews and reminders remain actionable without manufacturing tasks', async t => {
  const f = await fixture(t), at = '2026-10-21T07:00:00.000Z';
  f.command(f.owner, 'schedule.install', { id: 'job', definition: { nodeId: 'node', targetAgentId: 'worker', cron: '* * * * *', enabled: true, reviewPolicy: 'human', instructions: 'Check' } });
  const id = `occurrence_${digest(['job', at])}`;
  f.command(f.node, 'schedule.publish', { id, scheduleId: 'job', definitionRevision: 1, intendedAt: at, candidate: 'job-candidate', summary: 'Scheduled result', evidence: 'Fixture' });
  f.command(f.owner, 'schedule.install', { id: 'reminder', definition: { nodeId: 'node', intent: 'reminder', cron: '* * * * *', enabled: true, instructions: 'Check the report' } });
  const reminder = `occurrence_${digest(['reminder', at])}`;
  f.command(f.node, 'schedule.remind', { id: reminder, scheduleId: 'reminder', definitionRevision: 1, intendedAt: at, message: 'Check the report' });
  const items = (await f.board.read()).inbox;
  assert.equal(items.length, 2);
  await f.board.decideInbox({ item: items.find(i => i.kind === 'review'), decision: 'accept', reason: 'Result checked', key: 'accept-job' });
  await f.board.decideInbox({ item: items.find(i => i.kind === 'reminder'), key: 'ack-reminder' });
  assert.equal(f.get('occurrence', id).state, 'completed');
  assert.equal(f.get('notification', reminder).state, 'acknowledged');
  assert.equal(f.backend.store.all('task').length, 1);
});

test('monitor review describes its actual effect and does not complete the standing task', async t => {
  const f = await fixture(t);
  f.command(f.owner, 'task.create', { id: 'monitor-task', title: 'Check service health' });
  const e = f.command(f.owner, 'execution.request', { id: 'monitor', taskId: 'monitor-task', taskRevision: 1,
    targetAgentId: 'worker', instructions: 'Check', reviewPolicy: 'human', monitor: {
      startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + 60000).toISOString(), intervalSec: 10,
    } });
  f.command(f.node, 'execution.admit', { id: e.id, expectedRevision: e.revision, bindingId: 'monitor-binding', runId: 'check' });
  f.command(f.node, 'execution.monitor_result', { id: e.id, expectedRevision: 2, candidate: 'check-candidate', summary: 'Service healthy', evidence: 'Fixture check terminal' });
  const item = (await f.board.read()).inbox.find(i => i.entityId === e.id);
  assert.equal(item.action, 'execution.monitor_review'); assert.equal(item.summary, 'Service healthy');
  assert.match(item.acceptEffect, /Monitoring can continue/);
  await f.board.decideInbox({ item, key: 'accept-check', decision: 'accept', reason: 'Check verified' });
  assert.equal(f.get('execution', e.id).state, 'waiting_time');
  assert.equal(f.get('task', 'monitor-task').status, 'in_progress');
});

test('cancellation blocks human candidate acceptance and the board does not silently upgrade a stale preview', async t => {
  const f = await fixture(t);
  f.command(f.node, 'execution.submit', { id: 'e', expectedRevision: 2, candidate: 'candidate', summary: 'Result', evidence: 'Fixture terminal' });
  const item = (await f.board.read()).inbox[0];
  f.command(f.owner, 'execution.cancel', { id: 'e', expectedRevision: item.revision, reason: 'Scope withdrawn' });
  await assert.rejects(f.board.decideInbox({ item, decision: 'accept', reason: 'Old preview', key: 'no-upgrade' }), { code: 'stale_revision' });
  const current = (await f.board.read()).inbox.find(i => i.kind === 'review');
  assert.equal(current.disabled, true);
  await assert.rejects(f.board.decideInbox({ item: current, decision: 'accept', reason: 'Cannot accept', key: 'cancelled-review' }), { code: 'decision_unavailable' });
  assert.notEqual(f.get('task', 'task').status, 'done');
});

test('agent, task and Inbox projections carry owning node and reported machine without inferring host identity', async t => {
  const f = await fixture(t);
  f.command(f.node, 'node.heartbeat', { id: 'node', machine: { hostname: 'desktop', platform: 'linux' } });
  f.command(f.node, 'agent.advertise', { id: 'worker', expectedRevision: 1, availability: 'available' });
  f.ask(true);
  const b = await f.board.read(), agent = b.agents.find(a => a.id === 'worker');
  assert.equal(agent.machineName, 'desktop'); assert.equal(agent.nodeName, 'Local node');
  assert.equal(agent.availabilityLabel, 'Available (reported)');
  assert.equal(b.tasks[0].executionMachineName, 'desktop');
  assert.equal(b.tasks[0].executionNodeId, 'node');
  assert.equal(b.inbox[0].machineName, 'desktop');
  assert.match(b.inbox[0].locationLabel, /Node: Local node.*Machine: desktop/);
  const detail = await f.board.detailAgent({ agentId: 'worker' });
  assert.equal(detail.agent.machinePlatform, 'linux'); assert.equal(detail.tasks[0].title, 'Prepare deployment');
  const coordinator = b.agents.find(a => a.id === 'coordinator');
  assert.equal(coordinator.availabilityLabel, 'Unknown or stale');
});
