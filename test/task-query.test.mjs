import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryTasks, readTaskComments } from '../src/task-query.mjs';
import { digest } from '../src/protocol.mjs';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const companyId = 'company';
const taskId = id(100);
const from = '2026-10-01T00:00:00Z';
const to = '2026-10-08T00:00:00Z';
const task = (number, extra = {}) => ({ id: id(number), companyId, title: 'Task', status: 'todo', priority: 'medium',
  description: 'Preview', parentId: null, ...extra });
const comment = (number, extra = {}) => ({ id: id(number), companyId, issueId: taskId, body: 'Comment', createdAt: from, ...extra });
const event = (number, extra = {}) => ({ id: id(number), companyId, entityType: 'issue', entityId: taskId,
  actorType: 'user', actorId: 'human', action: 'issue.updated', createdAt: from, details: {}, ...extra });
const activity = { companyId, kind: 'activity', from, to };

function fixture() {
  const state = { calls: [], tasks: [], comments: [], events: [], resources: new Map([[taskId, task(100)]]),
    audit: { accessTier: 'full', items: [], nextCursor: null }, hook: null };
  const api = async (method, path) => {
    assert.equal(method, 'GET');
    const url = new URL(path, 'http://fixture.invalid');
    const params = url.searchParams;
    state.calls.push({ path: url.pathname, params });
    const override = await state.hook?.(url);
    if (override !== undefined) return structuredClone(override);
    let value;
    if (url.pathname === `/api/companies/${companyId}/issues`) {
      assert.equal(params.get('sortField'), 'id');
      assert.equal(params.get('sortDir'), 'asc');
      assert.equal(params.get('includePluginOperations'), 'true');
      assert.ok(+params.get('limit') <= 1000);
      value = state.tasks.filter(row => (!params.has('afterId') || row.id > params.get('afterId')) &&
        ['projectId', 'assigneeAgentId', 'assigneeUserId', 'parentId'].every(field => !params.has(field) || row[field] === params.get(field)) &&
        (!params.has('status') || params.get('status').split(',').includes(row.status))).slice(0, +params.get('limit'));
    } else if (url.pathname === `/api/issues/${taskId}/comments`) {
      assert.equal(params.toString(), 'order=asc');
      value = state.comments;
    } else if (url.pathname.startsWith('/api/issues/')) {
      const target = url.pathname.split('/').at(-1);
      value = state.resources.get(target) ?? state.tasks.find(row => row.id === target);
    } else if (url.pathname === `/api/companies/${companyId}/audit/agent-actions`) {
      assert.equal(params.get('actorScope'), 'all');
      assert.equal(params.get('entityType'), 'issue');
      assert.ok(+params.get('limit') <= 200);
      value = state.audit;
    } else assert.fail(`Unexpected path ${path}`);
    if (value === undefined) throw new Error('Not found');
    return structuredClone(value);
  };
  return { state, api, query: input => queryTasks(api, { companyId, ...input }) };
}

function forge(cursor, changes) {
  const { checksum: _, ...value } = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  Object.assign(value, changes);
  return Buffer.from(JSON.stringify({ ...value, checksum: digest(value) })).toString('base64url');
}

test('list includes terminal tasks without an implicit status and returns only preview fields', async () => {
  const f = fixture();
  f.state.tasks = [task(1, { status: 'done', description: 'x'.repeat(2000), config: { secret: 'private' } }), task(2, { status: 'cancelled' })];
  const result = await f.query({ kind: 'list' });
  assert.deepEqual(result.items.map(row => row.status), ['done', 'cancelled']);
  assert.equal(result.items[0].descriptionPreview.length, 1200);
  assert.equal(result.items[0].description, undefined);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(f.state.calls[0].params.has('status'), false);
  assert.equal(result.complete, true);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, null);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.match(result.warnings.join(' '), /previews.*humanTask/);
});

