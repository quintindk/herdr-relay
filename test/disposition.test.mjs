import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestReviewDisposition, reconcileCompletions, checkReviewWake } from '../src/disposition.mjs';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('published result obtains idempotent review interaction before confirmed issue disposition', async () => {
  let run = { id: 'run', request: { companyId: 'company', taskId: 'task', agentId: 'agent', runId: 'backend' },
    result: { candidate: 'candidate', summary: 'Result' }, nativeState: 'settled', settlement: { outcome: 'completed' }, publication: { state: 'recorded' } };
  const issue = { companyId: 'company', assigneeAgentId: 'agent', responsibleUserId: 'board', executionRunId: 'backend', status: 'in_progress' };
  const interactions = []; const calls = [];
  const operations = new Map();
  const store = { run: () => run, runs: () => [run], recordReview: (_, review) => (run = { ...run, review }),
    db: { prepare: () => ({ all: () => [] }) },
    operation: id => operations.get(id), saveOperation: value => { operations.set(value.id, value); return value; } };
  let lost = true;
  const api = async (_, token, method, path, body) => {
    assert.equal(token, 'scoped'); calls.push([method, path]);
    if (path.endsWith('/interactions')) {
      if (method === 'GET') return interactions;
      assert.equal(body.addresseeUserId, 'board');
      assert.equal(body.resolverPolicy, 'human_only');
      assert.equal(body.addresseeAgentId, undefined);
      interactions.push({ ...body, id: 'review', status: 'pending' });
      return interactions[0];
    }
    if (method === 'PATCH') {
      assert.equal(interactions.length, 1);
      assert.equal(body.reviewInteractionId, 'review');
      issue.status = body.status;
      if (lost) { lost = false; throw new Error('Lost committed PATCH'); }
    }
    return { ...issue };
  };
  await assert.rejects(requestReviewDisposition(store, 'run', 'scoped', api), /Lost committed/);
  assert.deepEqual(await requestReviewDisposition(store, 'run', 'scoped', api), { status: 'in_review', interactionId: 'review' });
  assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
  assert.equal(calls.filter(([method]) => method === 'PATCH').length, 1);
  issue.executionRunId = 'other';
  await assert.rejects(requestReviewDisposition(store, 'run', 'scoped', api), { code: 'disposition_conflict' });
  issue.status = 'done';
  assert.deepEqual(await requestReviewDisposition(store, 'run', 'scoped', api), { status: 'done' });
});

function fixture(store) {
  store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'native' });
  let run = store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  store.acknowledge(run.id);
  store.submit(run.id, { key: 'result', candidate: 'candidate', summary: 'Answer' });
  store.publication(run.id, { state: 'recorded', commentId: 'comment' });
  run = store.settle(run.id, { outcome: 'completed', evidence: 'Exact completed worker receipt' });
  store.saveOperation({ id: `review-disposition:${run.id}`, runId: run.id, state: 'waiting', candidate: 'candidate', interactionId: 'review' });
  const interaction = { id: 'review', status: 'accepted', kind: 'request_confirmation', resolverPolicy: 'human_only', idempotencyKey: `relay-review:${run.id}:${digest(run.result)}`,
    payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'candidate', label: run.id } } };
  const issue = { id: 'task', companyId: 'company', assigneeAgentId: 'agent', status: 'in_review', executionRunId: null, checkoutRunId: null };
  const backend = { id: 'backend', companyId: 'company', agentId: 'agent', status: 'succeeded' };
  const writes = [];
  const api = async (method, path, body) => {
    if (method === 'PATCH') { writes.push(body); Object.assign(issue, body); }
    if (path.endsWith('/interactions')) return [interaction];
    if (path.includes('/heartbeat-runs/')) return { ...backend };
    return { ...issue };
  };
  return { run, interaction, issue, backend, writes, api };
}

test('accepted exact candidate automatically completes once without retiring or waking its agent', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(store);
  await reconcileCompletions(store, f.api);
  assert.equal(f.issue.status, 'done');
  assert.equal(store.operation(`completion:${f.run.id}`).state, 'recorded');
  await reconcileCompletions(store, f.api);
  assert.deepEqual(f.writes, [{ status: 'done' }]);
  assert.equal(store.binding('worker').lifecycleState, undefined);
});

test('pending, rejected, mismatched and externally changed reviews cannot complete work', async t => {
  for (const change of [
    f => { f.interaction.status = 'pending'; },
    f => { f.interaction.status = 'rejected'; },
    f => { f.interaction.payload.target.revisionId = 'other'; },
    f => { f.interaction.id = 'other'; },
    f => { f.issue.assigneeAgentId = 'someone-else'; },
    f => { f.issue.status = 'todo'; },
    f => { f.issue.status = 'cancelled'; },
    f => { f.issue.executionRunId = 'active'; },
    f => { f.issue.executionBlocker = { cause: 'needs_reconciliation' }; },
    f => { f.backend.status = 'running'; },
  ]) {
    const store = new Store(':memory:'); t.after(() => store.close());
    const f = fixture(store); change(f);
    await reconcileCompletions(store, f.api);
    assert.equal(f.writes.length, 0);
  }
});

