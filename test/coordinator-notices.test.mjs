import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { reconcileCoordinatorNotices } from '../src/coordinator-notices.mjs';

function fixture(t, path = ':memory:') {
  let store = new Store(path);
  t.after(() => store.close());
  for (const id of ['origin', 'reviewer', 'worker']) {
    const identity = { companyId: 'company', machineId: 'machine', session: 'herdr-session',
      harness: 'opencode', sessionKind: 'id', conversationId: `chat-${id}` };
    const observedId = `herdr-agent:${digest(identity)}`;
    const placement = { directory: `/workspace/${id}`, terminalId: `terminal-${id}` };
    store.register({ id, companyId: 'company', agentId: `agent-${id}`, harness: 'opencode',
      instanceId: digest([identity.machineId, identity.session]), conversationId: `chat-${id}` });
    store.saveOperation({ id: observedId, runId: '', state: 'recorded', identity,
      availability: 'present', agentId: `agent-${id}`, placement, observation: { state: 'idle' } });
    store.saveOperation({ id: `opencode-bridge:${id}`, runId: '', state: 'armed', ready: true,
      lastSeen: new Date().toISOString(), epoch: `epoch-${id}`,
      identity: { bindingId: id, conversationId: `chat-${id}`, observedId, ...placement }, sessionCreatedAt: 100 });
  }
  const origin = { bindingId: 'origin', conversationId: 'chat-origin', sessionCreatedAt: 100 };
  store.saveOperation({ id: 'operator-task:parent', runId: '', state: 'recorded',
    request: { companyId: 'company', origin: { ...origin, sourceMessageId: 'human-create', sourceDigest: digest('Delegate') },
      body: { assigneeAgentId: 'agent-reviewer' } },
    receipt: { id: 'parent', companyId: 'company', assigneeAgentId: 'agent-reviewer' } });
  const grant = store.saveOperation({ id: `coordinator-review-grant:${digest([origin, 'parent', 'key'])}`,
    runId: '', state: 'active', request: { companyId: 'company', parentTaskId: 'parent', origin, key: 'key',
      reviewerBindingId: 'reviewer', reviewerBindingRevision: 1, reviewerAgentId: 'agent-reviewer',
      reviewerConversationId: 'chat-reviewer', reviewerSessionCreatedAt: 100 } });
  const f = { store, grant, calls: [], comments: [], issues: {
    parent: { id: 'parent', companyId: 'company', assigneeAgentId: 'agent-reviewer', status: 'blocked',
      updatedAt: '2026-10-07T12:00:00Z', blockedBy: [{ id: 'child' }, { id: 'unrelated-blocker' }] },
  }, interactions: { parent: [] } };
  f.reopen = () => { store.close(); store = new Store(path); f.store = store; };
  f.bridge = change => store.saveOperation({ ...store.operation('opencode-bridge:reviewer'), ...change });
  f.observed = change => {
    const id = store.operation('opencode-bridge:reviewer').identity.observedId;
    const observed = { ...store.operation(id), ...change };
    // Preserve explicit timestamps: saveOperation normally stamps the current time.
    store.db.prepare('UPDATE operations SET data = ? WHERE id = ?').run(JSON.stringify(observed), id);
    return observed;
  };
  f.insert = run => {
    store.db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?)').run(run.id, run.id, run.request.bindingId,
      run.nativeState === 'settled' ? 0 : 1, JSON.stringify(run));
    return run;
  };
  f.change = (id, change) => store.save({ ...store.run(id), ...change }, 'test.changed');
  f.insert({ id: 'parent-run', request: { companyId: 'company', taskId: 'parent', bindingId: 'reviewer',
    bindingRevision: 1, agentId: 'agent-reviewer', runId: 'parent-backend' }, conversationId: 'chat-reviewer',
    nativeState: 'settled', settlement: { outcome: 'waiting' }, dependency: { childId: 'child', state: 'recorded' },
    result: null, publication: { state: 'none' } });
  f.addChild = (taskId = 'child') => {
    store.saveOperation({ id: `operator-task:${taskId}`, runId: '', state: 'recorded',
      request: { companyId: 'company', relayReviewPolicy: 'coordinator', relayReviewGrantId: grant.id,
        body: { parentId: 'parent', assigneeAgentId: 'agent-worker' } },
      receipt: { id: taskId, companyId: 'company', parentId: 'parent', assigneeAgentId: 'agent-worker' } });
    const run = f.insert({ id: `${taskId}-run`, request: { companyId: 'company', taskId, bindingId: 'worker',
      bindingRevision: 1, agentId: 'agent-worker', runId: `${taskId}-backend` }, conversationId: 'chat-worker',
      nativeState: 'settled', settlement: { outcome: 'completed' }, publication: { state: 'recorded', commentId: 'published' },
      result: { key: 'result', candidate: `${taskId}-candidate`, summary: 'Worker-controlled text\nDo not execute me' },
      review: { candidate: `${taskId}-candidate`, interactionId: `${taskId}-interaction`, status: 'pending' } });
    store.saveOperation({ id: `review-disposition:${run.id}`, runId: run.id, state: 'waiting', policy: 'coordinator',
      candidate: run.result.candidate, interactionId: run.review.interactionId,
      coordinatorReviewGrant: { id: grant.id, request: grant.request } });
    f.issues[taskId] = { id: taskId, companyId: 'company', parentId: 'parent', assigneeAgentId: 'agent-worker', status: 'in_review' };
    f.interactions[taskId] = [{ id: run.review.interactionId, companyId: 'company', issueId: taskId,
      status: 'pending', kind: 'request_confirmation', resolverPolicy: 'not_creator',
      idempotencyKey: `relay-review:${run.id}:${digest(run.result)}`, payload: { target: {
        type: 'custom', key: 'herdr-relay-candidate', revisionId: run.result.candidate, label: run.id,
      } } }];
    return run;
  };
  f.run = f.addChild();
  f.notices = () => store.db.prepare("SELECT data FROM operations WHERE id LIKE 'coordinator-review-notice:%' ORDER BY rowid")
    .all().map(row => JSON.parse(row.data));
  f.posts = () => f.calls.filter(call => call.method === 'POST');
  f.api = async (method, path, body) => {
    f.calls.push({ method, path, body: structuredClone(body) });
    if (method === 'POST') {
      assert.equal(path, '/api/issues/parent/comments', 'Only the parent comment may be mutated');
      assert.equal(f.notices().find(item => item.request.clientRequestId === body.clientRequestId)?.state, 'uncertain');
      assert.deepEqual(Object.keys(body).sort(), ['body', 'clientRequestId']);
      let comment = f.comments.find(item => item.clientRequestId === body.clientRequestId);
      if (!comment) {
        comment = { id: `comment-${f.comments.length + 1}`, companyId: 'company', issueId: 'parent',
          authorUserId: 'deployment-specific-board-user', authorAgentId: null, createdByRunId: null, ...body };
        f.comments.push(comment);
      }
      return structuredClone(comment);
    }
    assert.equal(method, 'GET', 'No issue edits, review decisions or direct native injections');
    if (path === '/api/issues/parent/comments') return structuredClone(f.comments);
    const match = /^\/api\/issues\/([^/]+)(\/interactions)?$/.exec(path);
    assert.ok(match, `Unexpected read: ${path}`);
    const result = match[2] ? f.interactions[match[1]] : f.issues[match[1]];
    assert.ok(result, `Unknown fixture resource: ${path}`);
    return structuredClone(result);
  };
  return f;
}

