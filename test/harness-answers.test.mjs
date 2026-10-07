import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { harnessQuestion, parseRelayAnswer, harnessReview } from '../src/harness-answers.mjs';
import { digest } from '../src/protocol.mjs';
import { reconcileCompletions } from '../src/disposition.mjs';

function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'i', conversationId: 'c' });
  let run = store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  store.acknowledge(run.id); store.ask(run.id, { key: 'city', question: 'Which city?' });
  store.questionReceipt(run.id, { state: 'recorded', interactionId: 'question' });
  run = store.settle(run.id, { outcome: 'waiting', evidence: 'Terminal question turn' });
  const bridge = { state: 'armed', identity: { bindingId: 'worker', conversationId: 'c' } };
  const item = { id: 'question', ...run.waiting.request, status: 'pending' };
  const issue = { id: 'task', identifier: 'DEF-test', companyId: 'company', status: 'in_progress', assigneeAgentId: 'agent' };
  const writes = [];
  const api = async (method, path, body) => {
    if (method === 'POST') { writes.push(body); item.status = 'answered'; item.result = body; return item; }
    return path.endsWith('/interactions') ? [item] : issue;
  };
  const input = { source: { id: 'human-message', text: 'Relay answer question: Johannesburg', createdAt: Date.now() + 1 } };
  return { store, run, bridge, item, issue, writes, api, input };
}

test('only explicit answer syntax qualifies, not hypothetical discussion', () => {
  assert.deepEqual(parseRelayAnswer('Relay answer abc-123: Johannesburg'), { interactionId: 'abc-123', answer: 'Johannesburg' });
  for (const value of ['Johannesburg', 'What if I answer here?', 'Please Relay answer abc: London', 'Relay answer abc: ']) assert.throws(() => parseRelayAnswer(value));
});

test('settled clarification can be answered once with source attribution and continuation owned by Paperclip', async t => {
  const f = fixture(t);
  const pending = await harnessQuestion(f.store, f.bridge, 'questions', {}, f.api);
  assert.equal(pending.questions[0].interactionId, 'question');
  const receipt = await harnessQuestion(f.store, f.bridge, 'answer', f.input, f.api);
  assert.equal(receipt.answered, true);
  assert.match(f.writes[0].summaryMarkdown, /source message human-message/);
  assert.match(f.writes[0].summaryMarkdown, /not a separate authenticated/);
  assert.deepEqual(await harnessQuestion(f.store, f.bridge, 'answer', f.input, f.api), receipt);
  assert.equal(f.writes.length, 1);
  assert.equal(f.store.run(f.run.id).settlement.outcome, 'waiting');
  await assert.rejects(harnessQuestion(f.store, f.bridge, 'answer', { source: { ...f.input.source, text: 'Relay answer question: London' } }, f.api), { code: 'answer_conflict' });
});

test('dashboard answers win and lost replies reconcile without reposting', async t => {
  for (const scenario of ['dashboard-same', 'dashboard-other', 'lost-committed', 'lost-uncommitted']) {
    const f = fixture(t);
    if (scenario.startsWith('dashboard')) {
      f.item.status = 'answered'; f.item.result = { answers: [{ questionId: 'answer', optionIds: [], otherText: scenario === 'dashboard-same' ? 'Johannesburg' : 'London' }] };
    }
    let posts = 0;
    const api = async (...args) => {
      if (args[0] === 'POST') {
        posts++;
        if (scenario === 'lost-uncommitted') throw new Error('lost');
        const result = await f.api(...args);
        if (scenario === 'lost-committed') throw new Error('lost');
        return result;
      }
      return f.api(...args);
    };
    if (scenario === 'dashboard-same') assert.equal((await harnessQuestion(f.store, f.bridge, 'answer', f.input, api)).existing, true);
    else await assert.rejects(harnessQuestion(f.store, f.bridge, 'answer', f.input, api));
    if (scenario === 'lost-committed') assert.equal((await harnessQuestion(f.store, f.bridge, 'answer', f.input, api)).answered, true);
    if (scenario === 'lost-uncommitted') await assert.rejects(harnessQuestion(f.store, f.bridge, 'answer', f.input, api), { code: 'answer_uncertain' });
    assert.equal(posts, scenario.startsWith('lost') ? 1 : 0);
  }
});

test('foreign questions, terminal tasks and active work cannot be answered through the waiting bridge', async t => {
  for (const variant of ['foreign', 'done', 'active', 'disarmed', 'old-source']) {
    const f = fixture(t);
    if (variant === 'foreign') f.input.source.text = 'Relay answer other: London';
    if (variant === 'done') f.issue.status = 'done';
    if (variant === 'active') f.store.dispatch({ ...f.run.request, runId: 'next' });
    if (variant === 'disarmed') f.bridge.state = 'configured';
    if (variant === 'old-source') f.input.source.createdAt = 0;
    await assert.rejects(harnessQuestion(f.store, f.bridge, 'answer', f.input, f.api));
    assert.equal(f.writes.length, 0);
  }
});

test('natural-language answer keeps native source attribution without demanding a command', async t => {
  const f = fixture(t);
  f.input.source.text = 'Then use South African Standard Time please';
  const result = await harnessQuestion(f.store, f.bridge, 'answer', { ...f.input, interactionId: 'question', answer: 'Africa/Johannesburg' }, f.api);
  assert.equal(result.answered, true);
  assert.equal(f.writes[0].answers[0].otherText, 'Africa/Johannesburg');
});

