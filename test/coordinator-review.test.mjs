import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { coordinatorGrant, coordinatorReviewGrant, validateCoordinatorGrant } from '../src/coordinator-review.mjs';
import { resultPolicy, taskPolicy, validateTaskPolicy } from '../src/task-policy.mjs';

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const add = (id, companyId = 'company') => {
    store.register({ id, companyId, agentId: `agent-${id}`, harness: 'opencode',
      instanceId: `instance-${id}`, conversationId: `chat-${id}` });
    return store.saveOperation({ id: `opencode-bridge:${id}`, runId: '', state: 'armed',
      identity: { bindingId: id, conversationId: `chat-${id}` }, tokenHash: `token-${id}`,
      epoch: 'epoch', sessionCreatedAt: 100, controlRevision: 1 });
  };
  const bridge = add('origin');
  const reviewer = add('reviewer');
  add('worker');
  const origin = { bindingId: 'origin', conversationId: 'chat-origin', sessionCreatedAt: 100,
    sourceMessageId: 'create-parent', sourceDigest: digest('Delegate the parent') };
  const parent = store.saveOperation({ id: 'operator-task:parent', runId: '', state: 'recorded',
    request: { companyId: 'company', origin, body: { assigneeAgentId: 'agent-reviewer' } },
    receipt: { id: 'parent', companyId: 'company', assigneeAgentId: 'agent-reviewer' } });
  const input = { key: 'grant-once', parentTaskId: 'parent', reviewerBindingId: 'reviewer',
    source: { id: 'grant-human', text: 'Allow the coordinator to review direct children of this parent.', createdAt: 200 } };
  const f = { store, add, bridge, reviewer, origin, parent, input, calls: [],
    issue: { id: 'parent', companyId: 'company', assigneeAgentId: 'agent-reviewer', status: 'in_progress' } };
  f.api = async (method, path) => {
    f.calls.push({ method, path });
    assert.equal(method, 'GET');
    assert.equal(path, '/api/issues/parent');
    return { ...f.issue };
  };
  f.grant = (change = {}, api = f.api, caller = bridge) =>
    coordinatorGrant(store, caller, 'grant-review', { ...input, ...change }, api);
  f.revoke = (grantId, change = {}, caller = bridge) => coordinatorGrant(store, caller, 'revoke-review', {
    grantId, source: { id: 'revoke-human', text: `Revoke ${grantId}`, createdAt: 300 }, ...change,
  }, f.api);
  f.child = (grantId, change = {}) => store.saveOperation({ id: 'operator-task:child', runId: '', state: 'recorded',
    request: { companyId: 'company', origin, relayReviewPolicy: 'coordinator', relayReviewGrantId: grantId,
      body: { parentId: 'parent', assigneeAgentId: 'agent-worker' } },
    receipt: { id: 'child', companyId: 'company', parentId: 'parent', assigneeAgentId: 'agent-worker' }, ...change });
  return f;
}

test('grant derives exact native identities and records no source text, tokens or backend writes', async t => {
  const f = fixture(t);
  const receipt = await f.grant();
  const origin = { bindingId: 'origin', conversationId: 'chat-origin', sessionCreatedAt: 100 };
  assert.equal(receipt.grantId, `coordinator-review-grant:${digest([origin, 'parent', 'grant-once'])}`);
  assert.deepEqual(receipt, { grantId: receipt.grantId, state: 'active', companyId: 'company',
    parentTaskId: 'parent', reviewerBindingId: 'reviewer' });
  const operation = f.store.operation(receipt.grantId);
  assert.deepEqual(operation.request, { companyId: 'company', parentTaskId: 'parent', key: 'grant-once', origin,
    reviewerBindingId: 'reviewer', reviewerBindingRevision: 1, reviewerAgentId: 'agent-reviewer',
    reviewerConversationId: 'chat-reviewer', reviewerSessionCreatedAt: 100,
    sourceMessageId: 'grant-human', sourceDigest: digest(f.input.source.text), sourceCreatedAt: 200 });
  assert.equal(JSON.stringify(operation).includes(f.input.source.text), false);
  assert.equal(JSON.stringify(operation).includes('token'), false);
  assert.equal(taskPolicy(f.store, 'company', 'parent'), 'human');
  assert.deepEqual(validateCoordinatorGrant(f.store, receipt.grantId,
    { companyId: 'company', parentTaskId: 'parent', reviewerBindingId: 'reviewer' }), operation);
  assert.deepEqual(await f.grant(), receipt);
  assert.equal(f.calls.length, 2, 'Recorded retries still read current backend assignment');
  assert.deepEqual(f.store.operation(receipt.grantId), operation, 'Retries do not rewrite grants');
});

