import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { harnessTask } from '../src/harness-tasks.mjs';
import { digest } from '../src/protocol.mjs';

function fixture(t, state = 'configured') {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const binding = store.register({ id: 'caller', companyId: 'company', agentId: 'agent',
    harness: 'opencode', instanceId: 'instance', conversationId: 'chat' }).binding;
  store.saveOperation({ id: 'observed', runId: '', availability: 'present', identity: { conversationId: 'chat' },
    placement: { terminalId: 'terminal', directory: '/repo' } });
  const bridge = store.saveOperation({ id: 'opencode-bridge:caller', runId: '', state, ready: false,
    identity: { bindingId: binding.id, observedId: 'observed', conversationId: 'chat', terminalId: 'terminal', directory: '/repo' },
    epoch: 'epoch', tokenHash: 'token-hash', sessionCreatedAt: Date.now() - 1000, controlRevision: 1 });
  const source = { id: 'human-message', text: 'Manage this human task.', createdAt: Date.now() };
  const task = { id: 'task', companyId: 'company', title: 'Human work', description: 'Details',
    assigneeUserId: 'human', assigneeAgentId: null, status: 'todo', priority: 'medium' };
  const f = { store, bridge, source, task, calls: [], hook: null };
  f.api = async (method, path, body) => {
    f.calls.push({ method, path, body: structuredClone(body) });
    await f.hook?.(method, path, body);
    let value;
    if (method === 'POST') {
      assert.equal(path, '/api/companies/company/issues');
      Object.assign(task, body);
      value = task;
    } else if (method === 'PATCH') {
      assert.equal(path, '/api/issues/task');
      Object.assign(task, body);
      value = task;
    } else {
      assert.equal(method, 'GET');
      if (path === '/api/companies/company') value = { id: 'company', defaultResponsibleUserId: 'default-human' };
      else if (path === '/api/issues/task') value = task;
      else if (path === '/api/issues/task/interactions' || path.startsWith('/api/companies/company/issues?')) value = [];
      else if (path === '/api/agents/other-agent') value = { id: 'other-agent', companyId: 'company' };
      else assert.fail(`Unexpected API call: ${method} ${path}`);
    }
    return structuredClone(value);
  };
  f.invoke = (action, input) => harnessTask(store, bridge, action, input, f.api);
  f.inspect = () => f.invoke('task-inspect', { taskId: 'task' });
  f.create = () => ({ key: 'create', payload: { title: 'Follow-up' }, source: { ...source } });
  f.run = (foreign = false) => {
    const owner = foreign ? store.register({ id: 'foreign', companyId: 'other', agentId: 'foreign-agent',
      harness: 'opencode', instanceId: 'other-instance', conversationId: 'other-chat' }).binding : binding;
    const previous = store.operation(bridge.id);
    if (!foreign) store.saveOperation({ ...previous, state: 'armed', lastSeen: new Date().toISOString() });
    try {
      return store.dispatch({ bindingId: owner.id, bindingRevision: owner.revision, companyId: owner.config.companyId,
        agentId: owner.config.agentId, taskId: 'unrelated-task', runId: `backend-${store.runs().length}` });
    } finally {
      if (!foreign) store.saveOperation(previous);
    }
  };
  f.writes = () => f.calls.filter(call => call.method !== 'GET');
  return f;
}

test('new configured and armed chats create through humanTask with the default human and derived authority', async t => {
  for (const state of ['configured', 'armed']) {
    const f = fixture(t, state);
    const input = f.create();
    const result = await f.invoke('task-create', input);
    assert.equal(result.task.assigneeUserId, 'default-human');
    assert.equal(result.task.assigneeAgentId, null);
    assert.equal(result.task.status, 'todo');
    assert.equal(result.state, 'recorded');
    const operation = f.store.operation(result.operationId);
    assert.deepEqual(operation.request.authority, { kind: 'native', bindingId: 'caller', conversationId: 'chat',
      sessionCreatedAt: f.bridge.sessionCreatedAt, sourceMessageId: input.source.id, sourceDigest: digest(input.source.text) });
    assert.equal(operation.request.companyId, 'company');
    assert.equal(operation.request.origin, undefined);
    assert.equal(operation.request.source, undefined);
    assert.equal(JSON.stringify(operation).includes(input.source.text), false);
    assert.equal(f.store.runs().length, 0);
    await f.invoke('task-create', input);
    assert.equal(f.writes().length, 1);
    await assert.rejects(f.invoke('task-create', { ...input, source: { ...input.source, text: 'Different instruction' } }),
      { code: 'operation_conflict' });
  }
});

test('inspection needs no source or idle worker and records neither authority nor operations', async t => {
  const f = fixture(t);
  f.run();
  const before = f.store.db.prepare('SELECT * FROM operations').all();
  const result = await f.inspect();
  assert.equal(result.task.id, 'task');
  assert.equal(result.defaultHumanUserId, 'default-human');
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(result.authority, undefined);
  assert.equal(result.source, undefined);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM operations').all(), before);
  assert.equal(f.writes().length, 0);
});