test('harness review decisions require the exact latest candidate and never replay uncertain writes', async t => {
  for (const scenario of ['accept', 'reject', 'conflict', 'lost', 'uncommitted']) {
    const store = new Store(':memory:'); t.after(() => store.close());
    store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'i', conversationId: 'c' });
    let run = store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
    store.acknowledge(run.id); store.submit(run.id, { key: 'one', candidate: 'candidate', summary: 'Answer' });
    store.publication(run.id, { state: 'recorded' }); store.settle(run.id, { outcome: 'completed', evidence: 'Finished' });
    run = store.recordReview(run.id, { interactionId: 'review', candidate: 'candidate', status: 'pending' });
    const item = { id: 'review', kind: 'request_confirmation', resolverPolicy: 'human_only', status: scenario === 'conflict' ? 'rejected' : 'pending',
      createdAt: new Date(Date.now() - 1000).toISOString(), idempotencyKey: `relay-review:${run.id}:${digest(run.result)}`,
      payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'candidate', label: run.id } } };
    const bridge = store.saveOperation({ id: 'opencode-bridge:worker', runId: '', state: 'armed',
      sessionCreatedAt: 123, epoch: 'epoch', identity: { bindingId: 'worker', conversationId: 'c' } });
    const input = { interactionId: 'review', decision: scenario === 'reject' ? 'reject' : 'accept', reason: 'Needs changes',
      source: { id: 'human', text: 'accepted', createdAt: Date.now() } };
    let posts = 0;
    const api = async (method, path) => {
      if (method === 'POST') {
        posts++;
        if (scenario === 'uncommitted') throw new Error('lost');
        item.status = input.decision === 'accept' ? 'accepted' : 'rejected';
        item.result = { version: 1, outcome: item.status, reason: input.decision === 'reject' ? input.reason : null };
        item.resolvedByUserId = 'board-user';
        if (scenario === 'lost') throw new Error('lost');
      }
      return path.endsWith('/interactions') ? [item] : { id: 'task', companyId: 'company', assigneeAgentId: 'agent', status: 'in_review' };
    };
    if (['conflict', 'lost', 'uncommitted'].includes(scenario)) await assert.rejects(harnessReview(store, bridge, 'review', input, api));
    else assert.equal((await harnessReview(store, bridge, 'review', input, api)).status, item.status);
    if (scenario === 'lost') assert.equal((await harnessReview(store, bridge, 'review', input, api)).status, 'accepted');
    if (scenario === 'uncommitted') await assert.rejects(harnessReview(store, bridge, 'review', input, api), { code: 'review_uncertain' });
    assert.equal(posts, scenario === 'conflict' ? 0 : 1);
    assert.equal(store.run(run.id).nativeState, 'settled');
  }
});

function reviewFixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const f = { store, calls: [] };
  f.add = (id, companyId = 'company', conversationId = `chat-${id}`) => {
    store.register({ id, companyId, agentId: `agent-${id}`, harness: 'opencode', instanceId: 'instance', conversationId,
      label: `Worker ${id}` });
    const observed = store.saveOperation({ id: `observed:${id}`, runId: '', availability: 'present',
      identity: { conversationId }, placement: { directory: '/same-directory', terminalId: `terminal-${id}` } });
    return store.saveOperation({ id: `opencode-bridge:${id}`, runId: '', state: 'armed', sessionCreatedAt: 123,
      tokenHash: 'private-token', epoch: 'epoch', lastSeen: new Date().toISOString(),
      identity: { bindingId: id, conversationId, observedId: observed.id, ...observed.placement } });
  };
  f.bridge = f.add('origin'); f.worker = f.add('worker');
  f.dispatch = (bindingId = 'worker', taskId = 'task') => {
    const binding = store.binding(bindingId);
    return store.dispatch({ bindingId, bindingRevision: binding.revision, companyId: binding.config.companyId,
      agentId: binding.config.agentId, taskId, runId: `backend-${store.runs().length}` });
  };
  f.complete = (bindingId = 'worker', taskId = 'task', candidate = 'candidate') => {
    const run = f.dispatch(bindingId, taskId);
    store.acknowledge(run.id); store.submit(run.id, { key: candidate, candidate, summary: 'Result summary' });
    store.publication(run.id, { state: 'recorded' }); store.settle(run.id, { outcome: 'completed', evidence: 'Finished' });
    return store.recordReview(run.id, { interactionId: `review-${candidate}`, candidate, status: 'pending' });
  };
  f.run = f.complete();
  f.item = { id: f.run.review.interactionId, kind: 'request_confirmation', resolverPolicy: 'human_only', status: 'pending',
    createdAt: new Date(Date.now() - 1000).toISOString(), idempotencyKey: `relay-review:${f.run.id}:${digest(f.run.result)}`,
    payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: f.run.result.candidate, label: f.run.id } } };
  f.issue = { id: 'task', companyId: 'company', assigneeAgentId: 'agent-worker', status: 'in_review',
    title: 'Check the work', identifier: 'TEST-1', privateContext: 'must-not-leak' };
  f.task = store.saveOperation({ id: 'operator-task:delegation', runId: '', state: 'recorded', request: {
    companyId: 'company', body: { assigneeAgentId: 'agent-worker' }, relayReviewPolicy: 'human',
    origin: { bindingId: 'origin', conversationId: 'chat-origin', sessionCreatedAt: 123,
      sourceMessageId: 'delegation-source', sourceDigest: 'private-digest' },
  }, receipt: { ...f.issue } });
  f.input = { interactionId: f.item.id, candidate: 'candidate', decision: 'accept', reason: 'Needs changes',
    source: { id: 'human', text: 'Accept this result', createdAt: Date.now() } };
  f.api = async (method, path, body) => {
    f.calls.push({ method, path, body });
    if (method === 'POST') {
      f.item.status = path.endsWith('/accept') ? 'accepted' : 'rejected';
      f.item.result = { version: 1, outcome: f.item.status, reason: body.reason ?? null };
      f.item.resolvedByUserId = 'board-user';
      f.item.resolvedByAgentId = null; f.item.resolvedByRunId = null;
    }
    return structuredClone(path.endsWith('/interactions') ? [f.item] : f.issue);
  };
  f.invoke = (action = 'review', input = {}, bridge = f.bridge, api = f.api) => harnessReview(store, bridge, action,
    { ...f.input, ...input }, api);
  f.posts = () => f.calls.filter(call => call.method === 'POST');
  f.intent = () => store.operation(`harness-review:${digest(['company', f.item.id])}`);
  return f;
}