test('UUID keyset lookahead pages neither repeat nor lose the extra row', async () => {
  const f = fixture();
  f.state.tasks = [task(1), task(2), task(3), task(4)];
  const first = await f.query({ kind: 'list', limit: 2 });
  assert.equal(first.complete, false);
  assert.equal(first.hasMore, true);
  assert.equal(f.state.calls[0].params.get('limit'), '3');
  assert.equal(f.state.calls.length, 1);
  const second = await f.query({ kind: 'list', limit: 2, cursor: first.nextCursor });
  assert.deepEqual([...first.items, ...second.items].map(row => row.id), f.state.tasks.map(row => row.id));
  assert.equal(second.complete, true);
  assert.equal(f.state.calls.find(call => call.params.has('afterId')).params.get('afterId'), id(2));
});

test('supported list filters are sent exactly and normalised status order binds the cursor', async () => {
  const f = fixture();
  const filter = { projectId: id(20), statuses: ['todo', 'done'], assigneeAgentId: id(30), assigneeUserId: 'human', parentId: id(40) };
  f.state.tasks = [task(1, { ...filter, status: 'todo' }), task(2, { ...filter, status: 'done' }), task(3)];
  const first = await f.query({ kind: 'list', ...filter, limit: 1 });
  for (const field of ['projectId', 'assigneeAgentId', 'assigneeUserId', 'parentId']) assert.equal(f.state.calls[0].params.get(field), filter[field]);
  assert.equal(f.state.calls[0].params.get('status'), 'done,todo');
  assert.equal((await f.query({ kind: 'list', ...filter, statuses: ['done', 'todo'], limit: 1, cursor: first.nextCursor })).items[0].id, id(2));
});

test('children validate parent company, then query its direct children without a status restriction', async () => {
  const f = fixture();
  f.state.tasks = [task(1, { parentId: taskId, status: 'done' }), task(2)];
  const result = await f.query({ kind: 'children', taskId });
  assert.equal(f.state.calls[0].path, `/api/issues/${taskId}`);
  assert.equal(f.state.calls[1].params.get('parentId'), taskId);
  assert.deepEqual(result.items.map(row => row.id), [id(1)]);
  f.state.resources.set(taskId, task(100, { companyId: 'foreign' }));
  await assert.rejects(f.query({ kind: 'children', taskId }), { code: 'forbidden' });
});

test('strict fields, enums, limits, IDs and unsupported per-kind filters fail before API calls', async () => {
  const f = fixture();
  for (const input of [
    {}, { kind: 'inspect' }, { kind: ['list'] }, { kind: 'list', companyId: '' }, { kind: 'list', statuses: [] },
    { kind: 'list', statuses: Array(1) },
    { kind: 'list', statuses: ['all'] }, { kind: 'list', statuses: ['todo', 'todo'] }, { kind: 'list', statuses: 'done' },
    { kind: 'list', parentId: null }, { kind: 'list', projectId: null }, { kind: 'list', assigneeAgentId: 'null' },
    { kind: 'list', assigneeUserId: 'me' }, { kind: 'list', projectId: 'a,b' }, { kind: 'list', authority: {} },
    { kind: 'list', sortDir: 'desc' }, { kind: 'list', from }, { kind: 'list', taskId }, { kind: 'list', limit: undefined },
    { kind: 'children' }, { kind: 'children', taskId, parentId: id(1) }, { kind: 'comments' },
    { kind: 'comments', taskId, statuses: ['done'] }, { kind: 'comments', taskId, limit: 500 },
    { ...activity, projectId: id(1) }, { ...activity, statuses: ['done'] }, { ...activity, limit: 201 },
    ...[0, -1, 1.5, '2', null, 1000, Infinity].map(limit => ({ kind: 'list', limit })),
  ]) await assert.rejects(f.query(input), { code: 'invalid_request' });
  assert.equal(f.state.calls.length, 0);
});

