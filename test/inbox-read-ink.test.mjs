import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';
import { TaskBoardInkApp } from '../src/task-board-ink.mjs';

const h = React.createElement;
const tick = () => new Promise(resolve => setTimeout(resolve, 45));
const frame = instance => stripVTControlCharacters(instance.lastFrame());
async function input(instance, key) { instance.stdin.write(key); await tick(); }
async function inbox(instance) { await tick(); await input(instance, '\t'); await input(instance, '\t'); }
const base = { companies: [], agents: [], tasks: [], routines: [], projects: [], inbox: [], fetchedAt: new Date().toISOString() };
const result = id => ({ id: `result:${id}`, entityId: id, kind: 'run_result', instanceId: 'backend', revision: 1,
  title: `Result ${id}`, summary: 'Partial source coverage', from: 'Relay', stateLabel: 'completed · Unread result',
  action: 'notification.acknowledge', effect: 'Mark this result read. This does not approve the work.' });

test('one m marks the selected result read directly without opening details or a confirmation', async t => {
  const item = result('one'), writes = []; let read = false;
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: read ? [] : [item] }),
    detailInbox: async () => assert.fail('The list shortcut must not open details'),
    markInboxRead: async value => { writes.push(value); read = true; return { state: 'recorded', notificationId: item.entityId, message: 'Result marked read' }; },
    interval: 60000, width: 100, height: 28 }));
  t.after(() => instance.unmount()); await inbox(instance);
  assert.match(frame(instance), /m mark read/);
  await input(instance, 'm');
  assert.equal(writes.length, 1); assert.equal(writes[0].item.entityId, 'one'); assert.match(writes[0].key, /^human-read:/);
  assert.match(frame(instance), /Result marked read/); assert.match(frame(instance), /Inbox \(0\)/);
  assert.doesNotMatch(frame(instance), /Confirm this exact decision|Enter confirm|dismiss acknowledgement/);
});

test('the list exposes only five report lines while Enter details still scrolls to the full report tail', async t => {
  const summary = Array.from({ length: 40 }, (_, index) => `REPORT_LINE_${String(index + 1).padStart(2, '0')}`).join('\n');
  const first = { ...result('one'), summary }, second = result('two');
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [first, second] }),
    detailInbox: async () => first, decideInbox: async () => assert.fail('Reading details cannot publish'),
    markInboxRead: async () => assert.fail('Opening details cannot mark read'), interval: 60000, width: 90, height: 28 }));
  t.after(() => instance.unmount()); await inbox(instance);
  assert.match(frame(instance), /REPORT_LINE_01/); assert.match(frame(instance), /REPORT_LINE_05\.\.\./);
  assert.doesNotMatch(frame(instance), /REPORT_LINE_06|REPORT_LINE_40/); assert.match(frame(instance), /Result two/);
  await input(instance, '\r'); await input(instance, '\x1b[F');
  await input(instance, 'm');
  assert.match(frame(instance), /REPORT_LINE_40/);
  assert.equal(first.summary, summary);
});

test('m acknowledges reminders without changing questions, reviews, publications or disabled items', async t => {
  const reminder = { ...result('reminder'), kind: 'reminder', title: 'Remember this', stateLabel: 'Needs acknowledgement' };
  for (const item of [{ ...result('q'), kind: 'question', action: 'question.answer' },
    { ...result('review'), kind: 'review', action: 'execution.review' },
    { ...result('pending'), kind: 'publication', action: 'retry' },
    { ...result('disabled'), disabled: true }, reminder]) {
    let calls = 0;
    const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [item] }),
      markInboxRead: async () => { calls++; return { state: 'recorded', notificationId: item.entityId }; }, interval: 60000, width: 90, height: 24 }));
    try { await inbox(instance); await input(instance, 'm'); assert.equal(calls, item === reminder ? 1 : 0); }
    finally { instance.unmount(); }
  }
});

test('duplicate m input cannot publish two in-flight reads and completion does not steal a newer selection', async t => {
  const items = [result('one'), result('two'), result('three')], writes = [], opened = [];
  let release, readOne = false, order = items;
  const pending = new Promise(resolve => { release = resolve; });
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: order.filter(item => !readOne || item.entityId !== 'one') }),
    markInboxRead: async value => { writes.push(value); await pending; readOne = true; return { state: 'recorded', notificationId: 'one' }; },
    detailInbox: async ({ id }) => { opened.push(id); return items.find(item => item.id === id); }, decideInbox: async () => assert.fail('No decision'),
    interval: 60000, width: 100, height: 30 }));
  t.after(() => instance.unmount()); await inbox(instance);
  await input(instance, 'm'); await input(instance, 'm'); assert.equal(writes.length, 1);
  await input(instance, 'j'); order = [items[2], items[1], items[0]]; await input(instance, 'r');
  release(); await tick(); await tick(); await input(instance, '\r');
  assert.deepEqual(opened, ['result:two']);
});