for (const decision of ['accept', 'reject']) {
  test(`origin human can ${decision} the exact delegated candidate without changing task policy`, async t => {
    const f = reviewFixture(t);
    const task = f.store.operation(f.task.id);
    assert.deepEqual(await f.invoke('reviews'), { reviews: [{ scope: 'delegated', runId: f.run.id, taskId: 'task',
      identifier: 'TEST-1', title: 'Check the work', interactionId: f.item.id, candidate: 'candidate', summary: 'Result summary' }] });
    const receipt = await f.invoke('review', { decision });
    assert.equal(receipt.status, decision === 'accept' ? 'accepted' : 'rejected');
    assert.deepEqual(await f.invoke('review', { decision }), receipt);
    assert.equal(f.posts().length, 1);
    assert.deepEqual(f.posts()[0].body, decision === 'reject' ? { reason: 'Needs changes' } : {});
    assert.equal(f.intent().state, 'recorded');
    assert.equal(f.intent().request.bindingId, 'origin');
    assert.deepEqual(f.store.operation(f.task.id), task);
    assert.equal(f.issue.status, 'in_review');
    assert.equal(f.store.run(f.run.id).review.status, receipt.status);
    assert.deepEqual(await f.invoke('reviews'), { reviews: [], decisions: [{ interactionId: f.item.id,
      candidate: 'candidate', decision, sourceMessageId: 'human', sourceDigest: digest(f.input.source.text), state: 'recorded', receipt }] });
    assert.equal(f.intent().request.companyId, 'company');
    assert.equal(f.intent().request.taskId, 'task');
  });
}

test('worker-chat human review remains local and candidate is optional for loaded plugins', async t => {
  const f = reviewFixture(t);
  assert.equal((await f.invoke('reviews', {}, f.worker)).reviews[0].scope, 'local');
  assert.equal((await f.invoke('review', { candidate: undefined }, f.worker)).status, 'accepted');
  assert.equal(f.intent().request.bindingId, 'worker');
});

for (const state of ['uncertain', 'recorded']) {
  for (const stage of [0, 1, 2, 3]) {
    test(`${state} coordinator intent at await ${stage} prevents a competing human POST`, async t => {
      const f = reviewFixture(t);
      const decision = { id: `review-decision:${digest(['company', 'task'])}`, runId: 'coordinator-run',
        targetRunId: f.run.id, companyId: 'company', taskId: 'task', candidate: f.run.result.candidate,
        resultDigest: digest(f.run.result), interactionId: f.item.id, action: 'accept', policy: 'coordinator',
        state, ...(state === 'recorded' ? { confirmed: true } : {}) };
      if (!stage) f.store.saveOperation(decision);
      let calls = 0;
      const api = async (...args) => {
        const result = await f.api(...args);
        if (++calls === stage) f.store.saveOperation(decision);
        return result;
      };
      await assert.rejects(f.invoke('review', {}, f.bridge, api), { code: 'review_conflict' });
      assert.equal(f.posts().length, 0);
      assert.equal(f.intent(), null);
      assert.deepEqual(f.store.operation(decision.id), decision);
    });
  }
}

for (const [state, targetRunId, candidate, blocked] of [
  ['uncertain', 'older-run', 'older-candidate', true],
  ['recorded', 'older-run', 'candidate', true],
  ['recorded', 'older-run', 'older-candidate', false],
]) {
  test(`${state} coordinator decision for ${targetRunId}/${candidate} ${blocked ? 'blocks' : 'allows'} human review`, async t => {
    const f = reviewFixture(t);
    const decision = f.store.saveOperation({ id: `review-decision:${digest(['company', 'task'])}`,
      runId: 'coordinator-run', targetRunId, candidate, state });
    if (blocked) await assert.rejects(f.invoke(), { code: 'review_conflict' });
    else assert.equal((await f.invoke()).status, 'accepted');
    assert.equal(f.posts().length, blocked ? 0 : 1);
    assert.equal(f.intent()?.state ?? null, blocked ? null : 'recorded');
    assert.deepEqual(f.store.operation(decision.id), decision);
  });
}

test('recorded coordinator acceptance cannot be adopted as human proof', async t => {
  const f = reviewFixture(t);
  f.item.status = 'accepted';
  f.store.saveOperation({ id: `review-decision:${digest(['company', 'task'])}`, runId: 'coordinator-run',
    targetRunId: f.run.id, candidate: f.run.result.candidate, interactionId: f.item.id,
    state: 'recorded', confirmed: true, action: 'accept' });
  await assert.rejects(f.invoke(), { code: 'review_conflict' });
  assert.equal(f.posts().length, 0);
  assert.equal(f.intent(), null);
});

for (const caller of ['origin', 'worker']) {
  test(`${caller} human can override coordinator policy without a coordinator intent`, async t => {
    const f = reviewFixture(t);
    f.task.request.relayReviewPolicy = 'coordinator';
    f.store.saveOperation(f.task);
    f.item.resolverPolicy = 'not_creator';
    const receipt = await f.invoke('review', {}, caller === 'origin' ? f.bridge : f.worker);
    assert.equal(receipt.status, 'accepted');
    assert.equal(f.posts().length, 1);
    assert.equal(f.intent().state, 'recorded');
    assert.equal(f.intent().request.sourceMessageId, f.input.source.id);
    assert.equal(f.intent().request.sourceDigest, digest(f.input.source.text));
    assert.deepEqual(f.store.operation(f.task.id), f.task);
  });
}

test('origin human can accept a coordinator child through recorded descendant lineage', async t => {
  const f = reviewFixture(t);
  f.add('coordinator');
  const parent = f.complete('coordinator', 'parent', 'parent-candidate');
  f.task.request.body.assigneeAgentId = 'agent-coordinator';
  f.task.receipt = { id: 'parent', companyId: 'company', assigneeAgentId: 'agent-coordinator' };
  f.store.saveOperation(f.task);
  const child = f.store.saveOperation({ id: 'operation:child', runId: parent.id, state: 'recorded', request: {
    kind: 'task.create', method: 'POST', path: '/api/companies/company/issues', relayReviewPolicy: 'coordinator',
    body: { parentId: 'parent', assigneeAgentId: 'agent-worker' },
  }, receipt: { ...f.issue, parentId: 'parent' } });
  f.item.resolverPolicy = 'not_creator';
  assert.equal((await f.invoke('reviews')).reviews[0].scope, 'delegated');
  assert.equal((await f.invoke()).status, 'accepted');
  assert.equal(f.intent().state, 'recorded');
  assert.equal(f.intent().request.bindingId, 'origin');
  assert.equal(f.posts().length, 1);
  assert.deepEqual(f.store.operation(child.id), child);
});

