import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { createOperatorTask, mutate } from '../src/operations.mjs';
import { harnessDelegation } from '../src/harness-delegation.mjs';
import { coordinatorGrant, coordinatorReviewGrant } from '../src/coordinator-review.mjs';
import { taskPolicy } from '../src/task-policy.mjs';

async function fixture(t, worker = false) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const add = id => {
    const identity = { companyId: 'company', machineId: 'machine', session: 'default', harness: 'opencode',
      sessionKind: 'id', conversationId: `chat-${id}` };
    const observed = store.saveOperation({ id: `herdr-agent:${id}`, runId: '', identity, availability: 'present',
      agentId: `agent-${id}`, placement: { directory: `/work/${id}`, terminalId: `terminal-${id}` } });
    store.register({ id, companyId: 'company', agentId: observed.agentId, harness: 'opencode',
      instanceId: digest([identity.machineId, identity.session]), conversationId: identity.conversationId });
    return store.saveOperation({ id: `opencode-bridge:${id}`, runId: '', state: 'armed', ready: true,
      identity: { bindingId: id, observedId: observed.id, conversationId: identity.conversationId, ...observed.placement },
      tokenHash: `secret-${id}`, epoch: `epoch-${id}`, sessionCreatedAt: 100, lastSeen: new Date().toISOString() });
  };
  const bridge = add('origin');
  const reviewer = add('reviewer');
  add('worker');
  const origin = { bindingId: 'origin', conversationId: 'chat-origin', sessionCreatedAt: 100,
    sourceMessageId: 'create-parent', sourceDigest: digest('Delegate the parent') };
  const parent = store.saveOperation({ id: 'operator-task:parent', runId: '', state: 'recorded',
    request: { companyId: 'company', origin, relayReviewPolicy: 'human', body: { assigneeAgentId: 'agent-reviewer' } },
    receipt: { id: 'parent', companyId: 'company', assigneeAgentId: 'agent-reviewer' } });
  const f = { store, bridge, reviewer, origin, parent, calls: [],
    issue: { id: 'parent', companyId: 'company', assigneeAgentId: 'agent-reviewer', status: 'in_progress' } };
  f.api = async (method, path, body) => {
    f.calls.push({ method, path, body });
    if (method === 'POST') return { ...body, id: 'child', companyId: 'company' };
    if (path === '/api/issues/parent') return { ...f.issue };
    if (path === '/api/companies/company') return { id: 'company' };
    return { id: path.split('/').at(-1), companyId: 'company' };
  };
  const { grantId } = await coordinatorGrant(store, bridge, 'grant-review', {
    key: 'grant', parentTaskId: 'parent', reviewerBindingId: 'reviewer',
    source: { id: 'grant-human', text: 'Allow coordinator review of direct children.', createdAt: 200 },
  }, f.api);
  f.grantId = grantId;
  f.payload = { title: 'Independent child', parentId: 'parent', assigneeAgentId: 'agent-worker',
    relayReviewPolicy: 'coordinator', relayReviewGrantId: grantId };
  if (worker) {
    const pending = store.dispatch({ bindingId: 'reviewer', bindingRevision: 1, companyId: 'company',
      agentId: 'agent-reviewer', taskId: 'parent', runId: 'backend-parent' });
    f.run = store.acknowledge(pending.id);
  }
  f.create = (payload = {}, api = f.api, input = {}) => worker
    ? mutate(store, f.run, 'secret-worker', (_run, _token, ...args) => api(...args), {
      key: 'child', kind: 'task.create', payload: { ...f.payload, ...payload }, ...input,
    })
    : createOperatorTask(store, api, { companyId: 'company', key: 'child', origin,
      payload: { ...f.payload, ...payload }, ...input });
  f.revoke = () => {
    const grant = store.operation(grantId);
    store.saveOperation({ ...grant, state: 'revoked' });
  };
  f.calls.length = 0;
  return f;
}

