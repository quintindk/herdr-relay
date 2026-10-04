import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { review } from '../src/review.mjs';
import { candidate } from '../src/candidate.mjs';

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
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.register({ id: 'worker', companyId: 'company', agentId: 'worker', harness: 'opencode', instanceId: 'instance', conversationId: 'worker' });
  const request = { bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'worker', runId: 'backend', taskId: 'task' };
  const run = store.dispatch(request);
  store.acknowledge(run.id);
  store.submit(run.id, { key: 'one', summary: 'Graph changed', candidate: 'sha256:one' });
  store.publication(run.id, { state: 'recorded', commentId: 'receipt' });
  store.settle(run.id, { outcome: 'completed', evidence: 'Observed' });
  const caller = { id: 'reviewer-run', request: { companyId: 'company', agentId: 'reviewer', runId: 'review-run' } };
  const interactions = [];
  const api = async (run, token, method, path, body) => {
    if (method === 'GET') return interactions;
    if (path.endsWith('/accept')) { interactions[0].status = 'accepted'; return interactions[0]; }
    const interaction = { id: 'review', status: 'pending', ...body };
    interactions.push(interaction);
    return interaction;
  };
  const input = { runId: run.id, candidate: 'sha256:one' };
  await review(store, caller, 'token', api, { ...input, action: 'request' });
  await assert.rejects(review(store, run, 'token', api, { ...input, action: 'accept' }), { code: 'self_review_forbidden' });
  assert.equal((await review(store, caller, 'token', api, { ...input, action: 'accept' })).review.status, 'accepted');
  const eventCount = store.db.prepare('SELECT count(*) AS total FROM events').get().total;
  await review(store, caller, 'token', api, { ...input, action: 'inspect' });
  assert.equal(store.db.prepare('SELECT count(*) AS total FROM events').get().total, eventCount);
  const next = store.dispatch({ ...request, runId: 'new-backend' });
  store.acknowledge(next.id);
  store.submit(next.id, { key: 'two', summary: 'Corrected graph', candidate: 'sha256:two' });
  await assert.rejects(review(store, caller, 'token', api, { ...input, action: 'accept' }), { code: 'stale_candidate' });
});

test('lost acceptance response blocks a new candidate until the exact decision is reconciled', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.register({ id: 'worker', companyId: 'company', agentId: 'worker', harness: 'opencode', instanceId: 'instance', conversationId: 'worker' });
  const request = { bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'worker', runId: 'backend', taskId: 'task' };
  const run = store.dispatch(request);
  store.acknowledge(run.id);
  store.submit(run.id, { key: 'one', summary: 'Candidate', candidate: 'sha256:one' });
  store.publication(run.id, { state: 'recorded', commentId: 'receipt' });
  store.settle(run.id, { outcome: 'completed', evidence: 'Observed end' });
  const caller = { id: 'reviewer-run', request: { companyId: 'company', agentId: 'reviewer', runId: 'reviewer-backend' } };
  const interactions = [];
  let accepts = 0;
  const api = async (run, token, method, path, body) => {
    if (method === 'GET') return interactions;
    if (path.endsWith('/accept')) {
      accepts++;
      interactions[0].status = 'accepted';
      throw new Error('Lost acceptance response');
    }
    const interaction = { id: 'review', status: 'pending', ...body };
    interactions.push(interaction);
    return interaction;
  };
  const input = { runId: run.id, candidate: 'sha256:one' };
  await review(store, caller, 'token', api, { ...input, action: 'request' });
  await assert.rejects(review(store, caller, 'token', api, { ...input, action: 'accept' }));
  assert.throws(() => store.dispatch({ ...request, runId: 'next' }), { code: 'review_decision_uncertain' });
  assert.equal((await review(store, caller, 'token', api, { ...input, action: 'accept' })).review.status, 'accepted');
  assert.equal(accepts, 1);
  assert.ok(store.dispatch({ ...request, runId: 'next' }).id);
});
