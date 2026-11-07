import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';
import { TaskBoardInkApp } from '../src/task-board-ink.mjs';

const h = React.createElement, tick = () => new Promise(resolve => setTimeout(resolve, 45));
const request = { id: 'request:discussion', entityId: 'discussion', kind: 'interactive', section: 'pending', title: 'Permission requested · Discussion',
  summary: 'Mason → Surface', requesterName: 'Mason', nodeName: 'Surface', nodeId: 'node', folders: ['/work/discussion'],
  stateLabel: 'Awaiting approval', revision: 1, requestHash: 'hash', instanceId: 'backend', actions: ['Create enrolment and open/attach OpenCode'],
  limits: 'Node-wide enrolment limit: 25', scope: { roots: ['/work/discussion'], maxAgents: 25, profiles: ['build'] } };
const active = { ...request, id: 'interactive:standing', entityId: 'standing', section: 'active', title: 'Interactive agents · Mason', stateLabel: 'active' };
const base = { companies: [{ id: 'native', name: 'Relay' }], projects: [], tasks: [], routines: [], inbox: [],
  agents: [{ id: 'mason', companyId: 'native', name: 'Mason', displayName: 'Mason', mode: 'interactive', standingGrant: true, directory: '/work/project', nodeId: 'node' }],
  nodes: [{ id: 'node', name: 'Surface' }], nodePolicies: { node: { mode: 'roots', roots: ['/work'], maxAgents: 25 } },
  grantsAvailable: true, grants: { pending: [request], active: [active], history: [] }, fetchedAt: new Date().toISOString() };
const frame = instance => stripVTControlCharacters(instance.lastFrame());
async function input(instance, text) { instance.stdin.write(text); await tick(); }
async function grants(instance) { for (let i = 0; i < 3; i++) await input(instance, '\t'); }

test('Grants owns security requests and requires preview and confirmation before approval', async t => {
  const sent = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => base, detailGrant: async () => request,
    decideGrant: async command => { sent.push(command); return { state: 'recorded', message: 'Permission recorded' }; }, interval: 60000, width: 110, height: 30 }));
  t.after(() => instance.unmount()); await tick();
  await input(instance, '\t'); await input(instance, '\t');
  assert.match(frame(instance), /RELAY \/ INBOX/); assert.doesNotMatch(frame(instance), /Permission requested/);
  await input(instance, '\t'); assert.match(frame(instance), /RELAY \/ GRANTS/); assert.match(frame(instance), /Permission requested/);
  await input(instance, '\r'); assert.match(frame(instance), /Approve once/); assert.match(frame(instance), /Allow this scope/); assert.match(frame(instance), /Reject/);
  assert.deepEqual(sent, []);
  await input(instance, '\r'); assert.match(frame(instance), /Confirm: Approve once/); assert.deepEqual(sent, []);
  await input(instance, '\r'); assert.equal(sent.length, 1); assert.equal(sent[0].decision, 'approve_once'); assert.equal(sent[0].item.requestHash, 'hash');
});

test('Grants active revocation and new standing permission use separate confirmed commands', async t => {
  const sent = [], created = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => base, detailGrant: async () => active,
    decideGrant: async command => { sent.push(command); return { state: 'recorded', message: 'Revoked' }; },
    createGrant: async command => { created.push(command); return { state: 'recorded', message: 'Created' }; }, interval: 60000, width: 110, height: 32 }));
  t.after(() => instance.unmount()); await tick(); await grants(instance);
  await input(instance, '2'); await input(instance, '\r'); assert.match(frame(instance), /Revoke/);
  await input(instance, '\r'); assert.equal(sent.length, 0); await input(instance, '\r'); assert.equal(sent[0].item.section, 'active');
  await input(instance, 'n'); assert.match(frame(instance), /New interactive provisioning permission/);
  await input(instance, '\r'); assert.equal(created.length, 0); await input(instance, '\r');
  assert.equal(created.length, 1); assert.equal(created[0].payload.requesterAgentId, 'mason');
  assert.deepEqual(created[0].payload.scope.roots, ['/work/project']); assert.equal(created[0].payload.scope.maxAgents, 25);
});

test('failed security publication locks its payload and remains outside Inbox', async t => {
  let attempts = 0;
  const instance = render(h(TaskBoardInkApp, { read: async () => base, detailGrant: async () => request,
    decideGrant: async () => { attempts++; throw Error('Lost acknowledgement'); }, pendingGrantDecisions: () => [], interval: 60000, width: 100, height: 26 }));
  t.after(() => instance.unmount()); await tick(); await grants(instance); await input(instance, '\r');
  await input(instance, '\r'); await input(instance, '\r'); assert.equal(attempts, 1);
  assert.match(frame(instance), /Lost acknowledgement/); assert.match(frame(instance), /reconcile it in Grants/);
  await input(instance, '\r'); await input(instance, '\x1b[B'); await input(instance, '\r'); assert.equal(attempts, 1);
});

test('old backends show Grants as unavailable rather than claiming zero permissions', async t => {
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, grantsAvailable: false }), interval: 60000, width: 100, height: 22 }));
  t.after(() => instance.unmount()); await tick(); await grants(instance);
  assert.match(frame(instance), /Backend upgrade required for Grants management/);
});

test('Grants request detail sanitises source text and stays within a narrow viewport', async t => {
  const item = { ...request, topic: `Unsafe\x1b[31m context ${'long context '.repeat(100)}END_CONTEXT` };
  const instance = render(h(TaskBoardInkApp, { read: async () => base, detailGrant: async () => item, interval: 60000, width: 54, height: 22 }));
  t.after(() => instance.unmount()); await tick(); await grants(instance); await input(instance, '\r');
  assert.ok(frame(instance).split('\n').every(line => line.length <= 54));
  assert.ok(frame(instance).split('\n').length <= 22);
  for (let i = 0; i < 20; i++) await input(instance, '\x1b[6~');
  assert.match(frame(instance), /END_CONTEX[\s│]*T/); assert.match(frame(instance), /Esc close/);
});

