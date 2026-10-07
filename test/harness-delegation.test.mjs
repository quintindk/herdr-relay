import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { harnessDelegation } from '../src/harness-delegation.mjs';
import { reconcileNotifications } from '../src/completion-notifications.mjs';
import { mutate } from '../src/operations.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-delegation-'));
  const path = join(directory, 'state.sqlite');
  const f = { store: new Store(path), calls: [], tasks: new Map() };
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  f.restart = () => { f.store.close(); f.store = new Store(path); };
  f.add = (id, companyId = 'company') => {
    const identity = { companyId, machineId: 'machine', session: 'default', harness: 'opencode',
      sessionKind: 'id', conversationId: `session-${id}` };
    const observed = f.store.saveOperation({ id: `herdr-agent:${id}`, runId: '', identity,
      availability: 'present', agentId: `agent-${id}`, marker: `marker-${id}`,
      placement: { directory: `/work/${id}`, terminalId: `terminal-${id}` }, observation: { display: { name: `Agent ${id}` } } });
    f.store.register({ id, companyId, agentId: observed.agentId, harness: 'opencode',
      conversationId: identity.conversationId, instanceId: digest([identity.machineId, identity.session]), label: `Old ${id}` });
    return f.store.saveOperation({ id: `opencode-bridge:${id}`, runId: '',
      identity: { bindingId: id, observedId: observed.id, conversationId: identity.conversationId, ...observed.placement },
      sessionCreatedAt: 123, epoch: `epoch-${id}`, lastSeen: new Date().toISOString(), ready: true, state: 'armed',
      tokenHash: 'secret-hash', workerContext: '/private/must-not-be-read.json', token: 'secret-token' });
  };
  f.bridge = f.add('origin'); f.target = f.add('worker');
  f.api = async (method, path, body) => {
    f.calls.push({ method, path, body });
    if (method === 'GET') return path === '/api/companies/company' ? { id: 'company' }
      : { id: path.split('/').at(-1), companyId: 'company' };
    assert.equal(path, '/api/companies/company/issues');
    if (!f.tasks.has(body.idempotencyKey)) f.tasks.set(body.idempotencyKey, {
      id: `task-${f.tasks.size + 1}`, companyId: 'company', identifier: `TEST-${f.tasks.size + 1}`, ...body,
      token: 'secret-receipt-token', privateContext: { token: 'nested-secret' },
    });
    return f.tasks.get(body.idempotencyKey);
  };
  f.input = { key: 'delegate-once', targetBindingId: 'worker', title: 'Check the change', description: 'Run the checks and report the result.',
    source: { id: 'user-message', text: 'Ask the worker to check this.', createdAt: 456 } };
  f.invoke = (action = 'delegate', input = {}, bridge = f.bridge, api = f.api) => harnessDelegation(f.store, bridge, action, {
    conversationId: bridge.identity.conversationId, sessionCreatedAt: bridge.sessionCreatedAt, epoch: bridge.epoch,
    ...(action === 'delegate' ? f.input : {}), ...input,
  }, api);
  f.run = (bindingId = 'worker', taskId = 'task-1') => {
    const binding = f.store.binding(bindingId);
    return f.store.dispatch({ bindingId, bindingRevision: binding.revision, companyId: binding.config.companyId,
      agentId: binding.config.agentId, taskId, runId: `backend-${f.store.runs().length}` });
  };
  return f;
}

test('agents exposes only ready same-company peers and public placement fields', async t => {
  const f = fixture(t);
  f.add('foreign', 'other');
  f.store.saveOperation({ ...f.bridge, ready: false });
  assert.deepEqual(await f.invoke('agents'), { agents: [
    { bindingId: 'worker', agentId: 'agent-worker', label: 'Agent worker', directory: '/work/worker' },
  ] });
  assert.equal(f.calls.length, 0);
});

