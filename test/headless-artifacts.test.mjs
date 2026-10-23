import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { NodeJournal } from '../src/node-journal.mjs';
import { digest } from '../src/protocol.mjs';
import { headlessArtifactOperation, recordHeadlessObservation, probeHeadlessArtifacts } from '../src/headless-artifacts.mjs';
import { validateHeadlessCapabilities } from '../src/headless-capabilities.mjs';

function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/headless-artifacts-test-'), db = join(root, 'node.sqlite');
  let journal = new NodeJournal(db, { nodeId: 'node', instanceId: 'backend' });
  const scope = { id: `setup-${digest(root)}`, directory: root, profile: { sourceNamespaces: ['external:record'], taskActions: [],
    artifacts: { receipts: 'approved/receipts', state: 'approved/state.json', history: 'approved/history', runs: 'approved/runs', summaries: 'approved/summaries' } } };
  const work = { id: 'execution', execution: { runId: 'run' } }, source = { namespace: 'external:record', externalId: 'record' };
  const call = input => headlessArtifactOperation(journal, scope, work, input);
  t.after(() => { journal.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, scope, work, source, call, journal: () => journal, reopen: () => { journal.close(); journal = new NodeJournal(db, { nodeId: 'node', instanceId: 'backend' }); } };
}

test('headless capability profiles approve exact actions and paths without a business-job schema', () => {
  const profile = { sourceNamespaces: ['external:record'], taskActions: ['comment.create'], artifacts: { receipts: 'data/receipts', state: 'data/state.json', history: 'data/history', runs: 'data/runs', summaries: '/tmp/opencode' } };
  assert.equal(validateHeadlessCapabilities(profile), profile);
  for (const changes of [{ taskActions: ['execution.request'] }, { artifacts: { ...profile.artifacts, receipts: '../../private' } }, { artifacts: { ...profile.artifacts, state: '/private/owner.json' } }, { extraBusinessPolicy: 75 }])
    assert.throws(() => validateHeadlessCapabilities({ ...profile, ...changes }), { code: 'invalid_headless_capabilities' });
});

test('receipts are idempotent, CAS guarded, history-preserving and survive journal reopen', t => {
  const f = fixture(t), input = { operation: 'receipt', key: 'capture', source: f.source, action: 'intake', expectedRevision: 0, status: 'pending', data: { ask: 'Inspect evidence' } };
  const initial = f.call(input); assert.equal(initial.revision, 1); assert.equal(initial.projection, 'confirmed');
  f.reopen(); assert.deepEqual(f.call(input), initial);
  const update = f.call({ ...input, key: 'resolved', expectedRevision: 1, status: 'no_change', data: { outcome: 'Already handled' } });
  assert.equal(update.revision, 2); assert.equal(readdirSync(join(f.root, 'approved/history')).length, 2);
  assert.equal(f.call({ operation: 'read', id: initial.id, revision: 1 }).status, 'pending');
  assert.throws(() => f.call({ ...input, key: 'stale' }), { code: 'stale_revision' });
  assert.throws(() => f.call({ ...input, data: { changed: true } }), { code: 'operation_conflict' });
});

test('checkpoint commits are generic durability barriers, not business watermark or source-coverage interpreters', t => {
  const f = fixture(t), receipt = f.call({ operation: 'receipt', key: 'capture', source: f.source, action: 'intake', expectedRevision: 0, status: 'uncertain', data: { originalKey: 'operation' } });
  const checkpoint = { operation: 'checkpoint', key: 'checkpoint', expectedRevision: 0, data: { opaqueCursor: 'job-defined-token', arbitraryJobState: { stage: 'waiting' } }, receiptIds: [receipt.id] };
  assert.throws(() => f.call(checkpoint), { code: 'headless_receipts_unsettled' });
  f.call({ operation: 'receipt', key: 'resolved', source: f.source, action: 'intake', expectedRevision: 1, status: 'failed', data: { outcome: 'Known failure, contract decides whether business progress is allowed' } });
  const result = f.call(checkpoint); assert.equal(result.revision, 1); assert.equal(result.businessPolicy, 'external_job_contract');
  assert.deepEqual(f.call(checkpoint), result);
  assert.deepEqual(f.call({ operation: 'state' }).document._relayHeadless.data, checkpoint.data);
  assert.throws(() => f.call({ ...checkpoint, key: 'stale-checkpoint' }), { code: 'stale_revision' });
});

