import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';
import { TaskBoardInkApp } from '../src/task-board-ink.mjs';
import { wrapBoardText } from '../src/task-board-view.mjs';

const h = React.createElement, tick = () => new Promise(resolve => setTimeout(resolve, 45));
const question = { id: 'question:q', entityId: 'q', kind: 'question', title: 'Prepare deployment', summary: 'Which region should I use?',
  from: 'Wright', stateLabel: 'Waiting for your answer', revision: 1, instanceId: 'backend', action: 'question.answer',
  effect: 'Answer recorded. The worker can continue when eligible.' };
const review = { id: 'review:e', entityId: 'e', kind: 'review', title: 'Review configuration', summary: 'Configuration prepared',
  from: 'Wright', stateLabel: 'Ready for your review', revision: 6, candidate: 'long-opaque-candidate-identity', action: 'execution.review',
  acceptEffect: 'Accept this exact result and complete the task.', rejectEffect: 'Return the task to Todo. No revision turn is started automatically.' };
const task = { id: 'task', companyId: 'native', title: 'Prepare deployment', status: 'in_progress', responsibleUserId: 'owner',
  assigneeUserId: 'owner', executionAgentId: 'wright', executionAgentName: 'Wright', attentionLabel: 'Waiting for your answer' };
const base = { companies: [{ id: 'native', name: 'Relay' }], projects: [], agents: [{ id: 'wright', companyId: 'native', name: 'Wright' }],
  tasks: [task], routines: [], inbox: [question], showEmptyLocalBoard: false, fetchedAt: new Date().toISOString() };
const frame = instance => stripVTControlCharacters(instance.lastFrame());
async function input(instance, text) { instance.stdin.write(text); await tick(); }
async function inbox(instance) { await input(instance, '\t'); await input(instance, '\t'); }

test('native board Inbox answers only after exact preview and confirmation, without slash commands', async t => {
  const writes = []; let resolved = false;
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: resolved ? [] : [question] }),
    detailInbox: async ({ id }) => { assert.equal(id, question.id); return question; },
    decideInbox: async value => { writes.push(value); resolved = true; return { state: 'recorded', message: question.effect }; }, interval: 60000, width: 110, height: 28 }));
  t.after(() => instance.unmount()); await tick();
  assert.match(frame(instance), /Inbox \(1\)/); assert.match(frame(instance), /Waiting for your answer/);
  await inbox(instance); assert.match(frame(instance), /Question · Prepare deployment/);
  await input(instance, '\r'); assert.match(frame(instance), /Which region should I use/);
  assert.match(frame(instance), /Answer question/); assert.doesNotMatch(frame(instance), /Identity: q/);
  await input(instance, '\r'); await input(instance, 'South Africa North'); await input(instance, '\r');
  assert.equal(writes.length, 0); assert.match(frame(instance), /Confirm this exact decision/);
  assert.match(frame(instance), /South Africa North/);
  await input(instance, '\r');
  assert.equal(writes.length, 1); assert.equal(writes[0].body, 'South Africa North'); assert.match(writes[0].key, /^human-board:/);
  assert.match(frame(instance), /Inbox \(0\)/); assert.match(frame(instance), /No decisions need your attention/);
});

test('task Actions opens the same answer flow and keeps responsibility separate from execution', async t => {
  const opened = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => base,
    detailTask: async () => ({ task, actions: [question], comments: [], activity: [], revision: 2 }),
    detailInbox: async ({ id }) => { opened.push(id); return question; }, decideInbox: async () => assert.fail('No decision yet'),
    interval: 60000, width: 110, height: 28 }));
  t.after(() => instance.unmount()); await tick();
  await input(instance, 'j'); await input(instance, '\r');
  assert.match(frame(instance), /Actions/); assert.match(frame(instance), /Answer question/);
  await input(instance, '\t'); assert.match(frame(instance), /Responsible: owner/); assert.match(frame(instance), /Worker: Wright/);
  await input(instance, '\t'); await input(instance, '\t'); await input(instance, '\t'); await input(instance, '\t');
  await input(instance, '\r'); assert.deepEqual(opened, [question.id]);
  assert.match(frame(instance), /Enter open/);
});

