import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';
import { TaskBoardInkApp, taskRowStyle } from '../src/task-board-ink.mjs';

const h = React.createElement;
const tick = () => new Promise(resolve => setTimeout(resolve, 40));
const board = { companies: [{ id: 'company', name: 'Acme' }], agents: [], projects: [], routines: [], warnings: [], fetchedAt: new Date().toISOString(),
  tasks: [{ id: 'task', companyId: 'company', identifier: 'DEF-1', title: 'Review costs', status: 'todo', priority: 'medium',
     assigneeUserId: 'local-board', assigneeAgentId: null, parentId: null, projectId: null }] };

for (const width of [100, 60, 40, 24]) test(`native Ink rows retain complete primary references at width ${width}`, async t => {
  const reference = 'ABCDEFGHIJKLMNOP-9007199254740991';
  const task = { ...board.tasks[0], reference, identifier: reference, title: 'Numbered task', attentionLabel: 'Long attention text that must not hide identity' };
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...board, inbox: [], tasks: [task] }), interval: 60000, width, height: 26 }));
  t.after(() => instance.unmount()); await tick();
  const frame = stripVTControlCharacters(instance.lastFrame());
  assert.ok(frame.replace(/[\s│]/g, '').includes(reference), frame);
  assert.doesNotMatch(frame, /DEF-1/);
});

test('Ink board permanently deletes a blocked agent-owned occurrence after explicit confirmation', async t => {
  const task = { ...board.tasks[0], status: 'blocked', assigneeUserId: null, assigneeAgentId: 'sweep-agent' };
  const sibling = { ...task, id: 'sibling', identifier: 'DEF-2', title: 'Another sweep' };
  const writes = []; let deleted = false;
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...board, tasks: deleted ? [sibling] : [task, sibling] }),
    inspectTask: async input => ({ task: input.taskId === task.id ? task : sibling, interactions: [], revision: 'delete-revision' }),
    statusTask: async () => assert.fail('Deletion must not use human status mutation'),
    deleteTask: async input => { writes.push(input); deleted = true; return { state: 'recorded', deleted: true,
      outcome: { confirmed: true, deleted: true }, task }; }, interval: 60000, width: 100, height: 26 }));
  t.after(() => instance.unmount());
  await tick(); instance.stdin.write('j'); await tick(); instance.stdin.write('j'); await tick(); instance.stdin.write('s'); await tick();
  let frame = stripVTControlCharacters(instance.lastFrame());
  assert.match(frame, /Delete permanently/); assert.doesNotMatch(frame, /● Todo|○ Todo/);
  instance.stdin.write('\r'); await tick();
  assert.equal(writes.length, 0);
  assert.match(stripVTControlCharacters(instance.lastFrame()), /Confirm permanent deletion of DEF-1/);
  instance.stdin.write('\r'); await tick();
  assert.equal(writes.length, 1); assert.equal(writes[0].taskId, 'task');
  assert.equal(writes[0].companyId, 'company'); assert.equal(writes[0].expectedRevision, 'delete-revision');
  assert.ok(writes[0].key);
  frame = stripVTControlCharacters(instance.lastFrame());
  assert.match(frame, /Deleted DEF-1/); assert.match(frame, /DEF-2/); assert.match(frame, /TASKS · 1/);
});

test('Ink board reports refused deletion without removing the task', async t => {
  const task = { ...board.tasks[0], status: 'blocked', assigneeUserId: null, assigneeAgentId: 'agent' };
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...board, tasks: [task] }),
    inspectTask: async () => ({ task, revision: 'revision', interactions: [] }),
    deleteTask: async () => { throw Error('Stop active execution before deleting its task'); },
    interval: 60000, width: 100, height: 26 }));
  t.after(() => instance.unmount()); await tick(); instance.stdin.write('j'); await tick(); instance.stdin.write('j'); await tick();
  instance.stdin.write('s'); await tick(); instance.stdin.write('\r'); await tick(); instance.stdin.write('\r'); await tick();
  assert.match(stripVTControlCharacters(instance.lastFrame()), /Stop active execution before deleting its task/);
  instance.stdin.write('\u001b'); await tick(); instance.stdin.write('\u001b'); await tick();
  assert.match(stripVTControlCharacters(instance.lastFrame()), /TASKS · 1/);
});

