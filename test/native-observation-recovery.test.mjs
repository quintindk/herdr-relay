import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeJournal } from '../src/node-journal.mjs';
import { reconcileObservationConflict } from '../src/native-observation-recovery.mjs';
import { observeV2 } from '../packages/opencode-relay/native.mjs';
import { installLocalSchedule } from '../src/node-schedules.mjs';
import { tickAutomation } from '../src/node-automation.mjs';

test('only reclassified provenance conflicts recover, preserving the original invocation without resending or inventing a result', async t => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' }); t.after(() => journal.close());
  const invocation = { messageId: 'owned', prompt: 'Check', priorMessageIds: [] };
  const messages = [{ id: 'owned', type: 'user', text: 'Check' }, { id: 'instruction', type: 'synthetic',
    metadata: { instruction: { paths: ['/work/AGENTS.md'] } } }, { id: 'terminal', type: 'idle', outcome: 'succeeded' }];
  const work = journal.save({ id: 'execution', bindingId: 'binding', nativeConversationId: 'session', execution: { state: 'accepted' },
    state: 'conflict', observation: { state: 'conflict', reason: 'concurrent_native_input' }, invocation });
  const binding = { id: 'binding', identity: { sessionId: 'session' }, native: { snapshot: async () => ({ messages, idle: true, inbox: [] }),
    send: () => assert.fail('Recovery must never resend') }, observe: observeV2 };
  const recovered = await reconcileObservationConflict(journal, binding, work);
  assert.equal(recovered.state, 'observing'); assert.equal(recovered.observation.state, 'finished');
  assert.equal(recovered.staged, undefined); assert.deepEqual(recovered.invocation, invocation);
  assert.equal(recovered.recovery.previousObservation.reason, 'concurrent_native_input');
  messages.splice(2, 0, { id: 'new-human', type: 'user', text: 'Stop' });
  assert.equal((await reconcileObservationConflict(journal, binding, work)).state, 'conflict');
  messages.splice(2, 1);
  assert.equal((await reconcileObservationConflict(journal, { ...binding, id: 'other' }, work)).state, 'conflict');
});

test('a stranded automatic-instruction conflict settles without replaying the old turn or inventing a submission, releasing later cron ticks', async t => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' }); t.after(() => journal.close());
  const start = Date.parse('2026-10-26T12:00:00Z');
  installLocalSchedule(journal, { id: 'monitor', nodeId: 'node', targetAgentId: 'agent', revision: 1, enabled: true,
    cron: '* * * * *', timezone: 'Africa/Johannesburg', instructions: 'Read-only monitor' }, start);
  let sends = 0, messages = [];
  const binding = { id: 'binding', identity: { sessionId: 'session' }, native: {
    snapshot: async () => ({ messages, idle: true, inbox: [] }), send: async invocation => {
      sends++; messages = [{ id: invocation.messageId, type: 'user', text: invocation.prompt },
        { id: `instruction-${sends}`, type: 'synthetic', metadata: { instruction: { paths: ['/work/nested/AGENTS.md'] } } },
        { id: `terminal-${sends}`, type: 'idle', outcome: 'succeeded' }];
    } }, observe: () => ({ state: 'observed' }) };
  await tickAutomation(journal, async () => binding, start + 60000);
  const work = journal.works()[0];
  journal.save({ ...work, state: 'conflict', observation: { state: 'conflict', reason: 'concurrent_native_input' } });
  binding.observe = observeV2;
  await tickAutomation(journal, async () => binding, start + 60001);
  assert.equal(sends, 1); assert.equal(journal.work(work.id).state, 'settled');
  assert.equal(journal.work(work.id).execution.state, 'failed'); assert.equal(journal.work(work.id).error, 'missing_worker_submission');
  assert.equal(journal.work(work.id).staged, undefined);
  binding.observe = () => ({ state: 'observed' });
  await tickAutomation(journal, async () => binding, start + 120000);
  assert.equal(sends, 2, 'Only the next scheduled occurrence may start a new prompt');
});