test('newer candidates and unsettled work prevent accepted-result completion', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(store);
  const next = store.dispatch({ ...f.run.request, runId: 'next-backend' });
  await reconcileCompletions(store, f.api);
  assert.equal(f.writes.length, 0);
  store.acknowledge(next.id);
  store.submit(next.id, { key: 'next', candidate: 'newer', summary: 'New answer' });
  store.settle(next.id, { outcome: 'completed', evidence: 'Finished' });
  await reconcileCompletions(store, f.api);
  assert.equal(f.writes.length, 0);
});

test('acceptance during downtime and lost completion replies reconcile across restart without replay', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-completion-'));
  let store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const f = fixture(store);
  f.interaction.status = 'pending';
  await reconcileCompletions(store, f.api);
  store.close(); store = new Store(join(root, 'state.sqlite'));
  f.interaction.status = 'accepted';
  await reconcileCompletions(store, async (...args) => {
    const result = await f.api(...args);
    if (args[0] === 'PATCH') throw new Error('Lost committed response');
    return result;
  });
  assert.equal(store.operation(`completion:${f.run.id}`).state, 'uncertain');
  store.close(); store = new Store(join(root, 'state.sqlite'));
  await reconcileCompletions(store, f.api);
  assert.equal(store.operation(`completion:${f.run.id}`).state, 'recorded');
  assert.equal(f.writes.length, 1);
  f.issue.status = 'todo'; // A later operator reopen must not be undone.
  await reconcileCompletions(store, f.api);
  assert.equal(f.issue.status, 'todo');
});

test('unconfirmed completion is not resent and fences new work on the task', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(store); let attempts = 0;
  const api = async (...args) => {
    if (args[0] === 'PATCH') { attempts++; throw new Error('Transport unavailable'); }
    return f.api(...args);
  };
  await reconcileCompletions(store, api);
  await reconcileCompletions(store, api);
  assert.equal(attempts, 1);
  assert.equal(store.operation(`completion:${f.run.id}`).reason, 'completion_uncertain');
  assert.throws(() => store.dispatch({ ...f.run.request, runId: 'another' }), { code: 'completion_uncertain' });
  assert.equal(store.dispatch(f.run.request).id, f.run.id);
});

test('operator edits during verification block completion before any PATCH', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(store);
  f.issue.updatedAt = 'before';
  await reconcileCompletions(store, async (...args) => {
    if (args[1].includes('/heartbeat-runs/')) f.issue.updatedAt = 'after';
    return f.api(...args);
  });
  assert.equal(f.writes.length, 0);
  assert.equal(store.operation(`review-disposition:${f.run.id}`).reason, 'completion_conflict');
});

test('Paperclip acceptance-driven todo completes only with the exact latest audit transition', async t => {
  for (const scenario of ['accepted', 'manual-reopen', 'wrong-review', 'newer-edit', 'ambiguous-time']) {
    const store = new Store(':memory:'); t.after(() => store.close());
    const f = fixture(store);
    f.issue.status = 'todo';
    f.issue.updatedAt = '2026-10-05T10:00:00.000Z';
    const event = { companyId: 'company', entityId: 'task', action: 'issue.updated', createdAt: '2026-10-05T10:00:00.010Z',
      details: { source: 'request_confirmation_accept', interactionId: 'review', status: 'todo',
        _previous: { status: 'in_review' }, assigneeAgentId: 'agent', assigneeUserId: null } };
    const events = [event];
    if (scenario === 'manual-reopen') event.details.source = 'comment';
    if (scenario === 'wrong-review') event.details.interactionId = 'other';
    if (scenario === 'newer-edit') f.issue.updatedAt = '2026-10-05T10:00:01.000Z';
    if (scenario === 'ambiguous-time') events.push({ ...event });
    await reconcileCompletions(store, (...args) => args[1].endsWith('/activity') ? events : f.api(...args));
    assert.equal(f.writes.length, scenario === 'accepted' ? 1 : 0, scenario);
  }
});

test('child-completion wakes preserve an exact pending review without creating another Relay run', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(store);
  f.interaction.status = 'pending'; f.interaction.kind = 'request_confirmation';
  store.recordReview(f.run.id, { interactionId: 'review', status: 'pending', candidate: 'candidate' });
  Object.assign(f.backend, { id: 'child-wake', status: 'running', invocationSource: 'automation', contextSnapshot: {
    wakeReason: 'issue_children_completed', taskId: 'task',
  } });
  const input = { ...f.run.request, runId: 'child-wake', token: 'scoped' };
  let reads = 0;
  const api = async (_, token, method, path, body) => { assert.equal(token, 'scoped'); reads++; return f.api(method, path, body); };
  const decision = await checkReviewWake(store, input, api);
  assert.equal(decision.skip, true); assert.equal(decision.interactionId, 'review');
  assert.equal(store.runs().length, 1); assert.equal(f.writes.length, 0);
  const before = reads;
  assert.deepEqual(await checkReviewWake(store, input, api), decision);
  assert.equal(reads, before, 'Persisted no-op receipt replays without new effects');
  await assert.rejects(checkReviewWake(store, { ...input, taskId: 'other' }, api), { code: 'dispatch_conflict' });
});

