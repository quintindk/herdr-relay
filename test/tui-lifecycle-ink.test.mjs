import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';
import { TaskBoardInkApp } from '../src/task-board-ink.mjs';
import { previewCron } from '../src/cron-schedule.mjs';

const h = React.createElement;
const tick = () => new Promise(resolve => setTimeout(resolve, 40));

async function fixture(t, { width = 110, height = 32, supported = true, schedules = false } = {}) {
  const agent = { id: 'agent', name: 'Unused agent', displayName: 'Unused agent', nodeId: 'local', nodeName: 'Local',
    companyId: 'native', mode: 'interactive', locality: 'local', directory: '/workspace', capabilities: [], standingGrant: { scheduleManagement: true } };
  const f = { agents: [agent], pending: [], writes: [], previews: [], blocked: false, fail: false,
    routines: schedules ? [{ id: 'schedule', companyId: 'native', title: 'Existing schedule', state: 'active', enabled: true, revision: 1,
      cron: '* * * * *', timezone: 'Africa/Johannesburg', targetAgentId: agent.id, ownerNodeId: 'local', intent: 'job' }] : [] };
  const write = (action, input) => {
    f.writes.push({ action, input: structuredClone(input) });
    if (f.fail) { f.pending = [{ id: `publication:${input.key}`, key: input.key, kind: 'publication', title: 'Confirmed control pending',
      summary: action, action: f.fail === 'refused' ? 'dismiss' : 'retry' }]; throw Error('Acknowledgement unconfirmed. Inspect Inbox'); }
    f.pending = [];
  };
  f.instance = render(h(TaskBoardInkApp, {
    read: async () => ({ companies: [{ id: 'native', name: 'Relay' }], tasks: [], projects: [], agents: f.agents,
      nodes: [{ id: 'local', name: 'Local' }], localNode: { id: 'local', name: 'Local' }, inbox: f.pending, routines: f.routines,
      agentDeletionAvailable: supported, scheduleManagementAvailable: supported, warnings: [] }),
    pendingDecisions: () => f.pending,
    detailAgent: async () => ({ agent, tasks: [] }),
    detailRoutine: async () => ({ ...f.routines[0], runs: [] }),
    prepareAgentDelete: async ({ agentId }) => f.agentPreview ? f.agentPreview(agentId) : ({ agentId, name: agent.name, nodeId: agent.nodeId,
      directory: agent.directory, expectedRevision: 3, instanceId: 'backend', eligible: !f.blocked,
      blockers: f.blocked ? [{ kind: 'outstanding_work', ids: ['execution'] }] : [] }),
    deleteAgent: async input => { write('agent.delete', input); f.agents = []; return { state: 'recorded', agent: { id: input.agentId, deletedAt: '2026-11-11T00:00:00Z' }, message: 'Inactive agent deleted' }; },
    prepareScheduleCreation: async () => ({ instanceId: 'backend', nodes: [{ id: 'local', name: 'Local' }], agents: f.agents }),
    prepareScheduleCreate: async ({ payload }) => {
      f.previews.push(payload);
      if (!payload.id || /\s/.test(payload.id)) throw Error('Enter a schedule name/ID without spaces');
      if (!payload.definition.instructions.trim()) throw Error('Instructions are required');
      const cron = previewCron(payload.definition.cron, payload.definition.timezone);
      return { ...payload, instanceId: 'backend', nextRuns: cron.nextRuns, warnings: cron.warnings };
    },
    createSchedule: async input => {
      write('schedule.install', input);
      f.routines = [{ id: input.id, companyId: 'native', title: input.id, ...input.definition, enabled: input.definition.enabled, state: 'change_pending', revision: 1 }];
      return { state: 'recorded', schedule: { id: input.id, definition: input.definition }, message: 'Paused schedule created' };
    },
    prepareScheduleChange: async ({ scheduleId, operation }) => ({ scheduleId, operation, expectedRevision: 1, instanceId: 'backend', eligible: true,
      name: f.routines[0].title, nodeId: 'local', definition: { cron: '* * * * *', enabled: f.routines[0].enabled }, blockers: [] }),
    changeSchedule: async input => {
      write(`schedule.${input.operation}`, input);
      f.routines = f.routines.map(routine => ({ ...routine, enabled: input.operation === 'resume', cancelled: input.operation === 'delete', state: 'change_pending' }));
      return { state: 'recorded', schedule: { id: input.scheduleId, cancelled: input.operation === 'delete', definition: { enabled: input.operation === 'resume' } },
        message: input.operation === 'delete' ? 'Schedule deleted; history retained' : 'Schedule activation changed' };
    },
    interval: 60000, width, height,
  }));
  t.after(() => f.instance.unmount());
  f.key = async key => { f.instance.stdin.write(key); await tick(); };
  f.frame = () => stripVTControlCharacters(f.instance.lastFrame());
  f.agentsView = async () => { await f.key('\t'); await f.key('j'); };
  f.scheduleView = async () => { for (let i = 0; i < 4; i++) await f.key('\t'); };
  f.draft = async (id = 'manual-job') => {
    await f.key('c'); await f.key(id);
    await f.key('\t'); await f.key('\t'); await f.key('\t'); await f.key('Inspect the fixture only');
  };
  await tick(); return f;
}

