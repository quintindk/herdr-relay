import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';
import { TaskBoardInkApp } from '../src/task-board-ink.mjs';

const h = React.createElement, tick = () => new Promise(resolve => setTimeout(resolve, 45));
const frame = instance => stripVTControlCharacters(instance.lastFrame());
const base = { companies: [], agents: [], tasks: [], routines: [], projects: [], inbox: [], fetchedAt: new Date().toISOString() };
const message = { id: 'owner-message:one', entityId: 'one', kind: 'owner_message', title: 'Validation checkpoint',
  summary: Array.from({ length: 40 }, (_, index) => `MESSAGE_LINE_${String(index + 1).padStart(2, '0')}`).join('\n'),
  from: 'Armarius', stateLabel: 'Unread message', revision: 1, instanceId: 'backend', action: 'owner_message.read',
  effect: 'Mark this message read. Full text and sender history remain unchanged.' };
async function input(instance, key) { instance.stdin.write(key); await tick(); }
async function inbox(instance) { await tick(); await input(instance, '\t'); await input(instance, '\t'); }

test('plain Inbox messages show their sender and five-line preview, with full scrollable details and no question/approval flow', async t => {
  const writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [message] }),
    detailInbox: async () => message, decideInbox: async value => { writes.push(value); return { state: 'recorded', message: 'Message marked read' }; },
    interval: 60000, width: 100, height: 28 }));
  t.after(() => instance.unmount()); await inbox(instance);
  assert.match(frame(instance), /Message · Validation checkpoint/); assert.match(frame(instance), /1 messages/); assert.match(frame(instance), /Armarius/);
  assert.match(frame(instance), /MESSAGE_LINE_05\.\.\./); assert.doesNotMatch(frame(instance), /MESSAGE_LINE_06|MESSAGE_LINE_40/);
  await input(instance, '\r'); await input(instance, '\x1b[F');
  assert.match(frame(instance), /MESSAGE_LINE_40/); assert.match(frame(instance), /Mark message read/);
  assert.doesNotMatch(frame(instance), /Your answer|Accept result|Request changes|Confirm this exact decision/);
  assert.equal(writes.length, 0); await input(instance, 'm');
  assert.equal(writes.length, 1); assert.equal(writes[0].item.action, 'owner_message.read');
  assert.ok(instance.frames.every(value => !stripVTControlCharacters(value).includes('Confirm this exact decision')));
});

test('one list m marks a plain message read without opening details or requiring confirmation', async t => {
  let removed = false; const writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: removed ? [] : [message] }),
    detailInbox: async () => assert.fail('List read must not open details'),
    markInboxRead: async value => { writes.push(value); removed = true; return { state: 'recorded', messageId: 'one', message: 'Message marked read' }; },
    interval: 60000, width: 100, height: 28 }));
  t.after(() => instance.unmount()); await inbox(instance); await input(instance, 'm');
  assert.equal(writes.length, 1); assert.equal(writes[0].item.kind, 'owner_message');
  assert.match(frame(instance), /Inbox \(0\)/); assert.match(frame(instance), /Message marked read/);
  assert.doesNotMatch(frame(instance), /Confirm this exact decision/);
});

test('opening and closing a plain message does not acknowledge it, and search retains the hidden body text', async t => {
  const item = { ...message, summary: message.summary + '\nHIDDEN_OWNER_TEXT' };
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [item] }), detailInbox: async () => item,
    decideInbox: async () => assert.fail('Inspection must not acknowledge'), markInboxRead: async () => assert.fail('Search must not acknowledge'),
    interval: 60000, width: 80, height: 25 }));
  t.after(() => instance.unmount()); await inbox(instance); await input(instance, '/'); await input(instance, 'HIDDEN_OWNER_TEXT'); await input(instance, '\r');
  assert.match(frame(instance), /Validation checkpoint/); assert.doesNotMatch(frame(instance), /HIDDEN_OWNER_TEXT/);
  await input(instance, '\r'); await input(instance, '\x1b[F'); assert.match(frame(instance), /HIDDEN_OWNER_TEXT/);
  await input(instance, '\x1b'); assert.match(frame(instance), /Inbox \(1\)/);
});
