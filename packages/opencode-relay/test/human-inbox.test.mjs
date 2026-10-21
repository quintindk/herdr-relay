import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { humanInboxClient, registerHumanInbox } from '../human-inbox.mjs';
import { startBackend } from '../../../src/backend-service.mjs';

test('human inbox accepts the bootstrap owner context with the same local default as native CLI', async () => {
  const api = humanInboxClient({ token: 'owner-secret', fetch: async (url, options) => {
    assert.equal(url.origin, 'http://127.0.0.1:3210');
    assert.equal(options.headers.Authorization, 'Bearer owner-secret');
    return Response.json({ userId: 'owner' });
  } });
  assert.equal((await api('GET', '/v1/info')).userId, 'owner');
});

for (const transition of ['normal', 'reload', 'reconnect', 'dispose', 'switch']) test(`human inbox ${transition} preserves exact approval context`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-human-inbox-'));
  const backend = await startBackend({ database: ':memory:' });
  const owner = backend.store.bootstrap();
  const actor = backend.store.authenticate(owner.token);
  const command = (who, action, payload) => backend.store.command(who, { key: crypto.randomUUID(), action, payload });
  command(actor, 'node.enrol', { id: 'node', name: 'Node' });
  const node = backend.store.authenticate(backend.store.enrolCredential(actor, 'node', 'credential').token);
  command(node, 'agent.register', { id: 'worker', nodeId: 'node', name: 'Worker', mode: 'headless' });
  command(actor, 'task.create', { id: 'task', title: 'Task' });
  let e = command(actor, 'execution.request', { id: 'e', taskId: 'task', taskRevision: 1, targetAgentId: 'worker', instructions: 'Work' });
  e = command(node, 'execution.admit', { id: 'e', expectedRevision: e.revision, bindingId: 'binding', runId: 'run' });
  command(node, 'question.ask', { id: 'q', executionId: 'e', expectedRevision: e.revision, prompt: 'Which region?', humanRequired: true });
  const contextFile = join(dir, 'owner.json');
  writeFileSync(contextFile, JSON.stringify({ url: backend.origin, token: owner.token }), { mode: 0o600 });
  const state = { pending: null };
  let commands, reconnect, stop;
  let generation = 'service-1', selected = 'session';
  const dialogs = [], toasts = [];
  const ctx = { options: { ownerContextFile: contextFile }, storage: { store: () => [state, async mutation => mutation(state)] },
    location: { directory: dir }, client: { rpc: () => ({ inspect: async () => ({ generation }) }) },
    data: { on: (_type, callback) => { reconnect = callback; return () => {}; } },
    keymap: { layer: factory => { commands = factory().commands; } }, ui: { toast: { show: v => toasts.push(v) }, dialog: {
      select: async () => 'q', prompt: async () => 'South Africa North', confirm: async options => {
        dialogs.push(options);
        if (transition === 'reload') generation = 'service-2';
        if (transition === 'reconnect') reconnect();
        if (transition === 'dispose') stop();
        if (transition === 'switch') selected = 'other';
        return true;
      },
    } } };
  stop = registerHumanInbox(ctx, { clientId: 'client', selectedSession: () => selected });
  try {
    await commands.find(command => command.id === 'herdr.relay.questions').run();
    if (transition === 'normal') assert.equal(backend.store.get('question', 'q').answer.body, 'South Africa North');
    else assert.equal(backend.store.get('question', 'q').status, 'open');
    assert.equal(state.pending, null);
    assert.match(dialogs[0].message, /Which region\?[\s\S]*South Africa North/);
    assert.equal(toasts.at(-1).variant, transition === 'normal' ? 'success' : 'error');
  } finally { stop(); await backend.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('human inbox notification reads only human-addressed work and never answers or opens a dialog', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-human-notification-'));
  const backend = await startBackend({ database: ':memory:' });
  const owner = backend.store.bootstrap(), actor = backend.store.authenticate(owner.token);
  const command = (who, action, payload) => backend.store.command(who, { key: crypto.randomUUID(), action, payload });
  command(actor, 'node.enrol', { id: 'node', name: 'Node' });
  const node = backend.store.authenticate(backend.store.enrolCredential(actor, 'node', 'credential').token);
  for (const id of ['initiator', 'worker']) command(node, 'agent.register', { id, nodeId: 'node', name: id, mode: 'interactive' });
  for (const humanRequired of [false, true]) {
    const id = humanRequired ? 'human' : 'agent';
    command(actor, 'task.create', { id, title: id });
    const e = command(actor, 'execution.request', { id, taskId: id, taskRevision: 1, targetAgentId: 'worker', originAgentId: 'initiator', instructions: 'Bounded test' });
    const admitted = command(node, 'execution.admit', { id, expectedRevision: e.revision, bindingId: id, runId: id });
    command(node, 'question.ask', { id, executionId: id, expectedRevision: admitted.revision, prompt: id, humanRequired });
  }
  const contextFile = join(dir, 'owner.json');
  writeFileSync(contextFile, JSON.stringify({ url: backend.origin, token: owner.token }), { mode: 0o600 });
  const notified = Promise.withResolvers();
  const state = { pending: null };
  let stop;
  const ctx = { options: { ownerContextFile: contextFile, notificationSessionId: 'human-session' },
    storage: { store: () => [state, async mutation => mutation(state)] }, data: { on: () => () => {} }, keymap: { layer: () => {} },
    ui: { dialog: new Proxy({}, { get: () => () => assert.fail('Notification must never open a dialog') }),
      toast: { show: toast => notified.resolve(toast) } } };
  t.after(async () => { stop?.(); await backend.close(); rmSync(dir, { recursive: true, force: true }); });
  stop = registerHumanInbox(ctx, { clientId: 'client', selectedSession: () => 'human-session' });
  const toast = await Promise.race([notified.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('No inbox notification')), 5000); timer.unref(); })]);
  assert.match(toast.message, /1 question\(s\), 0 review\(s\)/);
  assert.equal(backend.store.get('question', 'human').status, 'open');
  assert.equal(backend.store.get('question', 'agent').status, 'open');
  assert.equal(state.pending, null);
});