for (const [name, change] of [
  ['unrelated chat in the same directory', f => { f.bridge = f.add('unrelated'); }],
  ['new chat in the same directory', f => { f.bridge = f.add('new', 'company', 'new-origin-chat'); }],
  ['new session creation identity', f => { f.bridge = f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 456 }); }],
  ['foreign caller company', f => { f.bridge = f.add('foreign', 'foreign-company'); }],
  ['foreign task request company', f => { f.task.request.companyId = 'foreign-company'; }],
  ['foreign receipt company', f => { f.task.receipt.companyId = 'foreign-company'; }],
  ['unverified receipt company', f => { delete f.task.receipt.companyId; }],
  ['different receipt task', f => { f.task.receipt.id = 'other-task'; }],
  ['unrecorded task creation', f => { f.task.state = 'uncertain'; }],
  ['missing origin', f => { delete f.task.request.origin; }],
  ['different origin binding', f => { f.task.request.origin.bindingId = 'other'; }],
  ['different origin conversation', f => { f.task.request.origin.conversationId = 'other'; }],
  ['different origin creation time', f => { f.task.request.origin.sessionCreatedAt = 456; }],
  ['changed recorded assignee', f => { f.task.request.body.assigneeAgentId = 'different-agent'; }],
  ['changed backend assignee', f => { f.issue.assigneeAgentId = 'different-agent'; }],
  ['changed backend company', f => { f.issue.companyId = 'different-company'; }],
  ['changed backend task', f => { f.issue.id = 'different-task'; }],
  ['terminal task', f => { f.issue.status = 'done'; }],
  ['backend execution', f => { f.issue.executionRunId = 'active'; }],
  ['unsettled task run on another binding', f => { f.add('another'); f.dispatch('another'); }],
  ['newer completed candidate', f => { f.complete('worker', 'task', 'newer'); }],
]) {
  test(`origin review denies ${name}`, async t => {
    const f = reviewFixture(t);
    change(f); f.store.saveOperation(f.task);
    assert.deepEqual(await f.invoke('reviews'), { reviews: [] });
    await assert.rejects(f.invoke(), { code: 'review_not_found' });
    assert.equal(f.posts().length, 0);
    assert.equal(f.intent(), null);
  });
}

test('task.create receipts and directory matches never adopt an origin review', async t => {
  const f = reviewFixture(t);
  f.store.db.prepare('DELETE FROM operations WHERE id = ?').run(f.task.id);
  f.store.saveOperation({ ...f.task, id: 'operation:worker-child', request: { ...f.task.request, kind: 'task.create' } });
  assert.deepEqual(await f.invoke('reviews'), { reviews: [] });
  await assert.rejects(f.invoke(), { code: 'review_not_found' });
  assert.equal(f.posts().length, 0);
});

test('listing exposes bounded string metadata only', async t => {
  const f = reviewFixture(t);
  f.issue.title = { token: 'must-not-leak' }; f.issue.identifier = { token: 'must-not-leak' };
  const result = await f.invoke('reviews');
  assert.equal(result.reviews[0].title, null); assert.equal(result.reviews[0].identifier, null);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  f.issue.title = 't'.repeat(1000); f.issue.identifier = 'i'.repeat(1000);
  const bounded = (await f.invoke('reviews')).reviews[0];
  assert.equal(bounded.title.length, 512); assert.equal(bounded.identifier.length, 128);
});

for (const scope of ['origin', 'worker']) {
  for (const [name, change] of [
    ['synthetic source', f => { f.input.source.synthetic = true; }],
    ['ignored source', f => { f.input.source.ignored = true; }],
    ['assistant source', f => { f.input.source.role = 'assistant'; }],
    ['old source', f => { f.input.source.createdAt = 1; }],
    ['future source', f => { f.input.source.createdAt = Date.now() + 60000; }],
    ['empty source ID', f => { f.input.source.id = ''; }],
    ['worker invocation', f => { f.store.save({ ...f.run, invocation: { messageId: f.input.source.id, priorUserIds: [] } }, 'test'); }],
    ['invocation history', f => { f.store.save({ ...f.run, invocation: { messageId: 'prompt', priorUserIds: [f.input.source.id] } }, 'test'); }],
    ['notification source', f => {
      f.store.saveOperation({ id: 'completion-notification:test', runId: f.run.id, state: 'uncertain', messageId: f.input.source.id,
        origin: { bindingId: scope, conversationId: `chat-${scope}`, sessionCreatedAt: 123 } });
    }],
  ]) {
    test(`${scope} review rejects ${name}`, async t => {
      const f = reviewFixture(t); change(f);
      await assert.rejects(f.invoke('review', {}, scope === 'origin' ? f.bridge : f.worker), { code: 'invalid_answer_source' });
      assert.equal(f.posts().length, 0);
      assert.equal(f.intent(), null);
    });
  }
}

test('permission-selected candidate must match, including when the interaction ID is reused', async t => {
  const f = reviewFixture(t);
  await assert.rejects(f.invoke('review', { candidate: 'different' }), { code: 'stale_candidate' });
  const newer = f.complete('worker', 'task', 'newer');
  f.store.recordReview(newer.id, { interactionId: f.item.id, candidate: 'newer', status: 'pending' });
  await assert.rejects(f.invoke(), { code: 'stale_candidate' });
  assert.equal(f.posts().length, 0);
});

for (const caller of ['origin', 'worker']) {
  test(`any active run in ${caller} caller binding denies review, even of another task`, async t => {
    const f = reviewFixture(t); f.dispatch(caller, 'unrelated-task');
    const bridge = caller === 'origin' ? f.bridge : f.worker;
    await assert.rejects(f.invoke('reviews', {}, bridge), { code: 'conversation_busy' });
    await assert.rejects(f.invoke('review', {}, bridge), { code: 'conversation_busy' });
    assert.equal(f.posts().length, 0);
  });
}

for (const stage of [1, 2, 3]) {
  test(`latest candidate is revalidated after await ${stage}, including POST and readback`, async t => {
    const f = reviewFixture(t);
    let calls = 0;
    const api = async (...args) => {
      const result = await f.api(...args);
      if (++calls === stage) f.complete('worker', 'task', 'replacement');
      return result;
    };
    await assert.rejects(f.invoke('review', {}, f.bridge, api), error => ['review_not_found', 'stale_candidate'].includes(error.code));
    assert.equal(f.posts().length, stage < 4 ? 0 : 1);
    assert.equal(f.intent()?.state ?? null, stage < 4 ? null : 'uncertain');
  });
}

