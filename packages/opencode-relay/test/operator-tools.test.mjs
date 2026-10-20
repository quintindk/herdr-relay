import assert from 'node:assert/strict';
import test from 'node:test';
import { registerOperatorTools, proposedActions } from '../operator-tools.mjs';

test('operator mutation tools register strict proposal schemas and never publish backend changes', async () => {
  const tools = [], proposals = [];
  const ctx = { options: {}, location: { directory: '/work' }, tool: { transform: async edit => {
    edit({ add: tool => tools.push(tool) }); return { dispose: async () => {} };
  } }, session: { context: async () => [{ id: 'source', type: 'user', text: 'Create a task for the audit', time: { created: 1 } }] },
  storage: { set: async (key, value) => proposals.push({ key, value }) } };
  const close = await registerOperatorTools(ctx);
  try {
    assert.equal(tools.length, Object.keys(proposedActions).length);
    for (const tool of tools) assert.equal(tool.input.additionalProperties, false);
    const result = await tools.find(tool => tool.name === 'relay_task_create').execute({ id: 'audit', title: 'Audit' }, { sessionID: 'session' });
    assert.equal(JSON.parse(result.content).state, 'proposed');
    assert.equal(proposals[0].value.action, 'task.create');
    assert.equal(proposals[0].value.source.id, 'source');
    ctx.options.workerContextFile = '/private/worker.json';
    await assert.rejects(tools[0].execute({}, { sessionID: 'session' }), /Worker plugin/);
  } finally { await close(); }
});