for (const [name, change] of [
  ['configured bridge', f => f.store.saveOperation({ ...f.target, state: 'configured' })],
  ['busy plugin', f => f.store.saveOperation({ ...f.target, ready: false })],
  ['stale plugin', f => f.store.saveOperation({ ...f.target, lastSeen: new Date(Date.now() - 11000).toISOString() })],
  ['future heartbeat', f => f.store.saveOperation({ ...f.target, lastSeen: new Date(Date.now() + 60000).toISOString() })],
  ['missing epoch', f => f.store.saveOperation({ ...f.target, epoch: null })],
  ['missing creation identity', f => f.store.saveOperation({ ...f.target, sessionCreatedAt: null })],
  ['changed bridge conversation', f => f.store.saveOperation({ ...f.target, identity: { ...f.target.identity, conversationId: 'new' } })],
  ['offline observation', (f, observed) => f.store.saveOperation({ ...observed, availability: 'offline' })],
  ['ambiguous observation', (f, observed) => f.store.saveOperation({ ...observed, availability: 'unknown' })],
  ['observation error', (f, observed) => f.store.saveOperation({ ...observed, error: 'agent_identity_ambiguous' })],
  ['stale observation', (f, observed) => f.store.db.prepare('UPDATE operations SET data = ? WHERE id = ?')
    .run(JSON.stringify({ ...observed, updatedAt: new Date(Date.now() - 16000).toISOString() }), observed.id)],
  ['changed agent', (f, observed) => f.store.saveOperation({ ...observed, agentId: 'different' })],
  ['changed company', (f, observed) => f.store.saveOperation({ ...observed, identity: { ...observed.identity, companyId: 'other' } })],
  ['changed machine', (f, observed) => f.store.saveOperation({ ...observed, identity: { ...observed.identity, machineId: 'other' } })],
  ['changed conversation', (f, observed) => f.store.saveOperation({ ...observed, identity: { ...observed.identity, conversationId: 'other' } })],
  ['changed harness', (f, observed) => f.store.saveOperation({ ...observed, identity: { ...observed.identity, harness: 'hermes' } })],
  ['changed terminal', (f, observed) => f.store.saveOperation({ ...observed, placement: { ...observed.placement, terminalId: 'other' } })],
  ['changed directory', (f, observed) => f.store.saveOperation({ ...observed, placement: { ...observed.placement, directory: '/other' } })],
  ['retired binding', f => f.store.retireBinding('worker')],
  ['unsettled Relay run', f => f.run()],
]) {
  test(`agents and new delegation reject ${name}`, async t => {
    const f = fixture(t);
    change(f, f.store.operation(f.target.identity.observedId));
    assert.deepEqual(await f.invoke('agents'), { agents: [] });
    await assert.rejects(f.invoke(), { code: 'agent_not_ready' });
    assert.equal(f.calls.length, 0);
  });
}