test('Agents x previews, confirms and deletes the exact inactive agent without acting on a group heading', async t => {
  const f = await fixture(t); await f.key('\t'); assert.match(f.frame(), /x delete inactive/);
  await f.key('x'); assert.equal(f.writes.length, 0); await f.key('j');
  await f.key('x'); assert.match(f.frame(), /Delete inactive agent/); assert.equal(f.writes.length, 0);
  await f.key('\r'); assert.match(f.frame(), /Confirm: Delete inactive agent/); assert.equal(f.writes.length, 0);
  await f.key('\r'); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].input.agentId, 'agent'); assert.equal(f.writes[0].input.expectedRevision, 3); assert.ok(f.writes[0].input.reason);
});

test('agent detail exposes deletion, blocked agents cannot confirm and Escape never publishes', async t => {
  const f = await fixture(t); await f.agentsView(); await f.key('\r'); assert.match(f.frame(), /x delete/);
  f.blocked = true; await f.key('x'); assert.match(f.frame(), /outstanding work/);
  await f.key('\r'); await f.key('\r'); assert.equal(f.writes.length, 0);
  f.blocked = false; await f.key('r'); assert.doesNotMatch(f.frame(), /Blocked: outstanding work/);
  await f.key('\r'); await f.key('\x1b'); await f.key('\x1b');
  assert.equal(f.writes.length, 0); assert.doesNotMatch(f.frame(), /Confirm: Delete/);
});

test('Schedule c edits a manual cron, previews its next runs and only then creates the paused definition', async t => {
  const f = await fixture(t); await f.scheduleView(); assert.match(f.frame(), /c create/);
  await f.draft(); await f.key('\r'); assert.match(f.frame(), /Confirm new cron schedule/); assert.equal(f.writes.length, 0);
  await f.key('\r'); assert.equal(f.writes.length, 1);
  const input = f.writes[0].input;
  assert.equal(input.id, 'manual-job'); assert.equal(input.definition.targetAgentId, 'agent');
  assert.equal(input.definition.timezone, 'Africa/Johannesburg'); assert.equal(input.definition.enabled, false);
  assert.equal(input.definition.reviewPolicy, 'human'); assert.ok(input.key);
  // The pending, paused revision can be resumed without waiting for an offline node.
  await f.key('p'); assert.match(f.frame(), /Resume schedule/); await f.key('\r'); await f.key('\r');
  assert.equal(f.writes.at(-1).input.operation, 'resume');
});

