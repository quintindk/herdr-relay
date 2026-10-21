import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeOpenCodeV2, observeV2, checkV2Version } from '../native.mjs';

const invocation = { messageId: 'owned', prompt: 'work', priorMessageIds: ['prior'] };
const user = { id: 'owned', type: 'user', text: 'work' };
const terminal = { id: 'terminal', type: 'idle', outcome: 'succeeded' };
const snapshot = messages => ({ messages, idle: true, inbox: [] });

test('native version guard admits only the explicitly exercised releases', () => {
  for (const version of ['2.1.0', '2.1.2']) assert.equal(checkV2Version(version), version);
  for (const version of ['2.1.1', '2.1.3', '2.2.0', undefined]) {
    assert.throws(() => checkV2Version(version), { code: 'unsupported_native_version' });
  }
});

test('v2 observation requires owned prompt and correlated idle evidence, not global idle alone', () => {
  assert.equal(observeV2(snapshot([terminal]), invocation).state, 'uncertain');
  assert.equal(observeV2(snapshot([user]), invocation).state, 'observed');
  assert.equal(observeV2(snapshot([{ ...user, text: 'different' }, terminal]), invocation).state, 'conflict');
  assert.deepEqual(observeV2(snapshot([user, terminal]), invocation), { state: 'finished', messageId: 'terminal', outcome: 'succeeded' });
  for (const outcome of ['failed', 'interrupted']) {
    assert.equal(observeV2(snapshot([user, { ...terminal, outcome }]), invocation).outcome, outcome);
  }
});

test('foreign input fences a turn but later input cannot erase its original terminal receipt', () => {
  const foreign = { id: 'foreign', type: 'user', text: 'other work' };
  assert.equal(observeV2(snapshot([user, foreign, terminal]), invocation).reason, 'concurrent_native_input');
  assert.equal(observeV2(snapshot([user, terminal, foreign]), invocation).state, 'finished');
  assert.equal(observeV2({ ...snapshot([user, terminal]), inbox: [{ id: 'queued' }] }, invocation).state, 'observed');
  assert.equal(observeV2({ ...snapshot([user, terminal]), idle: false }, invocation).state, 'observed');
});

test('versioned snapshot traverses native pages and rejects changed identity', async () => {
  let pages = 0;
  const session = { id: 'session', projectID: 'project', location: { directory: '/workspace' }, time: { created: 1 } };
  const client = {
    session: { get: async () => session, active: async () => ({}), inbox: { list: async () => [] } },
    message: { list: async input => {
      pages++;
      return input.cursor ? { data: [terminal], cursor: {} } : { data: [user], cursor: { next: 'page-2' } };
    } },
  };
  const native = new NativeOpenCodeV2(client, { sessionId: 'session', projectId: 'project', directory: '/workspace', createdAt: 1 });
  assert.deepEqual((await native.snapshot()).messages, [user, terminal]);
  assert.equal(pages, 2);
  session.location.directory = '/replacement';
  await assert.rejects(native.snapshot(), { code: 'native_identity_mismatch' });
});

test('snapshot rejects looping native cursors instead of silently truncating', async () => {
  let page = 0;
  const native = new NativeOpenCodeV2({
    session: { get: async () => ({ id: 's', projectID: 'p', location: { directory: '/work' }, time: { created: 1 } }) },
    message: { list: async () => ({ data: [{ id: `m-${page++}` }], cursor: { next: 'loop' } }) },
  }, { sessionId: 's', projectId: 'p', directory: '/work', createdAt: 1 });
  await assert.rejects(native.snapshot(), { code: 'invalid_native_cursor' });
});
