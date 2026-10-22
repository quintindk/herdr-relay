import assert from 'node:assert/strict';
import test from 'node:test';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { nativeBoard } from '../src/native-board.mjs';
import { buildBoardRows } from '../src/task-board-view.mjs';
import { renderTaskBoard } from '../src/task-board-view.mjs';
import { digest } from '../src/protocol.mjs';

test('native board traverses collections and updates status through current backend revisions', async () => {
  const backend = await startBackend({ database: ':memory:' });
  try {
    const api = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
    await api('POST', '/v1/commands', { key: 'create', action: 'task.create', payload: { id: 'task', title: 'Task' } });
    const board = nativeBoard(api);
    assert.equal((await board.read()).tasks[0].companyId, 'native');
    const groups = buildBoardRows(await board.read()).filter(row => row.type === 'group');
    assert.equal(groups.some(row => row.name === 'Human: Board (local-board)'), false);
    assert.equal(groups.find(row => row.name === 'Human: owner').counts.open, 1);
    const inspected = await board.inspectTask({ taskId: 'task' });
    const changed = await board.statusTask({ taskId: 'task', expectedRevision: inspected.revision, key: 'edit', payload: { status: 'in_progress' } });
    assert.equal(changed.state, 'recorded');
    assert.equal(changed.outcome.confirmed, true);
    assert.equal((await board.detailTask({ taskId: 'task' })).task.status, 'in_progress');
    await board.statusTask({ taskId: 'task', expectedRevision: changed.revision, key: 'comment', payload: { status: 'done', comment: 'Checked' } });
    assert.equal((await board.detailTask({ taskId: 'task' })).comments[0].body, 'Checked');
  } finally { await backend.close(); }
});

test('native empty board has no fabricated human owner group', async () => {
  const board = nativeBoard(async (method, path) => path === '/v1/info' ? { instanceId: 'backend', userId: 'owner' } : { items: [] });
  assert.deepEqual(buildBoardRows(await board.read()), []);
});

test('native board displays readable identifiers without changing task identity', async () => {
  const opaque = `task_pc_${'a'.repeat(64)}`;
  const tasks = [
    { id: opaque, title: 'Imported task', source: { metadata: { identifier: 'DEF-42' } } },
    { id: `${opaque}b`, title: 'Native task' },
    { id: 'short-id', title: 'Short task', identifier: 'RELAY-7' },
  ];
  const board = nativeBoard(async (method, path) => {
    if (path === '/v1/info') return { instanceId: 'backend', userId: 'owner' };
    if (path.startsWith('/v1/tasks?')) return { items: tasks };
    if (path.startsWith('/v1/tasks/')) return tasks.find(task => task.id === decodeURIComponent(path.slice('/v1/tasks/'.length)));
    return { items: [] };
  });
  const snapshot = await board.read();
  assert.equal(snapshot.tasks[0].identifier, 'DEF-42');
  assert.equal(snapshot.tasks[0].id, opaque);
  assert.equal(snapshot.tasks[1].identifier, `${tasks[1].id.slice(0,12)}…${tasks[1].id.slice(-8)}`);
  assert.equal(snapshot.tasks[2].identifier, 'RELAY-7');
  assert.equal((await board.inspectTask({ taskId: opaque })).task.identifier, 'DEF-42');
  assert.equal((await board.detailTask({ taskId: opaque })).task.id, opaque);
});