test('delegate persists derived immutable origin, todo assignment and default human policy', async t => {
  const f = fixture(t);
  f.store.saveOperation({ ...f.bridge, ready: false });
  const result = await f.invoke();
  const operation = f.store.operation(result.id);
  assert.deepEqual(operation.request.origin, { bindingId: 'origin', conversationId: 'session-origin', sessionCreatedAt: 123,
    sourceMessageId: 'user-message', sourceDigest: digest(f.input.source.text) });
  assert.equal(operation.request.companyId, 'company');
  assert.equal(operation.request.relayReviewPolicy, 'human');
  assert.equal(operation.request.body.status, 'todo');
  assert.equal(operation.request.body.assigneeAgentId, 'agent-worker');
  assert.equal(operation.request.body.relayReviewPolicy, undefined);
  assert.equal(operation.request.body.origin, undefined);
  assert.equal(JSON.stringify(operation).includes(f.input.source.text), false);
  assert.deepEqual(result, { id: operation.id, state: 'recorded', receipt: { id: 'task-1', identifier: 'TEST-1', title: f.input.title,
    status: 'todo', companyId: 'company', assigneeAgentId: 'agent-worker' }, runs: [] });
  assert.deepEqual(await f.invoke('delegation-status'), { delegations: [result] });
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('recorded retries survive restart and busy targets but changed payloads conflict', async t => {
  const f = fixture(t);
  const result = await f.invoke();
  f.restart();
  f.store.saveOperation({ ...f.target, ready: false, lastSeen: '2000-01-01T00:00:00Z' });
  const calls = f.calls.length;
  assert.deepEqual(await f.invoke(), result);
  for (const change of [{ title: 'Changed' }, { description: 'Changed' }, { relayReviewPolicy: 'none' }]) {
    await assert.rejects(f.invoke('delegate', change), { code: 'operation_conflict' });
  }
  f.add('other-worker');
  await assert.rejects(f.invoke('delegate', { targetBindingId: 'other-worker' }), { code: 'operation_conflict' });
  assert.equal(f.calls.length, calls);
  assert.equal(f.tasks.size, 1);
});

test('lost creation reply reconciles with the same namespaced idempotency key', async t => {
  const f = fixture(t);
  const loseReply = async (...args) => {
    const result = await f.api(...args);
    if (args[0] === 'POST') throw new Error('Lost committed reply');
    return result;
  };
  await assert.rejects(f.invoke('delegate', {}, f.bridge, loseReply), /Lost committed reply/);
  f.restart();
  f.store.saveOperation({ ...f.target, ready: false });
  await assert.rejects(f.invoke('delegate', { title: 'Changed' }), { code: 'operation_conflict' });
  await assert.rejects(f.invoke(), { code: 'agent_not_ready' });
  f.store.saveOperation(f.target);
  const result = await f.invoke();
  assert.equal(result.receipt.id, 'task-1');
  assert.equal(f.tasks.size, 1);
  const posts = f.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, posts[1].body);
  const origin = { bindingId: 'origin', conversationId: 'session-origin', sessionCreatedAt: 123,
    sourceMessageId: f.input.source.id, sourceDigest: digest(f.input.source.text) };
  const key = `harness-delegation:${digest([origin, f.input.key, f.input.source])}`;
  assert.equal(posts[0].body.idempotencyKey, `relay-operator:${digest(['company', key])}`);
});

for (const [name, change, code] of [
  ['target busy', f => f.store.saveOperation({ ...f.target, ready: false }), 'agent_not_ready'],
  ['target placement changed', f => {
    const observed = f.store.operation(f.target.identity.observedId);
    f.store.saveOperation({ ...observed, placement: { ...observed.placement, terminalId: 'new' } });
  }, 'agent_not_ready'],
  ['target retired', f => f.store.retireBinding('worker'), 'agent_not_ready'],
  ['target epoch changed', f => f.store.saveOperation({ ...f.target, epoch: 'new' }), 'agent_not_ready'],
  ['target creation changed', f => f.store.saveOperation({ ...f.target, sessionCreatedAt: 999 }), 'agent_not_ready'],
  ['caller disarmed', f => f.store.saveOperation({ ...f.bridge, state: 'configured' }), 'bridge_identity_mismatch'],
  ['caller epoch changed', f => f.store.saveOperation({ ...f.bridge, epoch: 'new' }), 'bridge_identity_mismatch'],
  ['caller creation changed', f => f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 999 }), 'bridge_identity_mismatch'],
  ['caller acquired Relay work', f => f.run('origin'), 'conversation_busy'],
]) {
  test(`creation revalidates after backend lookups when ${name}`, async t => {
    const f = fixture(t);
    const api = async (...args) => {
      const result = await f.api(...args);
      if (args[1] === '/api/agents/agent-worker') change(f);
      return result;
    };
    await assert.rejects(f.invoke('delegate', {}, f.bridge, api), { code });
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  });
}

