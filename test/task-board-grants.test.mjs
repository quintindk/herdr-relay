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
