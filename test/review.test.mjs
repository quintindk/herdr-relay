import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { review, reviewAuthority } from '../src/review.mjs';
import { candidate } from '../src/candidate.mjs';
import { digest } from '../src/protocol.mjs';
import { requestReviewDisposition, reconcileCompletions } from '../src/disposition.mjs';

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  for (const id of ['origin', 'worker', 'reviewer']) store.register({ id, companyId: 'company', agentId: id,
    harness: 'opencode', instanceId: id, conversationId: id });
  const request = { bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'worker', runId: 'backend', taskId: 'task' };
  let run = store.dispatch(request);
  store.acknowledge(run.id);
  store.submit(run.id, { key: 'one', summary: 'Graph changed', candidate: 'sha256:one' });
  store.publication(run.id, { state: 'recorded', commentId: 'receipt' });
  run = store.settle(run.id, { outcome: 'completed', evidence: 'Observed' });
  const caller = store.acknowledge(store.dispatch({ ...request, bindingId: 'reviewer', agentId: 'reviewer',
    runId: 'reviewer-backend', taskId: 'parent' }).id);
  const origin = { bindingId: 'origin', conversationId: 'origin', sessionCreatedAt: 100 };
  store.saveOperation({ id: 'opencode-bridge:reviewer', runId: '', state: 'armed',
    identity: { bindingId: 'reviewer', conversationId: 'reviewer' }, sessionCreatedAt: 100 });
  store.saveOperation({ id: 'operator-task:parent', runId: '', state: 'recorded',
    request: { companyId: 'company', origin: { ...origin, sourceMessageId: 'human', sourceDigest: digest('Create parent') },
      body: { assigneeAgentId: 'reviewer' } }, receipt: { id: 'parent', companyId: 'company', assigneeAgentId: 'reviewer' } });
  const grant = store.saveOperation({ id: `coordinator-review-grant:${digest([origin, 'parent', 'key'])}`, runId: '', state: 'active',
    request: { origin, companyId: 'company', parentTaskId: 'parent', key: 'key', reviewerBindingId: 'reviewer',
      reviewerBindingRevision: 1, reviewerAgentId: 'reviewer', reviewerConversationId: 'reviewer', reviewerSessionCreatedAt: 100 } });
  const creation = store.saveOperation({ id: 'operator-task:child', runId: '', state: 'recorded',
    request: { companyId: 'company', relayReviewPolicy: 'coordinator', relayReviewGrantId: grant.id,
      body: { parentId: 'parent', assigneeAgentId: 'worker' } },
    receipt: { id: 'task', companyId: 'company', parentId: 'parent', assigneeAgentId: 'worker' } });
  const child = { ...creation.receipt, status: 'in_review' };
  const parent = { id: 'parent', companyId: 'company', assigneeAgentId: 'reviewer', status: 'in_progress' };
  const interactions = []; const writes = [];
  const api = async (actor, token, method, path, body) => {
    assert.equal(token, 'token');
    if (method === 'GET') return structuredClone(path.endsWith('/interactions') ? interactions : path.endsWith('/parent') ? parent : child);
    writes.push({ method, path, body });
    if (method === 'PATCH') { Object.assign(child, body); return structuredClone(child); }
    if (path.endsWith('/accept') || path.endsWith('/reject')) {
      interactions[0].status = path.endsWith('/accept') ? 'accepted' : 'rejected';
      Object.assign(interactions[0], { resolvedByAgentId: actor.request.agentId,
        resolvedByRunId: actor.backendRunId ?? actor.request.runId, resolvedByUserId: null });
      return structuredClone(interactions[0]);
    }
    const interaction = { id: 'review', status: 'pending', createdByAgentId: actor.request.agentId, createdByUserId: null, ...body };
    interactions.push(interaction);
    return structuredClone(interaction);
  };
  const input = { runId: run.id, candidate: 'sha256:one', reason: 'Verified the candidate and its test evidence.' };
  return { store, request, run, caller, grant, creation, child, parent, interactions, writes, api, input };
}

function humanAcceptance(f) {
  f.interactions[0].status = 'accepted';
  return f.store.saveOperation({ id: `harness-review:${digest(['company', 'review'])}`, runId: f.run.id, state: 'recorded',
    request: { companyId: 'company', taskId: 'task', candidate: f.run.result.candidate, interactionId: 'review',
      decision: 'accept', sourceMessageId: 'explicit-human-acceptance', sourceDigest: digest('Accept this candidate') },
    receipt: { interactionId: 'review', status: 'accepted' } });
}

