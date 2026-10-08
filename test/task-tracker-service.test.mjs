import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { digest } from '../src/protocol.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const parentId = uuid(1), siblingId = uuid(2), dependencyId = uuid(3), projectId = uuid(4);
const from = '2026-10-01T00:00:00.000Z', to = '2026-10-02T00:00:00.000Z';

async function fixture(t, native = false, backendContext = true) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-task-tracker-'));
  const task = (id, fields) => ({ id, companyId: 'company', identifier: `TASK-${id.slice(-3)}`,
    title: 'Human task', description: 'Full task details. '.repeat(100), status: 'todo', priority: 'medium',
    assigneeUserId: 'human', assigneeAgentId: null, parentId: null, projectId, blockedByIssueIds: [],
    createdAt: from, updatedAt: from, ...fields });
  const tasks = new Map([
    [parentId, task(parentId, { title: 'Human parent', status: 'in_progress' })],
    [siblingId, task(siblingId, { title: 'Untouched sibling', parentId })],
    [dependencyId, task(dependencyId, { title: 'Finished dependency', status: 'done' })],
  ]);
  const requests = [], comments = [], activity = [], unexpected = [];
  const control = { failure: null, auditTier: 'full', malformed: null };
  const created = new Map();
  let sequence = 100, eventSequence = 1000;
  const comment = (issueId, body, clientRequestId) => {
    const row = { id: uuid(++sequence), companyId: 'company', issueId, body, clientRequestId,
      authorType: 'user', authorUserId: 'human', authorAgentId: null, derivedAuthorAgentId: null,
      createdByRunId: null, derivedCreatedByRunId: null, deletedAt: null,
      createdAt: new Date(Date.parse(from) + sequence * 1000).toISOString() };
    comments.push(row);
    return row;
  };
  const backend = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, path: req.url, body, token: req.headers.authorization,
        runId: req.headers['x-paperclip-run-id'] });
      res.setHeader('Content-Type', 'application/json');
      if (control.failure?.(req)) {
        res.writeHead(503); res.end(JSON.stringify({ message: 'Fixture backend unavailable' })); return;
      }
      const url = new URL(req.url, 'http://fixture'), path = url.pathname, params = url.searchParams;
      const issue = path.match(/^\/api\/issues\/([^/]+)(?:\/(interactions|comments)(?:\/([^/]+))?)?$/);
      let result;
      if (req.method === 'GET' && path === '/api/companies/company') {
        result = { id: 'company', defaultResponsibleUserId: 'human' };
      } else if (req.method === 'GET' && path === `/api/projects/${projectId}`) {
        result = { id: projectId, companyId: 'company' };
      } else if (req.method === 'GET' && path === '/api/companies/company/audit/agent-actions') {
        assert.equal(params.get('actorScope'), 'all');
        assert.equal(params.get('entityType'), 'issue');
        const rows = activity.filter(row => (!params.has('entityId') || row.entityId === params.get('entityId')) &&
          (!params.has('from') || row.createdAt >= params.get('from')) && (!params.has('to') || row.createdAt <= params.get('to')))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        const offset = params.has('cursor') ? Number(params.get('cursor').replace('audit-offset:', '')) : 0;
        const limit = Number(params.get('limit'));
        result = { accessTier: control.auditTier, items: rows.slice(offset, offset + limit),
          nextCursor: offset + limit < rows.length ? `audit-offset:${offset + limit}` : null };
      } else if (path === '/api/companies/company/issues' && req.method === 'GET') {
        result = [...tasks.values()].filter(row =>
          ['parentId', 'projectId', 'assigneeUserId', 'assigneeAgentId'].every(field => !params.has(field) || row[field] === params.get(field)) &&
          (!params.has('status') || params.get('status').split(',').includes(row.status)) &&
          (!params.has('afterId') || row.id > params.get('afterId')))
          .sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(params.get('limit')));
      } else if (path === '/api/companies/company/issues' && req.method === 'POST') {
        if (!created.has(body.idempotencyKey)) {
          const row = task(uuid(++sequence), body);
          tasks.set(row.id, row); created.set(body.idempotencyKey, row);
        }
        result = created.get(body.idempotencyKey);
      } else if (issue && tasks.has(issue[1])) {
        const row = tasks.get(issue[1]);
        if (req.method === 'GET' && !issue[2]) result = row;
        else if (req.method === 'GET' && issue[2] === 'interactions') result = [];
        else if (req.method === 'GET' && issue[2] === 'comments') {
          const rows = comments.filter(item => item.issueId === row.id)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          if (issue[3]) result = rows.find(item => item.id === issue[3]);
          else {
            assert.equal(params.get('order'), 'asc');
            const after = params.has('after') ? rows.findIndex(item => item.id === params.get('after')) + 1 : 0;
            result = rows.slice(after, params.has('limit') ? after + Math.min(500, Number(params.get('limit'))) : undefined);
          }
        } else if (req.method === 'POST' && issue[2] === 'comments') {
          result = comment(row.id, body.body, body.clientRequestId);
        } else if (req.method === 'PATCH' && !issue[2]) {
          const previous = row.status;
          const { comment: note, commentClientRequestId, reopen, resume, interrupt, ...fields } = body;
          Object.assign(row, fields, { updatedAt: new Date(Date.parse(from) + ++eventSequence * 1000).toISOString() });
          if (note !== undefined) comment(row.id, note, commentClientRequestId);
          activity.push({ id: uuid(eventSequence), companyId: 'company', entityType: 'issue', entityId: row.id,
            actorType: 'user', actorId: 'human', action: 'issue.updated', createdAt: row.updatedAt,
            details: { changes: { status: { from: previous, to: row.status } } }, entity: { issue: { id: row.id, status: row.status } } });
          result = row;
        }
      }
      if (result === undefined) {
        unexpected.push(`${req.method} ${req.url}`);
        res.writeHead(404); result = { message: 'Unexpected fixture request' };
      }
      if (control.malformed?.(req)) result = {};
      res.end(JSON.stringify(result));
    } catch (error) {
      unexpected.push(error.stack); res.writeHead(500); res.end(JSON.stringify({ message: 'Fixture contract failure' }));
    }
  });
  let service;
  t.after(async () => {
    await service?.close();
    await new Promise(resolve => backend.close(resolve));
    rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(unexpected, [], 'Fixture must implement every requested production backend route');
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const auth = join(directory, 'backend.json');
  writeFileSync(auth, JSON.stringify({ token: 'fixture-backend-operator' }), { mode: 0o600 });
  service = await startService({ directory, paperclipUrl: `http://127.0.0.1:${backend.address().port}`,
    backendContextFile: backendContext ? auth : undefined });
  const worker = service.store.register({ id: 'fresh-chat', companyId: 'company', agentId: 'agent',
    harness: 'opencode', instanceId: 'instance', conversationId: 'fresh-chat' });
  const observed = service.store.saveOperation({ id: 'herdr-agent:fresh-chat', runId: '', availability: 'present',
    identity: { conversationId: 'fresh-chat' }, placement: { directory: '/fixture', terminalId: 'terminal' } });
  service.store.saveOperation({ id: 'opencode-bridge:fresh-chat', runId: '', state: 'configured', ready: false,
    identity: { bindingId: worker.binding.id, observedId: observed.id, conversationId: 'fresh-chat', ...observed.placement },
    tokenHash: digest('fixture-bridge'), epoch: null, sessionCreatedAt: null, controlRevision: 1 });
  const connection = token => ({ socketPath: service.socketPath, token });
  const fields = { conversationId: 'fresh-chat', terminalId: 'terminal', epoch: 'epoch', sessionCreatedAt: 100, idle: true };
  const source = { id: 'native-human', text: 'Track this human work and update only its child task.', createdAt: 200 };
  const bridge = (action, input = {}) => call(connection('fixture-bridge'), 'POST', `/bridge/task-${action}`, { ...fields, ...input });
  const manage = (action, input = {}) => native ? bridge(action, { ...(action === 'inspect' ? {} : { source }), ...input }) :
    call(service, 'POST', '/tasks/manage', { companyId: 'company', action, ...input });
  const query = (kind, input = {}) => native ? bridge(kind, input) :
    call(service, 'POST', '/tasks/query', { companyId: 'company', kind, ...input });
  const reference = (action, input) => native ? bridge(`reference-${action}`,
    action === 'lookup' ? { payload: input } : { source, ...input }) :
    call(service, 'POST', '/tasks/references', { companyId: 'company', action, ...input });
  return { service, tasks, requests, comments, activity, control, worker, connection, fields, source, bridge, manage, query, reference,
    writes: () => requests.filter(request => request.method !== 'GET') };
}

for (const native of [false, true]) {
  const route = native ? 'configured native chat' : 'operator';
  test(`${route}: capture and manage a human child without touching its parent, siblings or Relay runs`, async t => {
    const f = await fixture(t, native);
    const untouched = structuredClone([...f.tasks.values()]);
    const input = { key: 'capture', payload: { title: 'Captured child', description: 'Unabridged child details. '.repeat(100),
      parentId, blockedByIssueIds: [dependencyId], projectId } };
    let result = await f.manage('create', input);
    const taskId = result.task.id;
    assert.equal(result.state, 'recorded');
    assert.deepEqual(result.outcome, { confirmed: true });
    assert.equal(result.task.assigneeUserId, 'human');
    assert.equal(result.task.assigneeAgentId, null);
    assert.equal(result.task.parentId, parentId);
    assert.deepEqual(result.task.blockedByIssueIds, [dependencyId]);
    assert.deepEqual(await f.manage('create', input), result);
    assert.equal(f.writes().length, 1);
    const create = f.writes()[0];
    assert.equal(create.path, '/api/companies/company/issues');
    assert.equal(create.body.assigneeUserId, 'human');
    assert.equal(create.body.status, 'todo');
    assert.match(create.body.idempotencyKey, /^relay-operator:/);

    const detail = await f.manage('inspect', { taskId });
    assert.equal(detail.task.description, input.payload.description);
    assert.ok(detail.task.description.length > 1200);
    assert.deepEqual(detail.task.blockedByIssueIds, [dependencyId]);
    assert.equal(detail.defaultHumanUserId, 'human');
    assert.match(detail.revision, /^[a-f0-9]{64}$/);
    const beforeReads = f.writes().length;
    const children = await f.query('children', { taskId: parentId, limit: 1 });
    assert.deepEqual(children.items.map(item => item.id), [siblingId]);
    assert.equal(children.hasMore, true);
    const rest = await f.query('children', { taskId: parentId, limit: 1, cursor: children.nextCursor });
    assert.deepEqual(rest.items.map(item => item.id), [taskId]);
    assert.equal(rest.complete, true);
    assert.equal(rest.items[0].descriptionPreview, input.payload.description.slice(0, 1200));
    const list = await f.query('list', { projectId, assigneeUserId: 'human', statuses: ['todo'], limit: 10 });
    assert.deepEqual(list.items.map(item => item.id), [siblingId, taskId]);
    assert.equal(list.complete, true);
    assert.equal(f.writes().length, beforeReads);

    for (const [action, payload, reason, status] of [
      ['comment', { body: 'Human progress note' }, undefined, 'todo'],
      ['edit', { title: 'Clarified child' }, undefined, 'todo'],
      ['complete', undefined, undefined, 'done'],
      ['reopen', { status: 'in_progress' }, undefined, 'in_progress'],
      ['cancel', undefined, 'No longer required', 'cancelled'],
    ]) {
      const request = { key: action, taskId, expectedRevision: result.revision,
        ...(payload === undefined ? {} : { payload }), ...(reason === undefined ? {} : { reason }) };
      const before = f.writes().length;
      result = await f.manage(action, request);
      assert.equal(result.task.status, status);
      assert.equal(result.outcome.confirmed, true);
      assert.equal(result.state, 'recorded');
      assert.equal(f.writes().length, before + 1, `${action} must make exactly one backend write`);
      const writes = f.writes().length;
      assert.deepEqual(await f.manage(action, request), result);
      assert.equal(f.writes().length, writes, `${action} retry must not repeat a backend write`);
    }
    const writes = f.writes().length;
    assert.equal(writes, 6);
    await assert.rejects(f.manage('edit', { key: 'stale', taskId, expectedRevision: detail.revision,
      payload: { title: 'Stale change' } }), { code: 'stale_revision', status: 409 });
    assert.equal(f.writes().length, writes);
    const note = f.writes().find(item => item.path.endsWith('/comments'));
    assert.deepEqual({ ...note.body, clientRequestId: '<id>' }, { body: 'Human progress note', clientRequestId: '<id>',
      reopen: false, resume: false, interrupt: false });
    const cancel = f.writes().at(-1);
    assert.deepEqual(cancel.body, { status: 'cancelled' });
    assert.equal(f.service.store.operation(result.operationId).request.reason, 'No longer required');
    assert.deepEqual(f.comments.map(item => item.body), ['Human progress note']);
    assert.equal(f.writes().filter(item => item.path.endsWith('/comments')).length, 1);
    assert.deepEqual(f.writes().filter(item => item.method === 'PATCH').map(item => item.path),
      Array(4).fill(`/api/issues/${taskId}`));
    assert.deepEqual([...f.tasks.values()].filter(item => item.id !== taskId), untouched);
    assert.deepEqual(f.service.store.runs(), []);
    assert.ok(f.requests.every(item => item.token === 'Bearer fixture-backend-operator' && item.runId === undefined));
    if (native) {
      assert.equal(f.service.store.operation('opencode-bridge:fresh-chat').state, 'configured');
      const operation = f.service.store.operation(result.operationId);
      assert.equal(operation.request.authority.kind, 'native');
      assert.equal(operation.request.authority.sourceDigest, digest(f.source.text));
      assert.equal(JSON.stringify(operation).includes(f.source.text), false);
    }

    const beforeComments = f.requests.length;
    const first = await f.query('comments', { taskId, limit: 1 });
    assert.equal(first.hasMore, false);
    assert.equal(first.complete, true);
    assert.equal(first.nextCursor, null);
    assert.deepEqual(first.items.map(item => item.body), ['Human progress note']);
    assert.equal(first.items[0].authorUserId, 'human');
    assert.equal(first.items[0].authorAgentId, null);
    assert.deepEqual(f.requests.slice(beforeComments).map(item => [item.method, item.path]), [
      ['GET', `/api/issues/${taskId}`], ['GET', `/api/issues/${taskId}/comments?order=asc`],
    ]);
    const events = [];
    let cursor;
    do {
      const page = await f.query('activity', { taskId, from, to, limit: 2, ...(cursor ? { cursor } : {}) });
      events.push(...page.items); cursor = page.nextCursor;
      assert.equal(page.complete, !page.hasMore);
    } while (cursor);
    assert.deepEqual(events.map(item => item.transition), [null, 'reopened', 'completed', null]);
    assert.ok(events.every(item => item.actor.type === 'user' && item.actor.id === 'human'));
    assert.deepEqual(events[1].changes.status, { from: 'done', to: 'in_progress' });
    assert.equal(f.writes().length, writes);
  });

  test(`${route}: paginated comments traverse more than 500 rows without backend truncation`, async t => {
    const f = await fixture(t, native);
    for (let i = 0; i < 503; i++) f.comments.push({ id: uuid(1000 - i), companyId: 'company', issueId: siblingId,
      body: `Existing comment ${i}`, authorType: 'user', authorUserId: 'human', authorAgentId: null,
      derivedAuthorAgentId: null, createdByRunId: null, derivedCreatedByRunId: null, deletedAt: null, createdAt: from });
    const first = await f.query('comments', { taskId: siblingId, limit: 499 });
    assert.equal(first.items.length, 499);
    assert.equal(first.hasMore, true);
    assert.equal(first.complete, false);
    assert.equal(typeof first.nextCursor, 'string');
    const second = await f.query('comments', { taskId: siblingId, limit: 499, cursor: first.nextCursor });
    assert.equal(second.items.length, 4);
    assert.equal(second.hasMore, false);
    assert.equal(second.complete, true);
    assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.items, ...second.items], f.comments.map(row => ({
      id: row.id, taskId: siblingId, companyId: 'company', body: row.body, createdAt: row.createdAt,
      authorAgentId: null, authorUserId: 'human', updatedAt: null,
    })));
    assert.deepEqual(f.requests.map(item => [item.method, item.path]), [
      ['GET', `/api/issues/${siblingId}`], ['GET', `/api/issues/${siblingId}/comments?order=asc`],
      ['GET', `/api/issues/${siblingId}`], ['GET', `/api/issues/${siblingId}/comments?order=asc`],
    ]);
    assert.deepEqual(f.writes(), []);
    assert.deepEqual(f.service.store.runs(), []);
  });

  test(`${route}: external reference creation under two keys reuses one task and explicit attach is read-only`, async t => {
    const f = await fixture(t, native);
    const externalReference = { namespace: 'github', externalId: 'owner/repo#12', url: 'https://github.com/owner/repo/issues/12' };
    const input = { key: 'capture-one', payload: { title: 'Referenced task' }, externalReference };
    const first = await f.manage('create', input);
    const second = await f.manage('create', { ...input, key: 'capture-two', payload: { title: 'Must not overwrite original' } });
    assert.equal(second.task.id, first.task.id);
    assert.equal(second.task.title, 'Referenced task');
    assert.deepEqual(second.outcome, { confirmed: true, reused: true });
    assert.equal(f.writes().length, 1);
    const lookup = await f.reference('lookup', { namespace: externalReference.namespace, externalId: externalReference.externalId });
    assert.equal(lookup.state, 'attached');
    assert.equal(lookup.task.id, first.task.id);
    assert.deepEqual(lookup.reference, { ...externalReference, companyId: 'company', taskId: first.task.id });
    assert.equal(await f.reference('lookup', { namespace: 'github', externalId: 'absent' }), null);
    const payload = { namespace: 'planner', externalId: 'manual-follow-up' };
    const inspected = await f.manage('inspect', { taskId: siblingId });
    await assert.rejects(f.reference('attach', { key: 'stale-reference', taskId: siblingId, expectedRevision: 'stale',
      payload, reason: 'Link existing task' }), { code: 'stale_revision', status: 409 });
    const inputAttach = { key: 'attach', taskId: siblingId, expectedRevision: inspected.revision, payload, reason: 'Link existing task' };
    const attached = await f.reference('attach', inputAttach);
    assert.equal(attached.reference.taskId, siblingId);
    assert.deepEqual(await f.reference('attach', inputAttach), attached);
    assert.deepEqual(await f.reference('lookup', payload), attached);
    const updated = await f.manage('inspect', { taskId: siblingId });
    assert.notEqual(updated.revision, inspected.revision);
    assert.deepEqual(updated.task.references, [{ ...payload, companyId: 'company', taskId: siblingId }]);
    f.control.failure = () => true;
    await assert.rejects(f.reference('lookup', payload), { code: 'paperclip_error', status: 502 });
    await assert.rejects(f.reference('attach', { ...inputAttach, key: 'failed-attach', payload: { ...payload, externalId: 'new' },
      expectedRevision: updated.revision }), { code: 'paperclip_error', status: 502 });
    assert.equal(f.writes().length, 1, 'Reference attachment must not PATCH a backend task');
    assert.deepEqual(f.service.store.runs(), []);
  });

  test(`${route}: backend failures and incomplete audit access cannot masquerade as empty results`, async t => {
    const f = await fixture(t, native);
    f.control.failure = () => true;
    for (const invoke of [
      () => f.manage('inspect', { taskId: parentId }),
      () => f.manage('create', { key: 'failed-create', payload: { title: 'Not created' } }),
      () => f.query('list'), () => f.query('children', { taskId: parentId }),
      () => f.query('comments', { taskId: parentId }), () => f.query('activity', { from, to }),
    ]) await assert.rejects(invoke(), { code: 'paperclip_error', status: 502,
      message: 'Paperclip operator request returned HTTP 503' });
    f.control.failure = req => req.url.includes('/comments?') || req.url.includes('/audit/');
    await assert.rejects(f.query('comments', { taskId: parentId }), { code: 'paperclip_error', status: 502 });
    await assert.rejects(f.query('list'), { code: 'paperclip_error', status: 502 });
    f.control.failure = null;
    f.control.auditTier = 'basic';
    for (const kind of ['list', 'children', 'activity']) await assert.rejects(f.query(kind,
      kind === 'children' ? { taskId: parentId } : kind === 'activity' ? { from, to } : {}),
    { code: 'incomplete_query', status: 403 });
    f.control.auditTier = 'full';
    f.control.malformed = req => req.url.includes('/issues?') || req.url.includes('/comments?');
    await assert.rejects(f.query('list'), { code: 'invalid_backend_response', status: 502 });
    await assert.rejects(f.query('comments', { taskId: parentId }), { code: 'invalid_backend_response', status: 502 });
    f.control.malformed = null;
    assert.equal((await f.query('list')).complete, true);
    assert.equal((await f.query('comments', { taskId: parentId })).complete, true);
    assert.equal((await f.query('activity', { from, to })).complete, true);
    assert.deepEqual(f.writes(), []);
  });
}