test('cursor rejects malformed encoding, checksum, order, schema and cross-query scope before I/O', async () => {
  const f = fixture();
  f.state.tasks = [task(1), task(2)];
  const { nextCursor } = await f.query({ kind: 'list', limit: 1 });
  const count = f.state.calls.length;
  for (const cursor of ['', null, 3, '%%%bad', 'e30=', 'e30', 'x'.repeat(16385),
    forge(nextCursor, { v: 2 }), forge(nextCursor, { extra: true }), forge(nextCursor, { order: 'id:desc' }),
    forge(nextCursor, { anchor: {} }), forge(nextCursor, { anchor: 'not-a-uuid' }),
    Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(nextCursor, 'base64url').toString()), checksum: 'bad' })).toString('base64url')]) {
    await assert.rejects(f.query({ kind: 'list', limit: 1, cursor }), { code: 'invalid_cursor' });
  }
  for (const change of [{ companyId: 'foreign' }, { limit: 2 }, { statuses: ['done'] }, { projectId: id(55) },
    { kind: 'children', taskId }, { kind: 'comments', taskId }]) {
    await assert.rejects(f.query({ kind: 'list', limit: 1, cursor: nextCursor, ...change }), { code: 'invalid_cursor' });
  }
  assert.equal(f.state.calls.length, count);
});

test('forged list anchors cannot skip from a missing, foreign or out-of-filter task', async () => {
  const f = fixture();
  f.state.tasks = [task(1), task(2)];
  const query = { kind: 'list', limit: 1, statuses: ['todo'] };
  const { nextCursor } = await f.query(query);
  await assert.rejects(f.query({ ...query, cursor: forge(nextCursor, { anchor: id(99) }) }), /Not found/);
  f.state.resources.set(id(99), task(99, { companyId: 'foreign' }));
  await assert.rejects(f.query({ ...query, cursor: forge(nextCursor, { anchor: id(99) }) }), { code: 'forbidden' });
  f.state.resources.set(id(99), task(99, { status: 'done' }));
  await assert.rejects(f.query({ ...query, cursor: forge(nextCursor, { anchor: id(99) }) }), { code: 'invalid_cursor' });
});

test('short and empty issue pages need full audit proof, never imply exhaustive authorisation', async () => {
  for (const tasks of [[], [task(1)]]) {
    for (const accessTier of ['basic', undefined]) {
      const f = fixture();
      f.state.tasks = tasks;
      f.state.audit.accessTier = accessTier;
      await assert.rejects(f.query({ kind: 'list' }), { code: 'incomplete_query' });
    }
  }
});

test('invalid, repeated, unsorted, foreign and unfiltered issue pages fail closed', async () => {
  for (const page of [{ items: [] }, [task(1), task(1)], [task(2), task(1)], [task(1, { companyId: 'foreign' })],
    [task(1, { status: 'unknown' })], [task(1, { description: {} })], [task(1, { title: {} })],
    [task(1), task(2), task(3)]]) {
    const f = fixture();
    f.state.hook = url => url.pathname.endsWith('/issues') ? page : undefined;
    await assert.rejects(f.query({ kind: 'list', limit: 1 }), { code: 'invalid_backend_response' });
  }
  const f = fixture();
  f.state.hook = url => url.pathname.endsWith('/issues') ? [task(1, { status: 'done' })] : undefined;
  await assert.rejects(f.query({ kind: 'list', statuses: ['todo'] }), { code: 'invalid_backend_response' });
});

