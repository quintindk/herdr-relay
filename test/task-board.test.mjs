import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { taskBoard } from '../src/task-board.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const issue = (n, companyId = 'company') => ({ id: uuid(n), companyId, identifier: `TASK-${n}`,
  title: `Task ${n}`, status: 'todo', priority: 'medium', parentId: null, assigneeAgentId: null,
  assigneeUserId: 'human', projectId: null, description: 'Collection preview', updatedAt: '2026-10-07T10:00:00.000Z' });
function fixture(t, data = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls = [];
  const api = async (...args) => {
    assert.equal(args.length, 2);
    const [method, path] = args;
    assert.equal(method, 'GET');
    const url = new URL(path, 'http://paperclip');
    assert.ok(!url.pathname.startsWith('/api/issues/'), 'No per-issue reads');
    calls.push(path);
    if (url.pathname === '/api/companies') {
      assert.equal(url.search, '');
      return data.companies ?? [{ id: 'company', name: 'Company' }];
    }
    const match = url.pathname.match(/^\/api\/companies\/([^/]+)(?:\/(agents|projects|issues))?$/);
    assert.ok(match, `Unexpected route: ${path}`);
    const companyId = decodeURIComponent(match[1]);
    if (!match[2]) return { id: companyId, name: companyId, secret: 'PRIVATE' };
    if (match[2] === 'agents') {
      assert.equal(url.search, '', 'Agent route accepts no query parameters');
      return data.agents ?? [];
    }
    if (match[2] === 'projects') {
      assert.equal(url.search, '?includeArchived=true');
      return data.projects ?? [];
    }
    assert.equal(url.searchParams.get('limit'), '1000');
    assert.equal(url.searchParams.get('sortField'), 'id');
    assert.equal(url.searchParams.get('sortDir'), 'asc');
    assert.equal(url.searchParams.get('includePluginOperations'), 'true');
    assert.deepEqual([...url.searchParams.keys()].sort(),
      [...['limit', 'sortField', 'sortDir', 'includePluginOperations'], ...(url.searchParams.has('afterId') ? ['afterId'] : [])].sort());
    const rows = data.tasks ?? [];
    return rows.filter(row => row.companyId === companyId && (!url.searchParams.has('afterId') || row.id > url.searchParams.get('afterId'))).slice(0, 1000);
  };
  return { store, api, calls };
}
function bind(store, companyId = 'company', agentId = 'agent', bindingId = agentId) {
  return store.register({ id: bindingId, companyId, agentId, harness: 'opencode', instanceId: bindingId, conversationId: bindingId }).binding;
}

test('projects actual issues and totals, never Relay runs or private configuration', async t => {
  const secret = { token: 'PRIVATE', adapterConfig: { password: 'PRIVATE' }, metadata: { secret: 'PRIVATE' }, content: 'PRIVATE' };
  const task = { ...issue(1), ...secret, parentId: uuid(2), projectId: 'project' };
  const f = fixture(t, { companies: [{ id: 'company', name: 'Company', ...secret }], tasks: [task],
    agents: [{ id: 'agent', companyId: 'company', name: 'Agent', ...secret }],
    projects: [{ id: 'project', companyId: 'company', name: 'Project', ...secret }] });
  f.store.runs = () => assert.fail('Board must not read Relay runs');
  const before = f.store.db.prepare('SELECT total_changes() AS count').get().count;
  const result = await taskBoard(f.store, f.api);
  assert.deepEqual(Object.keys(result).sort(), ['agents', 'companies', 'fetchedAt', 'projects', 'tasks', 'totals', 'warnings']);
  assert.deepEqual(result.companies, [{ id: 'company', name: 'Company' }]);
  assert.deepEqual(result.projects, [{ id: 'project', companyId: 'company', name: 'Project' }]);
  assert.deepEqual(result.agents, [{ id: 'agent', companyId: 'company', name: 'Agent', availability: 'unknown', bridgeState: null, nativeState: 'unknown' }]);
  const { description, ...expected } = issue(1);
  assert.deepEqual(result.tasks, [{ ...expected, parentId: uuid(2), projectId: 'project', descriptionPreview: description }]);
  assert.deepEqual(result.totals, { companies: 1, agents: 1, projects: 1, tasks: 1 });
  assert.deepEqual(result.warnings, []);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(f.store.db.prepare('SELECT total_changes() AS count').get().count, before);
});

test('explicit configured company excludes all other binding and discovery companies', async t => {
  const f = fixture(t, { tasks: [issue(1, 'chosen/company')] });
  bind(f.store, 'other');
  const result = await taskBoard(f.store, f.api, { companyId: 'chosen/company' });
  assert.deepEqual(result.companies, [{ id: 'chosen/company', name: 'chosen/company' }]);
  assert.equal(result.tasks.length, 1);
  assert.ok(f.calls.every(path => path.startsWith('/api/companies/chosen%2Fcompany')));
});