for (const stage of [4, 5, 6]) {
  test(`dispatch is fenced during review POST/readback at await ${stage}`, async t => {
    const f = reviewFixture(t);
    let calls = 0;
    const api = async (...args) => {
      const result = await f.api(...args);
      if (++calls === stage) {
        assert.equal(f.intent().state, 'uncertain');
        assert.throws(() => f.complete('worker', 'task', 'replacement'), { code: 'review_decision_uncertain' });
        assert.equal(f.store.dispatch(f.run.request).id, f.run.id);
      }
      return result;
    };
    assert.equal((await f.invoke('review', {}, f.bridge, api)).status, 'accepted');
    assert.equal(f.posts().length, 1);
    assert.equal(f.intent().state, 'recorded');
    assert.equal(f.dispatch().nativeState, 'unclaimed');
  });
}

for (const stage of [1, 2]) {
  test(`listing drops candidates replaced during GET ${stage}`, async t => {
    const f = reviewFixture(t);
    let calls = 0;
    const api = async (...args) => {
      const result = await f.api(...args);
      if (++calls === stage) f.complete('worker', 'task', 'replacement');
      return result;
    };
    assert.deepEqual(await f.invoke('reviews', {}, f.bridge, api), { reviews: [] });
    assert.equal(f.posts().length, 0);
  });
}

for (const stage of [2, 4, 6]) {
  test(`in-place candidate changes cannot retain authority after await ${stage}`, async t => {
    const f = reviewFixture(t);
    let calls = 0;
    const api = async (...args) => {
      const result = await f.api(...args);
      if (++calls === stage) f.store.save({ ...f.run, result: { ...f.run.result, summary: 'Replaced result' } }, 'test');
      return result;
    };
    await assert.rejects(f.invoke('review', {}, f.bridge, api), error => ['review_not_found', 'stale_candidate'].includes(error.code));
    assert.equal(f.posts().length, stage < 4 ? 0 : 1);
    assert.equal(f.intent()?.state ?? null, stage < 4 ? null : 'uncertain');
  });
}

for (const stage of [4, 5, 6]) {
  test(`origin replacement after await ${stage} leaves submitted intent uncertain`, async t => {
    const f = reviewFixture(t);
    let calls = 0;
    const api = async (...args) => {
      const result = await f.api(...args);
      if (++calls === stage) f.store.saveOperation({ ...f.bridge, epoch: 'replacement' });
      return result;
    };
    await assert.rejects(f.invoke('review', {}, f.bridge, api), { code: 'bridge_identity_mismatch' });
    assert.equal(f.posts().length, 1); assert.equal(f.intent().state, 'uncertain');
  });
}

for (const [name, change, code] of [
  ['bridge epoch', f => f.store.saveOperation({ ...f.bridge, epoch: 'replacement' }), 'bridge_identity_mismatch'],
  ['bridge token', f => f.store.saveOperation({ ...f.bridge, tokenHash: 'replacement' }), 'bridge_identity_mismatch'],
  ['bridge session', f => f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 456 }), 'bridge_identity_mismatch'],
  ['bridge placement', f => f.store.saveOperation({ ...f.bridge, identity: { ...f.bridge.identity, terminalId: 'replacement' } }), 'bridge_identity_mismatch'],
  ['disarmed bridge', f => f.store.saveOperation({ ...f.bridge, state: 'configured' }), 'bridge_unavailable'],
  ['retired caller', f => f.store.retireBinding('origin'), 'bridge_identity_mismatch'],
  ['recorded origin', f => {
    f.task.request.origin.conversationId = 'replacement'; f.store.saveOperation(f.task);
  }, 'stale_candidate'],
  ['recorded assignee', f => {
    f.task.request.body.assigneeAgentId = 'replacement'; f.store.saveOperation(f.task);
  }, 'stale_candidate'],
  ['caller active run', f => f.dispatch('origin', 'other-task'), 'conversation_busy'],
  ['unsettled task run', f => { f.add('another'); f.dispatch('another'); }, 'stale_candidate'],
  ['notification provenance', f => f.store.saveOperation({ id: 'completion-notification:late', runId: f.run.id,
    messageId: f.input.source.id, origin: f.task.request.origin, state: 'pending' }), 'invalid_answer_source'],
]) {
  test(`scope and source revalidation catches changed ${name} before intent is written`, async t => {
    const f = reviewFixture(t);
    let calls = 0;
    const api = async (...args) => {
      const result = await f.api(...args);
      if (++calls === 3) change(f);
      return result;
    };
    await assert.rejects(f.invoke('review', {}, f.bridge, api), { code });
    assert.equal(f.posts().length, 0); assert.equal(f.intent(), null);
  });
}

for (const field of ['id', 'companyId', 'assigneeAgentId', 'executionRunId', 'status']) {
  test(`fresh task ${field} is checked immediately before POST`, async t => {
    const f = reviewFixture(t);
    let calls = 0;
    const api = async (...args) => {
      if (++calls === 3) f.issue[field] = field === 'status' ? 'done' : 'replacement';
      return f.api(...args);
    };
    await assert.rejects(f.invoke('review', {}, f.bridge, api), { code: 'review_scope_changed' });
    assert.equal(f.posts().length, 0); assert.equal(f.intent(), null);
  });
}

for (const field of ['kind', 'idempotencyKey', 'candidate', 'runId', 'status']) {
  test(`POST readback must retain exact review ${field}`, async t => {
    const f = reviewFixture(t);
    const api = async (...args) => {
      const result = await f.api(...args);
      if (args[0] === 'POST') {
        if (field === 'candidate') f.item.payload.target.revisionId = 'replacement';
        else if (field === 'runId') f.item.payload.target.label = 'replacement';
        else f.item[field] = 'replacement';
      }
      return result;
    };
    await assert.rejects(f.invoke('review', {}, f.bridge, api), { code: 'review_uncertain' });
    assert.equal(f.posts().length, 1); assert.equal(f.intent().state, 'uncertain');
  });
}