test('Ink human-owned task picker retains status changes alongside deletion', async t => {
  const writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => board,
    inspectTask: async () => ({ task: board.tasks[0], revision: 'status-revision', interactions: [] }),
    statusTask: async input => { writes.push(input); return { state: 'recorded', outcome: { confirmed: true },
      task: { ...board.tasks[0], status: input.payload.status } }; },
    deleteTask: async () => assert.fail('Status change must not delete'), interval: 60000, width: 100, height: 26 }));
  t.after(() => instance.unmount()); await tick(); instance.stdin.write('j'); await tick(); instance.stdin.write('s'); await tick();
  let frame = stripVTControlCharacters(instance.lastFrame());
  assert.match(frame, /● Todo/); assert.match(frame, /Delete permanently/);
  instance.stdin.write('j'); await tick(); instance.stdin.write('\r'); await tick(); instance.stdin.write('\r'); await tick();
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].payload, { status: 'in_progress' });
  frame = stripVTControlCharacters(instance.lastFrame()); assert.match(frame, /Changed DEF-1 to Active/);
});

test('Ink status notice resets to the default legend two seconds after the latest identical error', async t => {
  const instance = render(h(TaskBoardInkApp, { read: async () => board,
    inspectTask: async () => { throw Error('Backend unavailable'); }, interval: 60000, width: 100, height: 26 }));
  t.after(() => instance.unmount()); await tick(); instance.stdin.write('j'); await tick();
  instance.stdin.write('s'); await tick();
  assert.match(stripVTControlCharacters(instance.lastFrame()), /Status unavailable: Backend unavailable/);
  await new Promise(resolve => setTimeout(resolve, 1100));
  instance.stdin.write('s'); await tick();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.match(stripVTControlCharacters(instance.lastFrame()), /Status unavailable: Backend unavailable/);
  await new Promise(resolve => setTimeout(resolve, 1000));
  const frame = stripVTControlCharacters(instance.lastFrame());
  assert.doesNotMatch(frame, /Status unavailable/); assert.match(frame, /s status · q quit/);
});

test('Ink status modal overlays a dimmed board with highlighted selection and visible text cursor', async t => {
  const instance = render(h(TaskBoardInkApp, { read: async () => board,
    inspectTask: async () => ({ task: { ...board.tasks[0], blockedBy: [], blockedByIssueIds: [], unblockDescriptor: null }, interactions: [], revision: 'revision' }),
    statusTask: async () => assert.fail('No submission in overlay test'), interval: 60000, width: 90, height: 24 }));
  t.after(() => instance.unmount());
  await tick(); instance.stdin.write('j'); await tick(); instance.stdin.write('s'); await tick();
  let frame = instance.lastFrame(); const plain = stripVTControlCharacters(frame);
  assert.match(plain, /Human:/); assert.match(plain, /DEF-1/); assert.match(plain, /Change status · DEF-1/); assert.match(plain, /● Todo/);
  assert.match(plain, /Comment \(optional\)/);
});

test('Ink status comment stays inside a fixed scrolling text box', async t => {
  const instance = render(h(TaskBoardInkApp, { read: async () => board,
    inspectTask: async () => ({ task: { ...board.tasks[0], blockedBy: [], blockedByIssueIds: [], unblockDescriptor: null }, interactions: [], revision: 'revision' }),
    statusTask: async () => assert.fail('No submission in viewport test'), interval: 60000, width: 70, height: 24 }));
  t.after(() => instance.unmount());
  await tick(); instance.stdin.write('j'); await tick(); instance.stdin.write('s'); await tick(); instance.stdin.write('\t'); await tick();
  const comment = Array.from({ length: 40 }, (_, index) => `comment-${String(index + 1).padStart(2, '0')}`).join(' ');
  instance.stdin.write(comment); await tick();
  const frame = stripVTControlCharacters(instance.lastFrame()), lines = frame.split('\n');
  assert.ok(lines.length <= 24);
  assert.match(frame, /Comment \(optional\)/); assert.match(frame, /\d+\/4000 · \d+ lines/);
  assert.doesNotMatch(frame, /comment-01/); assert.match(frame, /comment-40/);
  assert.match(frame, /┌|└/); assert.match(frame, /Enter review · Esc cancel/);
});