test('comments verify task, paginate the unbounded ascending collection locally and project safe fields', async () => {
  const f = fixture();
  f.state.comments = [comment(1, { config: { secret: 'private' }, clientRequestId: 'internal' }), comment(2), comment(3)];
  const first = await f.query({ kind: 'comments', taskId, limit: 2 });
  assert.equal(f.state.calls[0].path, `/api/issues/${taskId}`);
  assert.equal(f.state.calls[1].params.toString(), 'order=asc');
  assert.equal(first.hasMore, true);
  assert.equal(first.complete, false);
  const second = await f.query({ kind: 'comments', taskId, limit: 2, cursor: first.nextCursor });
  assert.equal(f.state.calls.length, 4);
  assert.equal(f.state.calls[2].path, `/api/issues/${taskId}`);
  assert.equal(f.state.calls.at(-1).params.toString(), 'order=asc');
  assert.deepEqual([...first.items, ...second.items].map(row => row.id), [id(1), id(2), id(3)]);
  assert.equal(second.complete, true);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.equal(JSON.stringify(first).includes('private'), false);
  assert.equal(first.items[0].clientRequestId, undefined);
  assert.match(first.warnings.join(' '), /not a snapshot.*current collection.*not delivered incrementally/);
});

test('comments reject foreign tasks and foreign comment collections', async () => {
  for (const problem of ['foreign-company', 'foreign-task']) {
    const f = fixture();
    f.state.comments = [comment(1), comment(2)];
    const query = { kind: 'comments', taskId, limit: 1 };
    const { nextCursor } = await f.query(query);
    if (problem === 'foreign-company') f.state.comments[0].companyId = 'foreign';
    else f.state.comments[0].issueId = id(9);
    await assert.rejects(f.query({ ...query, cursor: nextCursor }), { code: 'invalid_backend_response' });
    assert.equal(f.state.calls.filter(call => call.params.has('after')).length, 0);
  }
  const f = fixture();
  f.state.resources.set(taskId, task(100, { companyId: 'foreign' }));
  await assert.rejects(f.query({ kind: 'comments', taskId }), { code: 'forbidden' });
  assert.equal(f.state.calls.length, 1);
});

test('deleted anchors and changed ordered prefixes fail explicitly rather than miss comments', async () => {
  for (const change of [
    rows => rows.splice(2, 1),
    rows => rows.splice(0, 1),
    rows => rows.unshift(comment(9)),
    rows => rows.splice(0, 2, rows[1], rows[0]),
    rows => { rows[2].createdAt = '2026-10-01T00:00:00.000Z'; },
    rows => { rows[0].createdAt = '2026-10-01T00:00:00.000Z'; },
    rows => { rows.length = 0; },
  ]) {
    const f = fixture();
    f.state.comments = [comment(1), comment(2), comment(3), comment(4)];
    const query = { kind: 'comments', taskId, limit: 3 };
    const { nextCursor } = await f.query(query);
    f.state.hook = url => {
      if (url.pathname.endsWith('/comments')) {
        change(f.state.comments);
        return f.state.comments;
      }
    };
    await assert.rejects(f.query({ ...query, cursor: nextCursor }), { code: 'invalid_cursor' });
  }
});

test('comments reject duplicate, foreign, malformed and backwards collections including off-page rows', async () => {
  for (const page of [{ items: [] }, [comment(1), comment(1)], [comment(1, { companyId: 'foreign' })], [comment(1, { issueId: id(999) })],
    [comment(1, { body: {} })], [comment(1, { createdAt: 'yesterday' })], [comment(1, { clientRequestId: {} })],
    [comment(1), comment(2), comment(3, { body: null })],
    [comment(1, { createdAt: to }), comment(2)]]) {
    const f = fixture();
    f.state.hook = url => url.pathname.endsWith('/comments') ? page : undefined;
    await assert.rejects(f.query({ kind: 'comments', taskId, limit: 1 }), { code: 'invalid_backend_response' });
  }
});