test('configured fresh chat reads existing details, dependencies, comment pages and all-actor activity without prior work', async t => {
  const f = await fixture(t, true);
  f.tasks.get(siblingId).blockedByIssueIds = [dependencyId];
  f.tasks.get(siblingId).blockedBy = [{ ...f.tasks.get(dependencyId), privateContext: 'not-public' }];
  for (let i = 0; i < 3; i++) f.comments.push({ id: uuid(200 + i), companyId: 'company', issueId: siblingId,
    body: `Existing comment ${i}`, authorType: 'user', authorUserId: 'human', authorAgentId: null,
    derivedAuthorAgentId: null, createdByRunId: null, derivedCreatedByRunId: null, deletedAt: null,
    createdAt: new Date(Date.parse(from) + i * 1000).toISOString() });
  for (const [i, actorType] of ['user', 'agent', 'system', 'plugin'].entries()) f.activity.push({
    id: uuid(300 + i), companyId: 'company', entityType: 'issue', entityId: siblingId, actorType,
    actorId: `${actorType}-author`, action: 'issue.updated', createdAt: new Date(Date.parse(from) + i * 1000).toISOString(),
    details: { changes: { priority: { from: 'low', to: 'medium' } }, privateContext: 'not-public' },
  });
  const inspect = await f.manage('inspect', { taskId: siblingId });
  assert.equal(inspect.task.description, f.tasks.get(siblingId).description);
  assert.deepEqual(inspect.task.blockedByIssueIds, [dependencyId]);
  assert.equal(inspect.task.blockedBy[0].title, 'Finished dependency');
  assert.equal(inspect.task.blockedBy[0].privateContext, undefined);
  assert.equal((await f.query('list')).items.length, 3);
  assert.deepEqual((await f.query('children', { taskId: parentId })).items.map(item => item.id), [siblingId]);
  const first = await f.query('comments', { taskId: siblingId, limit: 2 });
  const second = await f.query('comments', { taskId: siblingId, limit: 2, cursor: first.nextCursor });
  assert.equal(first.hasMore, true);
  assert.equal(second.complete, true);
  assert.deepEqual([...first.items, ...second.items].map(item => item.body),
    ['Existing comment 0', 'Existing comment 1', 'Existing comment 2']);
  const recent = await f.query('activity', { from, to, limit: 2 });
  const older = await f.query('activity', { from, to, limit: 2, cursor: recent.nextCursor });
  assert.equal(recent.hasMore, true);
  assert.equal(older.complete, true);
  assert.deepEqual([...recent.items, ...older.items].map(item => item.actor.type), ['plugin', 'system', 'agent', 'user']);
  assert.equal(JSON.stringify([recent, older]).includes('not-public'), false);
  assert.equal(await f.reference('lookup', { namespace: 'github', externalId: 'unlinked' }), null);
  assert.deepEqual(f.writes(), []);
  assert.deepEqual(f.service.store.runs(), []);
  assert.equal(f.service.store.db.prepare("SELECT count(*) AS n FROM operations WHERE id LIKE 'human-task:%'").get().n, 0);
  assert.equal(f.service.store.operation('opencode-bridge:fresh-chat').state, 'configured');
});

