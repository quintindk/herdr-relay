import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { harnessDelegation } from '../src/harness-delegation.mjs';

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const bridges = ['origin', 'worker'].map(id => {
    const identity = { companyId: 'company', machineId: 'machine', session: id, harness: 'opencode',
      sessionKind: 'id', conversationId: `chat-${id}` };
    const observed = store.saveOperation({ id: `herdr-agent:${id}`, runId: '', identity, agentId: id,
      availability: 'present', placement: { directory: `/work/${id}`, terminalId: id } });
    store.register({ id, companyId: 'company', agentId: id, harness: 'opencode',
      conversationId: identity.conversationId, instanceId: digest([identity.machineId, identity.session]) });
    return store.saveOperation({ id: `opencode-bridge:${id}`, runId: '', state: 'armed', ready: true,
      identity: { bindingId: id, observedId: observed.id, conversationId: identity.conversationId, ...observed.placement },
      epoch: 'epoch', sessionCreatedAt: 123, tokenHash: 'hash', lastSeen: new Date().toISOString() });
  });
  const [bridge, target] = bridges;
  const origin = { bindingId: 'origin', conversationId: 'chat-origin', sessionCreatedAt: 123,
    sourceMessageId: 'earlier-message', sourceDigest: 'earlier-digest' };
  const parent = store.saveOperation({ id: 'operator-task:parent', runId: '', state: 'recorded',
    request: { companyId: 'company', origin, body: { assigneeAgentId: 'origin' } },
    receipt: { id: 'parent', companyId: 'company', assigneeAgentId: 'origin' } });
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'POST') return { ...body, id: 'child', companyId: 'company' };
    return path === '/api/companies/company' ? { id: 'company' }
      : { id: path.split('/').at(-1), companyId: 'company', status: 'in_progress' };
  };
  const invoke = (input = {}, backend = api) => harnessDelegation(store, bridge, 'delegate', {
    conversationId: 'chat-origin', sessionCreatedAt: 123, epoch: 'epoch', key: 'child',
    targetBindingId: 'worker', title: 'Child', description: 'Do authorised work', parentTaskId: 'parent',
    source: { id: 'new-message', text: 'Delegate a child task', createdAt: 456 }, ...input,
  }, backend);
  return { store, bridge, target, parent, calls, api, invoke };
}

test('native child creation maps parentTaskId and checks parent immediately before POST', async t => {
  const f = fixture(t);
  const result = await f.invoke();
  assert.equal(f.store.operation(result.id).request.body.parentId, 'parent');
  assert.equal(f.calls.at(-2).path, '/api/issues/parent');
  assert.equal(f.calls.at(-1).method, 'POST');
  assert.equal(f.calls.at(-1).body.parentTaskId, undefined);
  f.store.saveOperation({ ...f.target, ready: false });
  f.store.saveOperation({ ...f.parent, state: 'uncertain' });
  const count = f.calls.length;
  assert.deepEqual(await f.invoke(), result);
  assert.equal(f.calls.length, count);
  await assert.rejects(f.invoke({ parentTaskId: 'other' }), { code: 'operation_conflict' });
});

for (const [name, change] of [
  ['unknown parent', f => f.store.saveOperation({ ...f.parent, receipt: { id: 'other', companyId: 'company' } })],
  ['unrecorded parent', f => f.store.saveOperation({ ...f.parent, state: 'uncertain' })],
  ['other company', f => f.store.saveOperation({ ...f.parent, request: { ...f.parent.request, companyId: 'other' } })],
  ['other origin binding', f => f.store.saveOperation({ ...f.parent,
    request: { ...f.parent.request, origin: { ...f.parent.request.origin, bindingId: 'worker' } } })],
  ['other origin conversation', f => f.store.saveOperation({ ...f.parent,
    request: { ...f.parent.request, origin: { ...f.parent.request.origin, conversationId: 'other' } } })],
  ['other origin session', f => f.store.saveOperation({ ...f.parent,
    request: { ...f.parent.request, origin: { ...f.parent.request.origin, sessionCreatedAt: 124 } } })],
]) {
  test(`native creation refuses ${name} before any backend access`, async t => {
    const f = fixture(t);
    change(f);
    await assert.rejects(f.invoke(), { code: 'forbidden' });
    assert.equal(f.calls.length, 0);
  });
}

for (const status of ['done', 'cancelled', undefined]) {
  test(`native creation refuses parent status ${status}`, async t => {
    const f = fixture(t);
    await assert.rejects(f.invoke({}, async (...args) => {
      const result = await f.api(...args);
      return args[1] === '/api/issues/parent' ? { ...result, status } : result;
    }), { code: 'parent_unavailable' });
    assert.equal(f.calls.some(call => call.method === 'POST'), false);
  });
}

test('native creation rechecks durable parent and caller authorisation after backend reads', async t => {
  const f = fixture(t);
  await assert.rejects(f.invoke({}, async (...args) => {
    const result = await f.api(...args);
    if (args[1] === '/api/issues/parent') f.store.saveOperation({ ...f.parent,
      receipt: { ...f.parent.receipt, title: 'Changed receipt' } });
    return result;
  }), { code: 'parent_scope_changed' });
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
  await assert.rejects(f.invoke({}, async (...args) => {
    const result = await f.api(...args);
    if (args[1] === '/api/issues/parent') f.store.saveOperation({ ...f.bridge, state: 'configured' });
    return result;
  }), { code: 'bridge_identity_mismatch' });
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('native creation rejects backend parent scope changes and still refuses self delegation', async t => {
  const f = fixture(t);
  await assert.rejects(f.invoke({}, async (...args) => {
    const result = await f.api(...args);
    return args[1] === '/api/issues/parent' ? { ...result, companyId: 'other' } : result;
  }), { code: 'forbidden' });
  await assert.rejects(f.invoke({ targetBindingId: 'origin' }), { code: 'invalid_delegation_target' });
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});
