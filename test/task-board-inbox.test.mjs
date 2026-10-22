import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';
import { TaskBoardInkApp } from '../src/task-board-ink.mjs';
import { wrapBoardText, taskBoardColumns } from '../src/task-board-view.mjs';

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

test('native task columns use actual status width and reserve at least two thirds for titles', () => {
  assert.deepEqual(taskBoardColumns(100, ['[Todo]']), { title: 89, status: 6, gap: 1 });
  for (const width of [40, 54, 80, 100, 160, 240]) {
    const layout = taskBoardColumns(width, ['Long attention state '.repeat(8)]);
    assert.equal(layout.title + layout.status + layout.gap, width - 4);
    assert.ok(layout.status <= Math.floor((width - 4) / 3));
    assert.ok(layout.status <= 48);
  }
  assert.equal(taskBoardColumns(80, ['界界']).status, 4);
});

test('native board gives short statuses no unused fixed column and displays a longer task title', async t => {
  const title = 'A task title that previously disappeared into the oversized status column';
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, tasks: [{ ...task, title, status: 'todo', attentionLabel: '' }] }),
    detailInbox: async () => question, decideInbox: async () => assert.fail('Read-only layout'), interval: 60000, width: 100, height: 24 }));
  t.after(() => instance.unmount()); await tick();
  assert.match(frame(instance), /A task title that previously disappeared into the oversized status column/);
  assert.match(frame(instance), /\[Todo\]/);
});

test('long question scroll reaches the beginning and end without losing the answer or publishing it', async t => {
  const longQuestion = { ...question, summary: Array.from({ length: 45 }, (_, i) => `Question detail ${String(i + 1).padStart(2, '0')}`).join('\n') };
  const writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [longQuestion] }), detailInbox: async () => longQuestion,
    decideInbox: async value => { writes.push(value); return { state: 'recorded' }; }, interval: 60000, width: 90, height: 24 }));
  t.after(() => instance.unmount()); await tick(); await inbox(instance); await input(instance, '\r');
  await input(instance, 'Retained answer');
  assert.match(frame(instance), /Retained answer/);
  await input(instance, '\x1b[H');
  assert.match(frame(instance), /Question detail 01/); assert.match(frame(instance), /1–/);
  await input(instance, '\x1b[B'); assert.match(frame(instance), /2–/);
  await input(instance, '\x1b[A'); assert.match(frame(instance), /1–/);
  await input(instance, '\x1b[6~');
  assert.doesNotMatch(frame(instance), /Question detail 01/);
  await input(instance, '\x1b[F'); assert.match(frame(instance), /Retained answer/);
  await input(instance, '\r');
  await input(instance, '\x1b[H'); assert.match(frame(instance), /Question detail 01/);
  assert.equal(writes.length, 0);
  await input(instance, '\x1b[F'); await input(instance, '\r');
  assert.equal(writes.length, 1); assert.equal(writes[0].body, 'Retained answer');
});

test('review paging does not change the decision or reason while reading a long result', async t => {
  const item = { ...review, summary: Array.from({ length: 50 }, (_, i) => `Result line ${i + 1}`).join('\n') };
  const writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [item] }), detailInbox: async () => item,
    decideInbox: async value => { writes.push(value); return { state: 'recorded' }; }, interval: 60000, width: 90, height: 24 }));
  t.after(() => instance.unmount()); await tick(); await inbox(instance); await input(instance, '\r');
  await input(instance, '\x1b[B'); // Select request changes, not scroll, in the decision field.
  await input(instance, '\r'); await input(instance, 'Keep this review reason');
  await input(instance, '\x1b[H'); assert.match(frame(instance), /Result line 1/);
  await input(instance, '\x1b[6~'); await input(instance, '\x1b[F');
  assert.match(frame(instance), /Keep this review reason/);
  assert.equal(writes.length, 0);
  await input(instance, '\r'); await input(instance, '\r');
  assert.equal(writes[0].decision, 'reject'); assert.equal(writes[0].reason, 'Keep this review reason');
});

test('native board Inbox answers only after exact preview and confirmation, without slash commands', async t => {
  const writes = []; let resolved = false;
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: resolved ? [] : [question] }),
    detailInbox: async ({ id }) => { assert.equal(id, question.id); return question; },
    decideInbox: async value => { writes.push(value); resolved = true; return { state: 'recorded', message: question.effect }; }, interval: 60000, width: 110, height: 28 }));
  t.after(() => instance.unmount()); await tick();
  assert.match(frame(instance), /Inbox \(1\)/); assert.match(frame(instance), /Waiting for your answer/);
  await inbox(instance); assert.match(frame(instance), /Question · Prepare deployment/);
  await input(instance, '\r'); assert.match(frame(instance), /Which region should I use/);
  assert.match(frame(instance), /Your answer/); assert.doesNotMatch(frame(instance), /Identity: q/);
  await input(instance, 'South Africa North'); await input(instance, '\r');
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
  assert.match(frame(instance), /Enter preview/);
});

