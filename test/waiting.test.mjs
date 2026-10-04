import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { publishQuestion } from '../src/work.mjs';

test('published questions release native capacity only after settlement and preserve obligations', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.register({ id: 'driver', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'session' });
  const request = { bindingId: 'driver', bindingRevision: 1, companyId: 'company', agentId: 'agent', runId: 'first', taskId: 'task' };
  const run = store.dispatch(request);
  const question = { key: 'region', question: 'Which Azure region?' };
  assert.throws(() => store.ask(run.id, question), { code: 'invalid_question' });
  store.acknowledge(run.id);
  store.ask(run.id, question);
  store.ask(run.id, question);
  assert.throws(() => store.ask(run.id, { ...question, question: 'Changed?' }), { code: 'question_conflict' });
  assert.throws(() => store.submit(run.id, { key: 'one', summary: 'done', candidate: 'fixture' }), { code: 'work_waiting' });
  assert.throws(() => store.settle(run.id, { outcome: 'waiting', evidence: 'Ended' }), { code: 'question_not_published' });
  assert.throws(() => store.dispatch({ ...request, runId: 'second' }), { code: 'conversation_busy' });
  const interactions = [];
  let posts = 0;
  const api = async (run, token, method, path, input) => {
    if (method === 'GET') return interactions;
    posts++;
    interactions.push({ id: 'question', ...input });
    throw new Error('Lost committed response');
  };
  await assert.rejects(publishQuestion(store, run.id, 'token', api));
  await publishQuestion(store, run.id, 'token', api);
  assert.equal(posts, 1);
  store.settle(run.id, { outcome: 'waiting', evidence: 'Native question turn ended' });
  const next = store.dispatch({ ...request, runId: 'second', taskId: 'unrelated-obligation' });
  assert.notEqual(next.id, run.id);
  assert.equal(store.run(run.id).waiting.interactionId, 'question');
});