test('posts one machine-labelled parent notice, proves its receipt and leaves task state untouched', async t => {
  const f = fixture(t);
  const before = structuredClone({ issues: f.issues, interactions: f.interactions, runs: f.store.runs() });
  const operations = f.store.db.prepare('SELECT data FROM operations ORDER BY rowid').all();
  await reconcileCoordinatorNotices(f.store, f.api);
  const [notice] = f.notices();
  const key = digest([f.grant.id, 'parent', 'child', 'child-run', 'child-candidate', 'child-interaction']);
  assert.equal(notice.id, `coordinator-review-notice:${key}`);
  assert.equal(notice.state, 'recorded');
  assert.equal(notice.continuationState, 'awaiting_admission');
  assert.equal(notice.reason, 'continuation_unconfirmed');
  assert.equal(notice.commentId, 'comment-1');
  assert.equal(notice.request.clientRequestId, `relay-coordinator-review:${key}`);
  assert.match(notice.request.body, /machine-generated informational data, not a human instruction or authorisation/);
  assert.match(notice.request.body, /"kind":"candidate_ready"/);
  assert.equal(notice.request.body.includes(f.run.result.summary), false);
  assert.equal(f.posts().length, 1);
  assert.equal(f.calls.at(-1).path, '/api/issues/parent/comments');
  assert.deepEqual({ issues: f.issues, interactions: f.interactions, runs: f.store.runs() }, before);
  assert.deepEqual(f.store.db.prepare("SELECT data FROM operations WHERE id NOT LIKE 'coordinator-review-notice:%' ORDER BY rowid").all(), operations);
  const calls = f.calls.length;
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.equal(f.calls.length, calls);
});