test('candidate hashes working bytes, untracked files and executable bits without depending on commit', t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-candidate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', directory]);
  writeFileSync(join(directory, 'graph.json'), '{"nodes":[]}\n');
  const first = candidate(directory);
  execFileSync('git', ['-C', directory, 'add', 'graph.json']);
  assert.equal(candidate(directory).id, first.id);
  writeFileSync(join(directory, 'graph.json'), '{"nodes":["a"]}\n');
  assert.notEqual(candidate(directory).id, first.id);
  const second = candidate(directory).id;
  chmodSync(join(directory, 'graph.json'), 0o755);
  assert.notEqual(candidate(directory).id, second);
  symlinkSync('graph.json', join(directory, 'link'));
  assert.equal(candidate(directory).entries.find(entry => entry.path === 'link').mode, '120000');
});

test('review remains backend-owned and rejects stale candidates and self acceptance', async t => {
  const { store, request, run, caller, api, input, interactions } = fixture(t);
  await review(store, run, 'token', api, { ...input, action: 'request' });
  assert.equal(interactions[0].resolverPolicy, 'not_creator');
  assert.equal(interactions[0].addresseeAgentId, undefined);
  await assert.rejects(review(store, run, 'token', api, { ...input, action: 'accept' }), { code: 'self_review_forbidden' });
  await assert.rejects(review(store, run, 'token', api, { ...input, action: 'reject' }), { code: 'self_review_forbidden' });
  assert.equal((await review(store, caller, 'token', api, { ...input, action: 'accept' })).review.status, 'accepted');
  assert.equal(store.run(run.id).review.caller.id, caller.id);
  assert.equal(store.run(run.id).review.reason, input.reason);
  const eventCount = store.db.prepare('SELECT count(*) AS total FROM events').get().total;
  await review(store, caller, 'token', api, { ...input, action: 'inspect' });
  assert.equal(store.db.prepare('SELECT count(*) AS total FROM events').get().total, eventCount);
  const next = store.dispatch({ ...request, runId: 'new-backend' });
  store.acknowledge(next.id);
  store.submit(next.id, { key: 'two', summary: 'Corrected graph', candidate: 'sha256:two' });
  await assert.rejects(review(store, caller, 'token', api, { ...input, action: 'accept' }), { code: 'stale_candidate' });
});

test('lost acceptance response blocks a new candidate until the exact decision is reconciled', async t => {
  const { store, request, run, caller, api: backend, input } = fixture(t);
  let accepts = 0;
  const api = async (run, token, method, path, body) => {
    const response = await backend(run, token, method, path, body);
    if (path.endsWith('/accept')) {
      accepts++;
      throw new Error('Lost acceptance response');
    }
    return response;
  };
  await review(store, run, 'token', api, { ...input, action: 'request' });
  await assert.rejects(review(store, caller, 'token', api, { ...input, action: 'accept' }));
  assert.throws(() => store.dispatch({ ...request, runId: 'next' }), { code: 'review_decision_uncertain' });
  assert.equal((await review(store, caller, 'token', api, { ...input, action: 'accept' })).review.status, 'accepted');
  assert.equal(accepts, 1);
  assert.ok(store.dispatch({ ...request, runId: 'next' }).id);
});

test('human and agent-decides-human policies refuse all agent decisions and agent audiences', async t => {
  for (const policy of ['human', 'agent_decides']) {
    const f = fixture(t);
    f.store.saveOperation({ ...f.creation, request: { ...f.creation.request, relayReviewPolicy: policy } });
    if (policy === 'agent_decides') f.store.save({ ...f.run, result: { ...f.run.result,
      reviewDecision: { mode: 'human', reason: 'Needs human judgement' } } }, 'test.policy');
    for (const action of ['accept', 'reject']) await assert.rejects(review(f.store, f.caller, 'token', f.api,
      { ...f.input, action }), { code: 'human_review_required' });
    await assert.rejects(review(f.store, f.caller, 'token', f.api, { ...f.input, action: 'request', reviewerAgentId: 'reviewer' }),
      { code: 'human_review_required' });
    await review(f.store, f.store.run(f.run.id), 'token', f.api, { ...f.input, action: 'request' });
    assert.equal(f.interactions[0].resolverPolicy, 'human_only');
    assert.equal(f.writes.length, 1);
  }
});

