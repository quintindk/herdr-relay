import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { digest } from '../src/protocol.mjs';

test('folder schedule requires enrolled directory scope and materialises only a matching selected agent', t => {
  const store = new BackendStore(':memory:');
  t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token);
  const cmd = (actor, action, payload) => store.command(actor, { key: crypto.randomUUID(), action, payload });
  cmd(owner, 'node.enrol', { id: 'node', name: 'Node' });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  for (const id of ['agent', 'outside']) cmd(node, 'agent.register', { id, nodeId: 'node', name: id, mode: 'headless' });
  const definition = { nodeId: 'node', targetFolder: '/workspace', instructions: 'Check', enabled: true, at: '2026-10-21T06:00:00Z' };
  assert.throws(() => cmd(owner, 'schedule.install', { id: 'job', definition }), { code: 'target_not_enrolled' });
  assert.throws(() => cmd(node, 'agent.enrol_folder', { id: 'agent', expectedRevision: 1, directory: '/workspace' }), { code: 'forbidden' });
  cmd(owner, 'agent.enrol_folder', { id: 'agent', expectedRevision: 1, directory: '/workspace' });
  cmd(owner, 'schedule.install', { id: 'job', definition });
  const occurrenceId = `occurrence_${digest(['job', definition.at])}`;
  const payload = { id: 'q', occurrenceId, scheduleId: 'job', definitionRevision: 1, intendedAt: definition.at,
    bindingId: 'binding', runId: 'run', prompt: 'Where?' };
  assert.throws(() => cmd(node, 'schedule.ask', { ...payload, targetAgentId: 'outside' }), { code: 'target_not_enrolled' });
  assert.equal(store.all('task').length, 0);
  cmd(node, 'schedule.ask', { ...payload, targetAgentId: 'agent' });
  assert.equal(store.get('execution', occurrenceId).targetAgentId, 'agent');
  assert.throws(() => cmd(owner, 'agent.enrol_folder', { id: 'agent', expectedRevision: 2, directory: '/different' }),
    { code: 'directory_migration_required' });
});