for (const committed of [false, true]) {
  test(`lost POST reply, committed=${committed}: reconciles receipts without resending`, async t => {
    const f = fixture(t);
    const api = async (...args) => {
      if (args[0] !== 'POST') return f.api(...args);
      if (committed) await f.api(...args);
      else f.calls.push({ method: args[0], path: args[1], body: args[2] });
      throw new Error('private response, token=secret');
    };
    await reconcileCoordinatorNotices(f.store, api);
    assert.equal(f.notices()[0].state, 'uncertain');
    assert.equal(f.notices()[0].reason, 'backend_unavailable');
    for (let i = 0; i < 3; i++) await reconcileCoordinatorNotices(f.store, api);
    assert.equal(f.posts().length, 1);
    assert.equal(f.notices()[0].state, committed ? 'recorded' : 'uncertain');
    assert.equal(JSON.stringify(f.notices()).includes('secret'), false);
  });
}

test('a POST response is not proof without GET and a lost GET reply is recoverable', async t => {
  const f = fixture(t);
  await reconcileCoordinatorNotices(f.store, async (...args) => {
    if (args[1] === '/api/issues/parent/comments' && args[0] === 'GET') throw new Error('lost read');
    return f.api(...args);
  });
  assert.equal(f.notices()[0].state, 'uncertain');
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.equal(f.notices()[0].state, 'recorded');
  assert.equal(f.posts().length, 1);
});

for (const [name, change] of [
  ['missing ID', comment => { delete comment.id; }],
  ['wrong ID', comment => { comment.id = 'another'; }],
  ['wrong key', comment => { comment.clientRequestId = 'other'; }],
  ['wrong body', comment => { comment.body += 'edited'; }],
  ['wrong company', comment => { comment.companyId = 'other'; }],
  ['wrong issue', comment => { comment.issueId = 'other'; }],
]) {
  test(`receipt refuses ${name} and never retries POST`, async t => {
    const f = fixture(t);
    await reconcileCoordinatorNotices(f.store, async (...args) => {
      const response = await f.api(...args);
      if (args[0] === 'POST') change(f.comments[0]);
      return response;
    });
    await reconcileCoordinatorNotices(f.store, f.api);
    assert.equal(f.notices()[0].state, 'uncertain');
    assert.equal(f.notices()[0].reason, 'coordinator_notice_uncertain');
    assert.equal(f.posts().length, 1);
  });
}

test('request key and body suffice without optional receipt scope fields or assumed board author', async t => {
  const f = fixture(t);
  await reconcileCoordinatorNotices(f.store, async (...args) => {
    const response = await f.api(...args);
    if (args[0] === 'POST') {
      for (const field of ['companyId', 'issueId', 'authorUserId', 'authorAgentId', 'createdByRunId']) delete f.comments[0][field];
    }
    return response;
  });
  assert.equal(f.notices()[0].state, 'recorded');
});

