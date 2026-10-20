import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickAutomation } from '../src/node-automation.mjs';
import { BackendStore } from '../src/backend-store.mjs';

test('installed automation records native results offline and later publishes the original occurrence once', async () => {
  const backend = new BackendStore(':memory:');
  const owner = backend.authenticate(backend.bootstrap().token);
  const command = (actor, key, action, payload) => backend.command(actor, { key, action, payload });
  command(owner, 'node', 'node.enrol', { id: 'node', name: 'Node' });
  const node = backend.authenticate(backend.enrolCredential(owner, 'node', 'credential').token);
  command(node, 'agent', 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
  const start = Date.parse('2026-10-20T06:00:00Z');
  command(owner, 'schedule', 'schedule.install', { id: 'job', definition: { nodeId: 'node', targetAgentId: 'agent', enabled: true,
    instructions: 'Sweep inbox', cron: '* * * * *', timezone: 'Africa/Johannesburg', reviewPolicy: 'none' } });
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: backend.instance });
  let sends = 0;
  const binding = { id: 'binding', native: { snapshot: async () => ({ idle: true, messages: [], inbox: [] }), send: async () => { sends++; } },
    observe: () => ({ state: 'observed' }) };
  try {
    journal.consume(backend.events());
    await tickAutomation(journal, async () => binding, start);
    await tickAutomation(journal, async () => binding, start + 60000);
    const work = journal.works()[0];
    assert.ok(work);
    journal.save({ ...work, staged: { kind: 'result', payload: { candidate: 'sha256:one', summary: 'No new actions' } } });
    binding.observe = () => ({ state: 'finished', outcome: 'succeeded', messageId: 'terminal' });
    await tickAutomation(journal, async () => binding, start + 60000);
    await tickAutomation(journal, async () => binding, start + 60000);
    assert.equal(sends, 1);
    await journal.flush(async (_method, _path, body) => backend.command(node, body));
    assert.equal(backend.all('occurrence').length, 1);
    assert.equal(backend.get('schedule', 'job').appliedRevision, 1);
    assert.equal(backend.all('occurrence')[0].summary, 'No new actions');
  } finally { journal.close(); backend.close(); }
});