test('child-wake check does not suppress ordinary work, resolved reviews or admitted runs', async t => {
  for (const variant of ['manual', 'rejected', 'expired', 'wrong-candidate', 'todo', 'already-admitted']) {
    const store = new Store(':memory:'); t.after(() => store.close());
    const f = fixture(store);
    f.interaction.status = 'pending'; f.interaction.kind = 'request_confirmation';
    store.recordReview(f.run.id, { interactionId: 'review', status: 'pending', candidate: 'candidate' });
    Object.assign(f.backend, { id: 'wake', status: 'running', invocationSource: 'automation',
      contextSnapshot: { wakeReason: 'issue_children_completed', taskId: 'task' } });
    if (variant === 'manual') f.backend.invocationSource = 'on_demand';
    if (['rejected', 'expired'].includes(variant)) f.interaction.status = variant;
    if (variant === 'wrong-candidate') f.interaction.payload.target.revisionId = 'wrong';
    if (variant === 'todo') f.issue.status = 'todo';
    if (variant === 'already-admitted') store.dispatch({ ...f.run.request, runId: 'wake' });
    assert.deepEqual(await checkReviewWake(store, { ...f.run.request, runId: 'wake', token: 'scoped' },
      (_, __, method, path, body) => f.api(method, path, body)), { skip: false }, variant);
  }
});

test('legacy anyone reviews require exact recorded human proof, and cannot be reused for new requests', async t => {
  for (const variant of ['proof', 'missing', 'uncertain', 'wrong-candidate', 'wrong-company', 'wrong-decision', 'wrong-receipt']) {
    const store = new Store(':memory:'); t.after(() => store.close());
    const f = fixture(store);
    f.interaction.resolverPolicy = 'anyone';
    const proof = { id: `harness-review:${digest(['company', 'review'])}`, runId: f.run.id, state: 'recorded',
      request: { candidate: 'candidate', interactionId: 'review', decision: 'accept', sourceMessageId: 'human', sourceDigest: digest('Accept') },
      receipt: { interactionId: 'review', status: 'accepted' } };
    if (variant === 'uncertain') proof.state = 'uncertain';
    if (variant === 'wrong-candidate') proof.request.candidate = 'other';
    if (variant === 'wrong-company') proof.request.companyId = 'other';
    if (variant === 'wrong-decision') proof.request.decision = 'reject';
    if (variant === 'wrong-receipt') proof.receipt.interactionId = 'other';
    if (variant !== 'missing') store.saveOperation(proof);
    await assert.rejects(requestReviewDisposition(store, f.run.id, 'token', (_, __, ...args) => f.api(...args)),
      { code: 'human_review_required' });
    await reconcileCompletions(store, f.api);
    assert.equal(f.writes.length, variant === 'proof' ? 1 : 0, variant);
  }
});

test('disposition refuses candidate or assignment changes during review request before PATCH', async t => {
  for (const change of ['candidate', 'assignment']) {
    const store = new Store(':memory:'); t.after(() => store.close());
    const f = fixture(store);
    f.issue.status = 'in_progress';
    f.interaction.status = 'pending';
    await assert.rejects(requestReviewDisposition(store, f.run.id, 'token', async (_, __, ...args) => {
      const response = await f.api(...args);
      if (args[1].endsWith('/interactions')) {
        if (change === 'candidate') store.save({ ...f.run, result: { ...f.run.result, summary: 'Changed' } }, 'test.changed');
        else f.issue.assigneeAgentId = 'other';
      }
      return response;
    }));
    assert.equal(f.writes.length, 0);
  }
});

test('legacy pending anyone review stays incomplete until exact recorded human approval', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = fixture(store);
  f.interaction.resolverPolicy = 'anyone';
  f.interaction.status = 'pending';
  await assert.rejects(requestReviewDisposition(store, f.run.id, 'token', (_, __, ...args) => f.api(...args)),
    { code: 'human_review_required' });
  await reconcileCompletions(store, f.api);
  assert.equal(f.writes.length, 0);
  f.interaction.status = 'accepted';
  const proof = { id: `harness-review:${digest(['company', 'review'])}`, runId: f.run.id, state: 'uncertain',
    request: { companyId: 'company', taskId: 'task', candidate: 'candidate', interactionId: 'review', decision: 'accept',
      sourceMessageId: 'human', sourceDigest: digest('Accept') }, receipt: { interactionId: 'review', status: 'accepted' } };
  store.saveOperation(proof);
  await reconcileCompletions(store, f.api);
  assert.equal(f.writes.length, 0);
  store.saveOperation({ ...proof, state: 'recorded' });
  await reconcileCompletions(store, f.api);
  assert.deepEqual(f.writes, [{ status: 'done' }]);
});