test('comment traversal exceeds the backend 500-row cap without invoking its lossy after cursor', async () => {
  const f = fixture();
  // DB timestamps differ within one millisecond. JSON loses that precision and
  // IDs need not ascend. The installed after filter can include its own anchor.
  f.state.comments = Array.from({ length: 1203 }, (_, index) => comment(1203 - index));
  let afterCalls = 0;
  f.state.hook = url => {
    if (!url.pathname.endsWith('/comments')) return;
    const params = url.searchParams;
    if (params.has('after')) {
      afterCalls++;
      return f.state.comments.slice(f.state.comments.findIndex(row => row.id === params.get('after')),
        +params.get('limit'));
    }
    if (params.has('limit')) return f.state.comments.slice(0, Math.min(500, +params.get('limit')));
    return f.state.comments;
  };
  const items = [];
  let cursor;
  let pages = 0;
  do {
    assert.ok(pages++ < 10, 'Traversal must terminate');
    const result = await f.query({ kind: 'comments', taskId, limit: 499, ...(cursor ? { cursor } : {}) });
    items.push(...result.items);
    cursor = result.nextCursor;
    assert.equal(result.complete, cursor === null);
  } while (cursor);
  assert.deepEqual(items.map(row => row.id), f.state.comments.map(row => row.id));
  assert.equal(pages, 3);
  assert.equal(afterCalls, 0);
  assert.ok(f.state.calls.every(call => !call.params.has('limit') && !call.params.has('after')));
});

test('comment timestamps retain microsecond strings without UUID tie sorting', async () => {
  const f = fixture();
  f.state.comments = [comment(3, { createdAt: '2026-10-01T00:00:00.000123Z' }),
    comment(1, { createdAt: '2026-10-01T00:00:00.000124Z' })];
  const first = await f.query({ kind: 'comments', taskId, limit: 1 });
  const second = await f.query({ kind: 'comments', taskId, limit: 1, cursor: first.nextCursor });
  assert.deepEqual([...first.items, ...second.items].map(row => [row.id, row.createdAt]),
    f.state.comments.map(row => [row.id, row.createdAt]));
});

test('comment continuation observes suffix changes and fresh edits without claiming an incremental feed', async () => {
  const f = fixture();
  f.state.comments = [comment(1), comment(2), comment(3)];
  const query = { kind: 'comments', taskId, limit: 1 };
  const first = await f.query(query);
  f.state.comments[0].body = 'Edited prior comment';
  f.state.comments[1].body = 'Edited unread comment';
  f.state.comments.splice(2, 1, comment(4));
  const second = await f.query({ ...query, cursor: first.nextCursor });
  const third = await f.query({ ...query, cursor: second.nextCursor });
  assert.equal(second.items[0].body, 'Edited unread comment');
  assert.equal(third.items[0].id, id(4));
  assert.equal(third.complete, true);
  assert.equal((await f.query(query)).items[0].body, 'Edited prior comment');
  assert.equal(first.items[0].body, 'Comment');
});

test('empty comment collection and a deleted unread suffix complete only the current traversal', async () => {
  const f = fixture();
  const query = { kind: 'comments', taskId, limit: 1 };
  const empty = await f.query(query);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.complete, true);
  f.state.comments = [comment(1), comment(2)];
  const first = await f.query(query);
  f.state.comments.pop();
  const last = await f.query({ ...query, cursor: first.nextCursor });
  assert.deepEqual(last.items, []);
  assert.equal(last.complete, true);
});

test('shared comment reader preserves raw receipt fields and full bodies with a hard collection cap', async () => {
  const f = fixture();
  const receipt = comment(1, { body: 'x'.repeat(100000), clientRequestId: 'receipt', metadata: { source: 'raw' } });
  f.state.comments = [receipt];
  assert.deepEqual(await readTaskComments(f.api, { companyId, taskId }), [receipt]);
  assert.equal((await f.query({ kind: 'comments', taskId })).items[0].body, receipt.body);
  f.state.comments = Array.from({ length: 10000 }, (_, index) => comment(index + 1));
  assert.equal((await readTaskComments(f.api, { companyId, taskId })).length, 10000);
  const first = await f.query({ kind: 'comments', taskId, limit: 1 });
  f.state.comments.push(comment(10001));
  for (const read of [
    () => readTaskComments(f.api, { companyId, taskId }),
    () => f.query({ kind: 'comments', taskId }),
    () => f.query({ kind: 'comments', taskId, limit: 1, cursor: first.nextCursor }),
  ]) await assert.rejects(read(), { code: 'incomplete_query', status: 502 });
});

