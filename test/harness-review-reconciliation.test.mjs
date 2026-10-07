import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { harnessReview } from '../src/harness-answers.mjs';
import { reconcileHarnessReviews } from '../src/harness-review-reconciliation.mjs';

async function fixture(t, decision = 'reject') {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'i', conversationId: 'c' });
  let run = store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  store.acknowledge(run.id); store.submit(run.id, { key: 'result', candidate: 'candidate', summary: 'Result' });
  store.publication(run.id, { state: 'recorded' }); store.settle(run.id, { outcome: 'completed', evidence: 'Finished' });
  run = store.recordReview(run.id, { interactionId: 'review', candidate: 'candidate', status: 'pending' });
  store.saveOperation({ id: 'observed:worker', runId: '', availability: 'present', identity: { conversationId: 'c' } });
  const bridge = store.saveOperation({ id: 'opencode-bridge:worker', runId: '', state: 'armed', sessionCreatedAt: 123,
    epoch: 'epoch', lastSeen: new Date().toISOString(), identity: { bindingId: 'worker', conversationId: 'c', observedId: 'observed:worker' } });
  const f = { store, run, bridge, calls: [], locks: new Map(),
    issue: { id: 'task', companyId: 'company', assigneeAgentId: 'agent', status: 'in_review' },
    item: { id: 'review', companyId: 'company', issueId: 'task', kind: 'request_confirmation', status: 'pending',
      createdAt: new Date(Date.now() - 1000).toISOString(), idempotencyKey: `relay-review:${run.id}:${digest(run.result)}`,
      payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'candidate', label: run.id } } },
    input: { interactionId: 'review', candidate: 'candidate', decision, reason: 'Correct the result',
      source: { id: 'human', text: 'Please correct the result', createdAt: Date.now() } } };
  f.api = async (method, path) => {
    f.calls.push({ method, path });
    assert.equal(method, 'GET');
    return structuredClone(path.endsWith('/interactions') ? [f.item] : f.issue);
  };
  await assert.rejects(harnessReview(store, bridge, 'review', f.input, async (method, path) => {
    if (method !== 'POST') return f.api(method, path);
    f.item.status = decision === 'accept' ? 'accepted' : 'rejected';
    f.item.result = { version: 1, outcome: f.item.status, reason: decision === 'reject' ? f.input.reason : null };
    f.item.resolvedByUserId = 'board-user'; f.item.resolvedByAgentId = null; f.item.resolvedByRunId = null;
    f.issue.executionRunId = 'continuation'; f.issue.status = 'in_progress';
    throw new Error('Lost reply');
  }), /Lost reply/);
  f.id = `harness-review:${digest(['company', 'review'])}`;
  f.intent = () => store.operation(f.id);
  f.before = f.intent(); f.calls.length = 0;
  f.reconcile = (api = f.api) => reconcileHarnessReviews(store, api, f.locks);
  return f;
}

for (const decision of ['accept', 'reject']) {
  for (const status of ['in_progress', 'done', 'cancelled']) {
    test(`background confirms lost ${decision} on ${status} with active backend execution, GET only`, async t => {
      const f = await fixture(t, decision);
      f.issue.status = status;
      f.store.saveOperation({ ...f.bridge, state: 'configured' });
      const issue = structuredClone(f.issue);
      await f.reconcile();
      assert.equal(f.intent().state, 'recorded');
      assert.deepEqual(f.intent().request, f.before.request);
      assert.equal(f.intent().resultDigest, f.before.resultDigest);
      assert.equal(f.store.run(f.run.id).review.status, f.item.status);
      assert.match(f.intent().receipt.continuation, /End this turn/);
      assert.deepEqual(f.issue, issue);
      assert.equal(f.calls.length, 2);
      const recorded = f.intent();
      await f.reconcile();
      assert.deepEqual(f.intent(), recorded);
      assert.equal(f.calls.length, 2);
      f.store.saveOperation(f.bridge);
      assert.equal(f.store.dispatch({ ...f.run.request, runId: 'next' }).nativeState, 'unclaimed');
    });
  }
}