test('grant retry keys cannot change reviewer, source or reactivate a revoked grant', async t => {
  const f = fixture(t);
  const receipt = await f.grant();
  for (const source of [{ ...f.input.source, text: 'Changed' }, { ...f.input.source, createdAt: 201 },
    { ...f.input.source, id: 'different' }]) {
    await assert.rejects(f.grant({ source }), { code: 'coordinator_grant_conflict' });
  }
  const revoked = await f.revoke(receipt.grantId);
  assert.equal(revoked.state, 'revoked');
  const operation = f.store.operation(receipt.grantId);
  assert.deepEqual(operation.request.sourceDigest, digest(f.input.source.text));
  assert.equal(operation.revocation.sourceMessageId, 'revoke-human');
  assert.deepEqual(await f.revoke(receipt.grantId), revoked);
  assert.deepEqual(f.store.operation(receipt.grantId), operation);
  await assert.rejects(f.grant(), { code: 'coordinator_grant_inactive' });
  assert.throws(() => validateCoordinatorGrant(f.store, receipt.grantId,
    { companyId: 'company', parentTaskId: 'parent' }), { code: 'coordinator_grant_inactive' });
});

for (const [name, change, code] of [
  ['missing parent', f => f.store.db.prepare('DELETE FROM operations WHERE id = ?').run(f.parent.id), 'invalid_coordinator_parent'],
  ['missing reviewer', f => { f.input.reviewerBindingId = 'missing'; }, 'invalid_coordinator_reviewer'],
  ['different reviewer', f => { f.input.reviewerBindingId = 'worker'; }, 'invalid_coordinator_reviewer'],
  ['foreign reviewer', f => { f.add('foreign', 'other'); f.input.reviewerBindingId = 'foreign'; }, 'invalid_coordinator_reviewer'],
  ['origin reviewer', f => { f.input.reviewerBindingId = 'origin'; }, 'invalid_coordinator_reviewer'],
  ['reviewer disarmed', f => f.store.saveOperation({ ...f.reviewer, state: 'configured' }), 'invalid_coordinator_reviewer'],
  ['parent wrong company', f => f.store.saveOperation({ ...f.parent, receipt: { ...f.parent.receipt, companyId: 'other' } }), 'invalid_coordinator_parent'],
  ['parent wrong assignee', f => f.store.saveOperation({ ...f.parent, receipt: { ...f.parent.receipt, assigneeAgentId: 'other' } }), 'invalid_coordinator_parent'],
  ['parent has no native evidence', f => f.store.saveOperation({ ...f.parent, request: { ...f.parent.request,
    origin: { bindingId: 'origin', conversationId: 'chat-origin', sessionCreatedAt: 100 } } }), 'invalid_coordinator_parent'],
  ['parent is not root', f => f.store.saveOperation({ ...f.parent, request: { ...f.parent.request,
    body: { ...f.parent.request.body, parentId: 'root' } }, receipt: { ...f.parent.receipt, parentId: 'root' } }), 'invalid_coordinator_parent'],
  ['origin native creation changed', f => f.store.saveOperation({ ...f.parent, request: { ...f.parent.request,
    origin: { ...f.origin, sessionCreatedAt: 101 } } }), 'invalid_coordinator_parent'],
  ...['none', 'agent_decides', 'coordinator', 'unknown', null].map(policy => [`parent policy ${policy}`, f => f.store.saveOperation({ ...f.parent,
    request: { ...f.parent.request, relayReviewPolicy: policy } }), 'invalid_coordinator_parent']),
  ['backend wrong company', f => { f.issue.companyId = 'other'; }, 'coordinator_parent_scope_changed'],
  ['backend reassigned', f => { f.issue.assigneeAgentId = 'agent-worker'; }, 'coordinator_parent_scope_changed'],
  ['backend terminal', f => { f.issue.status = 'done'; }, 'coordinator_parent_scope_changed'],
  ['caller disarmed', f => f.store.saveOperation({ ...f.bridge, state: 'configured' }), 'bridge_identity_mismatch'],
  ['caller missing', f => f.store.db.prepare('DELETE FROM bindings WHERE id = ?').run('origin'), 'bridge_identity_mismatch'],
]) {
  test(`grant refuses ${name} without persisting authority`, async t => {
    const f = fixture(t);
    change(f);
    await assert.rejects(f.grant(), { code });
    assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM operations WHERE id LIKE 'coordinator-review-grant:%'").get().count, 0);
  });
}