test('native board displays paused schedules and completed taskless occurrences without inventing local admission', async () => {
  const backend = await startBackend({ database: ':memory:' });
  try {
    const token = backend.store.bootstrap().token;
    const owner = backend.store.authenticate(token);
    const command = (actor, key, action, payload) => backend.store.command(actor, { key, action, payload });
    command(owner, 'node', 'node.enrol', { id: 'node', name: 'Node' });
    const node = backend.store.authenticate(backend.store.enrolCredential(owner, 'node', 'credential').token);
    command(node, 'agent', 'agent.register', { id: 'agent', nodeId: 'node', name: 'Chat', mode: 'interactive' });
    command(node, 'ad', 'agent.advertise', { id: 'agent', expectedRevision: 1, availability: 'available', conversationId: 'chat' });
    command(owner, 'schedule', 'schedule.install', { id: 'visible-job', definition: { nodeId: 'node', targetAgentId: 'agent',
      targetConversationId: 'chat', cron: '* * * * *', enabled: true, instructions: 'Check' } });
    const board = nativeBoard(nativeBackendClient({ url: backend.origin, token }));
    let snapshot = await board.read();
    assert.equal(snapshot.routines[0].state, 'change_pending'); assert.equal(snapshot.routines[0].nextRunAt, null);
    command(node, 'ack', 'schedule.acknowledge', { id: 'visible-job', expectedRevision: 1 });
    snapshot = await board.read();
    assert.equal(snapshot.routines[0].state, 'active'); assert.equal(snapshot.routines[0].nextRunIsEstimate, true);
    const intendedAt = '2026-10-21T07:38:00.000Z';
    command(node, 'publish', 'schedule.publish', { id: `occurrence_${digest(['visible-job', intendedAt])}`, scheduleId: 'visible-job',
      definitionRevision: 1, intendedAt, candidate: 'candidate', summary: 'Live cron completed', evidence: 'Exact native terminal' });
    command(owner, 'pause', 'schedule.pause', { id: 'visible-job', expectedRevision: 1 });
    command(node, 'pause-ack', 'schedule.acknowledge', { id: 'visible-job', expectedRevision: 2 });
    snapshot = await board.read();
    assert.equal(snapshot.routines[0].state, 'paused'); assert.equal(snapshot.routines[0].executionMode, 'interactive_exact');
    assert.match(renderTaskBoard(snapshot, { width: 160, height: 40 }).text, /visible-job/);
    const detail = await board.detailRoutine({ scheduleId: 'visible-job' });
    assert.equal(detail.runs[0].status, 'completed'); assert.equal(detail.runs[0].linkedIssueId, null);
    assert.equal(detail.runs[0].summary, 'Live cron completed');
  } finally { await backend.close(); }
});

test('native board refuses repeated collection cursors instead of silently hiding schedules', async () => {
  const board = nativeBoard(async (method, path) => path.startsWith('/v1/schedules?')
    ? { items: [], nextCursor: 'loop' } : { items: [] });
  await assert.rejects(board.read(), { code: 'incomplete_collection' });
});

test('native board renders stable-agent schedules rather than rejecting their persistent target mode', async () => {
  const backend = await startBackend({ database: ':memory:' });
  try {
    const token = backend.store.bootstrap().token, owner = backend.store.authenticate(token);
    const command = (key, action, payload) => backend.store.command(owner, { key, action, payload });
    command('node', 'node.enrol', { id: 'node', name: 'Machine' });
    command('enrol', 'agent.enrol', { id: 'wright', nodeId: 'node', name: 'Wright', directory: '/workspace' });
    command('attach', 'agent.attach', { id: 'wright', expectedBindingRevision: 0, directory: '/workspace', conversationId: 'ses_fresh', bindingId: 'binding' });
    for (const [id, timing] of [['persistent-cron', { cron: '* * * * *' }], ['persistent-one-shot', { at: '2099-01-01T06:00:00Z' }]]) {
      command(id, 'schedule.install', { id, definition: { nodeId: 'node', targetAgentId: 'wright', instructions: 'Bounded check', enabled: true, ...timing } });
    }
    const snapshot = await nativeBoard(nativeBackendClient({ url: backend.origin, token })).read();
    assert.ok(snapshot.routines.every(r => r.executionMode === 'interactive_agent'));
    assert.doesNotThrow(() => buildBoardRows(snapshot));
    const frame = renderTaskBoard(snapshot, { width: 160, height: 40 });
    assert.match(frame.text, /persistent-cron/); assert.match(frame.text, /persistent-one-shot/);
    const malformed = { ...snapshot, routines: snapshot.routines.map(r => ({ ...r, executionMode: 'arbitrary-unsafe-mode' })) };
    assert.throws(() => buildBoardRows(malformed), /Invalid task board routines/);
  } finally { await backend.close(); }
});
