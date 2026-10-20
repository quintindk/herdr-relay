import assert from 'node:assert/strict';
import test from 'node:test';
import { startBackend } from '../src/backend-service.mjs';
import { digest } from '../src/protocol.mjs';

async function fixture(t) {
  const backend = await startBackend({ database: ':memory:' });
  t.after(() => backend.close());
  const store = backend.store;
  const ownerToken = store.bootstrap().token;
  const owner = store.authenticate(ownerToken);
  const command = (actor, action, payload, key = crypto.randomUUID()) => store.command(actor, { key, action, payload });
  for (const id of ['worker-node', 'other-node']) command(owner, 'node.enrol', { id, name: id });
  const node = store.authenticate(store.enrolCredential(owner, 'worker-node', 'worker').token);
  const other = store.authenticate(store.enrolCredential(owner, 'other-node', 'other').token);
  command(node, 'agent.register', { id: 'worker', nodeId: node.id, name: 'Worker', mode: 'headless' });
  command(owner, 'task.create', { id: 'task', title: 'Prepare report' });
  const request = command(owner, 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1,
    targetAgentId: 'worker', instructions: 'Prepare report', reviewPolicy: 'human' });
  const admitted = command(node, 'execution.admit', { id: request.id, expectedRevision: request.revision, bindingId: 'binding', runId: 'run' });
  const result = command(node, 'execution.submit', { id: admitted.id, expectedRevision: admitted.revision,
    candidate: 'commit:123', summary: 'Report ready', evidence: 'Native terminal receipt' });
  const payload = { id: 'artifact', executionId: result.id, expectedRevision: result.revision, runId: result.runId,
    resultDigest: result.result.digest, candidate: result.result.candidate, url: 'https://example.com/report', sha256: digest('report'), kind: 'report' };
  return { backend, store, ownerToken, owner, node, other, command, result, payload };
}

test('artifact references bind exact result and survive review without changing acceptance', async t => {
  const f = await fixture(t);
  const artifact = f.command(f.node, 'artifact.attach', f.payload, 'attach');
  assert.equal(artifact.taskId, 'task');
  assert.equal(artifact.authorNodeId, f.node.id);
  assert.equal(artifact.resultDigest, f.result.result.digest);
  assert.deepEqual(f.store.get('execution', f.result.id), f.result);
  const count = f.store.events().items.length;
  assert.deepEqual(f.command(f.node, 'artifact.attach', f.payload, 'attach'), artifact);
  assert.equal(f.store.events().items.length, count);
  assert.throws(() => f.command(f.node, 'artifact.attach', { ...f.payload, url: 'https://example.com/changed' }, 'attach'), { code: 'operation_conflict' });
  const accepted = f.command(f.owner, 'execution.review', { id: f.result.id, expectedRevision: f.result.revision,
    candidate: f.result.result.candidate, decision: 'accept', reason: 'Checked report' });
  const second = f.command(f.node, 'artifact.attach', { ...f.payload, id: 'after-review', expectedRevision: accepted.revision });
  assert.equal(second.resultDigest, artifact.resultDigest);
  assert.equal(f.store.snapshot().collections.artifact.length, 2);
  const headers = { Authorization: `Bearer ${f.ownerToken}` };
  const page = await (await fetch(`${f.backend.origin}/v1/artifacts?taskId=task&limit=1`, { headers })).json();
  assert.equal(page.items.length, 1);
  assert.equal(page.complete, false);
  const read = await (await fetch(`${f.backend.origin}/v1/artifacts/artifact`, { headers })).json();
  assert.deepEqual(read, artifact);
});

test('artifact authorisation and stale identities fail atomically', async t => {
  const f = await fixture(t);
  const count = f.store.events().items.length;
  for (const actor of [f.owner, f.other]) {
    assert.throws(() => f.command(actor, 'artifact.attach', f.payload), { code: 'forbidden' });
  }
  for (const changes of [{ runId: 'old' }, { candidate: 'different' }, { resultDigest: digest('different') }]) {
    assert.throws(() => f.command(f.node, 'artifact.attach', { ...f.payload, ...changes }), { code: 'stale_candidate' });
  }
  assert.throws(() => f.command(f.node, 'artifact.attach', { ...f.payload, expectedRevision: 1 }), { code: 'stale_revision' });
  assert.equal(f.store.all('artifact').length, 0);
  assert.equal(f.store.events().items.length, count);
});

test('artifact URLs and content digests are bounded references rather than local paths or credentials', async t => {
  const f = await fixture(t);
  const invalid = [
    { url: '/tmp/report' }, { url: 'file:///tmp/report' }, { url: 'http://example.com/report' },
    { url: 'https://user:secret@example.com/report' }, { url: ['https://example.com/report'] },
    { url: `https://example.com/${'a'.repeat(4096)}` }, { sha256: '123' }, { sha256: 'A'.repeat(64) },
    { sha256: ['a'.repeat(64)] }, { kind: 'local_path' },
  ];
  for (const changes of invalid) {
    assert.throws(() => f.command(f.node, 'artifact.attach', { ...f.payload, ...changes }, 'validation'), { code: 'invalid_artifact' });
  }
  assert.equal(f.store.all('artifact').length, 0);
  assert.equal(f.command(f.node, 'artifact.attach', f.payload, 'validation').id, f.payload.id);
});