for (const committed of [false, true]) {
  test(`delegated lost ${committed ? 'committed' : 'uncommitted'} reply never replays and guards both chats`, async t => {
    const f = reviewFixture(t);
    let posts = 0;
    const api = async (...args) => {
      if (args[0] !== 'POST') return f.api(...args);
      posts++;
      if (committed) await f.api(...args);
      throw new Error('Lost reply');
    };
    await assert.rejects(f.invoke('review', {}, f.bridge, api), /Lost reply/);
    assert.equal(f.intent().state, 'uncertain');
    await assert.rejects(f.invoke('review', { decision: 'reject' }, f.worker, api), { code: 'review_conflict' });
    if (committed) {
      assert.equal((await f.invoke('review', {}, f.bridge, api)).status, 'accepted');
      assert.equal(f.intent().state, 'recorded');
      assert.equal((await f.invoke('review', {}, f.bridge, api)).status, 'accepted');
    } else await assert.rejects(f.invoke('review', {}, f.bridge, api), { code: 'review_uncertain' });
    assert.equal(posts, 1);
  });
}

test('matching dashboard decisions reconcile without a POST but conflicting decisions do not', async t => {
  for (const decision of ['accept', 'reject']) {
    const f = reviewFixture(t);
    f.item.status = decision === 'accept' ? 'accepted' : 'rejected';
    f.item.result = { version: 1, outcome: f.item.status, reason: decision === 'reject' ? f.input.reason : null };
    f.item.resolvedByUserId = 'board-user';
    await assert.rejects(f.invoke('review', { decision: decision === 'accept' ? 'reject' : 'accept' }), { code: 'review_conflict' });
    assert.equal(f.intent(), null);
    assert.equal((await f.invoke('review', { decision })).status, f.item.status);
    assert.equal(f.intent().state, 'recorded'); assert.equal(f.posts().length, 0);
  }
});

test('simultaneous identical requests cannot replay an in-flight POST', async t => {
  const f = reviewFixture(t);
  let releasePost;
  const gate = new Promise(resolve => { releasePost = resolve; });
  const api = async (...args) => {
    if (args[0] === 'POST') await gate;
    return f.api(...args);
  };
  const pending = f.invoke('review', {}, f.bridge, api);
  try {
    await assert.rejects(f.invoke('review', {}, f.bridge, api), { code: 'review_uncertain' });
    assert.throws(() => f.dispatch(), { code: 'review_decision_uncertain' });
    assert.equal(f.store.dispatch(f.run.request).id, f.run.id);
  } finally { releasePost(); }
  assert.equal((await pending).status, 'accepted');
  assert.equal(f.posts().length, 1);
});

for (const lost of [false, true]) {
  test(`acceptance reconciles Done ${lost ? 'after a lost reply' : 'before POST readback'} without reposting`, async t => {
    const f = reviewFixture(t);
    const api = async (...args) => {
      const result = await f.api(...args);
      if (args[0] === 'POST') {
        f.issue.status = 'done';
        if (lost) throw new Error('Lost reply');
      }
      return result;
    };
    if (lost) {
      await assert.rejects(f.invoke('review', {}, f.bridge, api), /Lost reply/);
      assert.equal(f.intent().state, 'uncertain');
      assert.throws(() => f.dispatch(), { code: 'review_decision_uncertain' });
      assert.deepEqual(await f.invoke('reviews'), { reviews: [], decisions: [{ interactionId: f.item.id,
        candidate: 'candidate', decision: 'accept', sourceMessageId: 'human', sourceDigest: digest(f.input.source.text), state: 'uncertain' }] });
    }
    const receipt = await f.invoke('review', {}, f.bridge, api);
    assert.equal(receipt.status, 'accepted');
    assert.equal(f.store.run(f.run.id).review.status, 'accepted');
    assert.equal(f.intent().state, 'recorded');
    assert.deepEqual(await f.invoke('review', {}, f.bridge, api), receipt);
    assert.deepEqual((await f.invoke('reviews')).decisions[0].receipt, receipt);
    assert.equal(f.posts().length, 1);
    assert.equal(f.dispatch().nativeState, 'unclaimed');
  });
}

test('lost pending intent fences the task across bindings but not unrelated tasks or companies', async t => {
  const f = reviewFixture(t);
  await assert.rejects(f.invoke('review', {}, f.bridge, async (...args) => {
    if (args[0] === 'POST') throw new Error('Lost reply');
    return f.api(...args);
  }), /Lost reply/);
  f.add('another'); f.add('foreign', 'foreign-company');
  assert.throws(() => f.dispatch('another'), { code: 'review_decision_uncertain' });
  assert.equal(f.dispatch('foreign').nativeState, 'unclaimed');
  assert.equal(f.dispatch('another', 'other-task').nativeState, 'unclaimed');
  await assert.rejects(f.invoke(), { code: 'review_uncertain' });
  assert.throws(() => f.dispatch(), { code: 'review_decision_uncertain' });
  assert.equal(f.intent().state, 'uncertain');
  assert.equal((await f.invoke('reviews')).decisions[0].receipt, undefined);
});

test('human_only lifecycle completion can finish during acceptance without stranding its harness intent', async t => {
  const f = reviewFixture(t);
  f.store.saveOperation({ id: `review-disposition:${f.run.id}`, runId: f.run.id, state: 'waiting',
    candidate: f.run.result.candidate, interactionId: f.item.id });
  const operatorApi = async (method, path, body) => {
    if (path.startsWith('/api/heartbeat-runs/')) return { id: f.run.request.runId, companyId: 'company',
      agentId: 'agent-worker', status: 'succeeded' };
    if (method === 'PATCH') f.issue.status = body.status;
    return f.api(method, path, body);
  };
  const receipt = await f.invoke('review', {}, f.bridge, async (...args) => {
    const result = await f.api(...args);
    if (args[0] === 'POST') {
      await reconcileCompletions(f.store, operatorApi);
      assert.equal(f.issue.status, 'done');
      assert.equal(f.store.operation(`completion:${f.run.id}`).state, 'recorded');
      assert.equal(f.intent().state, 'uncertain');
      assert.throws(() => f.dispatch(), { code: 'review_decision_uncertain' });
    }
    return result;
  });
  assert.equal(receipt.status, 'accepted');
  assert.equal(f.intent().state, 'recorded');
  assert.deepEqual(await f.invoke(), receipt);
  assert.equal(f.posts().length, 1);
  assert.equal(f.dispatch().nativeState, 'unclaimed');
});