test('shared comment reader validates authority, input, collection and propagates transport failures', async () => {
  const f = fixture();
  await assert.rejects(readTaskComments(f.api, { companyId, taskId: 'bad' }), { code: 'invalid_request' });
  assert.equal(f.state.calls.length, 0);
  f.state.resources.set(taskId, task(100, { companyId: 'foreign' }));
  await assert.rejects(readTaskComments(f.api, { companyId, taskId }), { code: 'forbidden' });
  assert.equal(f.state.calls.length, 1);
  f.state.resources.set(taskId, task(100));
  f.state.comments = [comment(1), comment(1)];
  await assert.rejects(readTaskComments(f.api, { companyId, taskId }), { code: 'invalid_backend_response' });
  const failure = new Error('Collection unavailable');
  f.state.hook = url => { if (url.pathname.endsWith('/comments')) throw failure; };
  await assert.rejects(readTaskComments(f.api, { companyId, taskId }), error => error === failure);
});

test('activity requires an explicit valid bounded RFC3339 window and rejects unsupported filters', async () => {
  const f = fixture();
  for (const change of [{ from: undefined }, { to: undefined }, { from: to }, { from: '2026-10-09T00:00:00Z' },
    { from: '2026-10-01' }, { from: '2026-10-01T00:00:00' }, { from: '2026-02-30T00:00:00Z' },
    { from: '2026-10-01T25:00:00Z' }, { from: '2026-10-01T00:00:00+24:00' },
    { from: '2026-10-01T00:00:00.000001Z' }, { parentId: id(1) }, { assigneeUserId: 'human' }]) {
    await assert.rejects(f.query({ ...activity, ...change }), { code: 'invalid_request' });
  }
  assert.equal(f.state.calls.length, 0);
  assert.equal((await f.query({ ...activity, from: '2026-10-01T02:00:00+02:00' })).complete, true);
});

test('activity uses only full all-actor issue audit, verifies optional task and applies half-open bounds', async () => {
  const f = fixture();
  f.state.audit.items = [event(3, { createdAt: to }), event(2), event(1)];
  const result = await f.query({ ...activity, taskId });
  assert.deepEqual(result.items.map(row => row.id), [id(2), id(1)]);
  assert.equal(f.state.calls[0].path, `/api/issues/${taskId}`);
  const call = f.state.calls[1];
  assert.equal(call.path, '/api/companies/company/audit/agent-actions');
  assert.equal(call.params.get('entityId'), taskId);
  assert.equal(call.params.get('from'), from);
  assert.equal(call.params.get('to'), to);
  for (const accessTier of ['basic', undefined]) {
    f.state.audit.accessTier = accessTier;
    await assert.rejects(f.query(activity), { code: 'incomplete_query' });
  }
});

test('audit pagination retains exact opaque microsecond cursor and every equal-timestamp event', async () => {
  const f = fixture();
  const backendCursor = Buffer.from(JSON.stringify({ createdAt: '2026-10-01T00:00:00.000123Z', id: id(2) })).toString('base64url');
  f.state.audit = { accessTier: 'full', items: [event(3), event(2)], nextCursor: backendCursor };
  const first = await f.query({ ...activity, limit: 2 });
  f.state.audit = { accessTier: 'full', items: [event(1)], nextCursor: null };
  const second = await f.query({ ...activity, limit: 2, cursor: first.nextCursor });
  assert.equal(f.state.calls.at(-1).params.get('cursor'), backendCursor);
  assert.deepEqual([...first.items, ...second.items].map(row => row.id), [id(3), id(2), id(1)]);
  assert.equal(second.complete, true);
  for (const change of [{ from: '2026-10-02T00:00:00Z' }, { to: '2026-10-09T00:00:00Z' }, { taskId }, { companyId: 'foreign' }]) {
    await assert.rejects(f.query({ ...activity, limit: 2, ...change, cursor: first.nextCursor }), { code: 'invalid_cursor' });
  }
});