test('unsupported actions, invalid payloads and review policies never create tasks', async t => {
  const f = fixture(t);
  await assert.rejects(f.invoke('unknown'), { code: 'invalid_bridge_action' });
  for (const input of [{ key: '' }, { title: '' }, { description: '' }, { description: {} }]) {
    await assert.rejects(f.invoke('delegate', input), { code: 'invalid_request' });
  }
  for (const relayReviewPolicy of ['invalid', null, {}]) {
    await assert.rejects(f.invoke('delegate', { relayReviewPolicy }), { code: 'invalid_review_policy' });
  }
  assert.equal(f.calls.length, 0);
  const result = await f.invoke('delegate', { relayReviewPolicy: 'agent_decides' });
  assert.equal(f.store.operation(result.id).request.relayReviewPolicy, 'agent_decides');
});

test('source, caller and key namespaces keep distinct requests separate', async t => {
  const f = fixture(t);
  const first = await f.invoke();
  const second = await f.invoke('delegate', { key: 'another' });
  const third = await f.invoke('delegate', { source: { ...f.input.source, id: 'another-message' } });
  const fourth = await f.invoke('delegate', {}, f.add('another-origin'));
  assert.equal(new Set([first.id, second.id, third.id, fourth.id]).size, 4);
  assert.equal(f.tasks.size, 4);
});

test('caller identity, origin overrides, cross-company and self targets fail closed', async t => {
  const f = fixture(t);
  f.add('foreign', 'other');
  for (const change of [{ sessionCreatedAt: 124 }, { conversationId: 'new' }, { epoch: 'old' }, { bindingId: 'worker' }]) {
    for (const action of ['agents', 'delegate', 'delegation-status']) {
      await assert.rejects(f.invoke(action, change), { code: 'bridge_identity_mismatch' });
    }
  }
  for (const change of [{ origin: { bindingId: 'worker' } }, { companyId: 'other' }]) {
    await assert.rejects(f.invoke('delegate', change), { code: 'invalid_request' });
  }
  for (const targetBindingId of ['origin', 'foreign', 'missing']) {
    await assert.rejects(f.invoke('delegate', { targetBindingId }), { code: 'invalid_delegation_target' });
  }
  f.store.saveOperation({ ...f.bridge, state: 'configured' });
  await assert.rejects(f.invoke(), { code: 'bridge_unavailable' });
  f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 124 });
  await assert.rejects(f.invoke(), { code: 'bridge_identity_mismatch' });
  assert.equal(f.calls.length, 0);
});

test('active caller work must use the worker route and historical invocation messages cannot authorise delegation', async t => {
  const f = fixture(t);
  const run = f.run('origin');
  await assert.rejects(f.invoke(), error => error.code === 'conversation_busy' && /worker task route/.test(error.message));
  f.store.cancel(run.id);
  f.store.save({ ...f.store.run(run.id), invocation: { messageId: f.input.source.id } }, 'test.invocation');
  await assert.rejects(f.invoke(), { code: 'invalid_delegation_source' });
  assert.equal(f.calls.length, 0);
});

test('notification sources in every state and malformed or synthetic native sources are rejected', async t => {
  const f = fixture(t);
  for (const state of ['pending', 'uncertain', 'delivered', 'conflict']) {
    f.store.saveOperation({ id: 'completion-notification:test', runId: '', state, messageId: f.input.source.id,
      origin: { bindingId: 'origin', conversationId: 'session-origin', sessionCreatedAt: 123 } });
    await assert.rejects(f.invoke(), { code: 'invalid_delegation_source' });
  }
  for (const change of [{ text: '' }, { text: ' '.repeat(10) }, { text: 'x'.repeat(16001) }, { id: '' },
    { createdAt: '456' }, { createdAt: 122 }, { createdAt: Date.now() + 60000 }, { synthetic: true }, { ignored: true }]) {
    await assert.rejects(f.invoke('delegate', { source: { ...f.input.source, id: 'not-a-notification', ...change } }),
      { code: 'invalid_delegation_source' });
  }
  assert.equal(f.calls.length, 0);
});

