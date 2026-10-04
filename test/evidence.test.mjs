import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { resultBody } from '../src/protocol.mjs';

test('progress and worker/reviewer evidence retain attribution and reject changed retries', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.register({ id: 'worker', companyId: 'company', agentId: 'worker', harness: 'opencode', instanceId: 'instance', conversationId: 'session' });
  const run = store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'worker', taskId: 'task', runId: 'backend' });
  store.acknowledge(run.id);
  const progress = { key: 'implemented', summary: 'Graph updated, checking now' };
  store.progress(run.id, progress);
  assert.equal(store.progress(run.id, progress).progress.length, 1);
  assert.throws(() => store.progress(run.id, { ...progress, summary: 'Changed' }), { code: 'progress_conflict' });
  const submitted = store.submit(run.id, { key: 'one', summary: 'Graph updated', candidate: 'sha256:one', deliverables: ['graph.json'],
    checks: [{ command: 'npm test', outcome: 'passed', evidence: 'All tests passed', source: 'independent' }] });
  assert.equal(submitted.result.checks[0].source, 'worker_reported');
  assert.ok(resultBody(submitted).includes('Worker-reported checks'));
  assert.throws(() => store.progress(run.id, { key: 'late', summary: 'Still editing' }), { code: 'work_inactive' });
  const caller = { request: { companyId: 'company', agentId: 'reviewer' } };
  const check = { key: 'review', candidate: 'sha256:one', command: 'npm test', outcome: 'passed', evidence: 'Reviewer ran tests' };
  store.reviewerEvidence(run.id, check, caller);
  assert.equal(store.reviewerEvidence(run.id, check, caller).reviewerChecks.length, 1);
  assert.throws(() => store.reviewerEvidence(run.id, { ...check, candidate: 'sha256:old' }, caller), { code: 'stale_candidate' });
  assert.throws(() => store.reviewerEvidence(run.id, check, run), { code: 'self_review_forbidden' });
});