test('coordinator accept and reject require bounded review evidence', async t => {
  for (const action of ['accept', 'reject']) {
    const f = fixture(t);
    await review(f.store, f.run, 'token', f.api, { ...f.input, action: 'request' });
    for (const reason of [undefined, '', ' ', 'x'.repeat(4001)]) await assert.rejects(review(f.store, f.caller, 'token', f.api,
      { ...f.input, action, reason }), { code: 'invalid_request' });
    const receipt = await review(f.store, f.caller, 'token', f.api, { ...f.input, action });
    assert.equal(receipt.review.status, action === 'accept' ? 'accepted' : 'rejected');
    assert.equal(f.writes[1].body.reason, f.input.reason);
    const intent = f.store.operation(`review-decision:${digest(['company', 'task'])}`);
    assert.equal(intent.confirmed, true);
    assert.equal(intent.caller.id, f.caller.id);
    await review(f.store, f.caller, 'token', f.api, { ...f.input, action });
    assert.equal(f.writes.length, 2);
  }
});

for (const [name, change] of [
  ['revoked grant', f => f.store.saveOperation({ ...f.grant, state: 'revoked' })],
  ['different parent', f => { f.caller.request.taskId = 'other'; }],
  ['different binding revision', f => { f.caller.request.bindingRevision = 2; }],
  ['different conversation', f => { f.caller.conversationId = 'other'; }],
  ['different company', f => { f.caller.request.companyId = 'other'; }],
  ['inactive caller', f => f.store.save({ ...f.caller, nativeState: 'settled' }, 'test.settled')],
  ['cancelled caller', f => f.store.save({ ...f.caller, cancellationRequested: true }, 'test.cancel')],
  ['unacknowledged caller', f => f.store.save({ ...f.caller, deliveryState: 'pending' }, 'test.pending')],
  ['changed native reviewer', f => f.store.saveOperation({ ...f.store.operation('opencode-bridge:reviewer'), sessionCreatedAt: 101 })],
  ['wrong backend child parent', f => { f.child.parentId = 'other'; }],
  ['wrong backend child assignee', f => { f.child.assigneeAgentId = 'other'; }],
  ['wrong backend parent assignee', f => { f.parent.assigneeAgentId = 'worker'; }],
  ['terminal backend parent', f => { f.parent.status = 'done'; }],
  ['non-human parent final policy', f => {
    const parent = f.store.operation('operator-task:parent');
    f.store.saveOperation({ ...parent, request: { ...parent.request, relayReviewPolicy: 'none' } });
  }],
  ['arbitrary backend audience', f => { f.interactions[0].addresseeAgentId = 'other'; }],
  ['human backend audience', f => { f.interactions[0].addresseeUserId = 'board'; }],
  ['permissive backend resolver', f => { f.interactions[0].resolverPolicy = 'anyone'; }],
]) test(`coordinator refuses ${name} without decision writes`, async t => {
  const f = fixture(t);
  await review(f.store, f.run, 'token', f.api, { ...f.input, action: 'request' });
  change(f);
  await assert.rejects(review(f.store, f.caller, 'token', f.api, { ...f.input, action: 'accept' }));
  assert.equal(f.writes.length, 1);
});

test('coordinator authority is rechecked after every backend await before any decision write', async t => {
  for (const boundary of ['/interactions', '/task', '/parent']) {
    for (const change of [f => f.store.saveOperation({ ...f.grant, state: 'revoked' }),
      f => f.store.save({ ...f.caller, cancellationRequested: true }, 'test.cancel'),
      f => f.store.save({ ...f.run, result: { ...f.run.result, summary: 'Changed' } }, 'test.result')]) {
      const f = fixture(t);
      await review(f.store, f.run, 'token', f.api, { ...f.input, action: 'request' });
      const api = async (...args) => {
        const response = await f.api(...args);
        if (args[2] === 'GET' && args[3].endsWith(boundary)) change(f);
        return response;
      };
      await assert.rejects(review(f.store, f.caller, 'token', api, { ...f.input, action: 'accept' }));
      assert.equal(f.writes.length, 1, boundary);
    }
  }
});

