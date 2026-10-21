import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeDecisionJournal } from '../src/native-decision-journal.mjs';

const command = { key: 'answer', action: 'question.answer', payload: { id: 'question', expectedRevision: 1, body: 'Human answer' } };
test('confirmed decision survives a failed preflight and process reopen with private durable state', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-decision-')), path = join(root, 'decisions.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let journal = new NativeDecisionJournal(path);
  await assert.rejects(journal.submit(async () => { throw Error('Offline before any network publication'); }, command, 'backend'), /Offline/);
  assert.equal(journal.pending().length, 1); assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => journal.dismiss('answer'), { code: 'decision_uncertain' });
  journal.close(); journal = new NativeDecisionJournal(path);
  const calls = [];
  const api = async (method, _path, body) => {
    if (method === 'GET') return { instanceId: 'backend' };
    calls.push(body); return { id: 'question', status: 'answered', answer: { body: 'Human answer', author: { type: 'user' } } };
  };
  await journal.retry(api, 'answer');
  assert.deepEqual(calls, [command]); assert.equal(journal.pending().length, 0);
  await journal.retry(api, 'answer'); assert.equal(calls.length, 1);
  journal.close();
});

test('malformed success is retained as uncertain instead of being reported as a confirmed human decision', async t => {
  const journal = new NativeDecisionJournal(); t.after(() => journal.close());
  await assert.rejects(journal.submit(async method => method === 'GET' ? { instanceId: 'backend' } : { id: 'different-question', status: 'answered' }, command, 'backend'),
    { code: 'invalid_decision_receipt' });
  assert.equal(journal.pending()[0].state, 'pending');
});

test('pending decisions cannot change payload, operation identity or backend scope', async t => {
  const journal = new NativeDecisionJournal(); t.after(() => journal.close());
  await assert.rejects(journal.submit(async () => { throw Error('Lost connection'); }, command, 'backend'));
  await assert.rejects(journal.submit(async () => assert.fail('No network call'), { ...command, payload: { ...command.payload, body: 'Changed' } }, 'backend'), { code: 'decision_conflict' });
  await assert.rejects(journal.submit(async () => assert.fail('No network call'), { ...command, key: 'new-key' }, 'backend'), { code: 'decision_pending' });
  let posts = 0;
  await assert.rejects(journal.retry(async method => {
    if (method === 'POST') posts++;
    return { instanceId: 'different-backend' };
  }, 'answer'), { code: 'backend_identity_changed' });
  assert.equal(posts, 0); assert.equal(journal.pending()[0].state, 'pending');
});

test('definitive refusal is not replayed and can be dismissed explicitly without deleting its record', async t => {
  const journal = new NativeDecisionJournal(); t.after(() => journal.close());
  const api = async method => {
    if (method === 'GET') return { instanceId: 'backend' };
    throw Object.assign(Error('Stale revision'), { code: 'stale_revision', status: 409 });
  };
  await assert.rejects(journal.submit(api, command, 'backend'), /Stale/);
  assert.equal(journal.pending()[0].state, 'conflict');
  await assert.rejects(journal.retry(api, 'answer'), { code: 'decision_conflict' });
  journal.dismiss('answer'); assert.equal(journal.pending().length, 0);
  assert.equal(journal.db.prepare('SELECT state FROM decisions WHERE key=?').get('answer').state, 'dismissed');
});