test('review requires a reason and explains that request changes does not dispatch another turn', async t => {
  const writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [review] }), detailInbox: async () => review,
    decideInbox: async value => { writes.push(value); return { state: 'recorded', message: review.rejectEffect }; }, interval: 60000, width: 110, height: 30 }));
  t.after(() => instance.unmount()); await tick();
  await inbox(instance); await input(instance, '\r');
  assert.doesNotMatch(frame(instance), /long-opaque-candidate/);
  await input(instance, 't'); assert.match(frame(instance), /long-opaque-candidate-identity/);
  await input(instance, 'j'); await input(instance, '\r'); await input(instance, '\r');
  assert.equal(writes.length, 0); assert.match(frame(instance), /review reason is required/);
  await input(instance, 'Use the requested region'); await input(instance, '\r');
  assert.match(frame(instance), /No revision turn is started automatically/);
  await input(instance, '\r');
  assert.equal(writes[0].decision, 'reject'); assert.equal(writes[0].reason, 'Use the requested region');
});

test('native inbox selection follows identity across refresh reorder and a modal pins its original preview', async t => {
  let items = [question, review];
  const opened = [], writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: items }),
    detailInbox: async ({ id }) => { opened.push(id); return items.find(i => i.id === id); },
    decideInbox: async value => { writes.push(value); return { state: 'recorded' }; }, interval: 60000, width: 110, height: 28 }));
  t.after(() => instance.unmount()); await tick(); await inbox(instance);
  items = [review, question]; await input(instance, 'r'); await input(instance, '\r');
  assert.equal(opened[0], question.id);
  items = [{ ...question, revision: 99, summary: 'A different question' }];
  await input(instance, '\r'); await input(instance, 'Original answer'); await input(instance, '\r'); await input(instance, '\r');
  assert.equal(writes[0].item.revision, 1); assert.equal(writes[0].item.summary, question.summary);
});

test('uncertain publication locks the confirmed payload and retries with the original key', async t => {
  const writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => base, detailInbox: async () => question,
    decideInbox: async value => { writes.push(value); if (writes.length === 1) throw Error('Publication uncertain'); return { state: 'recorded', message: 'Original decision published' }; },
    interval: 60000, width: 110, height: 28 }));
  t.after(() => instance.unmount()); await tick(); await inbox(instance); await input(instance, '\r'); await input(instance, '\r');
  await input(instance, 'Pinned answer'); await input(instance, '\r'); await input(instance, '\r');
  assert.match(frame(instance), /Publication uncertain/);
  await input(instance, 'Do not change it'); await input(instance, '\r');
  assert.equal(writes.length, 2); assert.equal(writes[0].key, writes[1].key); assert.equal(writes[1].body, 'Pinned answer');
});

test('narrow native decision viewport sanitises source text and scrolls without overflowing controls', async t => {
  const wide = '界'.repeat(30) + '👨‍👩‍👧‍👦';
  const wrapped = wrapBoardText(wide, 10);
  assert.equal(wrapped.join(''), wide); assert.equal(wrapped[0], '界'.repeat(5));
  const item = { ...question, summary: '\u001b[31m\u202eWhich region? ' + 'Long context. '.repeat(80) };
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [item] }), detailInbox: async () => item,
    decideInbox: async () => assert.fail('No decision'), interval: 60000, width: 54, height: 18 }));
  t.after(() => instance.unmount()); await tick(); await inbox(instance); await input(instance, '\r');
  const text = frame(instance);
  assert.doesNotMatch(text, /\u202e/); assert.ok(text.split('\n').length <= 18);
  assert.ok(text.split('\n').every(line => [...line].length <= 54));
  assert.match(text, /Esc later/);
});