test('unknown decision never reposts, even concurrently, and inspection cannot certify it', async t => {
  const f = fixture(t);
  await review(f.store, f.run, 'token', f.api, { ...f.input, action: 'request' });
  let attempts = 0;
  const api = async (...args) => {
    if (args[3].endsWith('/accept')) { attempts++; throw new Error('Unknown outcome'); }
    return f.api(...args);
  };
  const decide = () => review(f.store, f.caller, 'token', api, { ...f.input, action: 'accept' });
  const results = await Promise.allSettled([decide(), decide()]);
  assert.ok(results.every(result => result.status === 'rejected'));
  await assert.rejects(decide(), { code: 'review_decision_uncertain' });
  assert.equal(attempts, 1);
  f.interactions[0].status = 'accepted';
  await assert.rejects(review(f.store, f.caller, 'token', api, { ...f.input, action: 'inspect' }), { code: 'review_decision_uncertain' });
  assert.equal(f.store.operation(`review-decision:${digest(['company', 'task'])}`).state, 'uncertain');
});

test('human review intents fence coordinator decisions across the whole task', async t => {
  for (const interactionId of ['review', 'older-review']) {
    const f = fixture(t);
    await review(f.store, f.run, 'token', f.api, { ...f.input, action: 'request' });
    f.store.saveOperation({ id: `harness-review:${digest(['company', interactionId])}`, runId: f.run.id,
      state: 'uncertain', request: { interactionId } });
    await assert.rejects(review(f.store, f.caller, 'token', f.api, { ...f.input, action: 'accept' }));
    assert.equal(f.writes.length, 1);
  }
});

test('coordinator disposition is unaddressed and only verified decisions survive grant revocation', async t => {
  for (const outcome of ['verified', 'external', 'uncertain']) {
    const f = fixture(t);
    f.child.responsibleUserId = 'board';
    await requestReviewDisposition(f.store, f.run.id, 'token', f.api);
    const disposition = f.store.operation(`review-disposition:${f.run.id}`);
    assert.equal(disposition.coordinatorReviewGrant.id, f.grant.id);
    assert.equal(f.interactions[0].addresseeAgentId, undefined);
    assert.equal(f.interactions[0].addresseeUserId, undefined);
    if (outcome === 'verified') await review(f.store, f.caller, 'token', f.api, { ...f.input, action: 'accept' });
    if (outcome === 'uncertain') await assert.rejects(review(f.store, f.caller, 'token', async (...args) => {
      const response = await f.api(...args);
      if (args[3].endsWith('/accept')) throw new Error('Lost response');
      return response;
    }, { ...f.input, action: 'accept' }));
    f.interactions[0].status = 'accepted';
    f.store.saveOperation({ ...f.grant, state: 'revoked' });
    const writes = [];
    await reconcileCompletions(f.store, async (method, path, body) => {
      if (path.includes('/heartbeat-runs/')) return { id: 'backend', companyId: 'company', agentId: 'worker', status: 'succeeded' };
      if (method === 'PATCH') { writes.push(body); Object.assign(f.child, body); }
      return f.api(f.run, 'token', 'GET', path);
    });
    assert.equal(writes.length, outcome === 'verified' ? 1 : 0, outcome);
  }
});

test('request and decision reject revocation at send boundaries, without privileged fallback', async t => {
  for (const action of ['request', 'accept']) {
    const f = fixture(t);
    if (action === 'accept') await review(f.store, f.run, 'token', f.api, { ...f.input, action: 'request' });
    const before = f.writes.length;
    await assert.rejects(review(f.store, action === 'request' ? f.run : f.caller, 'token', async (...args) => {
      const response = await f.api(...args);
      if (args[3].endsWith('/parent')) f.store.saveOperation({ ...f.grant, state: 'revoked' });
      return response;
    }, { ...f.input, action }));
    assert.equal(f.writes.length, before);
  }
  const f = fixture(t);
  await review(f.store, f.run, 'token', f.api, { ...f.input, action: 'request' });
  let attempts = 0;
  await assert.rejects(review(f.store, f.caller, 'token', async (...args) => {
    if (args[2] === 'POST') { attempts++; assert.equal(args[1], 'token'); throw new Error('Paperclip governance denied agent'); }
    return f.api(...args);
  }, { ...f.input, action: 'accept' }), /governance denied/);
  assert.equal(attempts, 1);
});

