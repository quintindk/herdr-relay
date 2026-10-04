import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hermesConfig, observeHermes } from '../src/hermes.mjs';

test('Hermes terminal proof must correlate persisted user and final assistant rows', () => {
  const invocation = { prompt: 'exact Relay prompt', priorUserIds: [1] };
  const snapshot = { idle: true, session: { session_id: 'runtime', messages: [
    { role: 'user', text: 'prior context', row_id: 1 },
    { role: 'user', text: invocation.prompt, row_id: 3 },
    { role: 'assistant', text: 'Finished', row_id: 7 },
  ] }, events: { events: [], truncated: false } };
  assert.equal(observeHermes(snapshot, invocation).state, 'observed');
  snapshot.events.events.push({ type: 'message.complete', session_id: 'runtime', payload: {
    status: 'complete', persisted_turn: { complete: true, user_row_id: 3, final_assistant_row_id: 7, row_ids: [3, 7] },
  } });
  assert.equal(observeHermes(snapshot, invocation).state, 'finished');
  snapshot.events.events[0].payload.persisted_turn.user_row_id = 1;
  assert.equal(observeHermes(snapshot, invocation).state, 'observed');
  snapshot.events.events[0].payload.persisted_turn.user_row_id = 3;
  snapshot.idle = false;
  assert.equal(observeHermes(snapshot, invocation).state, 'observed');
  snapshot.idle = true;
  snapshot.session.messages.push({ role: 'user', text: 'Human input', row_id: 8 });
  assert.equal(observeHermes(snapshot, invocation).state, 'conflict');
});

test('Hermes missing or evicted evidence never becomes completion from idle alone', () => {
  const invocation = { prompt: 'work', priorUserIds: [] };
  const snapshot = { idle: true, session: { session_id: 'runtime', messages: [] }, events: { events: [], truncated: true } };
  assert.equal(observeHermes(snapshot, invocation).state, 'uncertain');
  snapshot.session.messages.push({ role: 'user', text: 'work', row_id: 1 });
  assert.equal(observeHermes(snapshot, invocation).reason, 'terminal_evidence_evicted');
  snapshot.session.messages.push({ role: 'user', text: 'work', row_id: 2 });
  assert.equal(observeHermes(snapshot, invocation).state, 'conflict');
});

test('Hermes requires local credentials, exact runtime epoch and reservation', () => {
  const input = { url: 'ws://127.0.0.1:17402/api/ws', authFile: '/private/token', directory: '/work',
    runtimeId: 'runtime', epoch: 'epoch', exclusive: true };
  assert.deepEqual(hermesConfig(input), input);
  assert.throws(() => hermesConfig({ ...input, epoch: '' }), { code: 'invalid_request' });
  assert.throws(() => hermesConfig({ ...input, url: 'ws://example.com/api/ws' }), { code: 'invalid_native_config' });
  assert.throws(() => hermesConfig({ ...input, exclusive: false }), { code: 'native_reservation_required' });
});

test('legacy Hermes terminal replay requires the reserved input segment and unique durable final row', () => {
  const invocation = { prompt: 'work\n', priorUserIds: [], eventCursor: 10 };
  const snapshot = { idle: true, session: { session_id: 'runtime', messages: [
    { role: 'user', text: 'work', row_id: 4 }, { role: 'assistant', text: 'done', row_id: 6 },
  ] }, events: { events: [{ type: 'message.complete', session_id: 'runtime', seq: 11, payload: { status: 'complete', text: 'done' } }] } };
  assert.equal(observeHermes(snapshot, invocation).state, 'finished');
  snapshot.events.events[0].seq = 9;
  assert.equal(observeHermes(snapshot, invocation).state, 'observed');
  snapshot.events.events[0].seq = 11;
  snapshot.session.messages.push({ role: 'assistant', text: 'done', row_id: 7 });
  assert.equal(observeHermes(snapshot, invocation).state, 'observed');
});