test('Active searches originating request IDs and v previews the selected grant before revocation', async t => {
  const sent = [], lab = { ...active, title: 'Interactive agents · Lab', canRevoke: true, searchText: 'uwb-il2cpp-lab-dispatch-20261107' };
  const other = { ...active, id: 'interactive:other', entityId: 'other', title: 'Unrelated permission' };
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, grants: { ...base.grants, active: [other, lab] } }),
    detailGrant: async ({ id }) => [other, lab].find(item => item.id === id),
    decideGrant: async command => { sent.push(command); return { state: 'recorded', message: 'Revoked' }; }, interval: 60000, width: 110, height: 32 }));
  t.after(() => instance.unmount()); await tick(); await grants(instance); await input(instance, '2');
  await input(instance, '/'); await input(instance, 'uwb-il2cpp-lab-dispatch-20261107'); await input(instance, '\r');
  assert.match(frame(instance), /Interactive agents · Lab/); assert.doesNotMatch(frame(instance), /Unrelated permission/);
  await input(instance, 'v'); assert.match(frame(instance), /Confirm: Revoke/); assert.equal(sent.length, 0);
  await input(instance, '\r'); assert.equal(sent.length, 1); assert.equal(sent[0].item.entityId, lab.entityId);
});

test('polling/reordering Active preserves selection by grant identity rather than row number', async t => {
  const first = { ...active, id: 'interactive:first', entityId: 'first', title: 'First', canRevoke: true };
  const second = { ...active, id: 'interactive:second', entityId: 'second', title: 'Second', canRevoke: true };
  let records = [first, second];
  const sent = [];
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, grants: { ...base.grants, active: records } }),
    detailGrant: async ({ id }) => records.find(item => item.id === id),
    decideGrant: async command => { sent.push(command); return { state: 'recorded', message: 'Revoked' }; }, interval: 60000, width: 100, height: 30 }));
  t.after(() => instance.unmount()); await tick(); await grants(instance); await input(instance, '2'); await input(instance, 'j');
  records = [second, first]; await input(instance, 'r'); await input(instance, 'v'); await input(instance, '\r');
  assert.equal(sent[0].item.entityId, 'second');
});

test('closing a loading grant dialog prevents its stale response from replacing a newer selection', async t => {
  const first = { ...active, id: 'interactive:first', entityId: 'first', title: 'First permission' };
  const second = { ...active, id: 'interactive:second', entityId: 'second', title: 'Second permission' };
  let resolveFirst;
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, grants: { ...base.grants, active: [first, second] } }),
    detailGrant: async ({ id }) => id === first.id ? new Promise(resolve => { resolveFirst = resolve; }) : second,
    interval: 60000, width: 110, height: 32 }));
  t.after(() => instance.unmount()); await tick(); await grants(instance); await input(instance, '2'); await input(instance, '\r');
  await input(instance, '\x1b'); await input(instance, 'j'); await input(instance, '\r');
  resolveFirst(first); await tick(); await input(instance, '\r');
  assert.match(frame(instance), /Second permission/); assert.match(frame(instance), /Confirm: Revoke/);
});

test('p requests a linked repair only after preview, and pending repair approval has no standing-scope option', async t => {
  const target = { id: 'legacy-lab', name: 'Lab', directory: '/work/lab', state: 'blocked', reason: 'agent_limit' };
  const lab = { ...active, title: 'Interactive agents · Lab', repairTargets: [target], scope: { ...active.scope, maxAgents: 1, allowDispatch: true } };
  const previews = [], requests = [];
  const preview = { eligible: true, preparationId: target.id, expectedRevision: 3, scope: { ...lab.scope, maxAgents: 25 },
    previewHash: 'a'.repeat(64), instanceId: 'backend', checkpoint: { phase: 'directory' },
    changes: [{ field: 'maxAgents', before: 1, after: 25 }], preserves: ['preparation', 'agent identity', 'captured tasks'] };
  const instance = render(h(TaskBoardInkApp, { read: async () => ({ ...base, interactiveRecoveryAvailable: true, grants: { ...base.grants, active: [lab] } }),
    detailGrant: async () => lab,
    prepareInteractiveRepair: async input => { previews.push(input); return preview; },
    requestInteractiveRepair: async input => { requests.push(input); return { state: 'recorded', message: 'Repair permission requested' }; },
    interval: 60000, width: 110, height: 32 }));
  t.after(() => instance.unmount()); await tick(); await grants(instance); await input(instance, '2'); await input(instance, 'p');
  assert.match(frame(instance), /Repair interactive preparation/); assert.equal(requests.length, 0);
  await input(instance, '\r'); assert.equal(previews.length, 1); assert.equal(previews[0].id, target.id); assert.equal(previews[0].scope.maxAgents, 25);
  assert.match(frame(instance), /Change maxAgents: 1 → 25/); assert.equal(requests.length, 0);
  await input(instance, '\r'); assert.equal(requests.length, 1); assert.equal(requests[0].preview.previewHash, preview.previewHash);
  const repair = { ...request, kind: 'interactive_repair', repairPreview: preview };
  const pending = render(h(TaskBoardInkApp, { read: async () => ({ ...base, grants: { ...base.grants, pending: [repair] } }), detailGrant: async () => repair,
    interval: 60000, width: 110, height: 32 }));
  t.after(() => pending.unmount()); await tick(); await grants(pending); await input(pending, '\r');
  assert.match(frame(pending), /Approve repair once/); assert.doesNotMatch(frame(pending), /Allow this scope/);
});
