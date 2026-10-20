import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickAutomation } from '../src/node-automation.mjs';

test('scheduled clarification materialises one task, waits durably and resumes its exact binding on answer', async () => {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  store.command(owner, { key: 'node', action: 'node.enrol', payload: { id: 'node', name: 'Node' } });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  const cmd = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  cmd(node, 'agent', 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
  const clock = Date.now();
  cmd(owner, 'schedule', 'schedule.install', { id: 'job', definition: { nodeId: 'node', targetAgentId: 'agent', instructions: 'Check inbox',
    at: new Date(clock + 1000).toISOString(), enabled: true } });
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: store.instance });
    let loseContinuation = true;
    const api = async (method, path, body) => {
      if (method !== 'POST') return store.get(path.includes('/executions/') ? 'execution' : 'question', path.split('/').at(-1));
      const receipt = store.command(node, body);
      if (body.action === 'execution.continue' && loseContinuation) { loseContinuation = false; throw new Error('lost continuation receipt'); }
      return receipt;
    };
  let sends = 0;
  const binding = { id: 'binding', native: { snapshot: async () => ({ idle: true, messages: [], inbox: [] }), send: async () => { sends++; } },
    observe: () => ({ state: 'observed' }) };
  try {
    journal.consume(store.events());
    await tickAutomation(journal, async () => binding, clock, api);
    await tickAutomation(journal, async () => binding, clock + 1000, api);
    let work = journal.works()[0];
    journal.save({ ...work, staged: { kind: 'question', key: 'region', payload: { prompt: 'Which region?' } } });
    binding.observe = () => ({ state: 'finished', outcome: 'succeeded', messageId: 'terminal' });
    await tickAutomation(journal, async () => binding, clock + 1000, api);
    await journal.flush(api);
    const question = store.all('question')[0];
    assert.equal(store.all('task').length, 1);
    assert.equal(question.status, 'open');
    cmd(owner, 'answer', 'question.answer', { id: question.id, expectedRevision: question.revision, body: 'South Africa North' });
    journal.consume(store.events());
    binding.observe = () => ({ state: 'observed' });
    await tickAutomation(journal, async () => binding, clock + 1000, api);
    await journal.flush(api);
    journal.consume(store.events());
    await tickAutomation(journal, async () => binding, clock + 1000, api);
    work = journal.works()[0];
    assert.equal(sends, 2, JSON.stringify({ work, outbox: journal.db.prepare('SELECT data FROM outbox').all(),
      occurrences: journal.db.prepare('SELECT data FROM occurrences').all() }));
    assert.match(work.invocation.prompt, /South Africa North/);
    journal.save({ ...work, staged: { kind: 'result', key: 'result', payload: { candidate: 'sha256:one', summary: 'Done' } } });
    binding.observe = () => ({ state: 'finished', outcome: 'succeeded', messageId: 'terminal-2' });
    await tickAutomation(journal, async () => binding, clock + 1000, api);
    await journal.flush(api);
    assert.equal(store.all('occurrence').length, 1);
    assert.equal(store.all('execution')[0].state, 'completed');
  } finally { journal.close(); store.close(); }
});