test('Ink routine detail shows occurrences and opens an exactly correlated task', async t => {
  const routine = { id: 'routine:one', routineId: 'native-routine', companyId: 'company', title: 'Inbox sweep', state: 'active',
    executionMode: 'headless', cron: '0 * * * *', timezone: 'Africa/Johannesburg', nextRunAt: '2026-10-14T11:00:00Z', target: 'agent' };
  const occurrenceTask = { ...board.tasks[0], origin: { kind: 'routine_execution', routineId: 'native-routine', runId: 'run-one' } };
  const value = { ...board, routines: [routine], tasks: [occurrenceTask] };
  const details = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => value,
    inspectTask: async () => assert.fail('No status change'), statusTask: async () => assert.fail('No status change'),
    detailRoutine: async input => ({ ...routine, scheduleId: input.scheduleId, backendStatus: 'active', description: 'Sweep inbox',
      runs: [{ id: 'run-one', routineId: 'native-routine', companyId: 'company', status: 'completed', source: 'schedule',
        linkedIssueId: 'task', triggeredAt: '2026-10-14T10:00:00Z', completedAt: '2026-10-14T10:05:00Z' }] }),
    detailTask: async input => { details.push(input); return { task: { ...occurrenceTask, description: 'Full task detail' },
      result: { runId: 'relay-run', summary: 'Sweep completed with two messages triaged.', candidate: 'candidate-one' },
      comments: [{ id: 'comment', body: 'Publication receipt', authorAgentId: 'agent' }], revision: 'revision' }; },
    interval: 60000, width: 100, height: 26 }));
  t.after(() => instance.unmount());
  await tick(); instance.stdin.write('\r'); await tick();
  let frame = stripVTControlCharacters(instance.lastFrame());
  assert.match(frame, /CRON · Inbox sweep/); assert.match(frame, /DEF-1/); assert.match(frame, /completed/);
  instance.stdin.write('o'); await tick(); frame = stripVTControlCharacters(instance.lastFrame());
  assert.deepEqual(details, [{ companyId: 'company', taskId: 'task' }]); assert.match(frame, /Overview/);
  assert.match(frame, /Summary/); assert.match(frame, /Full task detail/); assert.doesNotMatch(frame, /Sweep completed/);
  instance.stdin.write('\t'); await tick(); frame = stripVTControlCharacters(instance.lastFrame());
  assert.match(frame, /Submitted result/); assert.match(frame, /Sweep completed with two messages triaged/); assert.doesNotMatch(frame, /Publication receipt/);
  instance.stdin.write('\t'); await tick(); frame = stripVTControlCharacters(instance.lastFrame());
  assert.match(frame, /Publication receipt/); assert.doesNotMatch(frame, /Full task detail/);
});

