import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BackendStore } from '../src/backend-store.mjs';
import { nativeBoard } from '../src/native-board.mjs';
import { NativeDecisionJournal } from '../src/native-decision-journal.mjs';
import { canMarkInboxRead } from '../src/inbox-read.mjs';
import { digest } from '../src/protocol.mjs';

function fixture(t) {
  const store = new BackendStore(':memory:');
  const journal = new NativeDecisionJournal();
  t.after(() => { journal.close(); store.close(); });
  const owner = store.authenticate(store.bootstrap().token);
  let sequence = 0;
  const command = (actor, action, payload) => store.command(actor, { key: `fixture-${++sequence}`, action, payload });
  command(owner, 'node.enrol', { id: 'node', name: 'Local' });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'fixture').token);
  command(node, 'agent.register', { id: 'worker', nodeId: 'node', name: 'Worker', mode: 'interactive' });
  command(owner, 'schedule.install', { id: 'job', definition: { nodeId: 'node', targetAgentId: 'worker', instructions: 'Fixture only', cron: '* * * * *',
    enabled: true, reviewPolicy: 'none', runResultNotifications: { inbox: true, requester: false } } });
  const at = '2026-11-14T06:00:00.000Z', occurrenceId = `occurrence_${digest(['job', at])}`;
  const summary = Array.from({ length: 40 }, (_, index) => `FULL_REPORT_LINE_${index + 1}`).join('\n');
  command(node, 'schedule.publish', { id: occurrenceId, scheduleId: 'job', definitionRevision: 1, intendedAt: at,
    candidate: 'fixture-candidate', summary, evidence: 'Disposable fixture only' });
  command(owner, 'schedule.install', { id: 'reminder', definition: { nodeId: 'node', intent: 'reminder', instructions: 'Remember the report', cron: '* * * * *', enabled: true } });
  const reminderId = `occurrence_${digest(['reminder', at])}`;
  command(node, 'schedule.remind', { id: reminderId, scheduleId: 'reminder', definitionRevision: 1, intendedAt: at, message: 'Remember the report' });
  const operator = { type: 'user', id: store.owner, scope: { kind: 'node_operator', nodeId: 'node', mode: 'localUser' } };
  const writes = [];
  const api = async (method, path, body) => {
    if (path === '/v1/info') return { userId: store.owner, instanceId: store.instance, features: {} };
    if (method === 'POST') { writes.push(body); return store.command(operator, body); }
    const [collection, id] = path.slice('/v1/'.length).split('?')[0].split('/');
    return id ? store.get(collection.slice(0, -1), decodeURIComponent(id)) : { items: store.all(collection.slice(0, -1)), nextCursor: null };
  };
  return { store, owner, journal, api, writes, occurrenceId, reminderId, summary, board: nativeBoard(api, { decisionJournal: journal }) };
}

test('direct mark-as-read acknowledges informational results/reminders and preserves complete detail and business state', async t => {
  const f = fixture(t), snapshot = await f.board.read();
  for (const kind of ['run_result', 'reminder']) {
    const item = snapshot.inbox.find(entry => entry.kind === kind);
    const before = f.store.get('notification', item.entityId);
    const result = await f.board.markInboxRead({ item, key: `read-${kind}` });
    assert.equal(result.state, 'recorded'); assert.equal(result.notificationId, item.entityId);
    assert.equal(f.store.get('notification', item.entityId).revision, before.revision + 1);
    assert.equal(f.store.get('notification', item.entityId).state, 'acknowledged');
    assert.equal(f.writes.at(-1).action, 'notification.acknowledge');
    assert.deepEqual(f.writes.at(-1).payload, { id: item.entityId, expectedRevision: item.revision });
  }
  assert.equal(snapshot.inbox.find(item => item.kind === 'run_result').summary, f.summary);
  assert.equal(f.store.get('occurrence', f.occurrenceId).state, 'completed');
  assert.equal(f.store.get('occurrence', f.occurrenceId).summary, f.summary);
  assert.equal(f.store.get('schedule', 'job').revision, 1);
  assert.equal((await f.board.read()).inbox.length, 0);
  assert.equal(f.journal.pending().length, 0);
});

test('mark-as-read cannot answer questions, approve reviews, retry/dismiss publications or acknowledge disabled/malformed items', async t => {
  const f = fixture(t), item = (await f.board.read()).inbox.find(entry => entry.kind === 'run_result');
  for (const invalid of [{ ...item, kind: 'question', action: 'question.answer' }, { ...item, kind: 'review', action: 'execution.review' },
    { ...item, kind: 'publication', action: 'retry' }, { ...item, kind: 'publication', action: 'dismiss' }, { ...item, disabled: true },
    { ...item, action: 'question.answer' }, { ...item, revision: 0 }, { ...item, instanceId: null }]) {
    await assert.rejects(f.board.markInboxRead({ item: invalid, key: 'must-not-write' }), { code: 'read_unavailable' });
  }
  assert.equal(canMarkInboxRead({ kind: 'run_result', action: 'execution.review' }), false);
  assert.equal(f.writes.length, 0); assert.equal(f.journal.pending().length, 0);
});