test('offline Inbox retains cached work and fetch time instead of reporting empty success', async t => {
  let failed = false;
  const instance = render(h(TaskBoardInkApp, { read: async () => { if (failed) throw Error('Backend offline'); return base; },
    interval: 60000, width: 120, height: 28 }));
  t.after(() => instance.unmount()); await tick(); await inbox(instance);
  failed = true; await input(instance, 'r');
  assert.match(frame(instance), /Inbox unavailable: showing cached state/);
  assert.match(frame(instance), /Question · Prepare deployment/);
  assert.match(frame(instance), /last updated .*SAST/);
  assert.doesNotMatch(frame(instance), /No decisions need your attention/);
});

test('Agents is separate from Tasks and exposes mode, node, machine, freshness and read-only detail', async t => {
  const agent = { id: 'wright', companyId: 'native', displayName: 'Wright', name: 'Wright @ Local node', mode: 'interactive',
    nodeName: 'Local node', nodeId: 'node-secret-identity', machineName: 'desktop', machinePlatform: 'linux', directory: '/work/wright',
    lastSeenAt: new Date().toISOString(), nodeLastSeenAt: new Date().toISOString(), availabilityLabel: 'Available (reported)', capabilities: [] };
  const idle = { ...agent, id: 'idle', displayName: 'Idle worker', name: 'Idle worker', mode: 'headless', availabilityLabel: 'Unknown or stale' };
  const opened = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, agents: [agent, idle] }), detailAgent: async input => {
    opened.push(input.agentId); return { agent, tasks: [{ title: task.title, attentionLabel: task.attentionLabel }] };
  }, interval: 60000, width: 120, height: 30 }));
  t.after(() => instance.unmount()); await tick();
  assert.doesNotMatch(frame(instance), /Idle worker/);
  await input(instance, '\t');
  assert.match(frame(instance), /Wright · interactive · Available \(reported\)/);
  assert.match(frame(instance), /Node: Local node.*Machine: desktop/);
  assert.match(frame(instance), /Idle worker · headless · Unknown or stale/);
  await input(instance, '\r');
  assert.deepEqual(opened, ['wright']);
  assert.match(frame(instance), /Machine: desktop \(linux\)/); assert.match(frame(instance), /Workspace: \/work\/wright/);
  assert.doesNotMatch(frame(instance), /node-secret-identity/);
  await input(instance, 't'); assert.match(frame(instance), /node-secret-identity/);
});

test('native visual layout uses a view-specific heading, contextual counters and a quiet empty state', async t => {
  const agents = [{ id: 'a', companyId: 'native', name: 'Interactive worker', mode: 'interactive' },
    { id: 'b', companyId: 'native', name: 'Headless worker', mode: 'headless' }];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, agents, inbox: [] }), interval: 60000, width: 110, height: 28 }));
  t.after(() => instance.unmount()); await tick();
  assert.match(frame(instance), /RELAY \/ TASKS/); assert.match(frame(instance), /╭|╰/);
  await input(instance, '\t');
  assert.match(frame(instance), /RELAY \/ AGENTS/); assert.match(frame(instance), /1 interactive\s+1 headless/);
  await input(instance, '\t');
  assert.match(frame(instance), /RELAY \/ INBOX/); assert.match(frame(instance), /0 questions\s+0 reviews\s+0 reminders/);
  assert.match(frame(instance), /No decisions need your attention/); assert.match(frame(instance), /Tab switches views/);
});

test('native cards and header remain inside a narrow terminal without changing navigation', async t => {
  const agents = [{ id: 'a', companyId: 'native', displayName: 'A very long interactive worker name', mode: 'interactive',
    nodeName: 'Long workstation label', machineName: 'desktop', directory: '/work/a-long-folder', availabilityLabel: 'Unknown or stale' }];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, agents }), interval: 60000, width: 54, height: 18 }));
  t.after(() => instance.unmount()); await tick(); await input(instance, '\t');
  const lines = frame(instance).split('\n');
  assert.ok(lines.length <= 18); assert.ok(lines.every(line => [...line].length <= 54));
  assert.match(frame(instance), /RELAY \/ AGENTS/);
  await input(instance, '\t'); assert.match(frame(instance), /Question · Prepare deployment/);
});