test('marking the selected item after a preceding item disappears advances to its immediate neighbour', async t => {
  const items = [result('one'), result('two'), result('three'), result('four')];
  const removed = new Set(), opened = []; let release;
  const first = new Promise(resolve => { release = resolve; });
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: items.filter(item => !removed.has(item.entityId)) }),
    markInboxRead: async ({ item }) => { if (item.entityId === 'one') await first; removed.add(item.entityId); return { state: 'recorded', notificationId: item.entityId }; },
    detailInbox: async ({ id }) => { opened.push(id); return items.find(item => item.id === id); }, decideInbox: async () => assert.fail('No decision'),
    interval: 60000, width: 100, height: 30 }));
  t.after(() => instance.unmount()); await inbox(instance);
  await input(instance, 'm'); await input(instance, 'j'); release(); await tick(); await tick();
  await input(instance, 'm'); await input(instance, '\r');
  assert.deepEqual(opened, ['result:three']);
});

for (const mode of ['error', 'unconfirmed', 'wrong-identity']) test(`an unsuccessful read (${mode}) does not hide the selected item as acknowledged`, async t => {
  const item = result('one');
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [item] }),
    markInboxRead: async () => {
      if (mode === 'error') throw Error('Read transport unavailable');
      return mode === 'unconfirmed' ? { state: 'pending', notificationId: 'one' } : { state: 'recorded', notificationId: 'another-item' };
    }, interval: 60000, width: 100, height: 24 }));
  t.after(() => instance.unmount()); await inbox(instance); await input(instance, 'm');
  assert.match(frame(instance), /Result one/); assert.match(frame(instance), /Inbox \(1\)/);
  assert.match(frame(instance), /Read transport unavailable|Read acknowledgement is unconfirmed/);
});

test('typing m in search or pressing it outside Inbox does not acknowledge anything', async t => {
  const item = { ...result('one'), summary: 'm appears only in the full stored message' };
  let writes = 0;
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [item] }),
    markInboxRead: async () => { writes++; return { state: 'recorded', notificationId: item.entityId }; }, interval: 60000, width: 100, height: 24 }));
  t.after(() => instance.unmount()); await tick(); await input(instance, 'm'); assert.equal(writes, 0);
  await input(instance, '\t'); await input(instance, 'm'); assert.equal(writes, 0);
  await input(instance, '\t'); await input(instance, '/'); await input(instance, 'm'); await input(instance, '\r');
  assert.equal(writes, 0); assert.match(frame(instance), /Result one/);
});

test('search still finds hidden message text without expanding the five-line list preview', async t => {
  const item = { ...result('one'), summary: Array.from({ length: 30 }, (_, index) => `BODY_${index + 1}`).join('\n') + '\nHIDDEN_SEARCH_TAIL' };
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [item] }), detailInbox: async () => item,
    decideInbox: async () => assert.fail('Read-only detail'), interval: 60000, width: 100, height: 28 }));
  t.after(() => instance.unmount()); await inbox(instance);
  await input(instance, '/'); await input(instance, 'HIDDEN_SEARCH_TAIL'); await input(instance, '\r');
  assert.match(frame(instance), /Result one/); assert.doesNotMatch(frame(instance), /HIDDEN_SEARCH_TAIL/);
  await input(instance, '\r'); await input(instance, '\x1b[F'); assert.match(frame(instance), /HIDDEN_SEARCH_TAIL/);
});

test('a late read acknowledgement does not switch the human back from another view', async t => {
  const item = result('one'); let release, removed = false;
  const pending = new Promise(resolve => { release = resolve; });
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: removed ? [] : [item], grants: { pending: [], active: [], history: [] } }),
    markInboxRead: async () => { await pending; removed = true; return { state: 'recorded', notificationId: item.entityId }; }, interval: 60000, width: 100, height: 28 }));
  t.after(() => instance.unmount()); await inbox(instance); await input(instance, 'm'); await input(instance, '\t');
  assert.match(frame(instance), /RELAY \/ GRANTS/);
  release(); await tick(); await tick(); assert.match(frame(instance), /RELAY \/ GRANTS/);
});
