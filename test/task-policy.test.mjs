import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { taskPolicy } from '../src/task-policy.mjs';
import { createOperatorTask, mutate } from '../src/operations.mjs';
import { requestReviewDisposition } from '../src/disposition.mjs';

function fixture(t, policy) {
  const store = new Store(':memory:'); t.after(() => store.close());
  if (policy) store.saveOperation({ id: 'operator-task:create', runId: '', state: 'recorded',
    request: { companyId: 'company', relayReviewPolicy: policy }, receipt: { id: 'task', companyId: 'company' } });
  store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'i', conversationId: 'c' });
  const run = store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  store.acknowledge(run.id);
  return { store, run, submission: { key: 'one', candidate: 'candidate', summary: 'Answer' } };
}

test('creator policy constrains submission while agent_decides requires a reasoned choice', t => {
  for (const policy of [undefined, 'human', 'none', 'agent_decides']) {
    const f = fixture(t, policy);
    assert.equal(taskPolicy(f.store, 'company', 'task'), policy ?? 'human');
    if (policy === 'agent_decides') {
      assert.throws(() => f.store.submit(f.run.id, f.submission), { code: 'review_decision_required' });
      assert.throws(() => f.store.submit(f.run.id, { ...f.submission, reviewDecision: { mode: 'none', reason: '' } }), { code: 'invalid_review_decision' });
      f.store.submit(f.run.id, { ...f.submission, reviewDecision: { mode: 'none', reason: 'Deterministic informational answer' } });
    } else {
      assert.throws(() => f.store.submit(f.run.id, { ...f.submission, reviewDecision: { mode: policy === 'none' ? 'human' : 'none', reason: 'override' } }), { code: 'review_policy_locked' });
      f.store.submit(f.run.id, f.submission);
    }
  }
});

test('delegating agent and operator persist policy per task without sending unsupported backend fields', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const api = async (method, path, body) => {
    if (method === 'GET') return { id: 'company' };
    assert.equal(body.relayReviewPolicy, undefined);
    return { id: body.title, companyId: 'company', ...body };
  };
  const input = { companyId: 'company', key: 'one', payload: { title: 'operator-task', relayReviewPolicy: 'agent_decides' } };
  await createOperatorTask(store, api, input);
  assert.equal(taskPolicy(store, 'company', 'operator-task'), 'agent_decides');
  await assert.rejects(createOperatorTask(store, api, { ...input, payload: { ...input.payload, relayReviewPolicy: 'none' } }), { code: 'operation_conflict' });
  await mutate(store, { id: 'parent-run', request: { companyId: 'company', bindingId: 'parent', taskId: 'parent' } }, 'token',
    (_, __, ...args) => api(...args), { key: 'child', kind: 'task.create', payload: { title: 'child', parentId: 'parent', relayReviewPolicy: 'none' } });
  assert.equal(taskPolicy(store, 'company', 'child'), 'none');
  assert.equal(taskPolicy(store, 'other', 'child'), 'human');
});

test('no-review completes only after verified publication and settlement with no acceptance interaction', async t => {
  for (const policy of ['none', 'agent_decides']) {
    const f = fixture(t, policy);
    f.store.submit(f.run.id, { ...f.submission, ...(policy === 'agent_decides' ? { reviewDecision: { mode: 'none', reason: 'Simple calculation' } } : {}) });
    const issue = { id: 'task', companyId: 'company', assigneeAgentId: 'agent', executionRunId: 'backend', status: 'in_progress' };
    let writes = 0;
    const api = async (_, __, method, path, body) => {
      assert.notEqual(method, 'POST');
      if (method === 'PATCH') { writes++; issue.status = body.status; }
      return path.endsWith('/interactions') ? [] : { ...issue };
    };
    await assert.rejects(requestReviewDisposition(f.store, f.run.id, 'token', api), { code: 'result_not_ready' });
    f.store.publication(f.run.id, { state: 'recorded' });
    f.store.settle(f.run.id, { outcome: 'completed', evidence: 'Terminal receipt' });
    assert.deepEqual(await requestReviewDisposition(f.store, f.run.id, 'token', api), { status: 'done', policy: 'none' });
    assert.equal(writes, 1); assert.equal(f.store.run(f.run.id).review, undefined);
    assert.equal(f.store.operation(`no-review-completion:${f.run.id}`).state, 'recorded');
  }
});

test('no-review uncertainty never replays and cannot bypass Paperclip review or pending interactions', async t => {
  for (const scenario of ['lost', 'uncommitted', 'human_only', 'pending']) {
    const f = fixture(t, 'none'); f.store.submit(f.run.id, f.submission);
    f.store.publication(f.run.id, { state: 'recorded' }); f.store.settle(f.run.id, { outcome: 'completed', evidence: 'finished' });
    const issue = { id: 'task', companyId: 'company', assigneeAgentId: 'agent', status: 'in_progress',
      ...(scenario === 'human_only' ? { reviewPolicy: 'human_only' } : {}) };
    let attempts = 0;
    const api = async (_, __, method, path) => {
      if (method === 'PATCH') { attempts++; if (scenario === 'lost') issue.status = 'done'; throw new Error('lost'); }
      return path.endsWith('/interactions') ? scenario === 'pending' ? [{ status: 'pending' }] : [] : { ...issue };
    };
    await assert.rejects(requestReviewDisposition(f.store, f.run.id, 'token', api));
    if (scenario === 'lost') assert.equal((await requestReviewDisposition(f.store, f.run.id, 'token', api)).status, 'done');
    else await assert.rejects(requestReviewDisposition(f.store, f.run.id, 'token', api));
    assert.equal(attempts, ['lost', 'uncommitted'].includes(scenario) ? 1 : 0);
  }
});