for (const worker of [false, true]) {
  const route = worker ? 'worker' : 'operator';

  test(`${route} persists explicit coordinator policy and grant without sending local fields or secrets`, async t => {
    const f = await fixture(t, worker);
    const operation = await f.create();
    assert.equal(operation.request.relayReviewPolicy, 'coordinator');
    assert.equal(operation.request.relayReviewGrantId, f.grantId);
    assert.equal(operation.request.body.relayReviewPolicy, undefined);
    assert.equal(operation.request.body.relayReviewGrantId, undefined);
    assert.equal(JSON.stringify(operation).includes('secret-'), false);
    assert.equal(taskPolicy(f.store, 'company', 'parent'), 'human');
    assert.equal(taskPolicy(f.store, 'company', 'child'), 'coordinator');
    assert.equal(coordinatorReviewGrant(f.store, 'company', 'child').id, f.grantId);
    assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => call.body), [operation.request.body]);
    assert.equal(f.calls.at(-2).path, '/api/issues/parent', 'Parent is the last backend read before POST');
  });

  test(`${route} never infers coordinator authority from a grant or parent`, async t => {
    const f = await fixture(t, worker);
    for (const policy of [undefined, 'human', 'none', 'agent_decides']) {
      await assert.rejects(f.create({ relayReviewPolicy: policy }), { code: 'invalid_review_policy' });
    }
    for (const grantId of [undefined, null, '', ' ', 42, {}]) {
      await assert.rejects(f.create({ relayReviewGrantId: grantId }), { code: 'invalid_request' });
    }
    assert.equal(f.calls.length, 0);
    const operation = await f.create({ relayReviewPolicy: undefined, relayReviewGrantId: undefined });
    assert.equal(operation.request.relayReviewGrantId, undefined);
    assert.equal(taskPolicy(f.store, 'company', 'child'), 'none');
    assert.equal(coordinatorReviewGrant(f.store, 'company', 'child'), null);
  });

  test(`${route} rejects missing, cross-parent, grandchild and self-assigned scope`, async t => {
    const f = await fixture(t, worker);
    for (const parentId of [undefined, null, 'other-parent', 'child']) {
      await assert.rejects(f.create({ parentId }), { code: 'coordinator_grant_inactive' });
    }
    for (const assigneeAgentId of [undefined, null, 'agent-reviewer']) {
      await assert.rejects(f.create({ assigneeAgentId }), { code: 'invalid_coordinator_child' });
    }
    await assert.rejects(f.create({ assigneeAgentId: undefined, assigneeUserId: 'human' }), { code: 'invalid_coordinator_child' });
    await assert.rejects(f.create({ relayReviewGrantId: 'missing' }), { code: 'coordinator_grant_inactive' });
    f.revoke();
    await assert.rejects(f.create(), { code: 'coordinator_grant_inactive' });
    assert.equal(f.calls.length, 0);
  });

  test(`${route} requires the parent to remain a human-reviewed root`, async t => {
    for (const change of [
      { request: { relayReviewPolicy: 'none' } },
      { request: { body: { assigneeAgentId: 'agent-reviewer', parentId: 'grandparent' } } },
    ]) {
      const f = await fixture(t, worker);
      f.store.saveOperation({ ...f.parent, request: { ...f.parent.request, ...change.request } });
      await assert.rejects(f.create(), { code: 'invalid_coordinator_parent' });
      assert.equal(f.calls.length, 0);
    }
  });

  test(`${route} checks current backend parent assignment, root, status and company`, async t => {
    for (const change of [{ id: 'other' }, { companyId: 'other' }, { assigneeAgentId: 'agent-worker' },
      { assigneeUserId: 'human' }, { status: 'done' }, { status: 'cancelled' }, { parentId: 'grandparent' },
      ...(worker ? [{ executionRunId: 'other-run' }] : [])]) {
      const f = await fixture(t, worker);
      Object.assign(f.issue, change);
      await assert.rejects(f.create());
      assert.equal(f.calls.some(call => call.method === 'POST'), false);
    }
  });

  test(`${route} revalidates grant and native scope after every backend await`, async t => {
    for (const path of worker ? ['/api/issues/parent'] :
      ['/api/companies/company', '/api/projects/project', '/api/agents/agent-worker', '/api/issues/blocker', '/api/issues/parent']) {
      for (const change of [
        f => f.revoke(),
        f => f.store.saveOperation({ ...f.reviewer, sessionCreatedAt: 101 }),
        f => f.store.saveOperation({ ...f.parent, request: { ...f.parent.request, relayReviewPolicy: 'none' } }),
        f => {
          const grant = f.store.operation(f.grantId);
          f.store.saveOperation({ ...grant, request: { ...grant.request, sourceDigest: 'changed' } });
        },
        ...(worker ? [f => f.store.save({ ...f.run, cancellationRequested: true }, 'test.cancel')] :
          [f => f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 101 })]),
      ]) {
        const f = await fixture(t, worker);
        await assert.rejects(f.create({ projectId: 'project', blockedByIssueIds: ['blocker'] }, async (...args) => {
          const result = await f.api(...args);
          if (args[1] === path) change(f);
          return result;
        }));
        assert.equal(f.calls.some(call => call.method === 'POST'), false, path);
      }
    }
  });

  test(`${route} recorded retries survive revocation but grant and payload conflicts remain immutable`, async t => {
    const f = await fixture(t, worker);
    const operation = await f.create();
    f.revoke();
    f.calls.length = 0;
    assert.deepEqual(await f.create(), operation);
    for (const change of [{ relayReviewGrantId: 'another-grant' }, { title: 'Changed' }, { parentId: 'other' },
      { relayReviewPolicy: 'human', relayReviewGrantId: undefined }]) {
      await assert.rejects(f.create(change), { code: 'operation_conflict' });
    }
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.store.operation(operation.id), operation);
  });

  test(`${route} uncertain retries cannot bypass revocation`, async t => {
    const f = await fixture(t, worker);
    await assert.rejects(f.create({}, async (...args) => {
      const result = await f.api(...args);
      if (args[0] === 'POST') throw new Error('Lost receipt');
      return result;
    }), /Lost receipt/);
    f.revoke();
    f.calls.length = 0;
    await assert.rejects(f.create(), { code: 'coordinator_grant_inactive' });
    assert.equal(f.calls.length, 0);
  });

  test(`${route} concurrent conflicting creation cannot overwrite persisted intent`, async t => {
    const f = await fixture(t, worker);
    let interleaved = false;
    await assert.rejects(f.create({}, async (...args) => {
      const result = await f.api(...args);
      if (!interleaved) {
        interleaved = true;
        await f.create({ title: 'Other request' });
      }
      return result;
    }), { code: 'operation_conflict' });
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  });
}