test('Ink board keeps separate sections, tree guides and the complete working shortcut legend', async t => {
  const parent = { ...board.tasks[0], id: 'parent', identifier: 'DEF-10', title: 'Parent', status: 'in_progress' };
  const child = { ...board.tasks[0], id: 'child', identifier: 'DEF-11', title: 'Child', parentId: 'parent', status: 'blocked' };
  const routine = { id: 'routine:one', routineId: 'native', companyId: 'company', title: 'Inbox sweep', state: 'active',
    executionMode: 'headless', cron: '0 * * * *', timezone: 'Africa/Johannesburg', nextRunAt: 'later', target: 'agent' };
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...board, routines: [routine], tasks: [parent, child] }),
    inspectTask: async () => assert.fail('No mutation'), statusTask: async () => assert.fail('No mutation'),
    detailTask: async () => ({}), detailRoutine: async () => ({}), interval: 60000, width: 110, height: 26 }));
  t.after(() => instance.unmount()); await tick();
  const frame = stripVTControlCharacters(instance.lastFrame());
  assert.match(frame, /CRON · 1/); assert.match(frame, /TASKS · 2/);
  assert.match(frame, /DEF-10/); assert.match(frame, /└─|├─/); assert.match(frame, /DEF-11/);
  const taskLines = frame.split('\n').filter(line => /DEF-1[01]/.test(line));
  assert.equal(taskLines.length, 2);
  assert.equal(taskLines[0].indexOf('[Active]'), taskLines[1].indexOf('[Blocked]'));
  assert.doesNotMatch(frame, /CRON.*Human: Board/);
  for (const shortcut of ['Enter/Tab detail', 'Space/←/→ fold', '/ search', 'h done', 'i idle', 'r refresh', 's status', 'q quit']) {
    assert.match(frame, new RegExp(shortcut.replaceAll('/', '\\/').replaceAll('←', '\\u2190').replaceAll('→', '\\u2192')));
  }
});

test('Ink task rows colour active and review states and dim terminal states', async t => {
  const tasks = [
    { ...board.tasks[0], id: 'todo', identifier: 'DEF-20', title: 'Todo task' },
    { ...board.tasks[0], id: 'active', identifier: 'DEF-21', title: 'Active task', status: 'in_progress' },
    { ...board.tasks[0], id: 'review', identifier: 'DEF-22', title: 'Review task', status: 'in_review' },
    { ...board.tasks[0], id: 'blocked', identifier: 'DEF-23', title: 'Blocked task', status: 'blocked' },
    { ...board.tasks[0], id: 'done', identifier: 'DEF-24', title: 'Done task', status: 'done' },
  ];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...board, tasks }),
    inspectTask: async () => assert.fail('No mutation'), statusTask: async () => assert.fail('No mutation'),
    detailTask: async () => assert.fail('No detail'), detailRoutine: async () => assert.fail('No routine'),
    interval: 60000, width: 90, height: 24 }));
  t.after(() => instance.unmount()); await tick(); instance.stdin.write('h'); await tick();
  const frame = instance.lastFrame(); for (const identifier of ['DEF-20', 'DEF-21', 'DEF-22', 'DEF-23', 'DEF-24']) assert.match(frame, new RegExp(identifier));
  assert.deepEqual(taskRowStyle(tasks[0]), { color: undefined, dimColor: false });
  assert.deepEqual(taskRowStyle(tasks[1]), { color: 'cyan', dimColor: false });
  assert.deepEqual(taskRowStyle(tasks[2]), { color: 'magenta', dimColor: false });
  assert.deepEqual(taskRowStyle(tasks[3]), { color: 'yellow', dimColor: false });
  assert.deepEqual(taskRowStyle(tasks[4]), { color: undefined, dimColor: true });
  assert.deepEqual(taskRowStyle(tasks[0], false, true), { color: undefined, dimColor: true });
});

test('Ink native cron detail shows paused taskless completion receipts and sanitises summaries', async t => {
  const routine = { id: 'native-job', companyId: 'native', title: 'native-job', state: 'paused', cron: '* * * * *',
    timezone: 'Africa/Johannesburg', executionMode: 'interactive_exact', backendStatus: 'applied', nextRunAt: null,
    nextRunIsEstimate: true, targetAgentId: 'chat', delivery: { state: 'paused', reason: 'Requested revision 2, applied 2' },
    runs: [{ id: 'occurrence', status: 'completed', triggeredAt: '2026-10-21T07:38:00Z', nativeOccurrence: true,
      linkedIssueId: null, summary: 'Cron completed\n\u001b[31m\u202e safely' }] };
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ companies: [{ id: 'native', name: 'Relay' }],
    agents: [], projects: [], tasks: [], routines: [routine], warnings: [] }),
  detailRoutine: async () => routine, detailTask: async () => assert.fail('Taskless occurrence must not open a task'),
  interval: 60000, width: 120, height: 26 }));
  t.after(() => instance.unmount()); await tick();
  assert.match(stripVTControlCharacters(instance.lastFrame()), /native-job.*paused/);
  instance.stdin.write('\r'); await tick();
  const frame = stripVTControlCharacters(instance.lastFrame());
  assert.match(frame, /CRON · native-job/); assert.match(frame, /clock preview/);
  assert.match(frame, /completed.*taskless.*Cron completed/);
  assert.doesNotMatch(frame, /identity mismatch|not on board|\u202e/);
});

