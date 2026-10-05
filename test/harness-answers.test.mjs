import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { harnessQuestion, parseRelayAnswer, harnessReview } from '../src/harness-answers.mjs';
import { digest } from '../src/protocol.mjs';

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
    const item = { id: 'review', kind: 'request_confirmation', status: scenario === 'conflict' ? 'rejected' : 'pending',
      createdAt: new Date().toISOString(), idempotencyKey: `relay-review:${run.id}:${digest(run.result)}`,
      payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'candidate', label: run.id } } };
    const bridge = { state: 'armed', identity: { bindingId: 'worker', conversationId: 'c' } };
    const input = { interactionId: 'review', decision: scenario === 'reject' ? 'reject' : 'accept', reason: 'Needs changes',
      source: { id: 'human', text: 'accpeted', createdAt: Date.now() + 1 } };
    let posts = 0;
    const api = async (method, path) => {
      if (method === 'POST') {
        posts++;
        if (scenario === 'uncommitted') throw new Error('lost');
        item.status = input.decision === 'accept' ? 'accepted' : 'rejected';
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
