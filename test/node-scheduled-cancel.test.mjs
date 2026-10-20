import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickAutomation } from '../src/node-automation.mjs';

async function fixture(t) {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const cmd = (actor, action, payload) => store.command(actor, { key: crypto.randomUUID(), action, payload });
  cmd(owner, 'node.enrol', { id: 'node', name: 'Node' });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  cmd(node, 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
  const clock = Date.now();
  cmd(owner, 'schedule.install', { id: 'job', definition: { nodeId: 'node', targetAgentId: 'agent', instructions: 'Check',
    at: new Date(clock + 1000).toISOString(), enabled: true } });
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: store.instance });
  t.after(() => { journal.close(); store.close(); });
  const api = async (method, path, body) => method === 'POST' ? store.command(node, body) :
    store.get(path.includes('/executions/') ? 'execution' : 'question', path.split('/').at(-1));
  let sends = 0, interrupts = 0, finished = false;
  const binding = { id: 'binding', native: {
    snapshot: async () => ({ idle: true, messages: [], inbox: [] }), send: async () => { sends++; },
  }, interrupt: async () => { interrupts++; }, observe: () => finished ?
    { state: 'finished', outcome: 'succeeded', messageId: `terminal-${sends}` } : { state: 'observed' } };
  const tick = client => tickAutomation(journal, async () => binding, clock + 1000, client ?? api);
  journal.consume(store.events());
  await tickAutomation(journal, async () => binding, clock, api);
  await tick();
  const work = journal.works()[0];
  journal.save({ ...work, staged: { kind: 'question', key: 'question', payload: { prompt: 'Where?' } } });
  finished = true;
  await tick(); await journal.flush(api); journal.consume(store.events());
  const cancel = () => {
    const execution = store.all('execution')[0];
    return cmd(owner, 'execution.cancel', { id: execution.id, expectedRevision: execution.revision, reason: 'Stop' });
  };
  const answer = () => {
    const question = store.all('question')[0];
    cmd(owner, 'question.answer', { id: question.id, expectedRevision: question.revision, body: 'Here' });
    journal.consume(store.events());
  };
  return { store, journal, tick, api, binding, cancel, answer, sends: () => sends, interrupts: () => interrupts,
    finish: value => { finished = value; }, occurrence: () => JSON.parse(journal.db.prepare('SELECT data FROM occurrences').get().data) };
}

test('cancelled scheduled question settles from persisted terminal evidence without another turn', async t => {
  const f = await fixture(t);
  f.cancel(); f.journal.consume(f.store.events());
  f.binding.native.snapshot = async () => { throw new Error('Runtime unavailable'); };
  await f.tick();
  assert.equal(f.occurrence().state, 'cancelled');
  assert.equal(f.store.all('execution')[0].state, 'waiting');
  await f.journal.flush(f.api);
  assert.equal(f.store.all('execution')[0].state, 'cancelled');
  assert.equal(f.sends(), 1);
  assert.equal(f.interrupts(), 0);
});

test('cancellation after continuation receipt is rechecked before native delivery', async t => {
  const f = await fixture(t);
  f.answer(); f.finish(false);
  let cancelled = false;
  const racedApi = async (method, path, body) => {
    const receipt = await f.api(method, path, body);
    if (body?.action === 'execution.continue' && !cancelled) { cancelled = true; f.cancel(); }
    return receipt;
  };
  await f.tick(racedApi);
  assert.equal(f.sends(), 1);
  assert.equal(f.journal.works()[0].execution.cancellationRequested, true);
  await f.tick(); await f.journal.flush(f.api);
  assert.equal(f.store.all('execution')[0].state, 'cancelled');
  assert.equal(f.interrupts(), 0);
});

test('running scheduled continuation cancellation requires its own terminal evidence and interrupts once', async t => {
  const f = await fixture(t);
  f.answer(); f.finish(false);
  await f.tick();
  assert.equal(f.sends(), 2);
  assert.equal(f.journal.works()[0].observation, null);
  f.cancel(); f.journal.consume(f.store.events());
  await f.tick(); await f.tick();
  assert.equal(f.interrupts(), 1);
  assert.equal(f.occurrence().state, 'admitted');
  assert.equal(f.store.all('execution')[0].state, 'accepted');
  f.finish(true);
  await f.tick(); await f.journal.flush(f.api);
  assert.equal(f.store.all('execution')[0].state, 'cancelled');
  assert.equal(f.occurrence().state, 'cancelled');
  assert.equal(f.sends(), 2);
});

test('scheduled continuation waits for another unsettled turn even if native service reports idle', async t => {
  const f = await fixture(t);
  f.answer(); f.finish(false);
  f.journal.save({ id: 'other', bindingId: 'binding', state: 'uncertain', execution: { id: 'other', state: 'accepted' } });
  await f.tick();
  assert.equal(f.sends(), 1);
  assert.equal(f.journal.works().find(work => work.id !== 'other').invocation, null);
  const other = f.journal.work('other');
  f.journal.save({ ...other, state: 'settled', execution: { ...other.execution, state: 'completed' } });
  await f.tick();
  assert.equal(f.sends(), 2);
});