test('post-send revocation and changed backend evidence leave the decision unverified', async t => {
  for (const change of [f => f.store.saveOperation({ ...f.grant, state: 'revoked' }),
    f => { f.interactions[0].payload.target.revisionId = 'other'; },
    f => { f.interactions[0].addresseeAgentId = 'other'; },
    f => { f.interactions[0].kind = 'question'; }]) {
    const f = fixture(t);
    await review(f.store, f.run, 'token', f.api, { ...f.input, action: 'request' });
    await assert.rejects(review(f.store, f.caller, 'token', async (...args) => {
      const response = await f.api(...args);
      if (args[3].endsWith('/accept')) change(f);
      return response;
    }, { ...f.input, action: 'accept' }));
    const decision = f.store.operation(`review-decision:${digest(['company', 'task'])}`);
    assert.equal(decision.state, 'uncertain');
    assert.equal(decision.confirmed, undefined);
  }
});

test('optional issue context never substitutes for authoritative backend scope', async t => {
  const f = fixture(t);
  await review(f.store, f.run, 'token', f.api, { ...f.input, action: 'request' });
  f.child.parentId = 'foreign-parent';
  await assert.rejects(review(f.store, f.caller, 'token', f.api, { ...f.input, action: 'accept',
    issue: { ...f.child, parentId: 'parent' }, parent: f.parent }), { code: 'review_scope_changed' });
  assert.equal(f.writes.length, 1);
});

test('exact human override can be inspected and completed independently of coordinator grant activity', async t => {
  for (const revoke of ['never', 'before-human', 'after-human', 'during-inspect', 'during-completion']) {
    for (const addressed of [false, true]) {
      const f = fixture(t);
      await requestReviewDisposition(f.store, f.run.id, 'token', f.api);
      if (addressed) f.interactions[0].addresseeAgentId = 'reviewer';
      const revokeGrant = () => f.store.saveOperation({ ...f.grant, state: 'revoked' });
      if (revoke === 'before-human') revokeGrant();
      humanAcceptance(f);
      if (revoke === 'after-human') revokeGrant();
      const authority = reviewAuthority(f.store, f.run);
      assert.equal(authority.recorded, false, 'Human evidence must not become coordinator evidence');
      assert.equal(authority.humanRecorded, true);
      const observed = await review(f.store, f.run, 'token', async (...args) => {
        const response = await f.api(...args);
        if (revoke === 'during-inspect') revokeGrant();
        return response;
      }, { ...f.input, action: 'inspect' });
      assert.equal(observed.review.status, 'accepted');
      for (const status of ['accepted', 'pending']) {
        f.interactions[0].status = status;
        for (const action of ['accept', 'reject']) await assert.rejects(review(f.store, f.caller, 'token', f.api, { ...f.input, action }));
      }
      f.interactions[0].status = 'accepted';
      assert.equal(f.writes.length, 1, 'Human proof never authorises an agent POST');
      assert.equal(f.store.operation(`review-decision:${digest(['company', 'task'])}`), null);
      const writes = [];
      const api = async (method, path, body) => {
        if (path.includes('/heartbeat-runs/')) {
          if (revoke === 'during-completion') revokeGrant();
          return { id: 'backend', companyId: 'company', agentId: 'worker', status: 'succeeded' };
        }
        if (method === 'PATCH') { writes.push(body); Object.assign(f.child, body); }
        return f.api(f.run, 'token', 'GET', path);
      };
      await reconcileCompletions(f.store, api);
      await reconcileCompletions(f.store, api);
      assert.deepEqual(writes, [{ status: 'done' }], `${revoke}, addressed=${addressed}`);
      assert.equal(f.store.operation(`completion:${f.run.id}`).state, 'recorded');
    }
  }
});

test('bogus human override proof cannot authorise coordinator inspection or completion', async t => {
  const changes = [
    p => { p.state = 'uncertain'; }, p => { p.runId = 'other'; },
    p => { p.request.companyId = 'other'; }, p => { delete p.request.companyId; },
    p => { p.request.taskId = 'other'; }, p => { delete p.request.taskId; },
    p => { p.request.candidate = 'other'; }, p => { p.request.interactionId = 'other'; },
    p => { p.request.decision = 'reject'; }, p => { p.receipt.status = 'pending'; },
    p => { p.receipt.interactionId = 'other'; }, p => { delete p.receipt; },
    ...['sourceMessageId', 'sourceDigest'].flatMap(field => [undefined, '', ' ', 42].map(value => p => { p.request[field] = value; })),
  ];
  for (const revoked of [false, true]) {
    for (const change of changes) {
      const f = fixture(t);
      await requestReviewDisposition(f.store, f.run.id, 'token', f.api);
      const proof = humanAcceptance(f);
      change(proof);
      f.store.saveOperation(proof);
      if (revoked) f.store.saveOperation({ ...f.grant, state: 'revoked' });
      await assert.rejects(review(f.store, f.run, 'token', f.api, { ...f.input, action: 'inspect' }));
      await reconcileCompletions(f.store, async (method, path) => {
        assert.equal(method, 'GET');
        return f.api(f.run, 'token', method, path);
      });
      assert.equal(f.store.operation(`completion:${f.run.id}`), null);
      assert.equal(f.writes.length, 1);
    }
  }
});

