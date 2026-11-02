import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';
import { TaskBoardInkApp } from '../src/task-board-ink.mjs';

const h = React.createElement;
const tick = () => new Promise(resolve => setTimeout(resolve, 40));

async function fixture(t, { width = 100, height = 28, enabled = true, secondAgent = false } = {}) {
  const f = { name: 'Original', writes: [], opened: [], pending: [], fail: false };
  const agent = () => ({ id: 'agent', companyId: 'native', name: `${f.name} @ Local`, rawName: f.name, displayName: f.name, nodeId: 'local', nodeName: 'Local',
    locality: 'local', mode: 'interactive', availability: 'present', directory: '/workspace', capabilities: [] });
  f.instance = render(h(TaskBoardInkApp, {
    read: async () => ({ companies: [{ id: 'native', name: 'Relay' }], projects: [], tasks: [], agents: [agent(),
      ...(secondAgent ? [{ ...agent(), id: 'another', name: 'Zulu @ Local', displayName: 'Zulu', rawName: 'Zulu' }] : [])], nodes: [{ id: 'local', name: 'Local' }],
      localNode: { id: 'local', name: 'Local' }, inbox: f.pending, routines: [], agentRenamingAvailable: enabled, warnings: [] }),
    detailAgent: async ({ agentId }) => { f.opened.push(agentId); return { agent: agent(), tasks: [] }; },
    prepareAgentRename: async ({ agentId }) => ({ agentId, name: f.name, expectedNameRevision: 0, nodeId: 'local', directory: '/workspace', instanceId: 'backend' }),
    renameAgent: async input => {
      f.writes.push(input);
      if (f.fail) {
        f.pending = [{ id: `publication:${input.key}`, key: input.key, kind: 'publication', title: 'Confirmed rename pending', summary: input.name,
          action: f.fail === 'refused' ? 'dismiss' : 'retry' }];
        throw Error('Rename acknowledgement is unconfirmed. Reconcile in Inbox');
      }
      f.name = input.name; f.pending = []; return { state: 'recorded', agent: { id: input.agentId, name: input.name, nameRevision: 1 } };
    },
    pendingDecisions: () => f.pending, interval: 60000, width, height,
  }));
  t.after(() => f.instance.unmount());
  f.key = async key => { f.instance.stdin.write(key); await tick(); };
  f.frame = () => stripVTControlCharacters(f.instance.lastFrame());
  await tick(); await f.key('\t'); await f.key('j');
  return f;
}

test('Agents n edits the raw name, previews and confirms one rename while keeping the selected agent identity', async t => {
  const f = await fixture(t, { secondAgent: true });
  assert.match(f.frame(), /n rename/);
  await f.key('n'); assert.match(f.frame(), /Rename Relay agent/);
  await f.key('\x15'); await f.key('ZZ Docs'); await f.key('\r');
  assert.match(f.frame(), /Confirm agent rename/); assert.equal(f.writes.length, 0);
  await f.key('\r'); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].agentId, 'agent'); assert.equal(f.writes[0].name, 'ZZ Docs');
  assert.equal(f.writes[0].expectedNameRevision, 0); assert.equal(f.writes[0].instanceId, 'backend'); assert.ok(f.writes[0].key);
  await f.key('\r'); assert.deepEqual(f.opened, ['agent']);
});

test('agent detail also offers rename and cancelling either edit or confirmation never publishes', async t => {
  const f = await fixture(t);
  await f.key('\r'); assert.match(f.frame(), /Agent details/); assert.match(f.frame(), /n rename/);
  await f.key('n'); await f.key('\x15'); await f.key('Not applied'); await f.key('\r');
  await f.key('\x1b'); assert.match(f.frame(), /Rename Relay agent/);
  await f.key('\x1b'); assert.doesNotMatch(f.frame(), /Rename Relay agent|Confirm agent rename/); assert.equal(f.writes.length, 0);
});

test('blank, unchanged and multiline names cannot reach confirmation or publish', async t => {
  const f = await fixture(t);
  await f.key('n'); await f.key('\r'); assert.match(f.frame(), /different name/);
  await f.key('\x15'); await f.key('\r'); assert.match(f.frame(), /1–256/);
  await f.key('First\nSecond'); assert.match(f.frame(), /single line/); assert.equal(f.writes.length, 0);
});

test('an uncertain rename locks its payload and retries only the original operation key', async t => {
  const f = await fixture(t); f.fail = true;
  await f.key('n'); await f.key('\x15'); await f.key('Docs'); await f.key('\r'); await f.key('\r');
  assert.equal(f.writes.length, 1); assert.match(f.frame(), /retry original/);
  await f.key('Cannot change'); f.fail = false; await f.key('\r');
  assert.equal(f.writes.length, 2); assert.deepEqual(f.writes[1], f.writes[0]);
  assert.equal(f.name, 'Docs'); assert.equal(f.pending.length, 0);
});

test('a backend without rename support has no rename control and sends no mutation', async t => {
  const f = await fixture(t, { enabled: false });
  assert.doesNotMatch(f.frame(), /n rename/); await f.key('n');
  assert.match(f.frame(), /Upgrade the backend/); assert.equal(f.writes.length, 0);
});

test('a definitively refused rename opens Inbox for inspection instead of resubmitting the refused decision', async t => {
  const f = await fixture(t); f.fail = 'refused';
  await f.key('n'); await f.key('\x15'); await f.key('Docs'); await f.key('\r'); await f.key('\r');
  assert.equal(f.writes.length, 1); assert.match(f.frame(), /inspect refusal/);
  await f.key('\r'); assert.match(f.frame(), /RELAY \/ INBOX/); assert.equal(f.writes.length, 1);
});

test('the rename editor keeps confirmation controls visible on narrow panes', async t => {
  const f = await fixture(t, { width: 40, height: 18 });
  await f.key('n'); await f.key('\x15'); await f.key('Long documentation agent name'); await f.key('\r');
  const frame = f.frame(); assert.match(frame, /Confirm agent rename/); assert.match(frame, /Enter apply/);
  assert.ok(frame.split('\n').length <= 18); assert.equal(f.writes.length, 0);
});