test('deduplicates binding companies before falling back to the company directory', async t => {
  const f = fixture(t, { tasks: [issue(1, 'one'), issue(2, 'two')] });
  bind(f.store, 'one', 'a'); bind(f.store, 'one', 'b'); bind(f.store, 'two', 'c');
  const result = await taskBoard(f.store, f.api);
  assert.deepEqual(result.companies.map(row => row.id), ['one', 'two']);
  assert.equal(result.totals.tasks, 2);
  assert.ok(!f.calls.includes('/api/companies'));
  assert.equal(f.calls.filter(path => path === '/api/companies/one').length, 1);
});

for (const size of [0, 999, 1000, 2001, 10000, 10001]) {
  test(`paginates ${size} issues with a stable UUID cursor and bounded cap`, async t => {
    const f = fixture(t, { tasks: Array.from({ length: size }, (_, n) => issue(n + 1)) });
    const result = await taskBoard(f.store, f.api, { companyId: 'company' });
    assert.equal(result.tasks.length, Math.min(size, 10000));
    assert.equal(result.totals.tasks, Math.min(size, 10000));
    const pages = f.calls.filter(path => path.includes('/issues?')).map(path => new URL(path, 'http://paperclip'));
    assert.equal(pages.length, Math.min(Math.floor(size / 1000) + 1, 10));
    assert.equal(pages[0].searchParams.get('afterId'), null);
    for (let n = 1; n < pages.length; n++) assert.equal(pages[n].searchParams.get('afterId'), uuid(n * 1000));
    assert.equal(new Set(result.tasks.map(row => row.id)).size, result.tasks.length);
    assert.equal(result.warnings.length, size >= 10000 ? 1 : 0);
    if (size >= 10000) assert.match(result.warnings[0], /10000 issues returned; more may exist/);
  });
}

test('bounds company discovery without inventing unsupported query parameters', async t => {
  const f = fixture(t, { companies: Array.from({ length: 101 }, (_, n) => ({ id: `company-${n}`, name: `Company ${n}` })) });
  const result = await taskBoard(f.store, f.api);
  assert.equal(result.companies.length, 100);
  assert.equal(result.totals.companies, 100);
  assert.equal(result.warnings.length, 1);
  assert.ok(!f.calls.some(path => path.includes('/company-100/')));
});