test('Ink task detail clips long content and scrolls inside a fixed modal viewport', async t => {
  const description = Array.from({ length: 40 }, (_, index) => `Evidence line ${String(index + 1).padStart(2, '0')} with enough text to render.`).join('\n');
  const instance = render(h(TaskBoardInkApp, { read: async () => board,
    inspectTask: async () => assert.fail('No mutation'), statusTask: async () => assert.fail('No mutation'),
    detailRoutine: async () => assert.fail('No routine'),
    detailTask: async () => ({ task: { ...board.tasks[0], description }, result: null,
      comments: [{ id: 'comment', body: 'Latest note', authorUserId: 'human' }], revision: 'revision' }),
    interval: 60000, width: 90, height: 22 }));
  t.after(() => instance.unmount()); await tick(); instance.stdin.write('j'); await tick(); instance.stdin.write('\r'); await tick();
  let frame = stripVTControlCharacters(instance.lastFrame());
  assert.match(frame, /Evidence line 01/); assert.doesNotMatch(frame, /Evidence line 40/); assert.match(frame, /1-\d+\/\d+/);
  for (let i = 0; i < 30; i++) { instance.stdin.write('j'); await tick(); }
  frame = stripVTControlCharacters(instance.lastFrame());
  assert.doesNotMatch(frame, /Evidence line 01/); assert.match(frame, /Evidence line 2\d|Evidence line 3\d/);
  assert.match(frame, /↑↓ scroll · PgUp\/PgDn · Home\/End/);
  instance.stdin.write('\t'); await tick(); instance.stdin.write('\t'); await tick();
  frame = stripVTControlCharacters(instance.lastFrame()); assert.match(frame, /Latest note/); assert.match(frame, /1-2\/2/);
  instance.stdin.write('\t'); await tick(); frame = stripVTControlCharacters(instance.lastFrame());
  assert.match(frame, /Evidence line 2\d|Evidence line 3\d/);
});

test('Ink detail viewport stays inside a narrow terminal and keeps controls visible', async t => {
  const instance = render(h(TaskBoardInkApp, { read: async () => board,
    inspectTask: async () => assert.fail('No mutation'), statusTask: async () => assert.fail('No mutation'),
    detailRoutine: async () => assert.fail('No routine'),
    detailTask: async () => ({ task: { ...board.tasks[0], description: 'x '.repeat(500) }, result: null, comments: [], revision: 'revision' }),
    interval: 60000, width: 54, height: 16 }));
  t.after(() => instance.unmount()); await tick(); instance.stdin.write('j'); await tick(); instance.stdin.write('\r'); await tick();
  const lines = stripVTControlCharacters(instance.lastFrame()).split('\n');
  assert.ok(lines.length <= 16);
  assert.ok(lines.every(line => line.length <= 54));
  assert.match(lines.join('\n'), /PgUp\/PgDn/);
  assert.match(lines.join('\n'), /1-\d+\/\d+/);
});