test('edit, assign and complete preserve humanTask revisions and mutation semantics', async t => {
  const f = fixture(t);
  let inspected = await f.inspect();
  for (const [action, payload, reason, expected] of [
    ['edit', { title: 'Renamed' }, 'Clarify title', { title: 'Renamed' }],
    ['assign', { assigneeAgentId: 'other-agent' }, 'Explicit delegation', { assigneeUserId: null, assigneeAgentId: 'other-agent' }],
    ['assign', { assigneeUserId: 'another-human' }, 'Return to human', { assigneeUserId: 'another-human', assigneeAgentId: null }],
    ['complete', undefined, 'Finished', { status: 'done' }],
  ]) {
    inspected = await f.invoke(`task-${action}`, { key: reason, taskId: 'task', expectedRevision: inspected.revision,
      ...(payload === undefined ? {} : { payload }), reason, source: f.source });
    assert.equal(inspected.state, 'recorded');
    assert.deepEqual(f.writes().at(-1).body, expected);
  }
  await assert.rejects(f.invoke('task-edit', { key: 'stale', taskId: 'task', expectedRevision: 'stale',
    payload: { title: 'Stale edit' }, source: f.source }), { code: 'stale_revision' });
  assert.equal(f.writes().length, 4);
});

test('unknown fields and authority, company, origin or protocol overrides are rejected before API calls', async t => {
  const f = fixture(t);
  for (const field of ['companyId', 'origin', 'authority', 'action', 'bindingId', 'conversationId', 'sessionCreatedAt',
    'epoch', 'terminalId', 'idle', 'unknown']) {
    await assert.rejects(f.invoke('task-create', { ...f.create(), [field]: 'foreign' }), { code: 'invalid_request' });
    await assert.rejects(f.invoke('task-inspect', { taskId: 'task', [field]: 'foreign' }), { code: 'invalid_request' });
  }
  await assert.rejects(f.invoke('task-delete', {}), { code: 'invalid_bridge_action' });
  await assert.rejects(f.invoke('task-create', { ...f.create(), payload: { title: 'Task', companyId: 'foreign' } }),
    { code: 'invalid_request' });
  assert.equal(f.calls.length, 0);
  f.task.companyId = 'foreign';
  await assert.rejects(f.inspect(), { code: 'forbidden' });
  assert.equal(f.writes().length, 0);
});

test('all writes reject an active caller run even when it targets another task', async t => {
  const f = fixture(t);
  const revision = (await f.inspect()).revision;
  f.run();
  f.calls.length = 0;
  for (const action of ['create', 'edit', 'assign', 'complete']) {
    await assert.rejects(f.invoke(`task-${action}`, action === 'create' ? f.create() : {
      key: action, taskId: 'task', expectedRevision: revision, source: f.source,
      ...(action === 'complete' ? {} : { payload: action === 'edit' ? { title: 'New' } : { assigneeUserId: 'human' } }),
    }), { code: 'conversation_busy' });
  }
  assert.equal(f.calls.length, 0);
});

test('native sources reject stale, future, synthetic, ignored, non-user and invalid text evidence', async t => {
  const f = fixture(t);
  for (const source of [null, {}, { ...f.source, id: '' }, { ...f.source, id: 'x'.repeat(65537) },
    { ...f.source, text: '' }, { ...f.source, text: ' ' }, { ...f.source, text: 'x'.repeat(16001) },
    { ...f.source, createdAt: f.bridge.sessionCreatedAt - 1 }, { ...f.source, createdAt: Date.now() + 60000 },
    { ...f.source, createdAt: '123' }, { ...f.source, createdAt: 1.5 },
    { ...f.source, synthetic: true }, { ...f.source, ignored: true }, { ...f.source, role: 'assistant' }]) {
    await assert.rejects(f.invoke('task-create', { ...f.create(), source }), { code: 'invalid_task_source' });
  }
  const { source, ...missing } = f.create();
  await assert.rejects(f.invoke('task-create', missing), { code: 'invalid_task_source' });
  assert.equal(f.calls.length, 0);
  await f.invoke('task-create', { ...f.create(), source: { ...f.source, role: 'user', text: 'x'.repeat(16000),
    createdAt: f.bridge.sessionCreatedAt } });
});

test('invocation messages from any binding or company never authorise human writes', async t => {
  for (const foreign of [false, true]) {
    const f = fixture(t);
    const run = f.run(foreign);
    f.store.save({ ...run, nativeState: 'settled', invocation: { messageId: f.source.id } }, 'test');
    await assert.rejects(f.invoke('task-create', f.create()), { code: 'invalid_task_source' });
    assert.equal(f.calls.length, 0);
  }
});