test('human overrides retain exact interaction audience and target checks', async t => {
  for (const change of [i => { i.addresseeAgentId = 'other'; }, i => { i.addresseeUserId = 'board'; },
    i => { i.resolverPolicy = 'anyone'; }, i => { i.id = 'other'; }, i => { i.kind = 'question'; },
    i => { i.payload.target.revisionId = 'other'; }, i => { i.payload.target.label = 'other'; }]) {
    const f = fixture(t);
    await requestReviewDisposition(f.store, f.run.id, 'token', f.api);
    humanAcceptance(f);
    f.store.saveOperation({ ...f.grant, state: 'revoked' });
    change(f.interactions[0]);
    await assert.rejects(review(f.store, f.run, 'token', f.api, { ...f.input, action: 'inspect' }));
    await reconcileCompletions(f.store, async (method, path) => {
      assert.equal(method, 'GET');
      return f.api(f.run, 'token', method, path);
    });
    assert.equal(f.store.operation(`completion:${f.run.id}`), null);
  }
});

test('human override proof is rechecked at completion read boundaries', async t => {
  for (const boundary of ['/interactions', '/task', '/heartbeat-runs/backend']) {
    const f = fixture(t);
    await requestReviewDisposition(f.store, f.run.id, 'token', f.api);
    const proof = humanAcceptance(f);
    await reconcileCompletions(f.store, async (method, path) => {
      assert.equal(method, 'GET');
      if (path.endsWith(boundary)) f.store.saveOperation({ ...proof, state: 'uncertain' });
      return path.includes('/heartbeat-runs/') ? { id: 'backend', companyId: 'company', agentId: 'worker', status: 'succeeded' } :
        f.api(f.run, 'token', method, path);
    });
    assert.equal(f.store.operation(`completion:${f.run.id}`), null, boundary);
  }
});

test('disposition preserves the current grant and concurrent local fields after review returns', async t => {
  const f = fixture(t);
  const id = `review-disposition:${f.run.id}`;
  f.store.saveOperation({ id, runId: f.run.id, candidate: f.run.result.candidate, state: 'waiting', oldField: 'keep' });
  await requestReviewDisposition(f.store, f.run.id, 'token', async (...args) => {
    const response = await f.api(...args);
    if (args[2] === 'POST') f.store.saveOperation({ ...f.store.operation(id), concurrentField: 'preserve' });
    return response;
  });
  const disposition = f.store.operation(id);
  assert.deepEqual(disposition.coordinatorReviewGrant, { id: f.grant.id, request: f.grant.request });
  assert.equal(disposition.concurrentField, 'preserve');
  assert.equal(disposition.oldField, 'keep');
  assert.equal(disposition.interactionId, 'review');
});

test('coordinator creation belongs only to the exact candidate author run', async t => {
  const f = fixture(t);
  for (const caller of [f.caller, { ...f.run, id: 'other' }, { ...f.run, backendRunId: 'other' },
    { ...f.run, conversationId: 'other' }, ...['agentId', 'bindingId', 'bindingRevision', 'runId'].map(field =>
      ({ ...f.run, request: { ...f.run.request, [field]: 'other' } }))]) {
    await assert.rejects(review(f.store, caller, 'token', f.api, { ...f.input, action: 'request' }), { code: 'review_author_mismatch' });
  }
  assert.equal(f.writes.length, 0);
  await requestReviewDisposition(f.store, f.run.id, 'token', f.api);
  assert.equal(f.interactions[0].sourceRunId, 'backend');
  assert.equal(f.interactions[0].createdByAgentId, 'worker');
});

