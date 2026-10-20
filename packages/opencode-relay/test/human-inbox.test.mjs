import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHumanInbox } from '../human-inbox.mjs';
import { startBackend } from '../../../src/backend-service.mjs';

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