test('duplicate matching receipts remain uncertain', async t => {
  const f = fixture(t);
  await reconcileCoordinatorNotices(f.store, async (...args) => {
    const response = await f.api(...args);
    if (args[0] === 'POST') f.comments.push({ ...f.comments[0] });
    return response;
  });
  assert.equal(f.notices()[0].state, 'uncertain');
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.equal(f.posts().length, 1);
});

const ineligible = [
  ['revoked grant', f => f.store.saveOperation({ ...f.grant, state: 'revoked' })],
  ['disarmed reviewer', f => f.store.saveOperation({ ...f.store.operation('opencode-bridge:reviewer'), state: 'configured' })],
  ['child cancelled locally', f => f.change('child-run', { cancellationRequested: true })],
  ['child not completed', f => f.change('child-run', { settlement: { outcome: 'cancelled' } })],
  ['publication uncertain', f => f.change('child-run', { publication: { state: 'uncertain' } })],
  ['child native unsettled', f => f.change('child-run', { nativeState: 'claimed' })],
  ['review cancelled', f => f.change('child-run', { review: { ...f.run.review, status: 'cancelled' } })],
  ['review rejected', f => f.change('child-run', { review: { ...f.run.review, status: 'rejected' } })],
  ['review candidate changed', f => f.change('child-run', { review: { ...f.run.review, candidate: 'other' } })],
  ['disposition interaction changed', f => f.store.saveOperation({ ...f.store.operation('review-disposition:child-run'), interactionId: 'other' })],
  ['disposition grant changed', f => f.store.saveOperation({ ...f.store.operation('review-disposition:child-run'),
    coordinatorReviewGrant: { id: 'other', request: f.grant.request } })],
  ['human intent', f => f.store.saveOperation({ id: `harness-review:${digest(['company', 'child-interaction'])}`, runId: 'child-run', state: 'uncertain' })],
  ['coordinator decision', f => f.store.saveOperation({ id: `review-decision:${digest(['company', 'child'])}`,
    runId: 'parent-run', targetRunId: 'child-run', state: 'uncertain' })],
  ['completion intent', f => f.store.saveOperation({ id: 'completion:child-run', runId: 'child-run', state: 'uncertain' })],
  ['reviewer busy elsewhere', f => f.insert({ ...f.store.run('parent-run'), id: 'busy', nativeState: 'claimed',
    request: { ...f.store.run('parent-run').request, taskId: 'other' } })],
  ['parent final result', f => f.change('parent-run', { result: { candidate: 'final' } })],
  ['parent review pending', f => f.change('parent-run', { review: { status: 'pending' } })],
  ['parent cancelled locally', f => f.change('parent-run', { cancellationRequested: true })],
  ['parent not waiting', f => f.change('parent-run', { settlement: { outcome: 'completed' } })],
  ['parent waiting other child', f => f.change('parent-run', { dependency: { state: 'recorded', taskIds: ['other'] } })],
  ['parent wait uncertain', f => f.change('parent-run', { dependency: { state: 'uncertain', childId: 'child' } })],
  ['parent reviewer changed', f => f.change('parent-run', { conversationId: 'changed' })],
  ['newer parent turn', f => f.insert({ ...f.store.run('parent-run'), id: 'next-parent', dependency: null })],
  ['newer child candidate', f => f.insert({ ...f.run, id: 'next-child' })],
  ['newer child without result', f => f.insert({ ...f.run, id: 'next-child', result: null })],
  ['child backend cancelled', f => { f.issues.child.status = 'cancelled'; }],
  ['child not in review', f => { f.issues.child.status = 'in_progress'; }],
  ['child reparented', f => { f.issues.child.parentId = 'other'; }],
  ['child reassigned', f => { f.issues.child.assigneeAgentId = 'other'; }],
  ['parent reassigned', f => { f.issues.parent.assigneeAgentId = 'other'; }],
  ['parent reparented', f => { f.issues.parent.parentId = 'other'; }],
  ['parent terminal', f => { f.issues.parent.status = 'done'; }],
  ['parent backend cancelled', f => { f.issues.parent.status = 'cancelled'; }],
  ['parent final review', f => { f.issues.parent.status = 'in_review'; }],
  ['parent pending confirmation', f => { f.interactions.parent = [{ status: 'pending', kind: 'request_confirmation' }]; }],
  ['interaction cancelled', f => { f.interactions.child[0].status = 'cancelled'; }],
  ['interaction rejected', f => { f.interactions.child[0].status = 'rejected'; }],
  ['interaction accepted', f => { f.interactions.child[0].status = 'accepted'; }],
  ['interaction wrong ID', f => { f.interactions.child[0].id = 'other'; }],
  ['interaction wrong digest', f => { f.interactions.child[0].idempotencyKey = 'other'; }],
  ['interaction wrong target', f => { f.interactions.child[0].payload.target.revisionId = 'other'; }],
  ['interaction wrong resolver', f => { f.interactions.child[0].resolverPolicy = 'any_agent'; }],
  ['interaction wrong audience', f => { f.interactions.child[0].addresseeAgentId = 'other'; }],
  ['interaction human audience', f => { f.interactions.child[0].addresseeUserId = 'user'; }],
  ['interaction duplicated', f => { f.interactions.child.push({ ...f.interactions.child[0] }); }],
];