test('coordinator interactions require exact candidate author and source run on all reads', async t => {
  for (const change of [i => { i.sourceRunId = 'reviewer-backend'; }, i => { delete i.sourceRunId; },
    i => { i.createdByAgentId = 'reviewer'; }, i => { delete i.createdByAgentId; }, i => { i.createdByUserId = 'board'; }]) {
    const f = fixture(t);
    await requestReviewDisposition(f.store, f.run.id, 'token', f.api);
    change(f.interactions[0]);
    for (const action of ['request', 'inspect', 'accept']) await assert.rejects(review(f.store,
      action === 'accept' ? f.caller : f.run, 'token', f.api, { ...f.input, action }), { code: 'review_author_mismatch' });
    assert.equal(f.writes.length, 1);
  }
});

test('uncertain coordinator decisions cannot adopt another resolver agent, run or user', async t => {
  for (const action of ['accept', 'reject']) {
    for (const change of [i => { i.resolvedByAgentId = 'other'; }, i => { delete i.resolvedByAgentId; },
      i => { i.resolvedByRunId = 'other'; }, i => { delete i.resolvedByRunId; },
      i => { i.resolvedByUserId = 'board'; }]) {
      for (const lost of [false, true]) {
        const f = fixture(t);
        await requestReviewDisposition(f.store, f.run.id, 'token', f.api);
        let posts = 0;
        const api = async (...args) => {
          const response = await f.api(...args);
          if (args[2] === 'POST') {
            posts++;
            change(f.interactions[0]);
            if (lost) throw new Error('Lost decision reply');
          }
          return response;
        };
        await assert.rejects(review(f.store, f.caller, 'token', api, { ...f.input, action }));
        await assert.rejects(review(f.store, f.caller, 'token', api, { ...f.input, action }), { code: 'review_resolver_mismatch' });
        assert.equal(posts, 1);
        const decision = f.store.operation(`review-decision:${digest(['company', 'task'])}`);
        assert.equal(decision.state, 'uncertain');
        assert.equal(decision.confirmed, undefined);
        await assert.rejects(review(f.store, f.run, 'token', f.api, { ...f.input, action: 'inspect' }), { code: 'review_decision_uncertain' });
      }
    }
  }
});

test('recorded coordinator acceptance is rechecked against backend resolver attribution before completion', async t => {
  for (const field of ['resolvedByAgentId', 'resolvedByRunId', 'resolvedByUserId']) {
    const f = fixture(t);
    await requestReviewDisposition(f.store, f.run.id, 'token', f.api);
    await review(f.store, f.caller, 'token', f.api, { ...f.input, action: 'accept' });
    f.interactions[0][field] = 'other';
    f.store.saveOperation({ ...f.grant, state: 'revoked' });
    await reconcileCompletions(f.store, async (method, path) => {
      assert.equal(method, 'GET');
      return f.api(f.run, 'token', method, path);
    });
    assert.equal(f.store.operation(`completion:${f.run.id}`), null);
  }
});

test('revocation before disposition recovers one human-only review without mutating coordinator policy or grant', async t => {
  for (const lost of [false, true]) {
    const f = fixture(t);
    f.child.status = 'in_progress';
    const revoked = f.store.saveOperation({ ...f.grant, state: 'revoked' });
    assert.equal(reviewAuthority(f.store, f.run).humanOnlyRecovery, true);
    const api = async (...args) => {
      const response = await f.api(...args);
      if (lost && args[2] === 'POST') throw new Error('Lost committed request');
      return response;
    };
    if (lost) await assert.rejects(requestReviewDisposition(f.store, f.run.id, 'token', api), /Lost committed/);
    else await requestReviewDisposition(f.store, f.run.id, 'token', api);
    await requestReviewDisposition(f.store, f.run.id, 'token', api);
    const disposition = f.store.operation(`review-disposition:${f.run.id}`);
    assert.equal(disposition.policy, 'coordinator');
    assert.equal(disposition.reviewerMode, 'human_recovery');
    assert.deepEqual(disposition.coordinatorReviewGrant, { id: revoked.id, request: revoked.request });
    assert.deepEqual(f.store.operation(revoked.id), revoked);
    assert.equal(f.store.operation(f.creation.id).request.relayReviewPolicy, 'coordinator');
    assert.equal(f.interactions[0].resolverPolicy, 'human_only');
    assert.equal(f.interactions[0].createdByAgentId, 'worker');
    assert.equal(f.interactions[0].sourceRunId, 'backend');
    assert.equal(f.interactions[0].addresseeAgentId, undefined);
    for (const action of ['accept', 'reject']) await assert.rejects(review(f.store, f.caller, 'token', f.api,
      { ...f.input, action }), { code: 'human_review_required' });
    await review(f.store, f.run, 'token', f.api, { ...f.input, action: 'inspect' });
    f.interactions[0].status = 'accepted';
    await assert.rejects(review(f.store, f.run, 'token', f.api, { ...f.input, action: 'inspect' }), { code: 'review_decision_uncertain' });
    humanAcceptance(f);
    const writes = [];
    const operatorApi = async (method, path, body) => {
      if (path.includes('/heartbeat-runs/')) return { id: 'backend', companyId: 'company', agentId: 'worker', status: 'succeeded' };
      if (method === 'PATCH') { writes.push(body); Object.assign(f.child, body); }
      return f.api(f.run, 'token', 'GET', path);
    };
    await reconcileCompletions(f.store, operatorApi);
    await reconcileCompletions(f.store, operatorApi);
    assert.deepEqual(writes, [{ status: 'done' }]);
    assert.equal(f.writes.filter(call => call.method === 'POST').length, 1);
    assert.equal(f.writes.filter(call => call.method === 'PATCH').length, 1);
    assert.deepEqual(f.store.operation(revoked.id), revoked);
  }
});