test('legacy artifacts and state fields remain unchanged until an explicit hashed reconciliation', t => {
  const f = fixture(t); const initial = f.call({ operation: 'receipt', key: 'init', source: f.source, action: 'intake', expectedRevision: 0, status: 'no_change', data: {} });
  const legacy = '{"old":"receipt","outcome":"unknown"}\n', state = '{"jobField":"Keep me"}';
  writeFileSync(join(f.root, 'approved/receipts/old.json'), legacy); writeFileSync(join(f.root, 'approved/state.json'), state);
  const old = f.call({ operation: 'read', legacyFile: 'old.json' });
  const checkpoint = { operation: 'checkpoint', key: 'checkpoint', expectedRevision: 0, data: { cursor: 'opaque' }, receiptIds: [initial.id] };
  assert.throws(() => f.call(checkpoint), { code: 'headless_legacy_unreconciled' });
  f.call({ operation: 'receipt', key: 'reconcile', source: f.source, action: 'intake', expectedRevision: 1, status: 'no_change', data: { evidence: 'Retained' }, legacyRefs: [{ fileName: 'old.json', sha256: old.sha256 }] });
  f.call(checkpoint);
  assert.equal(readFileSync(join(f.root, 'approved/receipts/old.json'), 'utf8'), legacy);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'approved/state.json'))).jobField, 'Keep me');
  const backup = readdirSync(join(f.root, 'approved/history')).find(n => n.startsWith('legacy-state-'));
  assert.equal(readFileSync(join(f.root, 'approved/history', backup), 'utf8'), state);
});

test('artifact paths reject traversal, symlinks and external edits without discarding them', t => {
  const f = fixture(t), input = { operation: 'receipt', key: 'one', source: f.source, action: 'intake', expectedRevision: 0, status: 'no_change', data: {} };
  const r = f.call(input), path = join(f.root, 'approved/receipts', `${r.id}.json`); writeFileSync(path, '{"externalEdit":true}');
  assert.equal(f.call({ operation: 'read', id: r.id }).projection, 'conflict');
  assert.throws(() => f.call({ ...input, key: 'overwrite', expectedRevision: 1 }), { code: 'headless_artifact_conflict' });
  assert.throws(() => f.call({ operation: 'read', legacyFile: '../../owner.json' }), { code: 'headless_artifact_path_forbidden' });
  unlinkSync(path); symlinkSync(join(f.root, 'node.sqlite'), path);
  assert.throws(() => f.call({ operation: 'read', id: r.id }), { code: 'headless_artifact_file_forbidden' });
});

test('durable intent is replayed after a crash, never as another artifact or an invented completion', t => {
  const f = fixture(t), transaction = f.journal().transaction.bind(f.journal()); let once = true;
  f.journal().transaction = fn => { const result = transaction(fn); if (once) { once = false; throw Error('Simulated crash after intent'); } return result; };
  const input = { operation: 'receipt', key: 'durable', source: f.source, action: 'intake', expectedRevision: 0, status: 'uncertain', data: { originalKey: 'same' } };
  assert.throws(() => f.call(input), /Simulated crash/); f.reopen(); assert.equal(f.call(input).revision, 1);
  assert.equal(f.call({ operation: 'inventory' }).receipts.length, 1);
});

test('native applied outcomes require a confirmed backend operation, not model-authored success text', t => {
  const f = fixture(t);
  assert.throws(() => f.call({ operation: 'receipt', key: 'task', source: f.source, action: 'task.create', expectedRevision: 0, status: 'applied', data: { operationId: 'invented' } }), { code: 'headless_outcome_unverified' });
});

test('capability canaries are isolated from real artifacts and test only granted artifact paths', t => {
  const f = fixture(t), proof = probeHeadlessArtifacts(f.journal(), f.scope, f.work);
  assert.equal(proof.checkpointGuard, true); assert.equal(proof.runSummary, true);
  assert.deepEqual(probeHeadlessArtifacts(f.journal(), f.scope, f.work), proof);
  assert.equal(f.call({ operation: 'state' }).revision, 0); assert.equal(f.call({ operation: 'inventory' }).receipts.length, 0);
  assert.equal(probeHeadlessArtifacts(f.journal(), { ...f.scope, profile: { ...f.scope.profile, artifacts: undefined } }, f.work).granted, false);
});