test('legacy permissive acceptance needs recorded harness proof before lifecycle completion', async t => {
  const f = reviewFixture(t);
  f.item.resolverPolicy = 'not_creator';
  f.store.saveOperation({ id: `review-disposition:${f.run.id}`, runId: f.run.id, state: 'waiting',
    candidate: f.run.result.candidate, interactionId: f.item.id });
  const operatorApi = async (method, path, body) => {
    if (path.startsWith('/api/heartbeat-runs/')) return { id: f.run.request.runId, companyId: 'company',
      agentId: 'agent-worker', status: 'succeeded' };
    if (method === 'PATCH') f.issue.status = body.status;
    return f.api(method, path, body);
  };
  const receipt = await f.invoke('review', {}, f.bridge, async (...args) => {
    const result = await f.api(...args);
    if (args[0] === 'POST') {
      await reconcileCompletions(f.store, operatorApi);
      assert.equal(f.intent().state, 'uncertain');
      assert.equal(f.issue.status, 'in_review');
      assert.equal(f.store.operation(`completion:${f.run.id}`), null);
      assert.equal(f.store.operation(`review-disposition:${f.run.id}`).reason, 'human_review_required');
    }
    return result;
  });
  assert.equal(receipt.status, 'accepted');
  const proof = f.intent();
  assert.equal(proof.state, 'recorded');
  await reconcileCompletions(f.store, operatorApi);
  assert.equal(f.issue.status, 'done');
  assert.equal(f.store.operation(`completion:${f.run.id}`).state, 'recorded');
  assert.deepEqual(f.intent(), proof);
  assert.deepEqual(await f.invoke(), receipt);
  assert.equal(f.posts().length, 1);
});

test('decision discovery omits private intent and receipt fields', async t => {
  const f = reviewFixture(t);
  const receipt = await f.invoke();
  const operation = f.intent();
  f.store.saveOperation({ ...operation, privateContext: 'must-not-leak',
    receipt: { ...operation.receipt, privateContext: 'must-not-leak' } });
  const result = await f.invoke('reviews');
  assert.deepEqual(result, { reviews: [], decisions: [{ interactionId: f.item.id, candidate: 'candidate',
    decision: 'accept', sourceMessageId: 'human', sourceDigest: digest(f.input.source.text), state: 'recorded', receipt }] });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

test('persisted older intents retain task fencing, replay and exact retry compatibility', async t => {
  const f = reviewFixture(t);
  await assert.rejects(f.invoke('review', {}, f.bridge, async (...args) => {
    if (args[0] === 'POST') throw new Error('Lost reply');
    return f.api(...args);
  }), /Lost reply/);
  const legacy = f.intent();
  delete legacy.request.companyId; delete legacy.request.taskId; delete legacy.request.sessionCreatedAt;
  f.store.saveOperation(legacy);
  assert.throws(() => f.dispatch(), { code: 'review_decision_uncertain' });
  assert.equal(f.store.dispatch(f.run.request).id, f.run.id);
  const recovered = { ...f.run.request, runId: 'recovery' };
  f.store.recover(f.run.id, recovered);
  assert.equal(f.store.dispatch(recovered).id, f.run.id);
  f.item.status = 'accepted'; f.issue.status = 'done';
  f.item.result = { version: 1, outcome: 'accepted', reason: null }; f.item.resolvedByUserId = 'board-user';
  assert.equal((await f.invoke('review', { candidate: undefined })).status, 'accepted');
  assert.equal(f.dispatch().nativeState, 'unclaimed');
});

for (const state of ['uncertain', 'recorded']) {
  test(`${state} decisions stay origin-bound and cannot be adopted by another source`, async t => {
    const f = reviewFixture(t);
    if (state === 'recorded') await f.invoke();
    else await assert.rejects(f.invoke('review', {}, f.bridge, async (...args) => {
      const result = await f.api(...args);
      if (args[0] === 'POST') throw new Error('Lost reply');
      return result;
    }), /Lost reply/);
    f.issue.status = 'done';
    assert.equal((await f.invoke('reviews')).decisions[0].state, state);
    assert.deepEqual(await f.invoke('reviews', {}, f.worker), { reviews: [] });
    await assert.rejects(f.invoke('review', {}, f.worker), { code: 'review_conflict' });
    for (const source of [{ ...f.input.source, id: 'other-human' }, { ...f.input.source, text: 'Different source text' }]) {
      await assert.rejects(f.invoke('review', { source }), { code: 'review_conflict' });
    }
    await assert.rejects(f.invoke('review', { decision: 'reject' }), { code: 'review_conflict' });
    assert.equal(f.posts().length, 1);
    assert.equal(f.intent().state, state);
    f.bridge = f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 456 });
    assert.deepEqual(await f.invoke('reviews'), { reviews: [] });
  });
}

for (const status of ['done', 'cancelled']) {
  test(`terminal ${status} never authorises a new harness decision`, async t => {
    const f = reviewFixture(t);
    f.issue.status = status; f.item.status = 'accepted';
    await assert.rejects(f.invoke(), { code: 'review_not_found' });
    assert.deepEqual(await f.invoke('reviews'), { reviews: [] });
    assert.equal(f.intent(), null);
    assert.equal(f.posts().length, 0);
  });
}

for (const field of ['status', 'candidate', 'idempotencyKey', 'kind']) {
  test(`Done cannot reconcile an uncertain acceptance with changed interaction ${field}`, async t => {
    const f = reviewFixture(t);
    await assert.rejects(f.invoke('review', {}, f.bridge, async (...args) => {
      const result = await f.api(...args);
      if (args[0] === 'POST') throw new Error('Lost reply');
      return result;
    }), /Lost reply/);
    f.issue.status = 'done';
    if (field === 'candidate') f.item.payload.target.revisionId = 'different';
    else f.item[field] = field === 'status' ? 'pending' : 'different';
    await assert.rejects(f.invoke(), { code: 'review_not_found' });
    assert.equal(f.intent().state, 'uncertain');
    assert.throws(() => f.dispatch(), { code: 'review_decision_uncertain' });
    assert.equal(f.posts().length, 1);
  });
}