test('completion and review notification IDs are rejected in every state, including after awaits', async t => {
  for (const kind of ['completion', 'review']) {
    for (const state of ['pending', 'uncertain', 'announced', 'superseded']) {
      for (const during of [false, true]) {
        const f = fixture(t);
        const notification = { id: `${kind}-notification:test`, runId: '', state, messageId: f.source.id,
          origin: { bindingId: 'caller', conversationId: 'chat', sessionCreatedAt: f.bridge.sessionCreatedAt } };
        if (during) f.hook = () => f.store.saveOperation(notification);
        else f.store.saveOperation(notification);
        await assert.rejects(f.invoke('task-create', f.create()), { code: 'invalid_task_source' });
        assert.equal(f.calls.length, during ? 1 : 0);
        assert.equal(f.writes().length, 0);
      }
    }
  }
});

test('missing native proof, stale bridges and inactive bindings cannot read or write', async t => {
  for (const change of [
    f => f.store.saveOperation({ ...f.bridge, epoch: 'other' }),
    f => f.store.saveOperation({ ...f.bridge, tokenHash: 'other' }),
    f => f.store.saveOperation({ ...f.bridge, sessionCreatedAt: f.bridge.sessionCreatedAt + 1 }),
    f => f.store.saveOperation({ ...f.bridge, identity: { ...f.bridge.identity, conversationId: 'new-chat' } }),
    f => f.store.saveOperation({ ...f.bridge, state: 'revoked' }),
    f => f.store.retireBinding('caller'),
    f => { f.bridge.sessionCreatedAt = null; f.store.saveOperation(f.bridge); },
    f => { f.bridge.epoch = ''; f.store.saveOperation(f.bridge); },
    f => { f.bridge.tokenHash = ''; f.store.saveOperation(f.bridge); },
    f => { f.bridge.identity.bindingId = 'missing'; f.store.saveOperation(f.bridge); },
  ]) {
    const f = fixture(t);
    change(f);
    await assert.rejects(f.inspect());
    await assert.rejects(f.invoke('task-create', f.create()));
    assert.equal(f.calls.length, 0);
  }
});

test('checks after awaited reads reject changed bridge proof, binding, source or active work before writes', async t => {
  for (const [change, code] of [
    [f => f.store.saveOperation({ ...f.bridge, epoch: 'new' }), 'bridge_identity_mismatch'],
    [f => f.store.saveOperation({ ...f.bridge, tokenHash: 'new' }), 'bridge_identity_mismatch'],
    [f => f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 1 }), 'bridge_identity_mismatch'],
    [f => f.store.saveOperation({ ...f.bridge, controlRevision: 2 }), 'bridge_identity_mismatch'],
    [f => f.store.saveOperation({ ...f.bridge, identity: { ...f.bridge.identity, terminalId: 'new' } }), 'bridge_identity_mismatch'],
    [f => f.store.retireBinding('caller'), 'bridge_identity_mismatch'],
    [f => f.run(), 'conversation_busy'],
    [(f, input) => { input.source.text = 'Changed text'; }, 'invalid_task_source'],
    [(f, input) => { input.source = { ...input.source, id: 'new-message' }; }, 'invalid_task_source'],
    [(f, input) => { input.source.createdAt++; }, 'invalid_task_source'],
    [(f, input) => { input.source.role = 'assistant'; }, 'invalid_task_source'],
    [f => {
      const run = f.run(true);
      f.store.save({ ...run, nativeState: 'settled', invocation: { messageId: f.source.id } }, 'test');
    }, 'invalid_task_source'],
  ]) {
    const f = fixture(t);
    const input = f.create();
    f.hook = () => change(f, input);
    await assert.rejects(f.invoke('task-create', input), { code });
    assert.equal(f.calls.length, 1);
    assert.equal(f.writes().length, 0);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM operations WHERE id LIKE 'human-task:%'").get().n, 0);
  }
});

test('inspection revalidates after awaits and a revoked post-write caller cannot record success', async t => {
  const read = fixture(t);
  read.hook = () => read.store.saveOperation({ ...read.bridge, tokenHash: 'rotated' });
  await assert.rejects(read.inspect(), { code: 'bridge_identity_mismatch' });
  assert.equal(read.calls.length, 1);
  const write = fixture(t);
  const expectedRevision = (await write.inspect()).revision;
  write.hook = method => { if (method === 'PATCH') write.store.saveOperation({ ...write.bridge, epoch: 'changed' }); };
  await assert.rejects(write.invoke('task-edit', { key: 'edit', taskId: 'task', expectedRevision,
    payload: { title: 'Changed' }, source: write.source }), { code: 'bridge_identity_mismatch' });
  const operation = JSON.parse(write.store.db.prepare("SELECT data FROM operations WHERE id LIKE 'human-task:%'").get().data);
  assert.equal(operation.state, 'uncertain');
  assert.equal(write.writes().length, 1);
});