for (const source of [undefined, { id: '', text: 'Grant', createdAt: 200 },
  { id: 'source', text: '', createdAt: 200 }, { id: 'source', text: 'Grant', createdAt: 99 },
  { id: 'source', text: 'Grant', createdAt: Number.MAX_SAFE_INTEGER },
  ...['synthetic', 'ignored'].map(field => ({ id: 'source', text: 'Grant', createdAt: 200, [field]: true })),
  { id: 'source', text: 'Grant', createdAt: 200, role: 'assistant' }]) {
  test(`rejects invalid source ${JSON.stringify(source)}`, async t => {
    const f = fixture(t);
    await assert.rejects(f.grant({ source }), { code: 'invalid_coordinator_source' });
    assert.equal(f.calls.length, 0);
  });
}

test('busy caller, Relay invocation and prior input cannot grant authority', async t => {
  const f = fixture(t);
  f.store.db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?)').run('run', 'backend', 'origin', 1, JSON.stringify({
    id: 'run', request: { bindingId: 'origin', companyId: 'company', taskId: 'other' }, nativeState: 'claimed',
    invocation: { messageId: 'grant-human', priorUserIds: ['prior-human'] },
  }));
  await assert.rejects(f.grant(), { code: 'conversation_busy' });
  f.store.save({ ...f.store.run('run'), nativeState: 'settled' }, 'test.settled');
  await assert.rejects(f.grant(), { code: 'invalid_coordinator_source' });
  await assert.rejects(f.grant({ source: { ...f.input.source, id: 'prior-human' } }), { code: 'invalid_coordinator_source' });
  assert.equal(f.calls.length, 0);
});

test('grant revalidates local authority and source after backend read, including retries', async t => {
  for (const retry of [false, true]) {
    for (const change of [f => f.store.saveOperation({ ...f.bridge, epoch: 'changed' }),
      f => f.store.saveOperation({ ...f.reviewer, sessionCreatedAt: 101 }),
      f => f.store.saveOperation({ ...f.parent, request: { ...f.parent.request, relayReviewPolicy: 'none' } }),
      f => { f.input.source.synthetic = true; }, f => { f.input.source.text = 'Changed during lookup'; }]) {
      const f = fixture(t);
      if (retry) await f.grant();
      await assert.rejects(f.grant({}, async (...args) => {
        const result = await f.api(...args);
        change(f);
        return result;
      }));
    }
  }
});

test('revocation requires explicit ID and the exact origin but not a live reviewer or parent', async t => {
  const f = fixture(t);
  const { grantId } = await f.grant();
  await assert.rejects(f.revoke(undefined), { code: 'invalid_request' });
  await assert.rejects(f.revoke('coordinator-review-grant:missing'), { code: 'coordinator_grant_not_found' });
  await assert.rejects(f.revoke(grantId, {}, f.reviewer), { code: 'coordinator_grant_not_found' });
  await assert.rejects(f.revoke(grantId, { source: f.input.source }), { code: 'invalid_coordinator_source' });
  f.store.db.prepare('DELETE FROM operations WHERE id = ?').run(f.parent.id);
  f.store.retireBinding('reviewer');
  assert.equal((await f.revoke(grantId)).state, 'revoked');
  assert.ok(f.store.operation(grantId), 'Revocation preserves the grant');
  await assert.rejects(f.revoke(grantId, { source: { id: 'new', text: 'Revoke again', createdAt: 400 } }),
    { code: 'coordinator_grant_conflict' });
});

test('notification sources never authorise grants or revocation, including uncertain delivery', async t => {
  for (const state of ['pending', 'uncertain', 'announced']) {
    const f = fixture(t);
    const { grantId } = await f.grant();
    const notification = { id: 'review-notification:one', runId: '', state, origin: f.origin, messageId: 'grant-human' };
    f.store.saveOperation(notification);
    await assert.rejects(f.grant(), { code: 'invalid_coordinator_source' });
    f.store.saveOperation({ ...notification, messageId: 'revoke-human' });
    await assert.rejects(f.revoke(grantId), { code: 'invalid_coordinator_source' });
    assert.equal(f.store.operation(grantId).state, 'active');
  }
});

test('concurrent grant retries preserve one immutable grant and cannot undo revocation', async t => {
  const f = fixture(t);
  const receipts = await Promise.all([f.grant(), f.grant()]);
  assert.deepEqual(receipts[0], receipts[1]);
  const { grantId } = receipts[0];
  await assert.rejects(f.grant({}, async (...args) => {
    const issue = await f.api(...args);
    await f.revoke(grantId);
    return issue;
  }), { code: 'coordinator_grant_inactive' });
  assert.equal(f.store.operation(grantId).state, 'revoked');
});

