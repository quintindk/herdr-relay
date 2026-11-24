import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { attachmentView, readAttachmentStatus, watchAttachmentStatus } from '../attachment-status.mjs';

function watcher(t) {
  const f = { selected: 'a', updates: [], loads: [] };
  const watcher = watchAttachmentStatus({ selectedSession: () => f.selected, update: value => f.updates.push(value),
    load: session => new Promise((resolve, reject) => f.loads.push({ session, resolve, reject })),
    observeSelection: callback => { f.track = callback; return () => { f.selectionStopped = true; }; },
    subscribe: callback => { f.reconnect = callback; return () => { f.connectionStopped = true; }; },
    interval: (callback, ms) => { f.tick = callback; assert.equal(ms, 2000); return {}; }, clear: () => { f.timerStopped = true; } });
  f.watcher = watcher; t.after(watcher.stop); return f;
}

test('sidebar status is exact-chat, read-only and distinguishes an active receiver from historical attachment', async () => {
  const ctx = { options: {}, location: { directory: '/work' }, session: { get: async () => ({ id: 'a', location: { directory: '/work' } }) } };
  const options = { connection: () => ({ sessionId: 'a', agentId: 'agent' }), request: async (_connection, method, path, body) => {
    assert.equal(method, 'POST'); assert.equal(path, '/agent/status'); assert.deepEqual(body, {});
    return { sessionId: 'a', agentId: 'agent', agentName: 'Mason', receivingHere: true, receiver: { state: 'active', generation: 2 }, obligations: [] };
  } };
  const status = await readAttachmentStatus(ctx, { sessionId: 'a' }, options);
  assert.equal(status.state, 'attached'); assert.equal(status.agentName, 'Mason');
  assert.match(attachmentView(status, 'a').label, /Attached/);
  assert.doesNotMatch(attachmentView(status, 'b').label, /Attached/);
  assert.equal((await readAttachmentStatus(ctx, { sessionId: 'a' }, { ...options, request: async () => { throw Error('offline'); } })).state, 'unavailable');
  assert.equal((await readAttachmentStatus(ctx, { sessionId: 'a' }, { ...options, connection: () => { throw Object.assign(Error('none'), { code: 'relay_not_attached' }); } })).state, 'not_attached');
  await assert.rejects(readAttachmentStatus(ctx, { sessionId: 'b' }, options), /another workspace/);
});

for (const transition of ['switch', 'roundtrip', 'reconnect', 'dispose']) test(`late sidebar replies cannot claim attachment after ${transition}`, async t => {
  const f = watcher(t);
  if (transition === 'switch' || transition === 'roundtrip') { f.selected = 'b'; f.track('b'); }
  if (transition === 'roundtrip') { f.selected = 'a'; f.track('a'); }
  if (transition === 'reconnect') f.reconnect();
  if (transition === 'dispose') f.watcher.stop();
  f.loads[0].resolve({ sessionId: 'a', state: 'attached', agentName: 'Mason' }); await setImmediate();
  assert.equal(f.updates.some(value => value.state === 'attached'), false);
});

test('sidebar avoids overlapping reads, shows outages, recovers and disposes listeners/timer', async t => {
  const f = watcher(t); await f.tick(); assert.equal(f.loads.length, 1);
  f.loads[0].reject(Error('offline')); await setImmediate(); assert.equal(f.updates.at(-1).state, 'unavailable');
  f.tick(); f.loads[1].resolve({ sessionId: 'a', state: 'attached', generation: 3 }); await setImmediate();
  assert.equal(f.updates.at(-1).state, 'attached');
  f.watcher.stop(); assert.equal(f.timerStopped && f.connectionStopped && f.selectionStopped, true);
});

test('identical 2-second poll replies do not emit until status or session changes', async t => {
  const f = watcher(t);
  const attached = { sessionId: 'a', state: 'attached', generation: 3, obligations: 0 };
  const reply = async value => { f.loads.at(-1).resolve({ ...value }); await setImmediate(); };
  await reply(attached);
  for (let i = 0; i < 3; i++) { f.tick(); await reply(attached); }
  assert.equal(f.loads.length, 4);
  assert.deepEqual(f.updates, [{ sessionId: 'a', state: 'checking' }, attached]);

  const changed = { ...attached, obligations: 1 };
  f.tick(); await reply(changed);
  f.tick(); await reply(changed);
  f.selected = 'b'; f.track('b');
  const next = { ...changed, sessionId: 'b' }, checking = { sessionId: 'b', state: 'checking' };
  f.tick(); await reply(next);
  f.tick(); await reply(next);
  f.reconnect(); f.reconnect();
  assert.deepEqual(f.updates.slice(2), [changed, checking, next, checking, checking]);
});

test('sidebar text cannot inject terminal controls through agent names', () => {
  const view = attachmentView({ sessionId: 'a', state: 'attached', agentName: '\x1b[31mMason\n\u202eHidden', generation: 1 }, 'a');
  assert.doesNotMatch(view.title, /\x1b|\n|\u202e/);
  assert.doesNotMatch(view.identity, /\x1b|\n|\u202e/);
});

test('compact attachment card uses semantic states, shows agent/node and hides technical generation', () => {
  const view = attachmentView({ sessionId: 'a', state: 'attached', agentName: 'Mason', nodeName: 'Evo', generation: 42, obligations: 2 }, 'a');
  assert.equal(view.identity, 'Mason · Evo'); assert.equal(view.icon, '●'); assert.equal(view.tone, 'success');
  assert.equal(view.detail, '2 outstanding'); assert.doesNotMatch(view.detail, /Generation|42/);
  for (const [state, tone] of [['pending', 'warning'], ['unavailable', 'error'], ['not_attached', 'info']]) {
    const status = attachmentView({ sessionId: 'a', state }, 'a'); assert.equal(status.tone, tone); assert.ok(status.label); assert.ok(status.icon);
  }
  assert.equal(attachmentView({ sessionId: 'a', state: 'attached', agentName: 'Mason' }, 'b').identity, '');
});