test('worker credentials cannot access any task tracker operator or native route', async t => {
  const f = await fixture(t);
  const routes = ['/tasks/query', '/tasks/references', '/tasks/manage', ...[
    'inspect', 'create', 'edit', 'assign', 'complete', 'list', 'children', 'comments', 'activity',
    'reference-lookup', 'reference-attach', 'comment', 'reopen', 'cancel',
  ].map(action => `/bridge/task-${action}`)];
  for (const path of routes) {
    await assert.rejects(call(f.connection(f.worker.token), 'POST', path, {}), { code: 'forbidden', status: 403 });
    await assert.rejects(call(f.connection('unknown'), 'POST', path, {}), { code: 'unauthorised', status: 401 });
  }
  for (const path of routes.filter(path => path.startsWith('/tasks/'))) {
    await assert.rejects(call(f.connection('fixture-bridge'), 'POST', path, {}), { code: 'forbidden', status: 403 });
  }
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.service.store.runs(), []);
});

for (const action of ['reference-lookup', 'reference-attach']) {
  test(`native ${action} rejects company overrides inside payload before backend access`, async t => {
    const f = await fixture(t, true);
    const revision = (await f.manage('inspect', { taskId: siblingId })).revision;
    const before = f.requests.length;
    await assert.rejects(f.bridge(action, { payload: { namespace: 'github', externalId: 'override', companyId: 'foreign' },
      ...(action === 'reference-attach' ? { source: f.source, taskId: siblingId, key: 'override', expectedRevision: revision,
        reason: 'Attach reference' } : {}) }), { code: 'invalid_request', status: 400 });
    assert.equal(f.requests.length, before);
    assert.equal(f.service.store.db.prepare("SELECT count(*) AS n FROM operations WHERE id LIKE 'task-reference:%'").get().n, 0);
  });
}

test('fresh native reads reject transport identity and top-level company overrides before backend access', async t => {
  const f = await fixture(t, true);
  for (const input of [{ conversationId: 'other' }, { terminalId: 'other' }]) {
    await assert.rejects(f.bridge('list', input), { code: 'bridge_identity_mismatch', status: 409 });
  }
  for (const action of ['inspect', 'list', 'children', 'comments', 'activity', 'reference-lookup']) {
    await assert.rejects(f.bridge(action, { taskId: parentId, companyId: 'foreign' }), { code: 'invalid_request', status: 400 });
  }
  assert.deepEqual(f.requests, []);
});

test('operator and native tracker reads require backend operator context rather than forwarding Relay credentials', async t => {
  const f = await fixture(t, false, false);
  await assert.rejects(f.query('list'), { code: 'operator_backend_unavailable', status: 503 });
  await assert.rejects(f.bridge('list'), { code: 'operator_backend_unavailable', status: 503 });
  assert.deepEqual(f.requests, []);
});