for (const [name, change] of [
  ['pending status', f => { f.item.status = 'pending'; }],
  ['opposite status', f => { f.item.status = 'accepted'; }],
  ['missing result', f => { delete f.item.result; }],
  ['wrong outcome', f => { f.item.result.outcome = 'accepted'; }],
  ['wrong reason', f => { f.item.result.reason = 'different'; }],
  ['missing reason', f => { delete f.item.result.reason; }],
  ['missing human', f => { delete f.item.resolvedByUserId; }],
  ['empty human', f => { f.item.resolvedByUserId = ' '; }],
  ['agent resolver', f => { f.item.resolvedByAgentId = 'agent'; }],
  ['run resolver', f => { f.item.resolvedByRunId = 'run'; }],
  ['wrong kind', f => { f.item.kind = 'ask_user_questions'; }],
  ['wrong interaction', f => { f.item.id = 'other'; }],
  ['wrong key', f => { f.item.idempotencyKey = 'other'; }],
  ['wrong candidate', f => { f.item.payload.target.revisionId = 'other'; }],
  ['wrong run label', f => { f.item.payload.target.label = 'other'; }],
  ['extra target field', f => { f.item.payload.target.extra = true; }],
  ['wrong issue', f => { f.issue.id = 'other'; }],
  ['wrong company', f => { f.issue.companyId = 'other'; }],
  ['wrong assignee', f => { f.issue.assigneeAgentId = 'other'; }],
  ['wrong interaction company', f => { f.item.companyId = 'other'; }],
  ['wrong interaction issue', f => { f.item.issueId = 'other'; }],
  ['changed result', f => { f.store.save({ ...f.run, result: { ...f.run.result, summary: 'other' } }, 'test'); }],
  ['changed review', f => { f.store.recordReview(f.run.id, { ...f.run.review, interactionId: 'other' }); }],
  ['unsettled run', f => { f.store.save({ ...f.run, nativeState: 'claimed' }, 'test'); }],
  ['unpublished result', f => { f.store.save({ ...f.run, publication: { state: 'uncertain' } }, 'test'); }],
  ['missing run', f => { f.store.db.prepare('DELETE FROM runs WHERE id = ?').run(f.run.id); }],
  ['wrong intent company', f => { f.store.saveOperation({ ...f.before, request: { ...f.before.request, companyId: 'other' } }); }],
  ['missing source', f => { f.store.saveOperation({ ...f.before, request: { ...f.before.request, sourceDigest: '' } }); }],
]) {
  test(`background leaves intent untouched for ${name}`, async t => {
    const f = await fixture(t); change(f);
    const before = f.intent();
    await f.reconcile();
    assert.deepEqual(f.intent(), before);
    assert.equal(f.locks.size, 0);
  });
}

for (const stage of [1, 2]) {
  for (const field of ['request', 'state', 'result', 'delete']) {
    test(`background does not overwrite concurrent ${field} change during GET ${stage}`, async t => {
      const f = await fixture(t);
      let before;
      await f.reconcile(async (...args) => {
        const result = await f.api(...args);
        if (f.calls.length === stage) {
          if (field === 'request') f.store.saveOperation({ ...f.before, request: { ...f.before.request, sourceDigest: 'replacement' } });
          if (field === 'state') f.store.saveOperation({ ...f.before, state: 'recorded', receipt: { marker: 'replacement' } });
          if (field === 'result') f.store.save({ ...f.run, result: { ...f.run.result, summary: 'replacement' } }, 'test');
          if (field === 'delete') f.store.db.prepare('DELETE FROM operations WHERE id = ?').run(f.id);
          before = f.intent();
        }
        return result;
      });
      assert.deepEqual(f.intent(), before);
      assert.equal(f.store.run(f.run.id).review.status, 'pending');
    });
  }
}

test('background shares the harness binding lock and skips active handlers', async t => {
  const f = await fixture(t);
  const key = 'harness-answer:worker';
  const active = Promise.resolve(); f.locks.set(key, active);
  await f.reconcile();
  assert.equal(f.calls.length, 0);
  assert.equal(f.locks.get(key), active);
  f.locks.delete(key);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = f.reconcile(async (...args) => { await gate; return f.api(...args); });
  assert.ok(f.locks.has(key));
  await f.reconcile();
  release(); await pending;
  assert.equal(f.calls.length, 2);
  assert.equal(f.locks.size, 0);
  assert.equal(f.intent().state, 'recorded');
});

test('background validates the original stored candidate rather than a later native run', async t => {
  const f = await fixture(t);
  // Model a later run already admitted by another process before receipt recovery.
  f.store.saveOperation({ ...f.before, state: 'recorded' });
  const next = f.store.dispatch({ ...f.run.request, runId: 'next' });
  f.store.saveOperation(f.before);
  await f.reconcile();
  assert.equal(f.intent().state, 'recorded');
  assert.equal(f.store.run(f.run.id).review.status, 'rejected');
  assert.deepEqual(f.store.run(next.id), next);
});

test('background leaves unavailable and ambiguous readback uncertain', async t => {
  for (const response of ['error', 'duplicate', 'invalid']) {
    const f = await fixture(t);
    await f.reconcile(async (...args) => {
      if (response === 'error') throw new Error('offline');
      const value = await f.api(...args);
      return args[1].endsWith('/interactions') ? (response === 'duplicate' ? [f.item, f.item] : {}) : value;
    });
    assert.deepEqual(f.intent(), f.before);
    assert.equal(f.locks.size, 0);
  }
});

test('background recovers persisted legacy intents without rewriting their source request', async t => {
  const f = await fixture(t);
  delete f.before.resultDigest;
  delete f.before.request.companyId; delete f.before.request.taskId; delete f.before.request.sessionCreatedAt;
  f.store.saveOperation(f.before);
  await f.reconcile();
  assert.equal(f.intent().state, 'recorded');
  assert.deepEqual(f.intent().request, f.before.request);
  assert.equal(f.intent().resultDigest, undefined);
});

test('background never creates an intent from a backend decision alone', async t => {
  const f = await fixture(t);
  f.store.db.prepare('DELETE FROM operations WHERE id = ?').run(f.id);
  await f.reconcile();
  assert.equal(f.intent(), null);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.run(f.run.id).review.status, 'pending');
});