for (const first of ['origin', 'worker']) {
  for (const decision of ['accept', 'reject']) {
    test(`simultaneous ${first}-first decisions reserve one shared intent (${decision})`, async t => {
      const f = reviewFixture(t);
      const second = first === 'origin' ? 'worker' : 'origin';
      const bridge = name => name === 'origin' ? f.bridge : f.worker;
      let releasePost;
      const gate = new Promise(resolve => { releasePost = resolve; });
      const api = async (...args) => {
        if (args[0] === 'POST') await gate;
        return f.api(...args);
      };
      const pending = f.invoke('review', { decision }, bridge(first), api);
      const rival = f.invoke('review', { decision: decision === 'accept' ? 'reject' : 'accept' }, bridge(second), api);
      try {
        await assert.rejects(rival, { code: 'review_conflict' });
        assert.equal(f.intent().request.bindingId, first);
        assert.equal(f.intent().state, 'uncertain');
      } finally { releasePost(); }
      assert.equal((await pending).status, decision === 'accept' ? 'accepted' : 'rejected');
      assert.equal(f.posts().length, 1);
      await assert.rejects(f.invoke('review', {}, bridge(second)), { code: 'review_conflict' });
    });
  }
}

for (const lost of [false, true]) {
  test(`rejection confirms with an immediate backend execution${lost ? ' after a lost reply' : ''}`, async t => {
    const f = reviewFixture(t);
    const api = async (...args) => {
      const result = await f.api(...args);
      if (args[0] === 'POST') {
        f.issue.executionRunId = 'new-backend-run'; f.issue.status = 'in_progress';
        if (lost) throw new Error('Lost reply');
      }
      return result;
    };
    if (lost) await assert.rejects(f.invoke('review', { decision: 'reject' }, f.bridge, api), /Lost reply/);
    const receipt = await f.invoke('review', { decision: 'reject' }, f.bridge, api);
    assert.equal(receipt.status, 'rejected');
    assert.equal(f.intent().state, 'recorded');
    assert.equal(f.store.run(f.run.id).review.status, 'rejected');
    assert.equal(f.posts().length, 1);
    assert.equal(f.issue.executionRunId, 'new-backend-run');
    assert.equal(f.issue.status, 'in_progress');
    const next = f.complete('worker', 'task', 'next-candidate');
    const active = f.dispatch('worker');
    assert.deepEqual(await f.invoke('review', { decision: 'reject' }, f.bridge, api), receipt);
    assert.deepEqual((await f.invoke('reviews')).decisions[0].receipt, receipt);
    assert.deepEqual(f.store.run(next.id), next);
    assert.deepEqual(f.store.run(active.id), active);
    assert.equal(f.posts().length, 1);
  });
}

for (const status of ['done', 'cancelled']) {
  test(`persisted rejection can read back on ${status} without a new POST`, async t => {
    const f = reviewFixture(t);
    await assert.rejects(f.invoke('review', { decision: 'reject' }, f.bridge, async (...args) => {
      const result = await f.api(...args);
      if (args[0] === 'POST') throw new Error('Lost reply');
      return result;
    }), /Lost reply/);
    f.issue.status = status;
    const request = f.intent().request;
    assert.equal((await f.invoke('review', { decision: 'reject' })).status, 'rejected');
    assert.deepEqual(f.intent().request, request);
    assert.equal(f.posts().length, 1);
  });
}

for (const [name, change] of [
  ['missing human', item => { delete item.resolvedByUserId; }],
  ['empty human', item => { item.resolvedByUserId = ' '; }],
  ['agent', item => { item.resolvedByAgentId = 'agent'; }],
  ['run', item => { item.resolvedByRunId = 'run'; }],
  ['result outcome', item => { item.result.outcome = 'accepted'; }],
  ['reason', item => { item.result.reason = 'Different changes'; }],
  ['missing reason', item => { delete item.result.reason; }],
  ['company', item => { item.companyId = 'other'; }],
  ['task', item => { item.issueId = 'other'; }],
]) {
  test(`rejection readback rejects mismatched ${name}`, async t => {
    const f = reviewFixture(t);
    await assert.rejects(f.invoke('review', { decision: 'reject' }, f.bridge, async (...args) => {
      const result = await f.api(...args);
      if (args[0] === 'POST') { f.issue.executionRunId = 'new-backend-run'; change(f.item); }
      return result;
    }), { code: 'review_uncertain' });
    const intent = f.intent();
    await assert.rejects(f.invoke('review', { decision: 'reject' }), { code: 'review_uncertain' });
    assert.deepEqual(f.intent(), intent);
    assert.equal(f.store.run(f.run.id).review.status, 'pending');
    assert.equal(f.posts().length, 1);
  });
}

test('POST readback never overwrites a concurrently replaced intent', async t => {
  const f = reviewFixture(t);
  let replacement;
  await assert.rejects(f.invoke('review', {}, f.bridge, async (...args) => {
    const result = await f.api(...args);
    if (args[0] === 'POST') replacement = f.store.saveOperation({ ...f.intent(), request: { ...f.intent().request, sourceDigest: 'changed' } });
    return result;
  }), { code: 'review_conflict' });
  assert.deepEqual(f.intent(), replacement);
  assert.equal(f.store.run(f.run.id).review.status, 'pending');
});

test('active backend execution never authorises adoption of a decision without an intent', async t => {
  const f = reviewFixture(t);
  f.issue.executionRunId = 'new-run';
  f.item.status = 'rejected'; f.item.result = { version: 1, outcome: 'rejected', reason: f.input.reason };
  f.item.resolvedByUserId = 'board-user';
  await assert.rejects(f.invoke('review', { decision: 'reject' }), { code: 'review_not_found' });
  assert.equal(f.intent(), null);
  assert.equal(f.posts().length, 0);
});

test('later coordinator intent cannot prevent read-only recovery of an older recorded receipt', async t => {
  const f = reviewFixture(t);
  const receipt = await f.invoke('review', { decision: 'reject' });
  const next = f.complete('worker', 'task', 'next');
  const coordinator = f.store.saveOperation({ id: `review-decision:${digest(['company', 'task'])}`, runId: 'coordinator',
    targetRunId: next.id, candidate: next.result.candidate, state: 'uncertain', action: 'accept' });
  assert.deepEqual(await f.invoke('review', { decision: 'reject' }), receipt);
  assert.deepEqual(f.store.operation(coordinator.id), coordinator);
  assert.equal(f.posts().length, 1);
});