for (const [name, change] of ineligible) {
  test(`does not notify: ${name}`, async t => {
    const f = fixture(t);
    change(f);
    await reconcileCoordinatorNotices(f.store, f.api);
    await reconcileCoordinatorNotices(f.store, f.api);
    assert.equal(f.posts().length, 0);
  });
}

test('busy reviewer defers until settled without consuming the attempt', async t => {
  const f = fixture(t);
  const busy = f.insert({ ...f.store.run('parent-run'), id: 'busy', nativeState: 'claimed',
    request: { ...f.store.run('parent-run').request, taskId: 'other' } });
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.equal(f.notices()[0].reason, 'coordinator_busy');
  assert.equal(f.posts().length, 0);
  f.change(busy.id, { nativeState: 'settled' });
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.equal(f.notices()[0].state, 'recorded');
});

test('revalidates grant and current candidate after every pre-POST await', async t => {
  const baseline = fixture(t);
  await reconcileCoordinatorNotices(baseline.store, baseline.api);
  const readCount = baseline.calls.findIndex(call => call.method === 'POST');
  assert.ok(readCount > 0);
  for (let index = 0; index < readCount; index++) {
    for (const change of [f => f.store.saveOperation({ ...f.grant, state: 'revoked' }),
      f => f.insert({ ...f.run, id: 'newer' }),
      f => f.change('child-run', { result: { ...f.run.result, summary: 'changed' } }),
      f => f.change('child-run', { request: { ...f.run.request, agentId: 'changed' } }),
      f => f.change('child-run', { backendRunId: 'replacement' }),
      f => f.change('child-run', { review: { ...f.run.review, status: 'rejected' } }),
      f => f.change('parent-run', { nativeState: 'claimed' }),
      f => f.bridge({ ready: false }),
      f => f.bridge({ lastSeen: new Date(Date.now() - 10001).toISOString() }),
      f => f.observed({ availability: 'offline' }),
      f => f.observed({ updatedAt: new Date(Date.now() - 15001).toISOString() }),
      f => f.store.saveOperation({ id: 'herdr-worker:reviewer', runId: '', bindingId: 'reviewer', state: 'blocked' })]) {
      const f = fixture(t);
      let reads = 0;
      await reconcileCoordinatorNotices(f.store, async (...args) => {
        const result = await f.api(...args);
        if (args[0] === 'GET' && reads++ === index) change(f);
        return result;
      });
      assert.equal(f.posts().length, 0, `Mutation at read ${index} must prevent POST`);
    }
  }
});

