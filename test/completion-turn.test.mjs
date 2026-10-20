import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverCompletionTurn } from '../src/completion-turn.mjs';

function fixture() {
  const notification = { id: 'notice', messageId: 'message', turnState: 'pending', turnText: 'Attributed worker result' };
  const snap = { idle: true, session: { model: { providerID: 'provider', id: 'model', variant: 'variant' }, agent: 'build' }, messages: [] };
  const calls = [], prompts = [];
  let lost = false, stopped = false;
  const args = { notification, snapshot: async () => structuredClone(snap), conversationId: 'origin', sdkOptions: () => ({}),
    unavailable: () => stopped,
    rpc: async (action, state, input) => {
      calls.push({ action, input });
      if (action === 'notification-turn-begin') {
        assert.equal(notification.turnState, 'pending');
        notification.turnState = 'uncertain';
        return { dispatch: true };
      }
      assert.equal(input.message.info.id, notification.messageId);
      notification.turnState = 'delivered';
    },
    client: { session: { promptAsync: async request => {
      assert.equal(notification.turnState, 'uncertain', 'Intent precedes the native send');
      prompts.push(request);
      snap.messages.push({ info: { id: request.body.messageID, role: 'user', sessionID: 'origin' }, parts: request.body.parts });
      if (lost) throw new Error('Lost response');
    } } },
  };
  return { args, notification, snap, calls, prompts, loseResponse: () => { lost = true; }, stop: () => { stopped = true; } };
}

test('completion starts the exact original chat with its selected agent, model and variant', async () => {
  const f = fixture();
  await deliverCompletionTurn(f.args);
  assert.equal(f.notification.turnState, 'delivered');
  assert.deepEqual(f.prompts, [{ path: { id: 'origin' }, body: { messageID: 'message', agent: 'build',
    model: { providerID: 'provider', modelID: 'model' }, variant: 'variant', parts: [{ type: 'text', text: 'Attributed worker result' }] } }]);
  await deliverCompletionTurn(f.args);
  assert.equal(f.prompts.length, 1);
});

test('lost prompt response reconciles exact history without resending', async () => {
  const f = fixture(); f.loseResponse();
  await assert.rejects(deliverCompletionTurn(f.args), /Lost response/);
  assert.equal(f.notification.turnState, 'uncertain');
  await deliverCompletionTurn(f.args);
  assert.equal(f.notification.turnState, 'delivered');
  assert.equal(f.prompts.length, 1);
});

test('uncertain send without native evidence stays uncertain', async () => {
  const f = fixture(); f.notification.turnState = 'uncertain';
  await deliverCompletionTurn(f.args);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.prompts, []);
});

for (const reason of ['busy', 'stopped', 'missing model', 'changed history']) test(`completion defers when ${reason}`, async () => {
  const f = fixture();
  if (reason === 'busy') f.snap.idle = false;
  if (reason === 'stopped') f.stop();
  if (reason === 'missing model') delete f.snap.session.model;
  if (reason === 'changed history') {
    let reads = 0;
    f.args.snapshot = async () => {
      if (++reads === 2) f.snap.messages.push({ info: { id: 'new-human', role: 'user' } });
      return structuredClone(f.snap);
    };
  }
  await deliverCompletionTurn(f.args);
  assert.equal(f.notification.turnState, 'pending');
  assert.deepEqual(f.prompts, []);
});