test('status is restricted to operator task origin identity and company with allowlisted run summaries', async t => {
  const f = fixture(t);
  const origin = { bindingId: 'origin', conversationId: 'session-origin', sessionCreatedAt: 123 };
  const task = { id: 'operator-task:owned', runId: '', state: 'recorded', request: { companyId: 'company', origin },
    receipt: { id: 'task-1', title: 'Owned', token: 'secret' }, token: 'secret' };
  f.store.saveOperation(task);
  for (const [id, request] of [
    ['legacy', { companyId: 'company' }], ['company', { companyId: 'other', origin }],
    ['binding', { companyId: 'company', origin: { ...origin, bindingId: 'worker' } }],
    ['conversation', { companyId: 'company', origin: { ...origin, conversationId: 'fresh' } }],
    ['creation', { companyId: 'company', origin: { ...origin, sessionCreatedAt: 124 } }],
  ]) f.store.saveOperation({ ...task, id: `operator-task:${id}`, request, receipt: { ...task.receipt, id } });
  f.store.saveOperation({ ...task, id: 'worker-task:not-operator' });
  f.store.saveOperation({ ...task, id: 'operator-task:wrong-receipt', receipt: { id: 'task-1', companyId: 'other' } });
  f.store.saveOperation({ ...task, id: 'operator-task:uncertain', state: 'uncertain', receipt: undefined });
  const run = f.run();
  f.store.save({ ...run, nativeState: 'settled', result: { summary: 'Finished checks', candidate: 'revision', token: 'secret' },
    publication: { state: 'recorded', token: 'secret' }, settlement: { outcome: 'completed', evidence: 'secret' },
    review: { status: 'accepted', token: 'secret' }, invocation: { prompt: 'secret', token: 'secret' } }, 'test.result');
  f.run('worker', 'unrelated');
  f.add('foreign', 'other'); f.run('foreign');
  const result = await f.invoke('delegation-status');
  assert.deepEqual(result.delegations.map(item => item.id), ['operator-task:uncertain', 'operator-task:owned']);
  assert.deepEqual(result.delegations[0].runs, []);
  assert.deepEqual(result.delegations[1].runs, [{ id: run.id, deliveryState: 'pending', nativeState: 'settled',
    outcome: 'completed', publicationState: 'recorded', reviewStatus: 'accepted', candidate: 'revision', summary: 'Finished checks' }]);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  const replacement = f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 999 });
  assert.deepEqual(await f.invoke('delegation-status', {}, replacement), { delegations: [] });
  assert.equal(f.calls.length, 0);
});

test('uncertain creation status is scoped intent only, even with a receipt claiming another root', async t => {
  const f = fixture(t);
  const delegated = await f.invoke();
  const root = f.store.operation(delegated.id);
  const run = f.run();
  f.store.save({ ...run, nativeState: 'settled', result: { candidate: 'private-candidate', summary: 'Private result' } }, 'test.result');
  const other = f.add('other');
  const origin = { ...root.request.origin, bindingId: 'other', conversationId: 'session-other' };
  const intent = f.store.saveOperation({ ...root, id: 'operator-task:uncertain', state: 'uncertain',
    request: { ...root.request, origin }, receipt: { ...root.receipt, title: 'Private title' } });
  for (const [id, request] of [
    ['company', { companyId: 'foreign', origin }],
    ['conversation', { companyId: 'company', origin: { ...origin, conversationId: 'fresh' } }],
    ['session', { companyId: 'company', origin: { ...origin, sessionCreatedAt: 124 } }],
    ['binding', root.request],
  ]) f.store.saveOperation({ ...intent, id: `operator-task:uncertain-${id}`, request });
  f.restart();
  assert.deepEqual(await f.invoke('delegation-status', {}, other), {
    delegations: [{ id: intent.id, state: 'uncertain', receipt: null, runs: [] }],
  });
  const owned = await f.invoke('delegation-status');
  assert.equal(owned.delegations.find(item => item.id === root.id).runs[0].summary, 'Private result');
});