test('Ink task details wrap unbroken text and reach its tail with End, then return to the title with Home', async t => {
  const title = 'A complete task title that is deliberately longer than its narrow modal header';
  const description = `START-${'x'.repeat(1400)}-END-OF-CONTENT`;
  const instance = render(h(TaskBoardInkApp, { read: async () => board,
    detailTask: async () => ({ task: { ...board.tasks[0], title, description }, result: null, comments: [], revision: 'revision' }),
    interval: 60000, width: 60, height: 20 }));
  t.after(() => instance.unmount()); await tick(); instance.stdin.write('j'); await tick(); instance.stdin.write('\r'); await tick();
  assert.match(stripVTControlCharacters(instance.lastFrame()), /START-/);
  instance.stdin.write('\x1b[F'); await tick();
  let output = stripVTControlCharacters(instance.lastFrame());
  assert.match(output, /END-OF-CONTENT/);
  assert.ok(output.split('\n').length <= 20);
  assert.ok(output.split('\n').every(line => line.length <= 60));
  instance.stdin.write('\x1b[H'); await tick();
  output = stripVTControlCharacters(instance.lastFrame());
  assert.match(output, /A complete task title/); assert.match(output, /1-\d+\/\d+/);
});

test('Ink assignment picker submits one freshly inspected assignment', async t => {
  const agents = [{ id: 'alpha', companyId: 'company', name: 'Alpha', availability: 'present' },
    { id: 'zulu', companyId: 'company', name: 'Zulu', availability: 'present' }];
  const writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...board, agents }),
    inspectTask: async () => ({ task: board.tasks[0], interactions: [], revision: 'assignment-revision' }),
    assignTask: async input => { writes.push(input); return { outcome: { confirmed: true }, task: { ...board.tasks[0], assigneeAgentId: 'zulu' } }; },
    statusTask: async () => assert.fail('No status change'), detailTask: async () => assert.fail('No detail'),
    detailRoutine: async () => assert.fail('No routine'), interval: 60000, width: 90, height: 24 }));
  t.after(() => instance.unmount()); await tick(); instance.stdin.write('j'); await tick(); instance.stdin.write('a'); await tick();
  let frame = stripVTControlCharacters(instance.lastFrame()); assert.match(frame, /Assign · DEF-1/); assert.match(frame, /Alpha/); assert.match(frame, /Zulu/);
  instance.stdin.write('j'); await tick(); instance.stdin.write('\r'); await tick();
  assert.equal(writes.length, 1); assert.equal(writes[0].expectedRevision, 'assignment-revision');
  assert.deepEqual(writes[0].payload, { assigneeAgentId: 'zulu' });
  frame = stripVTControlCharacters(instance.lastFrame()); assert.match(frame, /Assigned DEF-1 to Zulu/);
});

test('Ink task detail confirms the exact pending candidate review', async t => {
  const writes = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => board,
    inspectTask: async () => assert.fail('No inspection'), statusTask: async () => assert.fail('No status change'),
    detailRoutine: async () => assert.fail('No routine'),
    detailTask: async () => ({ task: { ...board.tasks[0], status: 'in_review', description: 'Review this result.' }, revision: 'review-revision', comments: [],
      result: { runId: 'run', summary: 'Result summary', candidate: 'candidate' },
      review: { runId: 'run', interactionId: 'interaction', candidate: 'candidate', summary: 'Result summary' } }),
    reviewTask: async input => { writes.push(input); return { state: 'recorded', receipt: { status: 'accepted' } }; },
    interval: 60000, width: 90, height: 24 }));
  t.after(() => instance.unmount()); await tick(); instance.stdin.write('j'); await tick(); instance.stdin.write('\r'); await tick();
  let frame = stripVTControlCharacters(instance.lastFrame()); assert.match(frame, /A approve · F\/R reject/);
  instance.stdin.write('A'); await tick(); frame = stripVTControlCharacters(instance.lastFrame()); assert.match(frame, /Approve · DEF-1/);
  instance.stdin.write('\r'); await tick();
  assert.equal(writes.length, 1); assert.equal(writes[0].candidate, 'candidate'); assert.equal(writes[0].expectedRevision, 'review-revision');
  assert.match(stripVTControlCharacters(instance.lastFrame()), /Approved DEF-1/);
});