test('all-boundary audit page stays incomplete and does not drop its continuation', async () => {
  const f = fixture();
  f.state.audit = { accessTier: 'full', items: [event(2, { createdAt: to })], nextCursor: 'opaque-next' };
  const first = await f.query({ ...activity, limit: 1 });
  assert.deepEqual(first.items, []);
  assert.equal(first.complete, false);
  assert.equal(first.hasMore, true);
  f.state.audit = { accessTier: 'full', items: [event(1)], nextCursor: null };
  const second = await f.query({ ...activity, limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].id, id(1));
});

test('activity normalises status histories, completion and reopening without exposing raw configuration', async () => {
  const f = fixture();
  f.state.audit.items = [
    event(6, { details: { changes: { status: { from: 'todo', to: 'done' }, adapterConfig: { from: 'secret', to: 'private' } }, config: 'private' } }),
    event(5, { details: { fromStatus: 'done', toStatus: 'todo' } }),
    event(4, { details: { _previous: { status: 'in_progress' }, status: 'done' } }),
    event(3, { details: { status: 'todo', _previous: { status: 'cancelled' } }, entity: { issue: { id: taskId, status: 'in_review', config: 'private' } } }),
    event(2, { action: 'issue.completed' }), event(1, { action: 'issue.reopened' }),
  ];
  const result = await f.query(activity);
  assert.deepEqual(result.items.map(row => row.transition), ['completed', 'reopened', 'completed', 'reopened', 'completed', 'reopened']);
  assert.deepEqual(result.items[0].changes, { status: { from: 'todo', to: 'done' } });
  assert.deepEqual(result.items[0].actor, { type: 'user', id: 'human' });
  assert.equal(result.items[0].action, 'issue.updated');
  assert.equal(result.items[0].at, from);
  assert.equal(result.items[0].currentStatus, undefined);
  assert.equal(result.items[3].currentStatus, 'in_review');
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('explicit null change values are preserved rather than replaced by legacy fallbacks', async () => {
  const f = fixture();
  f.state.audit.items = [event(1, { details: {
    changes: { assigneeUserId: { from: null, to: null }, status: { from: null, to: 'todo' } },
    assigneeUserId: 'not-the-change', _previous: { assigneeUserId: 'not-the-change', status: 'done' },
  } })];
  const result = await f.query(activity);
  assert.deepEqual(result.items[0].changes, { status: { from: null, to: 'todo' }, assigneeUserId: { from: null, to: null } });
  assert.equal(result.items[0].transition, null);
});

test('a short audit page with a continuation remains incomplete regardless of item count', async () => {
  const f = fixture();
  f.state.audit = { accessTier: 'full', items: [event(1)], nextCursor: 'backend-short-page' };
  const result = await f.query({ ...activity, limit: 200 });
  assert.equal(result.hasMore, true);
  assert.equal(result.complete, false);
});

test('comment and audit cursors validate anchor types and audit errors remain failures', async () => {
  const f = fixture();
  f.state.comments = [comment(1), comment(2)];
  const query = { kind: 'comments', taskId, limit: 1 };
  const comments = await f.query(query);
  const { anchor: validAnchor } = JSON.parse(Buffer.from(comments.nextCursor, 'base64url').toString());
  const calls = f.state.calls.length;
  for (const anchor of [id(1), null, { id: id(1) }, { id: id(1), at: 'yesterday' }, { id: 'bad', at: from },
    { id: id(1), at: from }, { ...validAnchor, extra: true }, { ...validAnchor, at: 'yesterday' },
    { ...validAnchor, id: 'bad' }, { ...validAnchor, prefixDigest: null }, { ...validAnchor, prefixDigest: 'bad' }]) {
    await assert.rejects(f.query({ ...query, cursor: forge(comments.nextCursor, { anchor }) }), { code: 'invalid_cursor' });
  }
  await assert.rejects(f.query({ ...query, cursor: forge(comments.nextCursor, { v: 1 }) }), { code: 'invalid_cursor' });
  for (const change of [{ companyId: 'foreign' }, { taskId: id(99) }, { limit: 2 }, { kind: 'children' }]) {
    await assert.rejects(f.query({ ...query, ...change, cursor: comments.nextCursor }), { code: 'invalid_cursor' });
  }
  assert.equal(f.state.calls.length, calls);
  await assert.rejects(f.query({ ...query, cursor: forge(comments.nextCursor,
    { anchor: { ...validAnchor, prefixDigest: '0'.repeat(64) } }) }), { code: 'invalid_cursor' });
  f.state.audit = { accessTier: 'full', items: [event(1)], nextCursor: 'opaque' };
  const audit = await f.query(activity);
  for (const anchor of ['', {}, 1, null]) {
    await assert.rejects(f.query({ ...activity, cursor: forge(audit.nextCursor, { anchor }) }), { code: 'invalid_cursor' });
  }
  const failure = new Error('Invalid backend cursor');
  f.state.hook = url => { if (url.searchParams.has('cursor')) throw failure; };
  await assert.rejects(f.query({ ...activity, cursor: forge(audit.nextCursor, { anchor: 'forged-backend-token' }) }), error => error === failure);
});

test('audit malformed envelopes, foreign rows, invalid order and non-advancing cursor fail', async () => {
  for (const audit of [
    { items: [], nextCursor: undefined }, { items: [], nextCursor: 'next' }, { items: [], nextCursor: 3 },
    { items: [event(1), event(1)], nextCursor: null }, { items: [event(1, { companyId: 'foreign' })], nextCursor: null },
    { items: [event(1, { entityType: 'agent' })], nextCursor: null }, { items: [event(1, { createdAt: 'bad' })], nextCursor: null },
    { items: [event(1, { createdAt: '2026-09-01T00:00:00Z' })], nextCursor: null },
    { items: [event(1), event(2, { createdAt: to })], nextCursor: null },
    { items: [event(1, { details: { changes: { status: { from: 'bad', to: 'done' } } } })], nextCursor: null },
  ]) {
    const f = fixture(); f.state.audit = { accessTier: 'full', ...audit };
    await assert.rejects(f.query(activity), { code: 'invalid_backend_response' });
  }
  const f = fixture();
  f.state.audit = { accessTier: 'full', items: [event(1)], nextCursor: 'same' };
  const first = await f.query(activity);
  await assert.rejects(f.query({ ...activity, cursor: first.nextCursor }), { code: 'invalid_backend_response' });
});

test('backend failures propagate for every query kind, never become empty success', async () => {
  for (const input of [{ kind: 'list' }, { kind: 'children', taskId }, { kind: 'comments', taskId }, activity]) {
    const error = new Error('Backend unavailable');
    await assert.rejects(queryTasks(async () => { throw error; }, { companyId, ...input }), failure => failure === error);
  }
});

test('maximum page sizes reserve backend lookahead only for issue lists', async () => {
  for (const input of [{ kind: 'list', limit: 999 }, { kind: 'comments', taskId, limit: 499 }, { ...activity, limit: 200 }]) {
    const f = fixture();
    await f.query(input);
    if (input.kind === 'comments') {
      assert.equal(f.state.calls.at(-1).params.toString(), 'order=asc');
      continue;
    }
    const call = f.state.calls.find(call => call.params.has('limit'));
    assert.equal(+call.params.get('limit'), input.limit + (input.kind === 'activity' ? 0 : 1));
  }
});
