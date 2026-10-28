import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickAutomation } from '../src/node-automation.mjs';
import { BackendStore } from '../src/backend-store.mjs';
import { digest } from '../src/protocol.mjs';

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

for (const outcome of ['succeeded', 'failed', 'interrupted']) {
  test(`scheduled terminal ${outcome} without a submission publishes one explicit failure and releases capacity`, async () => {
    const backend = new BackendStore(':memory:');
    const owner = backend.authenticate(backend.bootstrap().token);
    const command = (actor, key, action, payload) => backend.command(actor, { key, action, payload });
    command(owner, 'node', 'node.enrol', { id: 'node', name: 'Node' });
    const node = backend.authenticate(backend.enrolCredential(owner, 'node', 'credential').token);
    command(node, 'agent', 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
    command(owner, 'schedule', 'schedule.install', { id: 'job', definition: { nodeId: 'node', targetAgentId: 'agent',
      enabled: true, instructions: 'Return a result', cron: '* * * * *', timezone: 'Africa/Johannesburg' } });
    const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: backend.instance });
    let sends = 0, terminal = false;
    const binding = { id: 'binding', native: { snapshot: async () => ({ idle: true, messages: [], inbox: [] }), send: async () => { sends++; } },
      observe: () => terminal ? { state: 'finished', outcome, messageId: 'terminal' } : { state: 'observed' } };
    const start = Date.parse('2026-10-20T06:00:00Z');
    try {
      journal.consume(backend.events());
      await tickAutomation(journal, async () => binding, start);
      await tickAutomation(journal, async () => binding, start + 60000);
      terminal = true;
      await tickAutomation(journal, async () => binding, start + 60001);
      await tickAutomation(journal, async () => binding, start + 60002);
      assert.equal(sends, 1);
      const work = journal.works()[0];
      assert.equal(work.state, 'settled');
      assert.equal(work.execution.state, 'failed');
      assert.equal(work.error, outcome === 'succeeded' ? 'missing_worker_submission' : `native_${outcome}`);
      assert.equal(JSON.parse(journal.db.prepare('SELECT data FROM occurrences').get().data).state, 'failed');
      const failure = journal.db.prepare("SELECT data FROM outbox WHERE json_extract(data,'$.command.action')='schedule.fail'").all();
      assert.equal(failure.length, 1);
      const payload = JSON.parse(failure[0].data).command.payload;
      assert.throws(() => command(owner, 'forbidden-failure', 'schedule.fail', payload), { code: 'forbidden' });
      assert.throws(() => command(node, 'forged-failure', 'schedule.fail', { ...payload, id: 'forged' }), { code: 'invalid_occurrence' });
      await journal.flush(async (_method, _path, body) => backend.command(node, body));
      journal.consume(backend.events());
      assert.equal(journal.work(work.id).execution.state, 'failed');
      assert.equal(journal.work(work.id).execution.result, undefined);
      assert.equal(backend.all('occurrence').length, 1);
      assert.equal(backend.all('occurrence')[0].reason, work.error);
      assert.equal(backend.all('occurrence')[0].candidate, undefined);
      terminal = false;
      await tickAutomation(journal, async () => binding, start + 120000);
      assert.equal(sends, 2);
    } finally { journal.close(); backend.close(); }
  });
}

test('failure of materialised scheduled continuation blocks its task without inventing a result', () => {
  const backend = new BackendStore(':memory:');
  try {
    const owner = backend.authenticate(backend.bootstrap().token);
    const cmd = (actor, key, action, payload) => backend.command(actor, { key, action, payload });
    cmd(owner, 'node', 'node.enrol', { id: 'node', name: 'Node' });
    const node = backend.authenticate(backend.enrolCredential(owner, 'node', 'credential').token);
    cmd(node, 'agent', 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
    const intendedAt = new Date().toISOString();
    cmd(owner, 'schedule', 'schedule.install', { id: 'job', definition: { nodeId: 'node', targetAgentId: 'agent',
      enabled: true, instructions: 'Check', at: intendedAt } });
    const id = `occurrence_${digest(['job', intendedAt])}`;
    const question = cmd(node, 'ask', 'schedule.ask', { id: 'question', occurrenceId: id, scheduleId: 'job',
      definitionRevision: 1, intendedAt, bindingId: 'binding', runId: 'original', prompt: 'Which region?', humanRequired: true });
    cmd(owner, 'answer', 'question.answer', { id: question.id, expectedRevision: question.revision, body: 'South Africa North' });
    let execution = backend.get('execution', id);
    cmd(node, 'continue', 'execution.continue', { id, expectedRevision: execution.revision, runId: 'continuation' });
    const payload = { id, scheduleId: 'job', definitionRevision: 1, intendedAt,
      reason: 'missing_worker_submission', evidence: 'Native terminal receipt, continuation run' };
    const receipt = cmd(node, 'failed', 'schedule.fail', payload);
    assert.equal(receipt.state, 'failed');
    assert.deepEqual(cmd(node, 'failed', 'schedule.fail', payload), receipt);
    assert.throws(() => cmd(node, 'failed', 'schedule.fail', { ...payload, reason: 'changed' }), { code: 'operation_conflict' });
    execution = backend.get('execution', id);
    assert.equal(execution.state, 'failed');
    assert.equal(execution.result, undefined);
    assert.equal(execution.failure.reason, 'missing_worker_submission');
    assert.equal(backend.get('task', execution.taskId).status, 'blocked');
    assert.equal(backend.get('question', question.id).status, 'answered');
  } finally { backend.close(); }
});
