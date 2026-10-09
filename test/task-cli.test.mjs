import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'relay.sock');
  const context = join(directory, 'context.json');
  await writeFile(context, JSON.stringify({ socketPath, token: 'test-token' }));
  const requests = [];
  const response = { items: [], nextCursor: null, complete: true };
  const server = createServer(async (request, res) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : undefined });
    assert.equal(request.headers.authorization, 'Bearer test-token');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return {
    requests,
    response,
    run: args => new Promise(resolve => execFile(process.execPath, [cli, '--context', context, ...args],
      { timeout: 10000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))),
    file: async value => {
      const path = join(directory, 'input.json');
      await writeFile(path, JSON.stringify(value));
      return path;
    },
  };
}

test('runless query commands send exact POST bodies and return JSON unchanged', async t => {
  const f = await fixture(t);
  const filters = ['--project', 'project-id', '--status', 'todo,blocked', '--agent', 'agent-id', '--user', 'user-id'];
  const filterBody = { projectId: 'project-id', statuses: ['todo', 'blocked'], assigneeAgentId: 'agent-id', assigneeUserId: 'user-id' };
  const paging = ['--limit', '25', '--cursor', 'opaque-cursor'];
  const cases = [
    ['list', [], { kind: 'list' }],
    ['list', [...filters, '--parent', 'parent-id', ...paging], { kind: 'list', ...filterBody, parentId: 'parent-id', limit: 25, cursor: 'opaque-cursor' }],
    ['children', ['--task', 'task-id', ...filters, ...paging], { kind: 'children', taskId: 'task-id', ...filterBody, limit: 25, cursor: 'opaque-cursor' }],
    ['comments', ['--task', 'task-id', ...paging], { kind: 'comments', taskId: 'task-id', limit: 25, cursor: 'opaque-cursor' }],
    ['activity', ['--from', '2026-10-01T00:00:00Z', '--to', '2026-10-08T00:00:00Z'],
      { kind: 'activity', from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z' }],
    ['activity', ['--task', 'task-id', '--from', '2026-10-01T00:00:00Z', '--to', '2026-10-08T00:00:00Z', ...paging],
      { kind: 'activity', taskId: 'task-id', from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', limit: 25, cursor: 'opaque-cursor' }],
    ['reference-lookup', ['--namespace', 'github', '--external-id', 'org/repo#42'], { action: 'lookup', namespace: 'github', externalId: 'org/repo#42' }],
  ];
  for (const [action, args, body] of cases) {
    const result = await f.run(['task', action, '--company', 'company-id', ...args]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), f.response);
    assert.deepEqual(f.requests.at(-1), { method: 'POST', path: action === 'reference-lookup' ? '/tasks/references' : '/tasks/query',
      body: { companyId: 'company-id', ...body } });
  }
  assert.equal(f.requests.length, cases.length);
});

test('capture is human-safe and reference attachment preserves nested payload and optional reason', async t => {
  const f = await fixture(t);
  const reference = { namespace: 'github', externalId: 'org/repo#42', url: 'https://github.com/org/repo/issues/42' };
  for (const externalReference of [undefined, reference]) {
    const details = { payload: { title: 'Follow up' }, ...(externalReference ? { externalReference } : {}) };
    const file = await f.file(details);
    const result = await f.run(['task', 'capture', '--company', 'company-id', '--key', 'capture-key', '--file', file]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(f.requests.at(-1), { method: 'POST', path: '/tasks/manage', body: {
      ...details, action: 'create', companyId: 'company-id', key: 'capture-key',
    } });
  }
  for (const reason of [undefined, 'Attach the source issue']) {
    const details = { expectedRevision: 'revision', payload: reference, ...(reason ? { reason } : {}) };
    const file = await f.file(details);
    const result = await f.run(['task', 'reference-attach', '--company', 'company-id', '--task', 'task-id', '--key', 'attach-key', '--file', file]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(f.requests.at(-1), { method: 'POST', path: '/tasks/references', body: {
      ...details, action: 'attach', companyId: 'company-id', taskId: 'task-id', key: 'attach-key',
    } });
  }
  assert.equal(f.requests.length, 4);
});

test('existing and new human verbs use the manage route without changing their envelopes', async t => {
  const f = await fixture(t);
  const cases = [
    ['edit', { title: 'Updated title' }], ['reassign', { assigneeUserId: 'human-id' }],
    ['complete', undefined], ['comment', { body: 'Follow up' }], ['reopen', {}], ['cancel', undefined], ['recover', undefined],
  ];
  for (const [action, payload] of cases) {
    const details = { expectedRevision: 'revision', reason: 'Human instruction', ...(payload ? { payload } : {}) };
    const file = await f.file(details);
    const result = await f.run(['task', action, '--company', 'company-id', '--task', 'task-id', '--key', 'key', '--file', file]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(f.requests.at(-1), { method: 'POST', path: '/tasks/manage', body: {
      ...details, action: action === 'reassign' ? 'assign' : action, companyId: 'company-id', taskId: 'task-id', key: 'key',
    } });
  }
  const inspect = await f.run(['task', 'inspect', '--company', 'company-id', '--task', 'task-id']);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.deepEqual(f.requests.at(-1), { method: 'POST', path: '/tasks/manage', body: { action: 'inspect', companyId: 'company-id', taskId: 'task-id' } });
  assert.equal(f.requests.length, cases.length + 1);
});

test('generic operator create and worker task commands retain their routes', async t => {
  const f = await fixture(t);
  const payload = { title: 'Generic task', assigneeAgentId: 'agent-id' };
  const file = await f.file(payload);
  const cases = [
    [['task', 'create', '--company', 'company-id', '--key', 'key', '--file', file], 'POST', '/tasks',
      { companyId: 'company-id', key: 'key', payload }],
    [['task', 'list', 'run/id'], 'GET', '/runs/run%2Fid/tasks', undefined],
    [['task', 'inspect', 'run/id', '--task', 'child-id'], 'POST', '/runs/run%2Fid/child', { taskId: 'child-id' }],
    ...['create', 'assign', 'update'].map(action => [
      ['task', action, 'run/id', '--key', 'key', '--file', file], 'POST', '/runs/run%2Fid/mutate',
      { key: 'key', kind: `task.${action}`, payload },
    ]),
  ];
  for (const [args, method, path, body] of cases) {
    const result = await f.run(args);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(f.requests.at(-1), { method, path, body });
  }
  assert.equal(f.requests.length, cases.length);
});

test('invalid query limits and statuses fail locally without HTTP requests', async t => {
  const f = await fixture(t);
  for (const value of ['', '0', '-1', '1.5', '1e2', '0x10', 'NaN', 'Infinity', ' 2', '2 ', '1000', '9007199254740993']) {
    const result = await f.run(['task', 'list', '--company', 'company-id', `--limit=${value}`]);
    assert.equal(result.code, 1, `Accepted limit ${value}`);
    assert.equal(JSON.parse(result.stderr).code, 'invalid_request');
  }
  for (const [action, args] of [
    ['comments', ['--task', 'task-id', '--limit', '500']],
    ['activity', ['--from', '2026-10-01T00:00:00Z', '--to', '2026-10-08T00:00:00Z', '--limit', '201']],
    ...['', 'todo,', ',todo', 'todo,todo', 'todo, blocked', 'unknown'].map(status => ['list', [`--status=${status}`]]),
  ]) {
    const result = await f.run(['task', action, '--company', 'company-id', ...args]);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(JSON.parse(result.stderr).code, 'invalid_request');
  }
  assert.deepEqual(f.requests, []);
});

test('runless commands reject missing scope, positional runs and unsupported options', async t => {
  const f = await fixture(t);
  const cases = [
    ['task', 'list'], ['task', 'children', '--company', 'company-id'], ['task', 'comments', '--company', 'company-id'],
    ['task', 'activity', '--company', 'company-id'], ['task', 'reference-lookup', '--company', 'company-id', '--namespace', 'github'],
    ['task', 'capture', '--company', 'company-id'], ['task', 'comment', '--company', 'company-id', '--task', 'task-id'],
    ['task', 'list', '--company='], ['task', 'list', '--company', 'company-id', '--task', 'task-id'],
    ['task', 'children', '--company', 'company-id', '--task', 'task-id', '--parent', 'parent-id'],
    ['task', 'comments', '--company', 'company-id', '--task', 'task-id', '--status', 'todo'],
    ['task', 'list', '--company', 'company-id', '--file', 'ignored.json'],
    ['task', 'reference-lookup', '--company', 'company-id', '--namespace', 'github', '--external-id', '42', '--limit', '1'],
    ['task', 'list', 'run-id', '--limit', '1'], ['status', '--company', 'company-id'],
    ['task', 'assign', '--company', 'company-id'], ['status', '--namespace', 'github'],
    ['task', 'list', '--company', 'company-id', '--unknown', 'value'],
    ...['create', 'capture', 'inspect', 'list', 'children', 'comments', 'activity', 'reference-lookup', 'reference-attach', 'edit', 'reassign', 'complete', 'comment', 'reopen', 'cancel']
      .map(action => ['task', action, 'run-id', '--company', 'company-id']),
    ['task', 'list', '', 'extra', '--company', 'company-id'],
  ];
  for (const args of cases) {
    const result = await f.run(args);
    assert.equal(result.code, 1, `Accepted ${args.join(' ')}`);
    assert.ok(JSON.parse(result.stderr).code);
  }
  assert.deepEqual(f.requests, []);
});

test('mutation files reject unknown envelope and reference fields before sending', async t => {
  const f = await fixture(t);
  const reference = { namespace: 'github', externalId: '42' };
  const cases = [
    ...['edit', 'reassign', 'complete', 'comment', 'reopen', 'cancel', 'reference-attach'].map(action =>
      [action, { expectedRevision: 'revision', payload: {}, companyId: 'other-company' }]),
    ['capture', { payload: { title: 'Task' }, key: 'override' }],
    ['capture', { payload: { title: 'Task' }, externalReference: { ...reference, companyId: 'other-company' } }],
    ['capture', { title: 'Not a capture envelope' }], ['capture', { payload: [] }],
    ['reference-attach', { expectedRevision: 'revision', payload: { ...reference, taskId: 'other-task' } }],
    ['reference-attach', { payload: reference }], ['reference-attach', { expectedRevision: 'revision', payload: {} }],
    ['comment', []], ['comment', null],
  ];
  for (const [action, details] of cases) {
    const file = await f.file(details);
    const result = await f.run(['task', action, '--company', 'company-id', ...(action === 'capture' ? [] : ['--task', 'task-id']),
      '--key', 'key', '--file', file]);
    assert.equal(result.code, 1, `Accepted ${action}: ${JSON.stringify(details)}`);
    assert.equal(JSON.parse(result.stderr).code, 'invalid_request');
  }
  assert.deepEqual(f.requests, []);
});

test('help documents each exact runless query and distinguishes capture from generic create', async t => {
  const f = await fixture(t);
  const result = await f.run(['--help']);
  assert.equal(result.code, 0, result.stderr);
  for (const action of ['list', 'children', 'comments', 'activity', 'reference-lookup', 'reference-attach', 'capture', 'create']) {
    assert.ok(result.stdout.includes(`task ${action} --company COMPANY_ID`), action);
  }
  assert.match(result.stdout, /task list RUN  \[worker\]/);
  assert.match(result.stdout, /human-safe create/);
  assert.match(result.stdout, /generic operator create, unchanged/);
  assert.deepEqual(f.requests, []);
});