test('review requires a reason and explains that request changes does not dispatch another turn', async t => {
  const writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [review] }), detailInbox: async () => review,
    decideInbox: async value => { writes.push(value); return { state: 'recorded', message: review.rejectEffect }; }, interval: 60000, width: 110, height: 30 }));
  t.after(() => instance.unmount()); await tick();
  await inbox(instance); await input(instance, '\r');
  assert.doesNotMatch(frame(instance), /long-opaque-candidate/);
  await input(instance, '\x14'); assert.match(frame(instance), /long-opaque-candidate-identity/);
  await input(instance, '\x1b[B'); await input(instance, '\r'); await input(instance, '\r');
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
  await input(instance, 'Original answer'); await input(instance, '\r'); await input(instance, '\r');
  assert.equal(writes[0].item.revision, 1); assert.equal(writes[0].item.summary, question.summary);
});

test('uncertain publication locks the confirmed payload and retries with the original key', async t => {
  const writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => base, detailInbox: async () => question,
    decideInbox: async value => { writes.push(value); if (writes.length === 1) throw Error('Publication uncertain'); return { state: 'recorded', message: 'Original decision published' }; },
    interval: 60000, width: 110, height: 28 }));
  t.after(() => instance.unmount()); await tick(); await inbox(instance); await input(instance, '\r');
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
  assert.match(text, /Esc cancel/);
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

test('answering from task detail returns to Inbox with persistent acknowledgement and the next review visible', async t => {
  let answered = false;
  const writes = [], quit = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: answered ? [review] : [question] }),
    detailTask: async () => ({ task, actions: [question], comments: [], activity: [], revision: 2 }),
    detailInbox: async () => question, decideInbox: async value => { writes.push(value); answered = true; return { state: 'recorded', message: question.effect }; },
    onQuit: () => quit.push(true), interval: 60000, width: 110, height: 28 }));
  t.after(() => instance.unmount()); await tick();
  await input(instance, 'j'); await input(instance, '\r'); await input(instance, '\r');
  await input(instance, 't'); await input(instance, 'est word'); await input(instance, '\r');
  assert.equal(writes.length, 0);
  await input(instance, '\r');
  assert.equal(writes[0].body, 'test word');
  assert.match(frame(instance), /RELAY \/ INBOX/); assert.match(frame(instance), /Review · Review configuration/);
  assert.match(frame(instance), /Any required review will appear in this Inbox/);
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.match(frame(instance), /Answer recorded/);
  await input(instance, '\u001b'); assert.doesNotMatch(frame(instance), /Any required review will appear/); assert.equal(quit.length, 0);
  await input(instance, 'q'); assert.equal(quit.length, 1);
});

test('review choice and reason share one editor and survive returning from confirmation', async t => {
  const writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, inbox: [review] }), detailInbox: async () => review,
    decideInbox: async value => { writes.push(value); return { state: 'recorded', message: 'Changes requested.' }; }, interval: 60000, width: 110, height: 28 }));
  t.after(() => instance.unmount()); await tick(); await inbox(instance); await input(instance, '\r');
  assert.match(frame(instance), /Configuration prepared/); assert.match(frame(instance), /Review reason/);
  assert.match(frame(instance), /Accept result/); assert.match(frame(instance), /Request changes/);
  await input(instance, 'Correct the region');
  await input(instance, '\t'); await input(instance, '\x1b[B'); await input(instance, '\t'); await input(instance, '\r');
  assert.equal(writes.length, 0); assert.match(frame(instance), /Confirm this exact decision/);
  await input(instance, '\u001b'); assert.match(frame(instance), /Correct the region/);
  await input(instance, ' please'); await input(instance, '\r'); await input(instance, '\r');
  assert.equal(writes[0].decision, 'reject'); assert.equal(writes[0].reason, 'Correct the region please');
});

test('escaping the direct answer editor leaves the question unresolved without publishing a decision', async t => {
  const instance = render(h(TaskBoardInkApp, { read: async () => base, detailInbox: async () => question,
    decideInbox: async () => assert.fail('Unconfirmed draft must not be published'), interval: 60000, width: 54, height: 18 }));
  t.after(() => instance.unmount()); await tick(); await inbox(instance); await input(instance, '\r');
  await input(instance, 'Draft only'); await input(instance, '\u001b');
  assert.match(frame(instance), /Question · Prepare deployment/); assert.doesNotMatch(frame(instance), /Draft only/);
});
