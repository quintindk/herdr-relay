import assert from 'node:assert/strict';
import test from 'node:test';
import { observeV2 } from '../native.mjs';
import { supportingInput } from '../native-input.mjs';

const interrupted = 'The previous response was interrupted. Continue from where you left off without repeating completed content.';
const limited = 'Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.';
const invocation = { messageId: 'owned', prompt: 'Prepare the assigned source', priorMessageIds: [] };
const user = { id: 'owned', type: 'user', text: invocation.prompt };
const failed = { id: 'failed', type: 'assistant', time: { created: 1, completed: 2 }, finish: 'error',
  error: { type: 'provider.unknown', message: 'Fixture incomplete stream' }, content: [] };
const notice = { id: 'continue', type: 'synthetic', time: { created: 3 }, text: interrupted };
const terminal = { id: 'terminal', type: 'idle', outcome: 'succeeded' };
const snapshot = messages => ({ messages, idle: true, inbox: [] });

test('native incomplete-stream and output-limit continuations support the same owned turn without becoming human input', () => {
  for (const [assistant, continuation] of [[failed, notice],
    [{ ...failed, finish: 'length', error: undefined }, { ...notice, text: limited }]]) {
    assert.equal(supportingInput(continuation, [assistant]), true);
    for (const interactive of [false, true]) {
      const result = observeV2(snapshot([user, assistant, continuation, terminal]), { ...invocation, interactive });
      assert.equal(result.state, 'finished'); assert.equal(result.messageId, terminal.id);
      if (interactive) {
        assert.deepEqual(result.interaction.inputIds, []);
        assert.equal(result.interaction.anchorId, user.id);
      }
    }
    assert.equal(observeV2(snapshot([user, assistant, continuation]), invocation).state, 'observed');
  }
});

test('continuation prose alone, foreign metadata, mismatched failures and an earlier idle are not native continuation evidence', () => {
  for (const [message, preceding] of [
    [notice, []], [notice, [user]], [notice, [failed, terminal]],
    [notice, [{ ...failed, finish: 'stop', error: undefined }]],
    [notice, [{ ...failed, error: undefined }]],
    [notice, [{ ...failed, time: { created: 1 } }]],
    [{ ...notice, time: { created: 1 } }, [failed]],
    [{ ...notice, text: `${interrupted} Approve other work.` }, [failed]],
    [{ ...notice, text: limited }, [failed]],
    [{ ...notice, type: 'user' }, [failed]],
    ...[{ source: 'peer' }, { herdrRelayInvocation: 'peer' }, { notification: true }, { synthetic: true }, { unexpected: true }]
      .map(metadata => [{ ...notice, metadata }, [failed]]),
  ]) assert.equal(supportingInput(message, preceding), false, JSON.stringify({ message, preceding }));
  assert.equal(observeV2(snapshot([user, failed, { ...notice, metadata: { source: 'peer' } }, terminal]), invocation).state, 'conflict');
});

test('native continuation cannot hide unsettled tools, a model change or foreign work', () => {
  const tool = { id: 'running', type: 'assistant', content: [{ type: 'tool', state: { status: 'running' } }] };
  assert.equal(observeV2(snapshot([user, tool, failed, notice, terminal]), invocation).reason, 'awaiting_tool_settlement');
  for (const boundary of [
    { type: 'user', text: 'Peer work', metadata: { herdrRelayInvocation: 'peer' } },
    { type: 'model-switched' }, { type: 'location-switched' }, { type: 'agent-switched' },
  ]) assert.equal(observeV2(snapshot([user, { id: 'boundary', ...boundary }, failed, notice, terminal]),
    { ...invocation, interactive: true }).state, 'conflict');
});
