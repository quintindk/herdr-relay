import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { mutate } from '../src/operations.mjs';
import { digest } from '../src/protocol.mjs';
import { useChatReviewForRoutine } from '../src/job-review.mjs';

function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'chat' });
  const run = store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'job', runId: 'backend' });
  store.acknowledge(run.id);
  return { store, run };
}

test('an assigned job updates and completes human bookkeeping without a candidate approval', async t => {
  const f = fixture(t); const task = { id: 'human-task', companyId: 'company', status: 'todo', assigneeUserId: 'board' };
  let writes = 0;
  const api = async (_, __, method, path, body) => {
    assert.equal(path, '/api/issues/human-task');
    if (method === 'PATCH') { writes++; Object.assign(task, body); }
    return { ...task };
  };
  const result = await mutate(f.store, f.run, 'job-token', api, { key: 'done', kind: 'task.update', taskId: task.id, payload: { status: 'done' } });
  assert.equal(result.receipt.status, 'done'); assert.equal(writes, 1);
  assert.equal(f.store.run(f.run.id).nativeState, 'claimed');
});

test('source references prevent duplicate intake creation across jobs and conversation identities', async t => {
  const f = fixture(t); let task; let creates = 0;
  const api = async (_, __, method, path, body) => {
    if (method === 'POST') { creates++; task = { id: 'captured', companyId: 'company', ...body }; return { ...task }; }
    assert.equal(path, '/api/issues/captured'); return { ...task };
  };
  const input = { key: 'email-action', kind: 'task.create', payload: { title: 'Customer follow-up', assigneeUserId: 'board',
    externalReference: { namespace: 'email-action', externalId: 'native-message:action' } } };
  const first = await mutate(f.store, f.run, 'token', api, input);
  const another = { ...f.run, id: 'another-job', request: { ...f.run.request, bindingId: 'new-chat' } };
  const second = await mutate(f.store, another, 'token', api, { ...input, payload: { ...input.payload, title: 'Later wording' } });
  assert.equal(first.receipt.id, second.receipt.id); assert.equal(second.reusedExisting, true); assert.equal(creates, 1);
});

test('lost referenced intake receipts reuse one backend idempotency key rather than duplicate creation', async t => {
  const f = fixture(t); const tasks = new Map(); let posts = 0;
  const api = async (_, __, method, path, body) => {
    if (method === 'GET') return tasks.values().next().value;
    posts++;
    if (!tasks.has(body.idempotencyKey)) tasks.set(body.idempotencyKey, { id: 'task', companyId: 'company', ...body });
    if (posts === 1) throw Error('lost create reply');
    return tasks.get(body.idempotencyKey);
  };
  const input = { key: 'source', kind: 'task.create', payload: { title: 'Source action', assigneeUserId: 'board',
    externalReference: { namespace: 'email-action', externalId: 'message:one' } } };
  await assert.rejects(mutate(f.store, f.run, 'token', api, input), /lost create reply/);
  assert.equal((await mutate(f.store, f.run, 'token', api, input)).receipt.id, 'task');
  assert.equal(tasks.size, 1);
});

test('job reference attachment uses its context and remains company-scoped', async t => {
  const f = fixture(t);
  const api = async (_, token, method, path) => {
    assert.equal(token, 'job-token'); assert.equal(method, 'GET'); assert.equal(path, '/api/issues/customer');
    return { id: 'customer', companyId: 'company' };
  };
  const result = await mutate(f.store, f.run, 'job-token', api, { key: 'link', kind: 'task.reference-attach', taskId: 'customer',
    payload: { namespace: 'email-action', externalId: 'message:action' } });
  assert.equal(result.reference.taskId, 'customer');
  await assert.rejects(mutate(f.store, f.run, 'job-token', async () => ({ id: 'customer', companyId: 'foreign' }), {
    key: 'foreign', kind: 'task.reference-attach', taskId: 'customer', payload: { namespace: 'email-action', externalId: 'another' },
  }), { code: 'forbidden' });
});

test('job comments reconcile lost replies without another POST or pretending the user wrote them', async t => {
  const f = fixture(t), comments = []; let posts = 0;
  const api = async (_, __, method, path, body) => {
    if (path === '/api/issues/human-task') return { id: 'human-task', companyId: 'company' };
    if (method === 'POST') {
      posts++; comments.push({ id: 'comment', body: body.body, authorAgentId: 'agent', createdByRunId: 'backend' });
      throw Error('lost response');
    }
    return comments;
  };
  const input = { key: 'context', kind: 'task.comment', taskId: 'human-task', payload: { body: 'Verified customer evidence' } };
  await assert.rejects(mutate(f.store, f.run, 'token', api, input), /lost response/);
  assert.equal((await mutate(f.store, f.run, 'token', api, input)).reconciled, true);
  assert.equal(posts, 1);
});

test('changing the job to chat review withdraws its own request and completes reporting without acceptance', async t => {
  const f = fixture(t);
  const claim = f.store.saveOperation({ id: 'routine-task:job', runId: '', scheduleId: 'routine:test', state: 'recorded',
    request: { companyId: 'company', relayReviewPolicy: 'human' }, receipt: { id: 'job' } });
  f.store.submit(f.run.id, { key: 'output', candidate: 'candidate', summary: 'Actual results' });
  f.store.publication(f.run.id, { state: 'recorded' });
  f.store.settle(f.run.id, { outcome: 'completed', evidence: 'Verified native finish' });
  const run = f.store.run(f.run.id);
  f.store.recordReview(run.id, { interactionId: 'review', status: 'pending', candidate: 'candidate' });
  f.store.saveOperation({ id: `review-disposition:${run.id}`, runId: run.id, state: 'waiting', candidate: 'candidate' });
  const issue = { id: 'job', companyId: 'company', assigneeAgentId: 'agent', status: 'in_review' };
  const review = { id: 'review', kind: 'request_confirmation', status: 'pending', idempotencyKey: `relay-review:${run.id}:${digest(run.result)}`,
    payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'candidate', label: run.id } } };
  const writes = [];
  const api = async (method, path, body) => {
    if (method !== 'GET') writes.push({ method, path, body });
    if (path.endsWith('/withdraw')) { review.status = 'cancelled'; review.result = { outcome: 'withdrawn' }; return { ...review }; }
    if (path.endsWith('/interactions')) return [{ ...review }];
    if (method === 'PATCH') Object.assign(issue, body);
    return { ...issue };
  };
  const schedule = { id: claim.scheduleId, request: { companyId: 'company' } };
  await useChatReviewForRoutine(f.store, api, schedule, 'edit', async () => {});
  assert.equal(issue.status, 'done'); assert.equal(f.store.run(run.id).review.status, 'withdrawn');
  assert.equal(f.store.operation(`no-review-completion:${run.id}`).state, 'recorded');
  assert.equal(writes.some(write => write.path.endsWith('/accept')), false);
  const count = writes.length;
  await useChatReviewForRoutine(f.store, api, schedule, 'edit', async () => {});
  assert.equal(writes.length, count);
});