test('operator coordinator creation requires the exact explicit native grant origin', async t => {
  const f = await fixture(t);
  for (const origin of [undefined, { ...f.origin, bindingId: 'worker', conversationId: 'chat-worker' },
    { ...f.origin, conversationId: 'other' }, { ...f.origin, sessionCreatedAt: 101 }]) {
    await assert.rejects(f.create({}, f.api, { origin }), { code: 'invalid_origin' });
  }
  assert.equal(f.calls.length, 0);
});

test('worker coordinator creation rejects non-parent, stale, unacknowledged and inactive callers', async t => {
  for (const change of [
    { request: { taskId: 'child' } }, { request: { bindingId: 'worker' } }, { request: { agentId: 'agent-worker' } },
    { request: { bindingRevision: 2 } }, { conversationId: 'other' }, { backendRunId: 'replacement' },
    { nativeState: 'settled' }, { nativeState: 'unclaimed' }, { deliveryState: 'pending' },
    { cancellationRequested: true }, { result: { candidate: 'finished' } }, { waiting: { id: 'question' } },
  ]) {
    const f = await fixture(t, true);
    f.store.save({ ...f.run, ...change, request: { ...f.run.request, ...change.request } }, 'test.scope');
    await assert.rejects(f.create(), { code: 'coordinator_reviewer_mismatch' });
    assert.equal(f.calls.length, 0);
  }
});

test('worker self cannot use its own active child run to create granted grandchildren', async t => {
  const f = await fixture(t, true);
  const pending = f.store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company',
    agentId: 'agent-worker', taskId: 'child', runId: 'backend-child' });
  f.run = f.store.acknowledge(pending.id);
  await assert.rejects(f.create({ parentId: 'child' }), { code: 'coordinator_grant_inactive' });
  await assert.rejects(f.create(), { code: 'coordinator_reviewer_mismatch' });
  assert.equal(f.calls.length, 0);
});

test('creation snapshots caller input before awaits and never auto-issues a grant for a human parent', async t => {
  const f = await fixture(t);
  const input = { companyId: 'company', key: 'new-parent', origin: f.origin,
    payload: { title: 'Human root', assigneeAgentId: 'agent-reviewer', blockedByIssueIds: [] } };
  const operation = await createOperatorTask(f.store, async (...args) => {
    const result = await f.api(...args);
    input.payload.title = 'Changed';
    input.payload.blockedByIssueIds.push('injected');
    return result;
  }, input);
  assert.equal(operation.request.body.title, 'Human root');
  assert.deepEqual(operation.request.body.blockedByIssueIds, []);
  assert.equal(operation.request.relayReviewGrantId, undefined);
  assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM operations WHERE id LIKE 'coordinator-review-grant:%'").get().count, 1);
});

test('harness forwards optional validated grantId without exposing bridge secrets and preserves revoked retries', async t => {
  const f = await fixture(t);
  const input = { key: 'harness-child', targetBindingId: 'worker', title: 'Child', description: 'Review independently',
    parentTaskId: 'parent', relayReviewPolicy: 'coordinator', grantId: f.grantId,
    conversationId: 'chat-origin', sessionCreatedAt: 100, epoch: f.bridge.epoch,
    source: { id: 'create-child', text: 'Delegate a coordinator-reviewed child', createdAt: 300 } };
  const invoke = change => harnessDelegation(f.store, f.bridge, 'delegate', { ...input, ...change }, f.api);
  for (const grantId of [undefined, null, '', ' ', 42]) await assert.rejects(invoke({ grantId }), { code: 'invalid_request' });
  await assert.rejects(invoke({ relayReviewPolicy: undefined }), { code: 'invalid_review_policy' });
  assert.equal(f.calls.length, 0);
  const result = await invoke();
  assert.equal(f.store.operation(result.id).request.relayReviewGrantId, f.grantId);
  assert.equal(JSON.stringify(result).includes('secret-'), false);
  f.revoke();
  f.calls.length = 0;
  assert.deepEqual(await invoke(), result);
  await assert.rejects(invoke({ grantId: 'another' }), { code: 'operation_conflict' });
  assert.equal(f.calls.length, 0);
});