test('new-schedule editing supports reminders and explicit activation without an agent target', async t => {
  const f = await fixture(t); await f.scheduleView(); await f.key('c');
  await f.key('reminder'); await f.key('\t'); await f.key('\t'); await f.key('\t'); await f.key('Remember the fixture');
  await f.key('\t'); await f.key('\t'); await f.key(' '); // enabled
  await f.key('\t'); await f.key(' '); // kind: reminder
  await f.key('\r'); assert.match(f.frame(), /Confirm new cron schedule/);
  await f.key('\r'); const definition = f.writes[0].input.definition;
  assert.equal(definition.intent, 'reminder'); assert.equal(definition.nodeId, 'local'); assert.equal(definition.enabled, true);
  assert.equal(definition.targetAgentId, undefined); assert.equal(definition.reviewPolicy, 'none');
});

test('invalid schedule drafts never publish and escaping a confirmation returns to the editor', async t => {
  const f = await fixture(t); await f.scheduleView(); await f.key('c'); await f.key('\r');
  assert.match(f.frame(), /schedule name/); assert.equal(f.writes.length, 0);
  await f.key('valid'); await f.key('\t'); await f.key('\t'); await f.key('\t'); await f.key('Check fixture');
  await f.key('\r'); await f.key('\x1b'); assert.match(f.frame(), /Create cron schedule/);
  await f.key('\x1b'); assert.equal(f.writes.length, 0);
});

test('Schedule x cancels the exact selected schedule, hides it immediately and h retains its history', async t => {
  const f = await fixture(t, { schedules: true }); await f.scheduleView(); await f.key('x');
  assert.match(f.frame(), /Delete schedule/); assert.equal(f.writes.length, 0);
  await f.key('\r'); await f.key('\r'); assert.equal(f.writes[0].input.scheduleId, 'schedule');
  assert.match(f.frame(), /No schedules installed/);
  await f.key('h'); assert.match(f.frame(), /Existing schedule/);
});

for (const kind of ['create', 'delete']) test(`an uncertain schedule ${kind} locks its payload and retries only its original key`, async t => {
  const f = await fixture(t, { schedules: kind === 'delete' }); f.fail = true; await f.scheduleView();
  if (kind === 'create') await f.draft(); else await f.key('x');
  await f.key('\r'); await f.key('\r'); assert.match(f.frame(), /retry original/);
  await f.key('Do not change'); f.fail = false; await f.key('\r');
  assert.equal(f.writes.length, 2); assert.deepEqual(f.writes[0], f.writes[1]);
});

test('definitively refused agent deletion goes to Inbox instead of replaying the refusal', async t => {
  const f = await fixture(t); f.fail = 'refused'; await f.agentsView(); await f.key('x'); await f.key('\r'); await f.key('\r');
  assert.match(f.frame(), /inspect refusal/); await f.key('\r'); assert.match(f.frame(), /RELAY \/ INBOX/); assert.equal(f.writes.length, 1);
});

test('late deletion previews cannot reopen a cancelled dialog or replace a newer selection', async t => {
  const f = await fixture(t); let resolve;
  f.agentPreview = () => new Promise(done => { resolve = done; });
  await f.agentsView(); await f.key('x'); await f.key('\x1b');
  resolve({ agentId: 'agent', name: 'Late', eligible: true, blockers: [] }); await tick();
  assert.doesNotMatch(f.frame(), /Delete inactive agent|Late/); assert.equal(f.writes.length, 0);
});

test('older backends hide the new controls and send no mutation', async t => {
  const f = await fixture(t, { supported: false }); await f.scheduleView(); assert.doesNotMatch(f.frame(), /c create/);
  await f.key('c'); assert.match(f.frame(), /Upgrade the backend/); assert.equal(f.writes.length, 0);
});

test('creation and deletion controls remain inside a narrow terminal viewport', async t => {
  const f = await fixture(t, { width: 40, height: 18 }); await f.scheduleView(); await f.draft(); await f.key('\r');
  assert.match(f.frame(), /Confirm new cron schedule/); assert.match(f.frame(), /Enter apply/); assert.ok(f.frame().split('\n').length <= 18);
});