test('human recovery never substitutes for missing, malformed or conflicting coordinator scope', async t => {
  for (const change of [
    f => f.store.db.prepare('DELETE FROM operations WHERE id = ?').run(f.grant.id),
    f => f.store.saveOperation({ ...f.grant, state: 'unknown' }),
    f => f.store.saveOperation({ ...f.grant, state: 'revoked', request: { ...f.grant.request, companyId: 'other' } }),
    f => f.store.saveOperation({ ...f.grant, state: 'revoked', request: { ...f.grant.request, origin: { ...f.grant.request.origin, sessionCreatedAt: 101 } } }),
    f => f.store.saveOperation({ ...f.creation, receipt: { ...f.creation.receipt, parentId: 'other' } }),
    f => f.store.saveOperation({ ...f.creation, request: { ...f.creation.request, body: { ...f.creation.request.body, assigneeAgentId: 'other' } } }),
    f => f.store.saveOperation({ ...f.creation, id: 'operator-task:conflict', request: { ...f.creation.request, relayReviewGrantId: 'missing' } }),
    f => { const parent = f.store.operation('operator-task:parent');
      f.store.saveOperation({ ...parent, request: { ...parent.request, origin: { ...parent.request.origin, sourceDigest: '' } } }); },
    f => { f.child.parentId = 'other'; }, f => { f.parent.assigneeAgentId = 'other'; },
  ]) {
    const f = fixture(t);
    f.store.saveOperation({ ...f.grant, state: 'revoked' });
    change(f);
    await assert.rejects(requestReviewDisposition(f.store, f.run.id, 'token', f.api));
    assert.equal(f.writes.length, 0);
  }
});

test('installed effective resolver policy is authoritative over a compatibility alias', async t => {
  const f = fixture(t);
  await requestReviewDisposition(f.store, f.run.id, 'token', f.api);
  f.interactions[0].effectiveResolverPolicy = 'anyone';
  await assert.rejects(review(f.store, f.caller, 'token', f.api, { ...f.input, action: 'accept' }), { code: 'review_scope_changed' });
  f.interactions[0].effectiveResolverPolicy = 'not_creator';
  delete f.interactions[0].resolverPolicy;
  assert.equal((await review(f.store, f.caller, 'token', f.api, { ...f.input, action: 'accept' })).review.status, 'accepted');
});

test('human recovery authority and author identity are rechecked before sending the request', async t => {
  for (const change of [f => f.store.saveOperation({ ...f.grant, state: 'active' }),
    f => f.store.save({ ...f.run, backendRunId: 'replacement' }, 'test.recovered'),
    f => f.store.saveOperation({ ...f.creation, request: { ...f.creation.request, relayReviewGrantId: 'missing' } })]) {
    const f = fixture(t);
    f.store.saveOperation({ ...f.grant, state: 'revoked' });
    await assert.rejects(requestReviewDisposition(f.store, f.run.id, 'token', async (...args) => {
      const response = await f.api(...args);
      if (args[3].endsWith('/parent')) change(f);
      return response;
    }));
    assert.equal(f.writes.length, 0);
  }
});