test('a lost read acknowledgement reuses its original persisted key even when the shortcut supplies another key', async t => {
  const f = fixture(t); let lose = true;
  const api = async (...args) => {
    const result = await f.api(...args);
    if (args[0] === 'POST' && lose) { lose = false; throw Error('Lost read acknowledgement'); }
    return result;
  };
  const board = nativeBoard(api, { decisionJournal: f.journal });
  const item = (await board.read()).inbox.find(entry => entry.kind === 'run_result');
  await assert.rejects(board.markInboxRead({ item, key: 'original-read' }), /Lost read acknowledgement/);
  assert.equal(f.journal.pending().length, 1);
  assert.equal(f.store.get('notification', item.entityId).revision, 2);
  await board.markInboxRead({ item, key: 'must-reuse-original' });
  assert.deepEqual(f.writes.map(command => command.key), ['original-read', 'original-read']);
  assert.equal(f.store.get('notification', item.entityId).revision, 2);
  assert.equal(f.journal.pending().length, 0);
});

test('repeating a confirmed read from the same cached card reuses its receipt without another write', async t => {
  const f = fixture(t), item = (await f.board.read()).inbox.find(entry => entry.kind === 'run_result');
  await f.board.markInboxRead({ item, key: 'first-read' });
  await f.board.markInboxRead({ item, key: 'second-click-before-refresh' });
  assert.equal(f.writes.length, 1);
  assert.equal(f.store.get('notification', item.entityId).revision, 2);
  assert.equal(f.journal.pending().length, 0);
});

test('pending reads survive journal reopen and do not become a fresh read operation', async t => {
  const f = fixture(t), root = mkdtempSync('/tmp/opencode/inbox-read-journal-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'decisions.sqlite');
  let journal = new NativeDecisionJournal(path);
  try {
    const board = nativeBoard(async (...args) => {
      const result = await f.api(...args);
      if (args[0] === 'POST') throw Error('Lost persisted read reply');
      return result;
    }, { decisionJournal: journal });
    const item = (await board.read()).inbox.find(entry => entry.kind === 'run_result');
    await assert.rejects(board.markInboxRead({ item, key: 'persisted-read' }));
    journal.close(); journal = new NativeDecisionJournal(path);
    const reopened = nativeBoard(f.api, { decisionJournal: journal });
    await reopened.markInboxRead({ item, key: 'not-another-key' });
    assert.deepEqual(f.writes.map(command => command.key), ['persisted-read', 'persisted-read']);
    assert.equal(journal.pending().length, 0);
  } finally { journal.close(); }
});

test('a malformed acknowledgement revision remains uncertain instead of disappearing as a confirmed read', async t => {
  const f = fixture(t); let malformed = true;
  const board = nativeBoard(async (...args) => {
    const result = await f.api(...args);
    return args[0] === 'POST' && malformed ? { ...result, revision: 999 } : result;
  }, { decisionJournal: f.journal });
  const item = (await board.read()).inbox.find(entry => entry.kind === 'run_result');
  await assert.rejects(board.markInboxRead({ item, key: 'read-with-wrong-receipt' }), { code: 'invalid_decision_receipt' });
  assert.equal(f.journal.pending()[0].state, 'pending');
  malformed = false;
  await board.markInboxRead({ item, key: 'reuse-wrong-receipt-key' });
  assert.deepEqual(f.writes.map(command => command.key), ['read-with-wrong-receipt', 'read-with-wrong-receipt']);
  assert.equal(f.store.get('notification', item.entityId).revision, 2);
});

test('a refused stale read requires inspection and cannot generate another publication through repeated shortcuts', async t => {
  const f = fixture(t), item = (await f.board.read()).inbox.find(entry => entry.kind === 'run_result');
  f.store.command(f.owner, { key: 'another-terminal', action: 'notification.acknowledge',
    payload: { id: item.entityId, expectedRevision: 1 } });
  await assert.rejects(f.board.markInboxRead({ item, key: 'stale-read' }), { code: 'stale_revision' });
  await assert.rejects(f.board.markInboxRead({ item, key: 'do-not-publish-again' }), { code: 'decision_pending' });
  assert.equal(f.writes.length, 1); assert.equal(f.journal.pending()[0].state, 'conflict');
  assert.equal(f.store.get('notification', item.entityId).revision, 2);
});