test('only recorded independent direct children with an explicit coordinator policy resolve a grant', async t => {
  const f = fixture(t);
  const { grantId } = await f.grant();
  const child = f.child(grantId);
  assert.equal(coordinatorReviewGrant(f.store, 'company', 'child').id, grantId);
  assert.equal(coordinatorReviewGrant(f.store, 'other', 'child'), null);
  assert.equal(coordinatorReviewGrant(f.store, 'company', 'parent'), null);
  assert.equal(coordinatorReviewGrant(f.store, 'company', 'unknown'), null);
  for (const change of [
    { state: 'uncertain' },
    ...[undefined, 'human', 'none', 'agent_decides', 'unknown'].map(policy => ({ request: { ...child.request, relayReviewPolicy: policy } })),
    { request: { ...child.request, relayReviewGrantId: undefined } },
    { request: { ...child.request, relayReviewGrantId: 'missing' } },
    { request: { ...child.request, body: { ...child.request.body, parentId: 'child-parent' } }, receipt: { ...child.receipt, parentId: 'child-parent' } },
    { request: { ...child.request, body: { ...child.request.body, assigneeAgentId: 'agent-reviewer' } }, receipt: { ...child.receipt, assigneeAgentId: 'agent-reviewer' } },
    { receipt: { ...child.receipt, parentId: 'other' } },
    { receipt: { ...child.receipt, assigneeAgentId: 'other' } },
  ]) {
    f.child(grantId, change);
    assert.equal(coordinatorReviewGrant(f.store, 'company', 'child'), null);
  }
  f.child(grantId);
  await f.revoke(grantId);
  assert.equal(coordinatorReviewGrant(f.store, 'company', 'child'), null);
  assert.equal(taskPolicy(f.store, 'company', 'child'), 'coordinator', 'Revocation never weakens creator policy');
});

test('conflicting recorded child policies or grants do not confer authority', async t => {
  const f = fixture(t);
  const { grantId } = await f.grant();
  const child = f.child(grantId);
  for (const request of [{ ...child.request, relayReviewPolicy: 'human' }, { ...child.request, relayReviewGrantId: 'other' }]) {
    f.store.saveOperation({ ...child, id: 'operator-task:conflict', request });
    assert.equal(coordinatorReviewGrant(f.store, 'company', 'child'), null);
  }
});

test('raw worker creation records resolve without an operator child origin', async t => {
  const f = fixture(t);
  const { grantId } = await f.grant();
  const child = f.child(grantId);
  f.store.db.prepare('DELETE FROM operations WHERE id = ?').run(child.id);
  const { companyId, origin, ...request } = child.request;
  f.store.saveOperation({ ...child, id: 'worker-child', runId: 'parent-run', request: { ...request,
    kind: 'task.create', method: 'POST', path: '/api/companies/company/issues' } });
  assert.equal(coordinatorReviewGrant(f.store, 'company', 'child').id, grantId);
});

test('grant validation rejects wrong company, parent, reviewer and changed native binding identity', async t => {
  const f = fixture(t);
  const { grantId } = await f.grant();
  for (const scope of [{ companyId: 'other', parentTaskId: 'parent' }, { companyId: 'company', parentTaskId: 'other' },
    { companyId: 'company', parentTaskId: 'parent', reviewerBindingId: 'worker' }]) {
    assert.throws(() => validateCoordinatorGrant(f.store, grantId, scope));
  }
  const binding = f.store.binding('reviewer');
  f.store.db.prepare('UPDATE bindings SET data = ? WHERE id = ?').run(JSON.stringify({ ...binding, revision: 2 }), binding.id);
  assert.throws(() => validateCoordinatorGrant(f.store, grantId, { companyId: 'company', parentTaskId: 'parent' }),
    { code: 'coordinator_grant_scope_changed' });
});

test('coordinator policy is creator-owned and workers cannot replace it with none or human', async t => {
  const f = fixture(t);
  const { grantId } = await f.grant();
  f.child(grantId);
  const run = { request: { companyId: 'company', taskId: 'child' } };
  assert.equal(validateTaskPolicy('coordinator'), 'coordinator');
  assert.equal(resultPolicy(f.store, run, {}), 'coordinator');
  for (const mode of ['none', 'human']) assert.throws(() => resultPolicy(f.store, run,
    { reviewDecision: { mode, reason: 'Override the coordinator' } }), { code: 'review_policy_locked' });
});