test('fresh observations enrich by exact company and agent ID, never by repeated labels', async t => {
  const f = fixture(t, { agents: ['agent', 'old', 'foreign-id', 'offline'].map(id => ({ id, companyId: 'company', name: 'Same label' })) });
  bind(f.store);
  for (const [agentId, companyId, availability] of [
    ['agent', 'company', 'present'], ['old', 'company', 'present'], ['foreign-id', 'other', 'present'], ['offline', 'company', 'offline'],
  ]) {
    const record = f.store.saveOperation({ id: `herdr-agent:${agentId}`, runId: '', agentId, state: 'recorded', identity: { companyId, conversationId: 'PRIVATE' },
      availability, observation: { display: { name: '\u001b[31mCurrent\u001b[0m\nlabel', terminalTitle: 'PRIVATE' }, state: 'working' }, placement: { directory: 'PRIVATE' } });
    if (agentId === 'old') f.store.db.prepare('UPDATE operations SET data = ? WHERE id = ?')
      .run(JSON.stringify({ ...record, updatedAt: '2000-01-01T00:00:00Z' }), record.id);
  }
  f.store.saveOperation({ id: 'opencode-bridge:agent', runId: '', state: 'armed', lastSeen: new Date().toISOString(), tokenHash: 'PRIVATE' });
  const result = await taskBoard(f.store, f.api, { companyId: 'company' });
  assert.deepEqual(result.agents[0], { id: 'agent', companyId: 'company', name: 'Current label', availability: 'present', bridgeState: 'armed', nativeState: 'working' });
  assert.deepEqual(result.agents.slice(1).map(row => [row.id, row.name, row.availability, row.nativeState]), [
    ['old', 'Same label', 'unknown', 'unknown'], ['foreign-id', 'Same label', 'unknown', 'unknown'], ['offline', 'Same label', 'offline', 'unknown'],
  ]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  f.store.saveOperation({ id: 'opencode-bridge:agent', runId: '', state: 'armed', lastSeen: '2000-01-01T00:00:00Z' });
  assert.equal((await taskBoard(f.store, f.api, { companyId: 'company' })).agents[0].bridgeState, 'unavailable');
});

test('ambiguous or failed local observations cannot advertise a current native state', async t => {
  const f = fixture(t, { agents: [{ id: 'agent', companyId: 'company', name: 'Backend name' }] });
  const observed = { id: 'herdr-agent:one', runId: '', agentId: 'agent', identity: { companyId: 'company' },
    state: 'recorded', availability: 'present', observation: { display: { name: 'Observed name' }, state: 'working' } };
  f.store.saveOperation({ ...observed, error: 'PRIVATE' });
  const failed = await taskBoard(f.store, f.api);
  assert.equal(failed.agents[0].availability, 'unknown');
  assert.equal(failed.agents[0].nativeState, 'unknown');
  f.store.saveOperation(observed);
  f.store.saveOperation({ ...observed, id: 'herdr-agent:two' });
  const ambiguous = await taskBoard(f.store, f.api);
  assert.equal(ambiguous.agents[0].name, 'Backend name');
  assert.equal(ambiguous.agents[0].availability, 'unknown');
});

test('agent and project totals include the entire unpaginated company collections', async t => {
  const rows = Array.from({ length: 1001 }, (_, n) => ({ id: `row-${n}`, companyId: 'company', name: `Name ${n}` }));
  const f = fixture(t, { agents: rows, projects: rows });
  const result = await taskBoard(f.store, f.api);
  assert.equal(result.totals.agents, 1001);
  assert.equal(result.totals.projects, 1001);
  assert.equal(f.calls.filter(path => path.endsWith('/agents')).length, 1);
  assert.equal(f.calls.filter(path => path.includes('/projects?')).length, 1);
});

test('backend failures reject the poll with a sanitised error, never a successful empty board', async t => {
  const f = fixture(t);
  for (const failAt of ['/api/companies', '/agents', '/projects', '/issues']) {
    await assert.rejects(taskBoard(f.store, async (method, path) => {
      if (path.includes(failAt)) throw new Error('PRIVATE backend credentials');
      return f.api(method, path);
    }), error => error.code === 'backend_unavailable' && error.status === 502 && !error.message.includes('PRIVATE'));
  }
});

test('invalid collection envelopes, field types, duplicate IDs and foreign companies fail closed', async t => {
  const f = fixture(t);
  for (const [route, payload] of [
    ['/api/companies', { items: [] }], ['/api/companies', [null]],
    ['/api/companies', [{ id: 'company', name: { secret: 'PRIVATE' } }]],
    ['/api/companies', [{ id: 'company', name: 'A' }, { id: 'company', name: 'B' }]],
    ['/agents', [{ id: 'agent', companyId: 'other', name: 'Wrong' }]],
    ['/agents', [{ id: 'agent', companyId: 'company', name: { secret: 'PRIVATE' } }]],
    ['/projects', [{ id: 'project', companyId: 'other', name: 'Wrong' }]],
    ['/issues', { items: [issue(1)], nextCursor: 'PRIVATE' }],
    ['/issues', [{ ...issue(1), companyId: 'other' }]],
    ['/issues', [{ ...issue(1), description: { secret: 'PRIVATE' } }]],
    ['/issues', [{ ...issue(1), assigneeUserId: { secret: 'PRIVATE' } }]],
    ['/issues', [{ ...issue(1), id: 'not-a-uuid' }]],
    ['/issues', [issue(1), issue(1)]], ['/issues', [issue(2), issue(1)]],
    ['/issues', Array.from({ length: 1001 }, (_, n) => issue(n + 1))],
  ]) {
    await assert.rejects(taskBoard(f.store, (method, path) => path === route || path.includes(`${route}?`) || path.endsWith(route)
      ? payload : f.api(method, path)), { code: 'invalid_backend_response' });
  }
});

test('rejects repeated pagination and second-page errors rather than returning partial success', async t => {
  const rows = Array.from({ length: 1000 }, (_, n) => issue(n + 1));
  const f = fixture(t, { tasks: rows });
  for (const repeat of [true, false]) {
    await assert.rejects(taskBoard(f.store, (method, path) => {
      if (path.includes('afterId=')) {
        if (repeat) return rows;
        throw new Error('PRIVATE');
      }
      return f.api(method, path);
    }), { code: repeat ? 'invalid_backend_response' : 'backend_unavailable' });
  }
});

test('invalid explicit company never broadens into directory discovery', async t => {
  const f = fixture(t);
  for (const companyId of ['', null, {}, '   ']) {
    await assert.rejects(taskBoard(f.store, f.api, { companyId }), { code: 'invalid_request' });
  }
  assert.deepEqual(f.calls, []);
  await assert.rejects(taskBoard(f.store, async () => ({ id: 'other', name: 'Wrong company' }), { companyId: 'company' }),
    { code: 'invalid_backend_response' });
});
