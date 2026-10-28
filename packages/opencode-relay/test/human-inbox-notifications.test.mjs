import assert from 'node:assert/strict';
import test from 'node:test';
import { humanInboxNotifications } from '../human-inbox-notifications.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  let session = 'human', callback, cleared = false;
  const toasts = [], events = [];
  const notifier = humanInboxNotifications({ notificationSessionId: 'human', selectedSession: () => session,
    load: async () => [{ kind: 'question', id: 'q', revision: 1 }], notify: toast => toasts.push(toast), record: event => events.push(event),
    schedule: fn => { callback = fn; return 1; }, unschedule: () => { cleared = true; }, ...options });
  return { notifier, toasts, events, select: id => { session = id; notifier.invalidate(); }, tick: () => callback(), cleared: () => cleared };
}

test('human inbox notifies only its configured selected session and deduplicates unchanged pending work', async () => {
  const f = fixture();
  await flush();
  assert.equal(f.toasts.length, 1);
  assert.match(f.toasts[0].message, /1 question\(s\).*\/relay-questions/);
  assert.equal(f.toasts[0].sessionID, 'human');
  await f.notifier.refresh(); assert.equal(f.toasts.length, 1);
  f.select('worker'); await f.notifier.refresh(); assert.equal(f.toasts.length, 1);
  f.select('human'); await f.notifier.refresh(); assert.equal(f.toasts.length, 2);
  f.notifier.stop(); assert.equal(f.cleared(), true);
});

for (const transition of ['switch', 'roundtrip', 'reconnect', 'dispose']) test(`in-flight human notification is fenced after ${transition}`, async () => {
  let complete;
  const f = fixture({ load: () => new Promise(resolve => { complete = resolve; }) });
  if (transition === 'switch' || transition === 'roundtrip') f.select('other');
  if (transition === 'roundtrip') f.select('human');
  if (transition === 'reconnect') f.notifier.invalidate();
  if (transition === 'dispose') f.notifier.stop();
  complete([{ kind: 'question', id: 'q', revision: 1 }]);
  await flush(); assert.equal(f.toasts.length, 0);
  f.notifier.stop();
});

test('human inbox avoids overlapping reads, reports outages once and recovers without sending a decision', async () => {
  let failed = true, calls = 0;
  const f = fixture({ load: async () => { calls++; if (failed) throw Error('secret must not appear in toast'); return [{ kind: 'review', id: 'e', revision: 4 }]; } });
  await flush(); assert.equal(f.toasts.length, 1);
  assert.doesNotMatch(f.toasts[0].message, /secret/);
  await f.notifier.refresh(); assert.equal(f.toasts.length, 1);
  failed = false;
  await f.notifier.refresh(); assert.equal(f.toasts.length, 2);
  assert.match(f.toasts[1].message, /1 review\(s\)/);
  assert.equal(calls, 3);
  f.notifier.stop();
  let complete;
  const g = fixture({ load: () => new Promise(resolve => { complete = resolve; calls++; }) });
  const before = calls;
  g.tick(); await g.notifier.refresh(); assert.equal(calls, before);
  complete([]); await flush(); assert.equal(g.toasts.length, 0); g.notifier.stop();
});

test('new revisions trigger a notification and resolved items clear the deduplication fingerprint', async () => {
  let items = [{ kind: 'question', id: 'q', revision: 1 }];
  const f = fixture({ load: async () => items });
  await flush();
  items = [{ kind: 'question', id: 'q', revision: 2 }];
  await f.notifier.refresh(); assert.equal(f.toasts.length, 2);
  items = []; await f.notifier.refresh(); assert.equal(f.toasts.length, 2);
  items = [{ kind: 'question', id: 'q', revision: 2 }];
  await f.notifier.refresh(); assert.equal(f.toasts.length, 3);
  f.notifier.stop();
});