test('conflicting recorded roots cannot expose results through status or a recorded delegate retry', async t => {
  const f = fixture(t);
  const delegated = await f.invoke();
  const root = f.store.operation(delegated.id);
  const run = f.run();
  f.store.save({ ...run, nativeState: 'settled', result: { candidate: 'private', summary: 'Private result' } }, 'test.result');
  const other = f.add('other');
  f.store.saveOperation({ ...root, id: 'operator-task:conflict', request: { ...root.request,
    origin: { ...root.request.origin, bindingId: 'other', conversationId: 'session-other' } } });
  f.restart();
  assert.deepEqual(await f.invoke('delegation-status'), { delegations: [] });
  assert.deepEqual(await f.invoke('delegation-status', {}, other), { delegations: [] });
  const calls = f.calls.length;
  assert.deepEqual(await f.invoke(), { id: root.id, state: 'recorded', receipt: null, runs: [] });
  assert.equal(f.calls.length, calls);
});

test('status inherits child and grandchild results only through verified recorded lineage', async t => {
  const f = fixture(t);
  const delegated = await f.invoke();
  const root = f.store.operation(delegated.id);
  const entries = [root];
  let parentRun = f.run();
  for (const id of ['child', 'grandchild']) {
    const child = await mutate(f.store, parentRun, 'worker-token', async (_run, _token, method, _path, body) => {
      assert.equal(method, 'POST');
      return { ...body, id, companyId: 'company', identifier: `TEST-${id}` };
    }, { key: id, kind: 'task.create', payload: { title: id, parentId: parentRun.request.taskId, assigneeAgentId: 'agent-worker' } });
    entries.push(child);
    f.store.cancel(parentRun.id);
    parentRun = f.run('worker', id);
    f.store.save({ ...parentRun, result: { summary: `${id} result`, candidate: `${id} candidate` } }, 'test.result');
  }
  const other = f.add('other');
  f.restart();
  const status = await f.invoke('delegation-status');
  assert.equal(status.delegations.length, 3);
  for (const entry of entries) {
    const item = status.delegations.find(item => item.id === entry.id);
    assert.equal(item.receipt.id, entry.receipt.id);
    assert.equal(item.runs.length, 1);
    if (entry !== root) assert.equal(item.runs[0].summary, `${entry.receipt.id} result`);
  }
  assert.deepEqual(await f.invoke('delegation-status', {}, other), { delegations: [] });
  assert.deepEqual(await f.invoke('delegation-status', {}, f.target), { delegations: [] });
  f.store.saveOperation({ ...root, id: 'operator-task:conflict', request: { ...root.request,
    origin: { ...root.request.origin, bindingId: 'other', conversationId: 'session-other' } } });
  assert.deepEqual(await f.invoke('delegation-status'), { delegations: [] });
  assert.deepEqual(await f.invoke('delegation-status', {}, other), { delegations: [] });
});

test('recorded delegation origin returns completion only to its exact original native session', async t => {
  const f = fixture(t);
  const delegated = await f.invoke('delegate', { relayReviewPolicy: 'none' });
  assert.equal(f.store.operation(delegated.id).request.relayReviewPolicy, 'none');
  const run = f.run();
  f.store.acknowledge(run.id);
  f.store.submit(run.id, { key: 'result', summary: 'Checks passed', candidate: 'revision' });
  f.store.publication(run.id, { state: 'recorded' });
  f.store.settle(run.id, { outcome: 'completed', evidence: 'Finished' });
  f.store.saveOperation({ id: `no-review-completion:${run.id}`, runId: run.id, state: 'recorded', status: 'done', candidate: 'revision' });
  f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 999 });
  const [notification] = reconcileNotifications(f.store);
  assert.ok(notification, 'createOperatorTask must persist input.origin in request.origin');
  assert.deepEqual(notification.origin, { bindingId: 'origin', conversationId: 'session-origin', sessionCreatedAt: 123 });
  assert.equal(notification.summary, 'Checks passed');
  assert.deepEqual(reconcileNotifications(f.store), []);
});
