import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { taskBoardDetail, taskBoardReview } from '../src/task-board-review.mjs';

function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const companyId = randomUUID(), taskId = randomUUID(), interactionId = randomUUID(), candidate = 'candidate-1';
  store.register({ id: 'worker', companyId, agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'chat' });
  const run = store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId, agentId: 'agent', taskId, runId: 'backend' });
  store.acknowledge(run.id);
  store.submit(run.id, { key: 'result', candidate, summary: 'Candidate summary with concrete checks.' });
  store.publication(run.id, { state: 'recorded', commentId: 'comment' });
  store.settle(run.id, { outcome: 'completed', evidence: 'Finished' });
  store.recordReview(run.id, { status: 'pending', candidate, interactionId });
  const task = { id: taskId, companyId, identifier: 'DEF-1', title: 'Review me', description: 'Full task description.',
    descriptionTruncated: false, status: 'in_review', priority: 'medium', parentId: null, projectId: null,
    assigneeAgentId: 'agent', assigneeUserId: null, updatedAt: '2026-10-12T10:00:00.000Z' };
  const interaction = { id: interactionId, companyId, issueId: taskId, kind: 'request_confirmation', status: 'pending',
    createdAt: '2026-10-12T10:01:00.000Z', idempotencyKey: `relay-review:${run.id}:${digest(store.run(run.id).result)}`,
    payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: candidate, label: run.id } } };
  const comments = Array.from({ length: 4 }, (_, index) => ({ id: randomUUID(), companyId, issueId: taskId,
    body: `Comment ${index + 1}`, createdAt: `2026-10-12T10:0${index + 2}:00.000Z`, authorUserId: 'human' }));
  const calls = [];
  let loseReply = false;
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === `/api/issues/${taskId}`) return structuredClone(task);
    if (method === 'GET' && path === `/api/issues/${taskId}/interactions`) return [structuredClone(interaction)];
    if (method === 'GET' && path === `/api/issues/${taskId}/comments?order=asc`) return structuredClone(comments);
    if (method === 'POST' && path === `/api/issues/${taskId}/interactions/${interactionId}/accept`) {
      Object.assign(interaction, { status: 'accepted', result: { version: 1, outcome: 'accepted' }, resolvedByUserId: 'human' });
      if (loseReply) throw Error('lost reply');
      return structuredClone(interaction);
    }
    if (method === 'POST' && path === `/api/issues/${taskId}/interactions/${interactionId}/reject`) {
      Object.assign(interaction, { status: 'rejected', result: { version: 1, outcome: 'rejected', reason: body.reason }, resolvedByUserId: 'human' });
      return structuredClone(interaction);
    }
    assert.fail(`${method} ${path}`);
  };
  return { store, companyId, taskId, run, interactionId, candidate, task, interaction, comments, calls, api,
    lose: () => { loseReply = true; } };
}

test('board detail returns full text, final comments and exact pending candidate only', async t => {
  const f = fixture(t);
  const detail = await taskBoardDetail(f.store, f.api, { companyId: f.companyId, taskId: f.taskId });
  assert.equal(detail.task.description, 'Full task description.');
  assert.deepEqual(detail.comments.map(comment => comment.body), ['Comment 2', 'Comment 3', 'Comment 4']);
  assert.deepEqual(detail.review, { runId: f.run.id, interactionId: f.interactionId,
    candidate: f.candidate, summary: 'Candidate summary with concrete checks.' });
  assert.deepEqual(detail.result, { runId: f.run.id, candidate: f.candidate,
    summary: 'Candidate summary with concrete checks.', deliverables: null, checks: null });
  f.task.status = 'blocked';
  const completed = await taskBoardDetail(f.store, f.api, { companyId: f.companyId, taskId: f.taskId });
  assert.equal(completed.review, null);
  assert.equal(completed.result.summary, 'Candidate summary with concrete checks.');
});

for (const action of ['accept', 'reject']) test(`board ${action} records one exact human decision`, async t => {
  const f = fixture(t);
  const detail = await taskBoardDetail(f.store, f.api, { companyId: f.companyId, taskId: f.taskId });
  const input = { action, companyId: f.companyId, taskId: f.taskId, runId: f.run.id, interactionId: f.interactionId,
    candidate: f.candidate, expectedRevision: detail.revision, key: `${action}-key`, ...(action === 'reject' ? { reason: 'Please fix the evidence.' } : {}) };
  const result = await taskBoardReview(f.store, f.api, input);
  assert.equal(result.state, 'recorded');
  assert.equal(result.receipt.status, action === 'accept' ? 'accepted' : 'rejected');
  assert.match(result.receipt.attribution, /task board/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.store.run(f.run.id).review.status, action === 'accept' ? 'accepted' : 'rejected');
});

test('board review rejects stale detail and requires rejection feedback before POST', async t => {
  const f = fixture(t);
  const base = { companyId: f.companyId, taskId: f.taskId, runId: f.run.id, interactionId: f.interactionId,
    candidate: f.candidate, expectedRevision: 'stale', key: 'key' };
  await assert.rejects(taskBoardReview(f.store, f.api, { ...base, action: 'accept' }), { code: 'stale_candidate' });
  await assert.rejects(taskBoardReview(f.store, f.api, { ...base, action: 'reject', reason: '' }), { code: 'invalid_request' });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('lost committed board approval reconciles without another POST', async t => {
  const f = fixture(t), detail = await taskBoardDetail(f.store, f.api, { companyId: f.companyId, taskId: f.taskId });
  const input = { action: 'accept', companyId: f.companyId, taskId: f.taskId, runId: f.run.id,
    interactionId: f.interactionId, candidate: f.candidate, expectedRevision: detail.revision, key: 'accept-key' };
  f.lose();
  await assert.rejects(taskBoardReview(f.store, f.api, input), /lost reply/);
  const result = await taskBoardReview(f.store, f.api, input);
  assert.equal(result.reconciled, true);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});
