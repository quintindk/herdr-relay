import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { waitForChild } from '../src/dependencies.mjs';

test('child wait persists dependency, survives lost PATCH reply and settles only on terminal evidence', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'i', conversationId: 'c' });
  let run = store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'parent', runId: 'backend' });
  run = store.acknowledge(run.id);
  const child = { id: 'child', companyId: 'company', parentId: 'parent', assigneeAgentId: 'peer', status: 'todo' };
  const issue = { id: 'parent', companyId: 'company', assigneeAgentId: 'agent', status: 'in_progress', blockedBy: [] };
  let writes = 0;
  const api = async (_, __, method, path, body) => {
    if (path.endsWith('/child')) return child;
    if (method === 'PATCH') { writes++; issue.status = body.status; issue.blockedBy = body.blockedByIssueIds.map(id => ({ id })); throw new Error('lost'); }
    return issue;
  };
  await assert.rejects(waitForChild(store, run, 'token', api, { taskId: 'child' }));
  await waitForChild(store, run, 'token', api, { taskId: 'child' });
  assert.equal(writes, 1);
  assert.equal(store.run(run.id).dependency.childId, 'child');
  assert.throws(() => store.submit(run.id, { key: 'bad', summary: 'premature', candidate: 'bad' }), { code: 'work_waiting' });
  store.saveOperation({ id: 'opencode-bridge:worker', runId: '', state: 'armed' });
  store.beginNative(run.id, 'prompt', []);
  store.nativeStatus(run.id, { state: 'finished', messageId: 'reply' });
  store.finishNative(run.id, store.run(run.id).native);
  assert.equal(store.run(run.id).settlement.outcome, 'waiting');
  child.companyId = 'other';
  await assert.rejects(waitForChild(store, run, 'token', api, { taskId: 'child' }), { code: 'dependency_scope_mismatch' });
});