test('fresh scope reads catch backend reparenting or reassignment during validation', async t => {
  for (const change of [f => { f.issues.child.parentId = 'other'; },
    f => { f.issues.parent.assigneeAgentId = 'other'; }]) {
    const f = fixture(t);
    await reconcileCoordinatorNotices(f.store, async (...args) => {
      const result = await f.api(...args);
      if (args[1] === '/api/issues/child/interactions') change(f);
      return result;
    });
    assert.equal(f.posts().length, 0);
  }
});

test('uncertain committed receipts reconcile after revocation, cancellation and missing disposition', async t => {
  const f = fixture(t);
  await reconcileCoordinatorNotices(f.store, async (...args) => {
    const result = await f.api(...args);
    if (args[0] === 'POST') throw new Error('lost');
    return result;
  });
  f.store.saveOperation({ ...f.grant, state: 'revoked' });
  f.issues.parent.status = 'cancelled';
  f.interactions.child[0].status = 'rejected';
  f.store.db.prepare('DELETE FROM operations WHERE id = ?').run('review-disposition:child-run');
  const start = f.calls.length;
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.deepEqual(f.calls.slice(start).map(({ method, path }) => [method, path]), [['GET', '/api/issues/parent/comments']]);
  assert.equal(f.notices()[0].state, 'recorded');
  assert.equal(f.posts().length, 1);
});

test('partial fanout notifies ready children without requiring siblings to complete or clearing blockers', async t => {
  const f = fixture(t);
  f.addChild('sibling');
  f.change('parent-run', { dependency: { state: 'recorded', taskIds: ['child', 'sibling', 'cancelled-child'] } });
  f.issues.sibling.status = 'in_progress';
  const blockers = structuredClone(f.issues.parent.blockedBy);
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.equal(f.posts().length, 1);
  assert.match(f.posts()[0].body.body, /"childTaskId":"child"/);
  f.issues.sibling.status = 'in_review';
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.equal(f.posts().length, 2);
  assert.equal(new Set(f.posts().map(call => call.body.clientRequestId)).size, 2);
  assert.deepEqual(f.issues.parent.blockedBy, blockers);
  assert.equal(f.issues.parent.status, 'blocked');
});

test('locks and durable intent prevent overlapping reconciliations from repeating a POST', async t => {
  for (const shared of [false, true]) {
    const f = fixture(t);
    const locks = new Map();
    await Promise.all(Array.from({ length: 4 }, () => reconcileCoordinatorNotices(f.store, f.api, shared ? locks : new Map())));
    assert.equal(f.posts().length, 1);
    assert.equal(f.notices()[0].state, 'recorded');
    assert.equal(locks.size, 0);
  }
  const f = fixture(t);
  const locks = new Map([['review:child-run', Promise.resolve()]]);
  await reconcileCoordinatorNotices(f.store, f.api, locks);
  assert.equal(f.calls.length, 0);
  assert.equal(locks.size, 1);
});

test('backend errors are code-safe blockers and read failures do not consume the POST attempt', async t => {
  const f = fixture(t);
  await reconcileCoordinatorNotices(f.store, async () => {
    throw Object.assign(new Error('credential=secret'), { code: 'credential=secret' });
  });
  assert.equal(f.notices()[0].state, 'blocked');
  assert.equal(f.notices()[0].reason, 'backend_unavailable');
  assert.equal(JSON.stringify(f.notices()).includes('secret'), false);
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.equal(f.notices()[0].state, 'recorded');
});

