import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeTranscript } from '../scripts/collaboration-evidence.mjs';

test('collaboration evidence uses the native cursor parameter and keeps pagination options inside the cursor', async () => {
  const calls = [];
  const client = { message: { list: async input => {
    calls.push(input);
    return input.cursor ? { data: [{ id: 'terminal' }], cursor: {} } : { data: [{ id: 'invocation' }], cursor: { next: 'opaque-native-cursor' } };
  } } };
  const messages = await nativeTranscript(client, 'test-session');
  assert.deepEqual(messages.map(message => message.id), ['invocation', 'terminal']);
  assert.deepEqual(calls, [{ sessionID: 'test-session', order: 'asc', limit: 100 }, { sessionID: 'test-session', cursor: 'opaque-native-cursor' }]);
  assert.ok(calls.every(call => !Object.hasOwn(call, 'after')));
});

test('collaboration evidence refuses a looping native cursor rather than accepting a truncated transcript', async () => {
  let page = 0;
  await assert.rejects(nativeTranscript({ message: { list: async () => ({ data: [{ id: `page-${++page}` }], cursor: { next: 'repeated' } }) } }, 'test-session'), /cursor repeated/);
});

test('collaboration evidence refuses duplicate messages across otherwise distinct pages', async () => {
  await assert.rejects(nativeTranscript({ message: { list: async input => ({ data: [{ id: 'same-message' }], cursor: input.cursor ? {} : { next: 'next' } }) } }, 'test-session'), /repeated message/);
});
