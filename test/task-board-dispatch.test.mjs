import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';
import { TaskBoardInkApp } from '../src/task-board-ink.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 45));
const task = { id: 'task', companyId: 'native', title: 'Send this task', status: 'todo', revision: 1, responsibleUserId: 'owner', assigneeUserId: 'owner' };
const board = { companies: [{ id: 'native', name: 'Relay' }], projects: [], routines: [], tasks: [task], inbox: [],
  agents: [{ id: 'agent', companyId: 'native', name: 'Worker', displayName: 'Worker', nodeId: 'node', nodeName: 'Destination', mode: 'interactive', availability: 'unknown' }] };
async function input(instance, text) { instance.stdin.write(text); await tick(); }
const frame = instance => stripVTControlCharacters(instance.lastFrame());

test('native a selects an enrolled agent, collects the handover and sends one execution request on Enter', async t => {
  const sent = [];
  const instance = render(React.createElement(TaskBoardInkApp, { read: async () => board, interval: 60000, width: 100, height: 26,
    dispatchTask: async value => { sent.push(value); return { state: 'recorded', execution: { taskId: 'task', targetAgentId: 'agent' }, message: 'Execution requested' }; } }));
  t.after(() => instance.unmount()); await tick(); await input(instance, 'j'); await input(instance, 'a');
  assert.match(frame(instance), /Assign task/); assert.match(frame(instance), /You \(human\)/); assert.match(frame(instance), /Worker/); assert.equal(sent.length, 0);
  await input(instance, 'j');
  await input(instance, '\r'); assert.match(frame(instance), /Handover/);
  await input(instance, '\r'); assert.equal(sent.length, 0); assert.match(frame(instance), /handover is required/);
  await input(instance, 'Read the handover and inspect only.'); await input(instance, '\r');
  assert.equal(sent.length, 1); assert.equal(sent[0].payload.instructions, 'Read the handover and inspect only.');
  assert.equal(sent[0].expectedRevision, 1); assert.equal(task.assigneeUserId, 'owner');
});

test('an uncertain native handover locks its exact payload instead of creating a fresh request on Enter', async t => {
  const sent = [];
  const instance = render(React.createElement(TaskBoardInkApp, { read: async () => board, interval: 60000, width: 90, height: 24,
    dispatchTask: async value => { sent.push(value); throw Error('Lost acknowledgement'); } }));
  t.after(() => instance.unmount()); await tick(); await input(instance, 'j'); await input(instance, 'a');
  await input(instance, 'j');
  await input(instance, '\r'); await input(instance, 'Only this check'); await input(instance, '\r');
  assert.match(frame(instance), /original request in Inbox/);
  await input(instance, '\r'); await input(instance, 'changed'); await input(instance, '\r'); assert.equal(sent.length, 1);
});

test('human is the first choice, previews current ownership and requires an explicit confirmed handback reason', async t => {
  const writes = [], preview = { taskId: 'task', expectedRevision: 3, executionId: 'run', executionRevision: 2, instanceId: 'backend', alreadyHuman: false };
  const instance = render(React.createElement(TaskBoardInkApp, { read: async () => board, interval: 60000, width: 90, height: 28,
    dispatchTask: async () => assert.fail('Human takeover must not dispatch'), prepareHandback: async () => preview,
    handbackTask: async input => { writes.push(input); return { state: 'recorded', message: 'With you' }; } }));
  t.after(() => instance.unmount()); await tick(); await input(instance, 'j'); await input(instance, 'a');
  await input(instance, '\r'); assert.match(frame(instance), /Take back from agent/);
  await input(instance, '\r'); assert.equal(writes.length, 0); assert.match(frame(instance), /reason is required/);
  await input(instance, 'I will finish it'); await input(instance, '\r'); assert.equal(writes.length, 0);
  assert.match(frame(instance), /Confirm this exact handback/);
  await input(instance, '\r'); assert.equal(writes.length, 1); assert.equal(writes[0].executionId, 'run'); assert.equal(writes[0].reason, 'I will finish it');
});