test('durable uncertainty and recorded receipts survive database close and reopen', async t => {
  for (const committed of [false, true]) {
    await t.test(`committed=${committed}`, async t => {
      const directory = mkdtempSync(join(tmpdir(), 'relay-coordinator-notices-'));
      const f = fixture(t, join(directory, 'state.sqlite'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      await reconcileCoordinatorNotices(f.store, async (...args) => {
        if (args[0] !== 'POST') return f.api(...args);
        if (committed) await f.api(...args);
        else f.calls.push({ method: args[0], path: args[1], body: args[2] });
        throw new Error('lost response');
      });
      f.reopen();
      await reconcileCoordinatorNotices(f.store, f.api);
      assert.equal(f.notices()[0].state, committed ? 'recorded' : 'uncertain');
      f.reopen();
      await reconcileCoordinatorNotices(f.store, f.api);
      assert.equal(f.posts().length, 1);
    });
  }
});

const unavailable = [
  ['not ready', f => f.bridge({ ready: false })],
  ['missing readiness', f => f.bridge({ ready: undefined })],
  ['truthy readiness', f => f.bridge({ ready: 'true' })],
  ['stale heartbeat', f => f.bridge({ lastSeen: new Date(Date.now() - 10001).toISOString() })],
  ['missing heartbeat', f => f.bridge({ lastSeen: undefined })],
  ['invalid heartbeat', f => f.bridge({ lastSeen: 'invalid' })],
  ['future heartbeat', f => f.bridge({ lastSeen: new Date(Date.now() + 60000).toISOString() })],
  ['missing epoch', f => f.bridge({ epoch: '' })],
  ['missing observation', f => f.store.db.prepare('DELETE FROM operations WHERE id = ?')
    .run(f.store.operation('opencode-bridge:reviewer').identity.observedId)],
  ['unrecorded observation', f => f.observed({ state: 'uncertain' })],
  ['offline observation', f => f.observed({ availability: 'offline' })],
  ['ambiguous observation', f => f.observed({ availability: 'unknown' })],
  ['observation error', f => f.observed({ error: 'private error' })],
  ['stale observation', f => f.observed({ updatedAt: new Date(Date.now() - 15001).toISOString() })],
  ['missing observation timestamp', f => f.observed({ updatedAt: undefined })],
  ['invalid observation timestamp', f => f.observed({ updatedAt: 'invalid' })],
  ['future observation', f => f.observed({ updatedAt: new Date(Date.now() + 60000).toISOString() })],
  ['wrong observed agent', f => f.observed({ agentId: 'other' })],
  ['wrong terminal', f => f.observed({ placement: { ...f.observed().placement, terminalId: 'other' } })],
  ['wrong directory', f => f.observed({ placement: { ...f.observed().placement, directory: '/other' } })],
  ...['companyId', 'harness', 'sessionKind', 'conversationId', 'machineId', 'session'].map(field =>
    [`wrong observation ${field}`, f => f.observed({ identity: { ...f.observed().identity, [field]: 'other' } })]),
  ...['directory', 'terminalId'].map(field => [`missing bridge ${field}`, f => f.bridge({
    identity: { ...f.store.operation('opencode-bridge:reviewer').identity, [field]: undefined },
  })]),
  ['inactive worker grant', f => f.store.saveOperation({ id: 'herdr-worker:reviewer', runId: '',
    bindingId: 'reviewer', state: 'blocked' })],
];

for (const [name, change] of unavailable) {
  test(`native admission defers ${name} without a dispatch intent`, async t => {
    const f = fixture(t);
    change(f);
    await reconcileCoordinatorNotices(f.store, f.api);
    await reconcileCoordinatorNotices(f.store, f.api);
    assert.equal(f.calls.length, 0);
    const [notice] = f.notices();
    assert.equal(notice.state, 'blocked');
    assert.equal(notice.reason, name === 'inactive worker grant' ? 'worker_grant_inactive' : 'coordinator_unavailable');
    assert.equal(notice.commentId, undefined);
    assert.equal(notice.continuationState, undefined);
  });
}

test('worker admission is required and validates the exact native placement', async t => {
  const f = fixture(t);
  const bridge = f.store.operation('opencode-bridge:reviewer');
  const grant = { id: 'herdr-worker:reviewer', runId: '', bindingId: 'reviewer', state: 'armed',
    target: { ...bridge.identity } };
  f.store.saveOperation({ ...grant, target: { ...grant.target, terminalId: 'other' } });
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.equal(f.notices()[0].reason, 'worker_grant_inactive');
  assert.equal(f.calls.length, 0);
  f.store.saveOperation(grant);
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.equal(f.notices()[0].state, 'recorded');
  assert.equal(f.notices()[0].continuationState, 'awaiting_admission');
});

test('offline coordinator may reconnect before first dispatch without consuming the notice', async t => {
  const f = fixture(t);
  f.bridge({ ready: false });
  f.observed({ availability: 'offline' });
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.equal(f.notices()[0].state, 'blocked');
  assert.equal(f.calls.length, 0);
  f.bridge({ ready: true, lastSeen: new Date().toISOString() });
  f.observed({ availability: 'present', updatedAt: new Date().toISOString() });
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.equal(f.posts().length, 1);
  assert.equal(f.notices()[0].state, 'recorded');
});

for (const committed of [false, true]) {
  test(`reconnection never replays uncertain comment, committed=${committed}`, async t => {
    const f = fixture(t);
    await reconcileCoordinatorNotices(f.store, async (...args) => {
      if (args[0] !== 'POST') return f.api(...args);
      if (committed) await f.api(...args);
      else f.calls.push({ method: args[0], path: args[1], body: args[2] });
      throw new Error('lost response');
    });
    f.bridge({ ready: false });
    f.observed({ availability: 'offline' });
    await reconcileCoordinatorNotices(f.store, f.api);
    f.bridge({ ready: true, lastSeen: new Date().toISOString() });
    f.observed({ availability: 'present', updatedAt: new Date().toISOString() });
    await reconcileCoordinatorNotices(f.store, f.api);
    assert.equal(f.posts().length, 1);
    assert.equal(f.notices()[0].state, committed ? 'recorded' : 'uncertain');
    if (committed) {
      assert.equal(f.notices()[0].continuationState, 'awaiting_admission');
      assert.equal(f.notices()[0].reason, 'continuation_unconfirmed');
    }
  });
}

test('recorded comment remains unconfirmed even with a later exact parent native invocation', async t => {
  const f = fixture(t);
  await reconcileCoordinatorNotices(f.store, f.api);
  const notice = f.notices()[0];
  const calls = f.calls.length;
  const run = f.store.run('parent-run');
  f.insert({ ...run, id: 'later-parent', request: { ...run.request, runId: 'later-backend' },
    createdAt: new Date(Date.parse(notice.updatedAt) + 1).toISOString(), nativeState: 'claimed',
    invocation: { messageId: 'native-message' } });
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.deepEqual(f.notices()[0], notice, 'No wake correlation can be inferred from run order or native invocation');
  f.bridge({ ready: false });
  f.observed({ availability: 'offline' });
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.deepEqual(f.notices()[0], notice, 'Offline status cannot erase an existing comment receipt');
  assert.equal(f.calls.length, calls);
});

test('existing comment receipts acquire explicit continuation uncertainty without backend mutations', async t => {
  const f = fixture(t);
  await reconcileCoordinatorNotices(f.store, f.api);
  const { continuationState, reason, ...receipt } = f.notices()[0];
  f.store.saveOperation(receipt);
  f.store.db.prepare('DELETE FROM operations WHERE id = ?').run('review-disposition:child-run');
  const calls = f.calls.length;
  await reconcileCoordinatorNotices(f.store, f.api);
  const updated = f.notices()[0];
  assert.equal(updated.state, 'recorded');
  assert.equal(updated.commentId, receipt.commentId);
  assert.equal(updated.continuationState, 'awaiting_admission');
  assert.equal(updated.reason, 'continuation_unconfirmed');
  await reconcileCoordinatorNotices(f.store, f.api);
  assert.deepEqual(f.notices()[0], updated);
  assert.equal(f.calls.length, calls);
});

for (const status of ['backlog', 'todo', 'in_progress', 'blocked']) {
  test(`nonterminal parent source status ${status} permits only the comment`, async t => {
    const f = fixture(t);
    f.issues.parent.status = status;
    const parent = structuredClone(f.issues.parent);
    await reconcileCoordinatorNotices(f.store, f.api);
    assert.equal(f.posts().length, 1);
    assert.deepEqual(f.issues.parent, parent);
    assert.equal(f.notices()[0].continuationState, 'awaiting_admission');
  });
}
