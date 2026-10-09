import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { configureBridge, armBridge } from '../src/opencode-bridge.mjs';
import { createServer } from 'node:http';
import { digest } from '../src/protocol.mjs';
import plugin from '../src/opencode-bridge-plugin.mjs';

const taskMutations = ['create', 'edit', 'assign', 'complete', 'reference-attach', 'cancel', 'reopen', 'comment'];

async function discoveryFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-tools-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const configDirectory = join(root, 'bridges'); mkdirSync(configDirectory);
  const inventoryFile = join(root, 'herdr.json'), countFile = join(root, 'calls');
  writeFileSync(countFile, '');
  const pane = { agent: 'opencode', agent_session: { value: 'first', kind: 'id' },
    terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  const inventory = () => writeFileSync(inventoryFile, JSON.stringify({ result: { agents: [pane] } }));
  inventory();
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(countFile)}, 'call\\n');\nconsole.log(fs.readFileSync(${JSON.stringify(inventoryFile)}, 'utf8'));\n`, { mode: 0o700 });
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  const requests = [], approvals = [], sdkCalls = [], hooks = [];
  const source = { info: { id: 'human', role: 'user', sessionID: 'first', time: { created: 123 } },
    parts: [{ type: 'text', text: 'Enrol the observed agent in /worker and reserve it.' }] };
  const messages = [source, { info: { id: 'tool-turn', role: 'assistant', sessionID: 'first', parentID: 'human' }, parts: [] }];
  let failMutation = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: req.url, body });
    const responses = {
      '/bridge/poll': { state: 'configured' }, '/bridge/agents': { agents: [{ bindingId: 'worker', ready: false }] },
      '/bridge/tasks': { tasks: [{ id: 'task', status: 'in_progress' }], companyId: 'company' },
      '/bridge/task-inspect': { task: { id: 'task', title: 'Human task' }, revision: 'revision' },
      ...Object.fromEntries(['list', 'children', 'comments', 'activity'].map(action => [`/bridge/task-${action}`, {
        items: [{ id: action }], nextCursor: 'next-page', hasMore: true, complete: false,
      }])),
      '/bridge/task-reference-lookup': { state: 'attached', reference: { namespace: 'github', externalId: 'issue-1', taskId: 'task' } },
      ...Object.fromEntries(taskMutations.map(action => [`/bridge/task-${action}`, { state: 'recorded' }])),
      '/bridge/enrolment-candidates': { candidates: [{ observedId: 'observed', directory: '/worker' }] },
      '/bridge/enrol-agent': { state: 'configured' }, '/bridge/delegation-status': { delegations: [] },
      '/bridge/notification-history': { notifications: [] },
      '/bridge/routine-create': { scheduleId: 'routine:self', targetBindingId: 'self', state: 'active' },
    };
    if ((req.url === '/bridge/enrol-agent' || taskMutations.some(action => req.url === `/bridge/task-${action}`)) && failMutation) {
      res.statusCode = 502;
      res.end(JSON.stringify({ code: 'lost_response', message: 'Response lost after enrolment' }));
    } else if (responses[req.url]) res.end(JSON.stringify(responses[req.url]));
    else { res.statusCode = 404; res.end(JSON.stringify({ code: 'unexpected', message: req.url })); }
  });
  t.after(async () => {
    for (const hook of hooks) await hook.dispose();
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  const socketPath = join(root, 'relay.sock');
  await new Promise(resolve => server.listen(socketPath, resolve));
  const config = conversationId => {
    const path = join(configDirectory, `${conversationId}.json`);
    writeFileSync(path, JSON.stringify({ directory: '/work', conversationId, terminalId: 'terminal', socketPath, token: 'fixture' }));
    return path;
  };
  const client = { session: {
    get: async ({ path }) => { sdkCalls.push('get'); return { data: { id: path.id, directory: '/work', time: { created: 123 } } }; },
    messages: async () => { sdkCalls.push('messages'); return { data: structuredClone(messages) }; },
    status: async () => ({ data: { first: { type: 'busy' }, second: { type: 'busy' } } }),
    promptAsync: async () => assert.fail('Configured tools must not send prompts'),
  } };
  const load = async options => {
    const hook = await plugin({ client, directory: '/work' }, options ?? { configDirectory });
    hooks.push(hook); return hook;
  };
  return { root, configDirectory, inventoryFile, countFile, pane, inventory, requests, approvals, sdkCalls, source, messages, config, load,
    failMutation: () => { failMutation = true; },
    context: { sessionID: 'first', messageID: 'tool-turn', ask: async permission => {
      assert.ok(permission.patterns.every(pattern => typeof pattern === 'string' && pattern.length > 0));
      approvals.push(permission);
    } } };
}

for (const discovery of [false, true]) {
test(`self-schedule tool accepts omitted target and retains human permission checks (discovery: ${discovery})`, async t => {
  const f = await discoveryFixture(t);
  const configFile = f.config('first');
  const { tool: tools } = await f.load(discovery ? undefined : { configFile });
  assert.equal(tools.relay_schedule_create.args.targetBindingId.parse(undefined), undefined);
  assert.equal(tools.relay_schedule_create.args.targetDirectory.parse('/work'), '/work');
  const args = { key: 'self-schedule', title: 'Read inbox', description: 'Read only',
    cron: '0 7-18 * * 1-5', timezone: 'Africa/Johannesburg', enabled: true, relayReviewPolicy: 'human' };
  await assert.rejects(tools.relay_schedule_create.execute(args, { ...f.context,
    ask: async () => { throw new Error('Permission denied'); } }), /Permission denied/);
  assert.equal(f.requests.some(request => request.path === '/bridge/routine-create'), false);
  const original = f.source.parts[0].text;
  await assert.rejects(tools.relay_schedule_create.execute(args, { ...f.context,
    ask: async () => { f.source.parts[0].text = 'Do not schedule'; } }), /User message changed/);
  f.source.parts[0].text = original;
  assert.equal(JSON.parse(await tools.relay_schedule_create.execute(args, f.context)).state, 'active');
  assert.equal(f.approvals.at(-1).permission, 'relay_schedule_create');
  assert.deepEqual(f.approvals.at(-1).patterns, ['/work']);
  const request = f.requests.find(request => request.path === '/bridge/routine-create');
  assert.equal(request.body.idle, false);
  assert.equal(request.body.targetBindingId, undefined);
  assert.deepEqual(request.body.source, { id: 'human', text: original, createdAt: 123 });
});

test(`configured busy bridge exposes read-only previews and permission-checked enrolment (discovery: ${discovery})`, async t => {
  const f = await discoveryFixture(t);
  const configFile = f.config('first');
  const hooks = await f.load(discovery ? undefined : { configFile });
  const tools = hooks.tool;
  assert.equal(Object.keys(tools).length, 38);
  assert.deepEqual(tools.relay_tasks.args, {});
  assert.equal(tools.relay_enrol_agent.args.reserved.parse(true), true);
  assert.equal(tools.relay_enrol_agent.args.reserved.parse(undefined), undefined);
  assert.equal(tools.relay_enrol_agent.args.observedId.parse(undefined), undefined);
  if (!discovery) {
    for (const entry of Object.values(tools)) {
      await assert.rejects(entry.execute({}, { ...f.context, sessionID: 'foreign' }), /enrolled conversation/);
    }
    assert.deepEqual(f.sdkCalls, [], 'Every direct tool must reject foreign context before native reads');
  }
  await hooks.config();
  assert.deepEqual(JSON.parse(await tools.relay_agents.execute({}, f.context)), { agents: [{ bindingId: 'worker', ready: false }] });
  assert.deepEqual(JSON.parse(await tools.relay_tasks.execute({}, f.context)), { tasks: [{ id: 'task', status: 'in_progress' }], companyId: 'company' });
  assert.deepEqual(JSON.parse(await tools.relay_enrolment_candidates.execute({}, f.context)), { candidates: [{ observedId: 'observed', directory: '/worker' }] });
  assert.deepEqual(JSON.parse(await tools.relay_delegations.execute({}, f.context)), { delegations: [], notifications: [] });
  assert.equal(f.sdkCalls.includes('messages'), false);
  assert.deepEqual(f.approvals, []);
  assert.ok(f.requests.every(request => request.body.idle === false), 'Busy configured conversations may inspect without arming');
  assert.equal(new Set(f.requests.map(request => request.body.epoch)).size, 1);
  const args = { key: 'enrol-once', directory: '/worker', observedId: 'observed', reserved: true };
  await assert.rejects(tools.relay_enrol_agent.execute(args, { ...f.context, messageID: 'missing' }), /user message could not be verified/);
  for (const flag of ['synthetic', 'ignored']) {
    f.source.parts[0][flag] = true;
    await assert.rejects(tools.relay_enrol_agent.execute(args, f.context), /user message could not be verified/);
    delete f.source.parts[0][flag];
  }
  assert.deepEqual(f.approvals, []);
  await assert.rejects(tools.relay_enrol_agent.execute(args, { ...f.context, ask: async () => { throw new Error('Permission denied'); } }), /Permission denied/);
  const original = structuredClone(f.source);
  for (const change of ['text', 'id', 'latest']) {
    try {
      await assert.rejects(tools.relay_enrol_agent.execute(args, { ...f.context, ask: async () => {
        if (change === 'text') f.source.parts[0].text = 'Do not enrol';
        else if (change === 'id') f.source.info.id = 'changed';
        else f.messages.push({ info: { ...f.source.info, id: 'newer' }, parts: f.source.parts });
      } }), /User message changed/);
    } finally { Object.assign(f.source, structuredClone(original)); f.messages.splice(2); }
  }
  assert.equal(f.requests.some(request => request.path === '/bridge/enrol-agent'), false);
  assert.deepEqual(JSON.parse(await tools.relay_enrol_agent.execute(args, f.context)), { state: 'configured' });
  assert.deepEqual(f.approvals, [{ permission: 'relay_enrol_agent', patterns: ['/worker'], always: [],
    metadata: { ...args, sourceMessageId: 'human', sourceText: original.parts[0].text } }]);
  assert.deepEqual(f.requests.at(-1).body.source, { id: 'human', text: original.parts[0].text, createdAt: 123 });
  for (const [key, value] of Object.entries(args)) assert.deepEqual(f.requests.at(-1).body[key], value);
  f.failMutation();
  await assert.rejects(tools.relay_enrol_agent.execute({ ...args, key: 'lost' }, f.context), { code: 'lost_response' });
  assert.equal(f.requests.filter(request => request.path === '/bridge/enrol-agent').length, 2, 'A lost mutation response must not retry tool execution');
});

test(`task queries forward filters and pagination without native history or permission (discovery: ${discovery})`, async t => {
  const f = await discoveryFixture(t);
  const configFile = f.config('first');
  const { tool: tools } = await f.load(discovery ? undefined : { configFile });
  const filters = { projectId: 'project', statuses: ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'],
    assigneeAgentId: 'agent', assigneeUserId: 'human' };
  for (const [action, args] of [
    ['list', { ...filters, parentId: 'parent', limit: 999, cursor: 'page' }],
    ['list', {}],
    ['children', { taskId: 'task', ...filters, limit: 999, cursor: 'page' }],
    ['comments', { taskId: 'task', limit: 499, cursor: 'page' }],
    ['activity', { taskId: 'task', from: '2026-10-01T00:00:00+02:00', to: '2026-10-08T00:00:00Z', limit: 200, cursor: 'page' }],
    ['activity', { from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z' }],
    ['reference-lookup', { payload: { namespace: 'github', externalId: 'issue-1' } }],
  ]) {
    const entry = tools[`relay_task_${action.replaceAll('-', '_')}`];
    for (const [field, schema] of Object.entries(entry.args)) assert.deepEqual(schema.parse(args[field]), args[field]);
    const result = JSON.parse(await entry.execute(args, { sessionID: 'first' }));
    assert.deepEqual(result, action === 'reference-lookup'
      ? { state: 'attached', reference: { namespace: 'github', externalId: 'issue-1', taskId: 'task' } }
      : { items: [{ id: action }], nextCursor: 'next-page', hasMore: true, complete: false });
    const request = f.requests.findLast(item => item.path === `/bridge/task-${action}`);
    const { epoch, conversationId, terminalId, sessionCreatedAt, idle, ...sent } = request.body;
    assert.deepEqual(sent, args, 'Reads forward only arguments, never native source');
    assert.equal(conversationId, 'first');
    assert.equal(idle, false);
  }
  assert.equal(f.sdkCalls.includes('messages'), false);
  assert.deepEqual(f.approvals, []);
  for (const [action, max] of [['list', 999], ['children', 999], ['comments', 499], ['activity', 200]]) {
    const schema = tools[`relay_task_${action}`].args.limit;
    for (const value of [0, -1, 1.5, max + 1, '1']) assert.equal(schema.safeParse(value).success, false);
    assert.equal(schema.parse(1), 1);
    assert.equal(schema.parse(undefined), undefined);
  }
  assert.equal(tools.relay_task_children.args.parentId, undefined);
  assert.equal(tools.relay_task_list.args.statuses.safeParse(['unknown']).success, false);
  assert.equal(tools.relay_task_list.args.parentId.safeParse(null).success, false);
  for (const field of ['from', 'to']) {
    for (const value of [undefined, '2026-10-08', '2026-10-08T00:00:00', 'invalid']) {
      assert.equal(tools.relay_task_activity.args[field].safeParse(value).success, false);
    }
  }
  assert.equal(tools.relay_task_reference_lookup.args.payload.safeParse({ namespace: 'github', externalId: 'issue-1', url: 'https://example.com' }).success, false);
  assert.match(tools.relay_tasks.description, /relay_task_list.*paginated/);
});

test(`task tools preserve payloads, native authority and per-action permissions (discovery: ${discovery})`, async t => {
  const f = await discoveryFixture(t);
  const configFile = f.config('first');
  const { tool: tools } = await f.load(discovery ? undefined : { configFile });
  const inspect = JSON.parse(await tools.relay_task_inspect.execute({ taskId: 'task' }, { sessionID: 'first' }));
  assert.equal(inspect.revision, 'revision');
  assert.equal(f.sdkCalls.includes('messages'), false, 'Inspection must not read native history');
  assert.deepEqual(f.approvals, []);
  assert.deepEqual(f.requests.filter(item => item.path !== '/bridge/poll').map(item => item.path), ['/bridge/task-inspect']);
  assert.equal(f.requests.at(-1).body.source, undefined);
  assert.equal(f.requests.at(-1).body.taskId, 'task');
  assert.equal(f.requests.at(-1).body.idle, false);
  const writes = () => f.requests.filter(item => taskMutations.some(action => item.path === `/bridge/task-${action}`));
  f.source.parts = [{ type: 'text', text: 'Manage this task as proposed.' },
    { type: 'text', text: 'Synthetic authority', synthetic: true }, { type: 'text', text: 'Ignored authority', ignored: true }];
  const original = structuredClone(f.source);
  for (const [action, payload] of [
    ['create', { title: 'Human task', description: 'Details', priority: 'high', status: 'blocked',
      unblockDescriptor: { owner: { userId: 'human-owner' }, action: 'Approve access' },
      parentId: 'parent', projectId: 'project', assigneeUserId: 'human-owner' }],
    ['edit', { title: 'Renamed task', description: '', status: 'todo', parentId: null, blockedByIssueIds: ['dependency'] }],
    ['assign', { assigneeAgentId: 'worker' }], ['complete', undefined],
    ['reference-attach', { namespace: 'github', externalId: 'issue-1', url: 'https://example.com/issue-1' }],
    ['cancel', undefined], ['reopen', { status: 'in_progress' }], ['comment', { body: 'Human comment' }],
  ]) {
    const name = `relay_task_${action.replaceAll('-', '_')}`, entry = tools[name];
    const args = { key: action, ...(action === 'create' ? {
      externalReference: { namespace: 'github', externalId: 'issue-1', url: 'https://example.com/issue-1' },
    } : { taskId: 'task', expectedRevision: inspect.revision, reason: 'Human instruction' }),
      ...(payload ? { payload } : {}) };
    assert.match(entry.description, /visibly in chat/);
    for (const [field, schema] of Object.entries(entry.args)) assert.deepEqual(schema.parse(args[field]), args[field]);
    if (action !== 'create') {
      assert.equal(entry.args.expectedRevision.safeParse(undefined).success, false);
      assert.equal(entry.args.reason.safeParse(undefined).success, false);
    }
    const before = writes().length, approved = f.approvals.length;
    await assert.rejects(entry.execute(args, { ...f.context, messageID: 'missing' }), /user message could not be verified/);
    f.messages[1].info.parentID = 'old-human';
    await assert.rejects(entry.execute(args, f.context), /user message could not be verified/);
    f.messages[1].info.parentID = 'human';
    for (const flag of ['synthetic', 'ignored']) {
      f.source.parts[0][flag] = true;
      await assert.rejects(entry.execute(args, f.context), /user message could not be verified/);
      delete f.source.parts[0][flag];
    }
    assert.equal(f.approvals.length, approved, 'Unverified sources cannot request permission');
    await assert.rejects(entry.execute(args, { ...f.context, ask: async () => { throw new Error('Permission denied'); } }), /Permission denied/);
    for (const change of ['text', 'id', 'latest']) {
      try {
        await assert.rejects(entry.execute(args, { ...f.context, ask: async () => {
          if (change === 'text') f.source.parts[0].text = 'Do not change the task';
          else if (change === 'id') f.source.info.id = 'changed';
          else f.messages.push({ info: { ...f.source.info, id: 'newer' }, parts: f.source.parts });
        } }), /User message changed/);
      } finally { Object.assign(f.source, structuredClone(original)); f.messages.splice(2); }
    }
    assert.equal(writes().length, before, 'Denied or stale native sources cannot send task writes');
    assert.deepEqual(JSON.parse(await entry.execute(args, f.context)), { state: 'recorded' });
    assert.deepEqual(f.approvals.at(-1), { permission: name, patterns: [args.taskId ?? payload.title], always: [],
      metadata: { ...args, sourceMessageId: 'human', sourceText: original.parts[0].text } });
    const { epoch, conversationId, terminalId, sessionCreatedAt, idle, ...sent } = writes().at(-1).body;
    assert.deepEqual(sent, { ...args, source: { id: 'human', text: original.parts[0].text, createdAt: 123 } });
    assert.equal(writes().at(-1).path, `/bridge/task-${action}`);
    assert.equal(f.approvals.length, approved + 1);
  }
  for (const payload of [{ assigneeUserId: null }, { assigneeAgentId: null }, { assigneeUserId: 'human' }]) {
    assert.deepEqual(tools.relay_task_assign.args.payload.parse(payload), payload);
  }
  for (const payload of [{}, { assigneeUserId: 'human', assigneeAgentId: 'agent' }, { assigneeUserId: null, assigneeAgentId: null }]) {
    assert.equal(tools.relay_task_assign.args.payload.safeParse(payload).success, false);
  }
  assert.equal(tools.relay_task_complete.args.payload, undefined);
  assert.equal(tools.relay_task_cancel.args.payload, undefined);
  assert.equal(tools.relay_task_create.args.externalReference.parse(undefined), undefined);
  assert.deepEqual(tools.relay_task_create.args.externalReference.parse({ namespace: 'github', externalId: 'issue-1' }), { namespace: 'github', externalId: 'issue-1' });
  assert.equal(tools.relay_task_create.args.externalReference.safeParse({ namespace: 'github', externalId: 'issue-1', companyId: 'other' }).success, false);
  assert.equal(tools.relay_task_create.args.payload.safeParse({ title: 'Task', externalReference: { namespace: 'github', externalId: 'issue-1' } }).success, false);
  assert.deepEqual(tools.relay_task_reopen.args.payload.parse({}), {});
  assert.deepEqual(tools.relay_task_reopen.args.payload.parse({ status: 'todo' }), { status: 'todo' });
  assert.equal(tools.relay_task_reopen.args.payload.safeParse({ status: 'done' }).success, false);
  assert.equal(tools.relay_task_comment.args.payload.safeParse({ body: '' }).success, false);
  assert.equal(tools.relay_task_reference_attach.args.payload.safeParse({ namespace: '', externalId: 'issue-1' }).success, false);
  assert.equal(tools.relay_task_reference_attach.args.payload.safeParse({ namespace: 'github', externalId: 'issue-1', url: 'invalid' }).success, false);
  assert.equal(tools.relay_task_edit.args.payload.safeParse({ status: 'cancelled' }).success, false);
  assert.equal(tools.relay_task_edit.args.payload.safeParse({ parentId: 'parent', blockedByIssueIds: Array(100).fill('dependency') }).success, true);
  assert.equal(tools.relay_task_edit.args.payload.safeParse({ blockedByIssueIds: Array(101).fill('dependency') }).success, false);
  assert.deepEqual(tools.relay_task_edit.args.payload.parse({ blockedByIssueIds: [] }), { blockedByIssueIds: [] });
  assert.equal(tools.relay_task_create.args.payload.safeParse({ title: 'Task', status: 'cancelled' }).success, false);
  assert.equal(tools.relay_task_edit.args.payload.safeParse({ status: 'done' }).success, false);
  assert.equal(tools.relay_task_create.args.payload.safeParse({ title: 'Task', assigneeAgentId: 'agent' }).success, false);
  assert.equal(tools.relay_task_create.args.payload.safeParse({ title: 'Task', status: 'blocked',
    unblockDescriptor: { owner: 'board', action: 'Approve' } }).success, true);
  f.failMutation();
  for (const action of taskMutations) {
    const before = writes().length;
    const args = { key: `lost-${action}`, ...(action === 'create' ? { payload: { title: 'Task' } } : {
      taskId: 'task', expectedRevision: inspect.revision, reason: 'Human instruction',
      ...(['complete', 'cancel'].includes(action) ? {} : { payload: {
        edit: { title: 'Renamed' }, assign: { assigneeUserId: 'human' },
        'reference-attach': { namespace: 'github', externalId: 'issue-1' }, reopen: {}, comment: { body: 'Comment' },
      }[action] }),
    }) };
    await assert.rejects(tools[`relay_task_${action.replaceAll('-', '_')}`].execute(args, f.context), { code: 'lost_response' });
    assert.equal(writes().length, before + 1, 'A lost task response must not retry execution');
  }
});

test(`task tools round-trip through the authenticated service (discovery: ${discovery})`, async t => {
  const f = await discoveryFixture(t);
  const task = { id: 'task', companyId: 'company', title: 'Human work', description: '',
    status: 'todo', priority: 'medium', assigneeUserId: 'human', assigneeAgentId: null };
  const requests = [];
  const backend = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/companies/company') {
      res.end(JSON.stringify({ id: 'company', defaultResponsibleUserId: 'human' }));
    } else if (req.method === 'GET' && req.url === '/api/agents/worker') {
      res.end(JSON.stringify({ id: 'worker', companyId: 'company' }));
    } else if (req.method === 'GET' && (req.url === '/api/issues/task/interactions' || req.url.startsWith('/api/companies/company/issues?'))) {
      res.end('[]');
    } else if ((req.method === 'POST' && req.url === '/api/companies/company/issues') ||
      (req.method === 'PATCH' && req.url === '/api/issues/task')) {
      Object.assign(task, body);
      res.end(JSON.stringify(task));
    } else if (req.method === 'GET' && req.url === '/api/issues/task') res.end(JSON.stringify(task));
    else { res.statusCode = 404; res.end(JSON.stringify({ message: `Unexpected request: ${req.method} ${req.url}` })); }
  });
  let service, hooks;
  t.after(async () => { await hooks?.dispose(); await service?.close(); await new Promise(resolve => backend.close(resolve)); });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const auth = join(f.root, 'backend.json'); writeFileSync(auth, '{"localTrusted":true}', { mode: 0o600 });
  const directory = join(f.root, 'relay');
  service = await startService({ directory, paperclipUrl: `http://127.0.0.1:${backend.address().port}`, backendContextFile: auth });
  service.store.saveOperation({ id: 'herdr-agent:test', runId: '', marker: 'marker', agentId: 'origin', availability: 'present',
    identity: { harness: 'opencode', sessionKind: 'id', conversationId: 'first', machineId: 'machine', session: 'default', companyId: 'company' },
    placement: { directory: '/work', terminalId: 'terminal' }, observation: { display: { name: 'origin' } } });
  const configured = await configureBridge(service.store, directory, async () => ({ id: 'origin', companyId: 'company',
    adapterType: 'herdr_relay', adapterConfig: { observationOnly: true, relayObservationMarker: 'marker' } }),
  { observedId: 'herdr-agent:test', reserved: true });
  hooks = await f.load(discovery ? { configDirectory: join(directory, 'bridges') } : { configFile: configured.bridgeConfigFile });
  const tools = hooks.tool;
  f.source.parts[0].text = 'Create and update the human task as proposed.';
  const inspect = () => tools.relay_task_inspect.execute({ taskId: 'task' }, { sessionID: 'first' }).then(JSON.parse);
  let result = await inspect();
  assert.equal(result.defaultHumanUserId, 'human');
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(f.sdkCalls.includes('messages'), false);
  assert.deepEqual(f.approvals, []);
  assert.ok(requests.every(item => item.method === 'GET'));
  assert.equal(service.store.db.prepare("SELECT count(*) AS n FROM operations WHERE id LIKE 'human-task:%'").get().n, 0);
  result = JSON.parse(await tools.relay_task_create.execute({ key: 'create', payload: { title: 'Created task' } }, f.context));
  assert.equal(result.task.title, 'Created task');
  assert.equal(result.task.assigneeUserId, 'human');
  assert.deepEqual(service.store.operation(result.operationId).request.authority, { kind: 'native', bindingId: configured.bindingId,
    conversationId: 'first', sessionCreatedAt: 123, sourceMessageId: 'human', sourceDigest: digest(f.source.parts[0].text) });
  const writes = () => requests.filter(item => item.method !== 'GET');
  await assert.rejects(tools.relay_task_edit.execute({ key: 'stale', taskId: 'task', expectedRevision: 'stale',
    reason: 'Old token', payload: { title: 'Not applied' } }, f.context), { code: 'stale_revision' });
  assert.equal(writes().length, 1);
  for (const [action, payload, reason] of [
    ['edit', { title: 'Renamed task' }, 'Clarify title'],
    ['assign', { assigneeAgentId: 'worker' }, 'Explicit agent assignment'],
    ['assign', { assigneeUserId: 'human' }, 'Return to human'],
    ['complete', undefined, 'Human work finished'],
  ]) {
    result = await inspect();
    result = JSON.parse(await tools[`relay_task_${action}`].execute({ key: reason, taskId: 'task', expectedRevision: result.revision,
      reason, ...(payload ? { payload } : {}) }, f.context));
    assert.equal(result.state, 'recorded');
    if (payload?.assigneeAgentId) {
      const before = writes().length;
      await assert.rejects(tools.relay_task_complete.execute({ key: 'cannot-bypass-review', taskId: 'task', expectedRevision: result.revision,
        reason: 'Not human-owned' }, f.context), { code: 'human_assignment_required' });
      assert.equal(writes().length, before);
    }
  }
  assert.equal(result.task.status, 'done');
  assert.match(writes()[0].body.idempotencyKey, /^relay-operator:[a-f0-9]{64}$/);
  assert.deepEqual(writes().map(({ body: { idempotencyKey, ...body } }) => body), [
    { title: 'Created task', assigneeUserId: 'human', description: '', status: 'todo' },
    { title: 'Renamed task' }, { assigneeUserId: null, assigneeAgentId: 'worker' },
    { assigneeUserId: 'human', assigneeAgentId: null }, { status: 'done' },
  ]);
});
}

test('discovery serialises delayed startup, keeps epochs through read errors and waits for the current exact chat', async t => {
  const f = await discoveryFixture(t);
  const hooks = await f.load(), tools = hooks.tool;
  await hooks.config(); await hooks.config();
  const firstReads = Promise.all(['relay_agents', 'relay_tasks'].map(name => tools[name].execute({}, f.context)));
  await delay(200);
  assert.equal(readFileSync(f.countFile, 'utf8'), 'call\n', 'Concurrent config and execute share one discovery refresh');
  assert.deepEqual(f.sdkCalls, []);
  const firstFile = f.config('first');
  await firstReads;
  const epoch = f.requests[0].body.epoch;
  assert.equal(new Set(f.requests.map(request => request.body.epoch)).size, 1, 'Concurrent initial reads load only one plugin');
  const scheduledCalls = readFileSync(f.countFile, 'utf8');
  await hooks.config(); await hooks.config();
  await delay(200);
  assert.equal(readFileSync(f.countFile, 'utf8'), scheduledCalls, 'Repeated config hooks must not start another discovery timer');
  assert.equal(f.requests.filter(request => request.path === '/bridge/poll').length, 1, 'Concurrent startup must not duplicate native polling');
  writeFileSync(firstFile, '{');
  await tools.relay_tasks.execute({}, f.context);
  assert.equal(f.requests.at(-1).body.epoch, epoch, 'Config read errors preserve the selected hooks');
  rmSync(firstFile);
  await tools.relay_agents.execute({}, f.context);
  assert.equal(f.requests.at(-1).body.epoch, epoch, 'Missing credentials do not replace the epoch');
  f.config('first');
  writeFileSync(f.inventoryFile, '{');
  await assert.rejects(tools.relay_agents.execute({}, f.context), /JSON/);
  f.inventory();
  await tools.relay_tasks.execute({}, f.context);
  assert.equal(f.requests.at(-1).body.epoch, epoch, 'Inventory read errors preserve the epoch');

  const before = f.requests.filter(request => request.path === '/bridge/tasks').length;
  let switched = false;
  const current = tools.relay_tasks.execute({}, { sessionID: 'second' }).then(result => { switched = true; return result; });
  await delay(200);
  assert.equal(switched, false, 'Old hooks must not refuse or execute a different native context');
  assert.equal(f.requests.filter(request => request.path === '/bridge/tasks').length, before);
  f.config('second');
  await delay(1100);
  assert.equal(switched, false, 'A config file alone must not bypass exact live selection');
  f.pane.agent_session.value = 'second'; f.inventory();
  await current;
  assert.equal(f.requests.at(-1).body.conversationId, 'second');
  assert.notEqual(f.requests.at(-1).body.epoch, epoch);
  assert.equal(hooks.tool, tools);
  await hooks.dispose();
  const stoppedCalls = readFileSync(f.countFile, 'utf8'), stoppedRequests = f.requests.length;
  await assert.rejects(tools.relay_tasks.execute({}, { sessionID: 'second' }), /disposed/);
  await delay(5200);
  assert.equal(readFileSync(f.countFile, 'utf8'), stoppedCalls, 'No duplicate discovery or native timers survive disposal');
  assert.equal(f.requests.length, stoppedRequests);
});

test('discovery bounds absent-config waits and disposal wakes all callers without invoking stale tools', async t => {
  const f = await discoveryFixture(t);
  const hooks = await f.load();
  const start = Date.now();
  await assert.rejects(hooks.tool.relay_tasks.execute({}, f.context), /not enrolled for this chat yet/);
  assert.ok(Date.now() - start >= 11500 && Date.now() - start < 14000, 'Discovery wait is bounded at twelve seconds');
  const calls = readFileSync(f.countFile, 'utf8').trim().split('\n').length;
  assert.ok(calls >= 10 && calls <= 13, `Expected roughly one refresh per second, got ${calls}`);
  f.config('first');
  await hooks.tool.relay_agents.execute({}, f.context);
  const reads = f.requests.filter(request => request.path !== '/bridge/poll').length;
  writeFileSync(f.inventoryFile, '{');
  const waiting = Promise.all(Object.values(hooks.tool).map(entry => assert.rejects(entry.execute({}, { sessionID: 'foreign' }), /disposed/)));
  await delay(200);
  const disposing = Date.now();
  await hooks.dispose(); await waiting;
  assert.ok(Date.now() - disposing < 1000, 'Disposal must interrupt the wait rather than leave the twelve-second timeout running');
  assert.equal(f.requests.filter(request => request.path !== '/bridge/poll').length, reads, 'Read errors must not expose old hooks to foreign context');
});

test('in-process plugin delivers and settles through the authenticated Relay bridge once', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  const pane = { agent: 'opencode', agent_session: { value: 'conversation', kind: 'id' },
    terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ result: { agents: [pane] } }))});\n`, { mode: 0o700 });
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  const service = await startService({ directory: join(root, 'relay'), paperclipUrl: 'http://127.0.0.1:3100' });
  let hooks;
  t.after(async () => {
    await hooks?.dispose(); await service.close();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  service.store.saveOperation({ id: 'herdr-agent:test', runId: '', marker: 'marker', agentId: 'agent', availability: 'present',
    identity: { harness: 'opencode', sessionKind: 'id', conversationId: 'conversation', machineId: 'machine', session: 'default', companyId: 'company' },
    placement: { directory: '/work', terminalId: 'terminal' }, observation: { display: { name: 'worker' } } });
  const backend = { id: 'agent', companyId: 'company', adapterType: 'herdr_relay', adapterConfig: { observationOnly: true, relayObservationMarker: 'marker' } };
  const api = async (method, path, body) => { if (method === 'PATCH') Object.assign(backend, body); return structuredClone(backend); };
  const configured = await configureBridge(service.store, join(root, 'relay'), api, { observedId: 'herdr-agent:test', reserved: true });
  let sends = 0, run, historyReads = 0;
  const messages = [];
  const client = { session: {
    get: async () => ({ data: { id: 'conversation', directory: '/work', time: { created: 123 }, agent: 'build', model: { providerID: 'litellm', id: 'fixture-model' } } }),
    messages: async () => { historyReads++; return { data: structuredClone(messages) }; },
    status: async () => ({ data: {} }),
    promptAsync: async ({ body }) => {
      sends++;
      assert.equal(body.agent, 'build'); assert.equal(body.model.modelID, 'fixture-model');
      messages.push({ info: { id: body.messageID, sessionID: 'conversation', role: 'user' }, parts: body.parts });
      await hooks['chat.message']({ sessionID: 'conversation', messageID: body.messageID }, { message: { id: body.messageID } });
      service.store.acknowledge(run.id);
      service.store.submit(run.id, { key: 'result', candidate: 'candidate', summary: 'Fixture answer' });
      messages.push({ info: { id: 'assistant', sessionID: 'conversation', role: 'assistant', parentID: body.messageID,
        finish: 'stop', time: { created: 124, completed: 125 } }, parts: [] });
      throw new Error('Response lost after provider accepted delivery');
    },
  } };
  const otherConfig = join(root, 'other-bridge.json');
  writeFileSync(otherConfig, JSON.stringify({ directory: '/other', conversationId: 'other', terminalId: 'other' }));
  const sameDirectory = join(root, 'same-directory.json');
  writeFileSync(sameDirectory, JSON.stringify({ directory: '/work', conversationId: 'other', terminalId: 'other' }));
  await assert.rejects(plugin({ client, directory: '/work' }, { configFiles: [configured.bridgeConfigFile, configured.bridgeConfigFile] }), /No unique bridge/);
  hooks = await plugin({ client, directory: '/work' }, { configFiles: [otherConfig, sameDirectory, configured.bridgeConfigFile] });
  await hooks.config();
  const until = async predicate => { for (let i = 0; i < 160; i++) { if (predicate()) return; await delay(50); } assert.fail('Bridge did not settle'); };
  await until(() => service.store.operation(`opencode-bridge:${configured.bindingId}`).ready);
  assert.equal(historyReads, 0, 'No task: readiness must not load conversation history');
  const firstSeen = service.store.operation(`opencode-bridge:${configured.bindingId}`).lastSeen;
  await until(() => service.store.operation(`opencode-bridge:${configured.bindingId}`).lastSeen !== firstSeen);
  assert.equal(historyReads, 0, 'Repeated idle polls must not load history');
  assert.ok(Date.parse(service.store.operation(`opencode-bridge:${configured.bindingId}`).lastSeen) - Date.parse(firstSeen) >= 2900,
    'Idle heartbeat must not spin at the active-work cadence');
  await armBridge(service.store, join(root, 'relay'), api, { bindingId: configured.bindingId });
  run = service.store.dispatch({ bindingId: configured.bindingId, bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  await call({ socketPath: service.socketPath, token: service.token }, 'POST', `/runs/${run.id}/attach`, { token: 'fixture-backend', runId: 'backend' });
  await until(() => service.store.run(run.id).nativeState === 'settled');
  assert.equal(sends, 1);
  assert.equal(service.store.run(run.id).settlement.outcome, 'completed');
  assert.equal(service.store.run(run.id).native.messageId, 'assistant');
});

test('configDirectory discovers enrolments after startup, follows the exact live chat and stops polling on disposal', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-discovery-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const directory = join(root, 'relay');
  const configDirectory = join(directory, 'bridges'); mkdirSync(configDirectory, { recursive: true });
  const inventoryFile = join(root, 'herdr.json');
  const countFile = join(root, 'calls'); writeFileSync(countFile, '');
  const pane = { agent: 'opencode', agent_session: { value: 'first', kind: 'id' },
    terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  writeFileSync(inventoryFile, JSON.stringify({ result: { agents: [pane] } }));
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(countFile)}, 'call\\n');\nconsole.log(fs.readFileSync(${JSON.stringify(inventoryFile)}, 'utf8'));\n`, { mode: 0o700 });
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  let hooks, service;
  t.after(async () => {
    await hooks?.dispose(); await service?.close();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  service = await startService({ directory, paperclipUrl: 'http://127.0.0.1:3100' });
  const sdkCalls = [], prompts = [];
  const client = { session: {
    get: async ({ path, query }) => {
      sdkCalls.push({ method: 'get', id: path.id, directory: query.directory });
      return { data: { id: path.id, directory: '/work', time: { created: path.id === 'first' ? 123 : 456 } } };
    },
    status: async () => { sdkCalls.push({ method: 'status' }); return { data: {} }; },
    messages: async ({ path }) => { sdkCalls.push({ method: 'messages', id: path.id }); return { data: [] }; },
    promptAsync: async request => { prompts.push(request); },
  } };
  hooks = await plugin({ client, directory: '/work' }, { configDirectory });
  const tools = hooks.tool;
  assert.deepEqual(Object.keys(tools).sort(), ['relay_agents', 'relay_answer', 'relay_coordinator_grant', 'relay_coordinator_revoke', 'relay_delegate', 'relay_delegations', 'relay_enrol_agent', 'relay_enrolment_candidates', 'relay_questions', 'relay_review', 'relay_reviews',
    'relay_schedule_cancel', 'relay_schedule_create', 'relay_schedule_edit', 'relay_schedule_inspect', 'relay_schedule_pause', 'relay_schedule_preview', 'relay_schedule_resume', 'relay_schedule_run', 'relay_schedules',
    'relay_task_activity', 'relay_task_assign', 'relay_task_cancel', 'relay_task_children', 'relay_task_comment', 'relay_task_comments', 'relay_task_complete', 'relay_task_create', 'relay_task_edit', 'relay_task_inspect', 'relay_task_list', 'relay_task_recover', 'relay_task_reference_attach', 'relay_task_reference_lookup', 'relay_task_reopen',
    'relay_tasks', 'relay_worker_prepare', 'relay_workers']);
  await hooks.config();
  for (const tool of Object.values(tools)) assert.equal(typeof tool.execute, 'function');
  let initialSettled = false;
  const initialRead = assert.rejects(tools.relay_questions.execute({}, { sessionID: 'first' }),
    { code: 'bridge_unavailable', status: 409 }).finally(() => { initialSettled = true; });
  await delay(200);
  assert.equal(initialSettled, false, 'The first tool call must wait for credentials rather than refuse immediately');
  assert.equal(readFileSync(countFile, 'utf8'), 'call\n', 'Empty-directory discovery has completed before enrolment');
  assert.deepEqual(sdkCalls, [], 'An empty directory must not inspect a native session');

  const configured = [];
  for (const conversationId of ['first', 'second']) {
    const observedId = `herdr-agent:${conversationId}`;
    service.store.saveOperation({ id: observedId, runId: '', marker: conversationId, agentId: conversationId, availability: 'present',
      identity: { harness: 'opencode', sessionKind: 'id', conversationId, machineId: 'machine', session: 'default', companyId: 'company' },
      placement: { directory: '/work', terminalId: 'terminal' }, observation: { display: { name: conversationId } } });
    const api = async () => ({ id: conversationId, companyId: 'company', adapterType: 'herdr_relay',
      adapterConfig: { observationOnly: true, relayObservationMarker: conversationId } });
    const config = await configureBridge(service.store, directory, api, { observedId, reserved: true });
    configured.push(config);
    // Each chat also has a historical config for another terminal in the same directory.
    writeFileSync(join(configDirectory, `historical-${conversationId}.json`), JSON.stringify({
      ...JSON.parse(readFileSync(config.bridgeConfigFile, 'utf8')), terminalId: 'old-terminal',
    }));
  }
  const bridge = index => service.store.operation(`opencode-bridge:${configured[index].bindingId}`);
  await initialRead;
  const until = async (predicate, message) => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(50); }
    assert.fail(message);
  };
  await until(() => bridge(0).ready, 'Config added after startup was not discovered');
  assert.equal(bridge(0).sessionCreatedAt, 123);
  assert.equal(bridge(1).lastSeen, undefined, 'The other chat must not report readiness on the same terminal');
  assert.deepEqual(sdkCalls.filter(call => call.method === 'get'), Array(2).fill({ method: 'get', id: 'first', directory: '/work' }));
  assert.deepEqual(prompts, []);

  pane.agent_session.value = 'second';
  writeFileSync(inventoryFile, JSON.stringify({ result: { agents: [pane] } }));
  // Neither plugin() nor config() is called again when the native chat changes.
  await until(() => bridge(1).ready, 'Fresh chat did not select its config without a plugin restart');
  assert.equal(bridge(1).sessionCreatedAt, 456);
  assert.deepEqual(sdkCalls.filter(call => call.method === 'get').at(-1), { method: 'get', id: 'second', directory: '/work' });
  assert.equal(hooks.tool, tools, 'Tools remain registered across enrolment and chat changes');
  const firstSeen = bridge(0).lastSeen;
  const secondSeen = bridge(1).lastSeen;
  const switchedAt = sdkCalls.length;
  await until(() => bridge(1).lastSeen !== secondSeen, 'The newly selected chat did not continue polling');
  assert.equal(bridge(0).lastSeen, firstSeen, 'The old chat must stop reporting readiness');
  assert.deepEqual(sdkCalls.slice(switchedAt).filter(call => call.method === 'get'), [{ method: 'get', id: 'second', directory: '/work' }]);
  assert.equal(sdkCalls.some(call => call.method === 'messages'), false, 'Idle discovery must not load conversation history');

  await hooks.dispose();
  const stoppedCalls = readFileSync(countFile, 'utf8');
  const stoppedSdkCalls = structuredClone(sdkCalls);
  const stoppedSeen = configured.map((_, index) => bridge(index).lastSeen);
  await delay(5500);
  assert.equal(readFileSync(countFile, 'utf8'), stoppedCalls, 'Disposal stops both discovery and native placement polling');
  assert.deepEqual(sdkCalls, stoppedSdkCalls, 'Disposal stops SDK polling');
  assert.deepEqual(configured.map((_, index) => bridge(index).lastSeen), stoppedSeen, 'Disposal stops Relay heartbeats');
  assert.deepEqual(prompts, [], 'Enrolment and switching idle chats must not send prompts');
});

test('configDirectory preserves an in-flight invocation and its epoch through a missing Herdr inventory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-inventory-gap-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const directory = join(root, 'relay');
  const inventoryFile = join(root, 'herdr.json');
  const pane = { agent: 'opencode', agent_session: { value: 'conversation', kind: 'id' },
    terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  writeFileSync(inventoryFile, JSON.stringify({ result: { agents: [pane] } }));
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconsole.log(require('node:fs').readFileSync(${JSON.stringify(inventoryFile)}, 'utf8'));\n`, { mode: 0o700 });
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  let hooks, service, run, busy = false, sdkCalls = 0;
  t.after(async () => {
    await hooks?.dispose(); await service?.close();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  service = await startService({ directory, paperclipUrl: 'http://127.0.0.1:3100' });
  service.store.saveOperation({ id: 'herdr-agent:test', runId: '', marker: 'marker', agentId: 'agent', availability: 'present',
    identity: { harness: 'opencode', sessionKind: 'id', conversationId: 'conversation', machineId: 'machine', session: 'default', companyId: 'company' },
    placement: { directory: '/work', terminalId: 'terminal' }, observation: { display: { name: 'worker' } } });
  const backend = { id: 'agent', companyId: 'company', adapterType: 'herdr_relay', adapterConfig: { observationOnly: true, relayObservationMarker: 'marker' } };
  const api = async (method, path, body) => { if (method === 'PATCH') Object.assign(backend, body); return structuredClone(backend); };
  const configured = await configureBridge(service.store, directory, api, { observedId: 'herdr-agent:test', reserved: true });
  const bridge = () => service.store.operation(`opencode-bridge:${configured.bindingId}`);
  const messages = [], prompts = [];
  const client = { session: {
    get: async () => { sdkCalls++; return { data: { id: 'conversation', directory: '/work', time: { created: 123 },
      agent: 'build', model: { providerID: 'litellm', id: 'fixture-model' } } }; },
    messages: async () => { sdkCalls++; return { data: structuredClone(messages) }; },
    status: async () => { sdkCalls++; return { data: busy ? { conversation: { type: 'busy' } } : {} }; },
    promptAsync: async ({ body }) => {
      prompts.push(body);
      busy = true;
      messages.push({ info: { id: body.messageID, sessionID: 'conversation', role: 'user' }, parts: body.parts });
      await hooks['chat.message']({ sessionID: 'conversation', messageID: body.messageID }, { message: { id: body.messageID } });
      service.store.acknowledge(run.id);
    },
  } };
  const until = async (predicate, message) => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(50); }
    assert.fail(message);
  };
  hooks = await plugin({ client, directory: '/work' }, { configDirectory: join(directory, 'bridges') });
  await hooks.config();
  await until(() => bridge().ready, 'Dynamic bridge did not report readiness');
  const epoch = bridge().epoch;
  assert.ok(epoch);
  await armBridge(service.store, directory, api, { bindingId: configured.bindingId });
  run = service.store.dispatch({ bindingId: configured.bindingId, bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  await call({ socketPath: service.socketPath, token: service.token }, 'POST', `/runs/${run.id}/attach`, { token: 'fixture-backend', runId: 'backend' });
  await until(() => service.store.run(run.id).native?.state === 'observed', 'Invocation was not delivered and observed');
  const invocation = service.store.run(run.id).invocation;
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].messageID, invocation.messageId);
  assert.equal(service.store.run(run.id).nativeState, 'claimed');

  writeFileSync(inventoryFile, JSON.stringify({ result: { agents: [] } }));
  const callsBeforeGap = sdkCalls, seenBeforeGap = bridge().lastSeen;
  // Cover the five-second discovery cycle as well as the active invocation's retry.
  await delay(5500);
  await assert.rejects(hooks.tool.relay_questions.execute({}, { sessionID: 'conversation' }), /Bridge placement changed/);
  assert.equal(sdkCalls, callsBeforeGap, 'Missing placement must block native snapshots');
  assert.equal(bridge().lastSeen, seenBeforeGap, 'Missing placement must block Relay heartbeats');
  assert.equal(bridge().epoch, epoch);
  assert.deepEqual(service.store.run(run.id).invocation, invocation);
  assert.equal(service.store.run(run.id).nativeState, 'claimed', 'Inventory loss must not settle pending work');
  assert.equal(prompts.length, 1, 'Inventory loss must not resend the prompt');

  service.store.submit(run.id, { key: 'result', candidate: 'candidate', summary: 'Fixture answer' });
  messages.push({ info: { id: 'assistant', sessionID: 'conversation', role: 'assistant', parentID: invocation.messageId,
    finish: 'stop', time: { created: 124, completed: 125 } }, parts: [] });
  busy = false;
  service.store.saveOperation(service.store.operation('herdr-agent:test'));
  writeFileSync(inventoryFile, JSON.stringify({ result: { agents: [pane] } }));
  await until(() => service.store.run(run.id).nativeState === 'settled', 'Restored placement did not settle the original invocation');
  const settledSeen = bridge().lastSeen;
  await until(() => bridge().lastSeen !== settledSeen, 'Bridge did not continue polling after settlement');
  assert.equal(bridge().epoch, epoch, 'Restoring the same placement must retain the plugin epoch');
  assert.deepEqual(service.store.run(run.id).invocation, invocation);
  assert.equal(service.store.run(run.id).settlement.outcome, 'completed');
  assert.equal(service.store.run(run.id).native.messageId, 'assistant');
  assert.equal(prompts.length, 1, 'Restoration and later polls must not duplicate delivery');
  const events = service.store.db.prepare('SELECT kind FROM events WHERE run_id = ?').all(run.id);
  assert.equal(events.filter(event => event.kind === 'native.delivery_intent').length, 1);
  assert.equal(events.filter(event => event.kind === 'native.settled').length, 1, 'The original invocation settles exactly once');
});

test('stale placement backs off discovery and disposal prevents further retries', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-backoff-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const countFile = join(root, 'calls');
  const configFile = join(root, 'config.json');
  writeFileSync(configFile, JSON.stringify({ directory: '/work', conversationId: 'original', terminalId: 'original' }));
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(countFile)}, 'call\\n');\nconsole.log('{"result":{"agents":[]}}');\n`, { mode: 0o700 });
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  let hooks;
  t.after(async () => {
    await hooks?.dispose();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  let sdkCalls = 0;
  const unexpected = async () => { sdkCalls++; throw new Error('Must not inspect a replaced conversation'); };
  hooks = await plugin({ directory: '/work', client: { session: { get: unexpected, messages: unexpected, status: unexpected } } }, { configFile });
  await hooks.config();
  const calls = () => readFileSync(countFile, 'utf8').trim().split('\n').length;
  for (let i = 0; i < 100 && calls() < 2; i++) await delay(20);
  assert.equal(calls(), 2, 'One startup discovery and one initial tick');
  await delay(1200);
  assert.equal(calls(), 2, 'First failure waits two seconds before retry');
  for (let i = 0; i < 100 && calls() < 3; i++) await delay(20);
  assert.equal(calls(), 3);
  await delay(1200);
  assert.equal(calls(), 3, 'Second failure waits four seconds before retry');
  assert.equal(sdkCalls, 0);
  await hooks.dispose();
  const stoppedAt = calls();
  await delay(3200);
  assert.equal(calls(), stoppedAt, 'No background retry after dispose');
});

for (const loseAcceptanceResponse of [false, true]) {
test(`discovery delegates native requests, announces UI-only results and accepts exact reviews from the origin chat (lost acceptance response: ${loseAcceptanceResponse})`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-delegation-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const directory = join(root, 'relay');
  const pane = { agent: 'opencode', agent_session: { value: 'conversation', kind: 'id' },
    terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ result: { agents: [pane] } }))});\n`, { mode: 0o700 });
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  const requests = [];
  let reviewItem, reviewIssue;
  const backend = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/companies/company') res.end(JSON.stringify({ id: 'company' }));
    else if (req.method === 'GET' && req.url === '/api/agents/worker') res.end(JSON.stringify({ id: 'worker', companyId: 'company' }));
    else if (req.method === 'POST' && req.url === '/api/companies/company/issues') {
      res.end(JSON.stringify({ ...body, id: 'task', identifier: 'TEST-1', companyId: 'company' }));
    } else if (req.method === 'GET' && req.url === '/api/issues/task') {
      res.end(JSON.stringify(reviewIssue));
    } else if (req.method === 'GET' && req.url === '/api/issues/task/interactions') {
      res.end(JSON.stringify([reviewItem]));
    } else if (req.method === 'POST' && req.url === '/api/issues/task/interactions/review/accept') {
      reviewItem.status = 'accepted';
      reviewItem.result = { version: 1, outcome: 'accepted' };
      reviewItem.resolvedByUserId = 'local-user';
      reviewItem.resolvedByAgentId = null;
      reviewItem.resolvedByRunId = null;
      if (loseAcceptanceResponse) {
        reviewIssue.status = 'done';
        // Delay complete readback evidence until the exact-source retry below.
        // Otherwise the lifecycle reconciler can independently record acceptance.
        reviewItem.resolvedByUserId = null;
        res.statusCode = 502;
        res.end(JSON.stringify({ message: 'Response lost after backend accepted the review' }));
      } else res.end(JSON.stringify(reviewItem));
    } else if (req.method === 'GET' && req.url === '/api/heartbeat-runs/backend-worker-review') {
      res.end(JSON.stringify({ id: 'backend-worker-review', companyId: 'company', agentId: 'worker', status: 'succeeded' }));
    } else if (req.method === 'PATCH' && req.url === '/api/issues/task') {
      Object.assign(reviewIssue, body);
      res.end(JSON.stringify(reviewIssue));
    } else { res.statusCode = 404; res.end(JSON.stringify({ message: 'Unexpected backend request' })); }
  });
  let hooks, service;
  t.after(async () => {
    await hooks?.dispose(); await service?.close(); await new Promise(resolve => backend.close(resolve));
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const auth = join(root, 'backend.json'); writeFileSync(auth, '{"localTrusted":true}', { mode: 0o600 });
  service = await startService({ directory, paperclipUrl: `http://127.0.0.1:${backend.address().port}`, backendContextFile: auth });
  const store = service.store, configured = {};
  for (const [agentId, conversationId, terminalId, workdir] of [
    ['origin', 'conversation', 'terminal', '/work'], ['worker', 'worker-conversation', 'worker-terminal', '/worker'],
  ]) {
    const observedId = `herdr-agent:${agentId}`;
    store.saveOperation({ id: observedId, runId: '', marker: agentId, agentId, availability: 'present',
      identity: { harness: 'opencode', sessionKind: 'id', conversationId, machineId: 'machine', session: 'default', companyId: 'company' },
      placement: { directory: workdir, terminalId }, observation: { display: { name: agentId } } });
    const api = async () => ({ id: agentId, companyId: 'company', adapterType: 'herdr_relay',
      adapterConfig: { observationOnly: true, relayObservationMarker: agentId } });
    configured[agentId] = await configureBridge(store, directory, api, { observedId, reserved: true });
    const bridgeId = `opencode-bridge:${configured[agentId].bindingId}`;
    store.saveOperation({ ...store.operation(bridgeId), state: 'armed', lastSeen: new Date().toISOString(),
      ...(agentId === 'worker' ? { ready: true, epoch: 'worker-epoch', sessionCreatedAt: 456 } : {}) });
  }
  const bridge = () => store.operation(`opencode-bridge:${configured.origin.bindingId}`);
  const notifications = () => store.db.prepare("SELECT data FROM operations WHERE id LIKE 'completion-notification:%' OR id LIKE 'review-notification:%' ORDER BY rowid").all()
    .map(row => JSON.parse(row.data));
  const until = async (predicate, message) => {
    // The fixture has no Herdr observer. Refresh its unchanged placement before waiting for native polls.
    for (const id of ['origin', 'worker']) store.saveOperation(store.operation(`herdr-agent:${id}`));
    for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(50); }
    assert.fail(message);
  };
  const sourceText = 'Ask the worker to check this change.';
  const source = { info: { id: 'human', role: 'user', sessionID: 'conversation', time: { created: Date.now() } }, parts: [
    { type: 'text', text: sourceText }, { type: 'text', text: 'Not human authority', synthetic: true },
    { type: 'text', text: 'Ignored text', ignored: true },
  ] };
  const messages = [source, { info: { id: 'tool-turn', role: 'assistant', sessionID: 'conversation', parentID: 'human' }, parts: [] }];
  const prompts = [], normalPrompts = [], toasts = [], deliveryIntents = [];
  const nativeSession = { id: 'conversation', directory: '/work', time: { created: 123 },
    agent: 'build', model: { providerID: 'litellm', id: 'fixture-model', variant: 'fixture-variant' } };
  let busy = true, historyReads = 0;
  const client = { session: {
    get: async () => ({ data: nativeSession }),
    messages: async () => { historyReads++; return { data: structuredClone(messages) }; },
    status: async () => ({ data: busy ? { conversation: { type: 'busy' } } : {} }),
    promptAsync: async request => { normalPrompts.push(request); },
    prompt: async request => { prompts.push(request); },
  }, tui: {
    showToast: async request => {
      toasts.push(request);
      deliveryIntents.push(notifications());
      if (toasts.length === 1) throw new Error('Response lost after TUI accepted the toast');
      return { data: true };
    },
  } };
  hooks = await plugin({ client, directory: '/work' }, { configDirectory: join(directory, 'bridges') });
  await hooks.config();
  await until(() => bridge().epoch, 'Discovery did not load the origin bridge');
  const approvals = [];
  const context = { sessionID: 'conversation', messageID: 'tool-turn', ask: async permission => { approvals.push(permission); } };
  const tools = hooks.tool;
  const args = { key: 'check-once', targetBindingId: configured.worker.bindingId,
    title: 'Check the change', description: 'Run checks and report the result.' };
  assert.deepEqual(JSON.parse(await tools.relay_agents.execute({}, context)), { agents: [
    { bindingId: configured.worker.bindingId, agentId: 'worker', label: 'worker', directory: '/worker' },
  ] });
  assert.deepEqual(JSON.parse(await tools.relay_delegations.execute({}, context)), { delegations: [], notifications: [] });
  await assert.rejects(tools.relay_delegate.execute(args, { ...context, messageID: 'missing' }), /user message could not be verified/);
  messages[1].info.parentID = 'old-human';
  await assert.rejects(tools.relay_delegate.execute(args, context), /user message could not be verified/);
  messages[1].info.parentID = 'human';
  for (const flag of ['synthetic', 'ignored']) {
    source.parts[0][flag] = true;
    await assert.rejects(tools.relay_delegate.execute(args, context), /user message could not be verified/);
    delete source.parts[0][flag];
  }
  assert.deepEqual(approvals, [], 'Unverified source text must not reach the permission prompt');
  await assert.rejects(tools.relay_delegate.execute(args, { ...context, ask: async () => { throw new Error('Permission denied'); } }), /Permission denied/);
  for (const change of ['text', 'id']) {
    await assert.rejects(tools.relay_delegate.execute(args, { ...context, ask: async () => {
      if (change === 'text') source.parts[0].text = 'Changed request';
      else source.info.id = 'new-human';
    } }), /User message changed; no delegation sent/);
    source.parts[0].text = sourceText; source.info.id = 'human';
  }
  assert.deepEqual(requests, [], 'Denied, stale or synthetic source requests must not reach the backend');

  const delegated = JSON.parse(await tools.relay_delegate.execute(args, context));
  assert.deepEqual(approvals, [{ permission: 'relay_delegate', patterns: [args.targetBindingId], always: [],
    metadata: { ...args, sourceMessageId: 'human', sourceText } }]);
  assert.equal(delegated.state, 'recorded');
  assert.deepEqual(delegated.receipt, { id: 'task', identifier: 'TEST-1', title: args.title,
    status: 'todo', companyId: 'company', assigneeAgentId: 'worker' });
  const operation = store.operation(delegated.id);
  assert.deepEqual(operation.request.origin, { bindingId: configured.origin.bindingId, conversationId: 'conversation',
    sessionCreatedAt: 123, sourceMessageId: 'human', sourceDigest: digest(sourceText) });
  assert.equal(operation.request.relayReviewPolicy, 'none');
  assert.deepEqual(requests, [
    { method: 'GET', path: '/api/companies/company', body: undefined },
    { method: 'GET', path: '/api/agents/worker', body: undefined },
    { method: 'POST', path: '/api/companies/company/issues', body: operation.request.body },
  ]);
  assert.equal(operation.request.body.origin, undefined, 'Origin is retained by Relay, not sent to the backend');
  assert.deepEqual(JSON.parse(await tools.relay_delegate.execute(args, context)), delegated);
  assert.equal(requests.length, 3, 'Retrying the same source and key must not create another task');
  assert.deepEqual(JSON.parse(await tools.relay_delegations.execute({}, context)), { delegations: [delegated], notifications: [] });
  const historyBeforeNotifications = structuredClone(messages);
  const sessionBeforeNotifications = structuredClone(nativeSession);
  const readsBeforeNotifications = historyReads;

  // Seed the completed worker result and exact backend completion receipt, not a notification.
  const binding = store.binding(configured.worker.bindingId);
  const run = store.dispatch({ bindingId: binding.id, bindingRevision: binding.revision, companyId: 'company',
    agentId: 'worker', taskId: 'task', runId: 'backend-worker' });
  store.acknowledge(run.id);
  store.submit(run.id, { key: 'result', candidate: 'revision', summary: 'Checks passed' });
  store.publication(run.id, { state: 'recorded' });
  store.settle(run.id, { outcome: 'completed', evidence: 'Fixture worker finished' });
  store.saveOperation({ id: `completion:${run.id}`, runId: run.id, state: 'recorded', status: 'done', candidate: 'revision' });
  await until(() => notifications().length === 1, 'Service lifecycle did not create a completion notification');
  const notification = notifications()[0];
  assert.equal(notification.state, 'pending');
  assert.deepEqual(notification.origin, { bindingId: configured.origin.bindingId, conversationId: 'conversation', sessionCreatedAt: 123 });
  const nextRun = store.dispatch({ ...run.request, runId: 'backend-worker-next' });
  store.acknowledge(nextRun.id);
  store.submit(nextRun.id, { key: 'next-result', candidate: 'next-revision', summary: 'Follow-up checks passed' });
  store.publication(nextRun.id, { state: 'recorded' });
  store.settle(nextRun.id, { outcome: 'completed', evidence: 'Fixture follow-up finished' });
  store.saveOperation({ id: `completion:${nextRun.id}`, runId: nextRun.id, state: 'recorded', status: 'done', candidate: 'next-revision' });
  await until(() => notifications().length === 2, 'Service lifecycle did not create the next completion notification');
  const nextNotification = notifications()[1];
  for (let i = 0; i < 2; i++) {
    const seen = bridge().lastSeen;
    await until(() => bridge().lastSeen !== seen, 'Busy origin stopped polling');
    assert.deepEqual(notifications().map(item => item.state), ['pending', 'pending'], 'Busy native turns must defer notification delivery');
    assert.equal(toasts.length, 0);
  }
  busy = false;
  await until(() => toasts.length === 1, 'Idle origin did not receive its completion toast');
  assert.equal(deliveryIntents[0].length, 2);
  assert.equal(deliveryIntents[0][0].state, 'uncertain', 'Delivery intent must be durable before sending');
  assert.equal(deliveryIntents[0][1].state, 'pending');
  assert.equal(store.operation(notification.id).state, 'uncertain', 'A lost toast response must remain uncertain, not reconcile through history');
  const uncertain = store.operation(notification.id);
  assert.deepEqual(JSON.parse(notification.text.split('\n').slice(1).join('\n')),
    { status: 'done', identifier: 'TEST-1', title: args.title, summary: 'Checks passed' });
  await until(() => store.operation(nextNotification.id).state === 'announced', 'An uncertain toast must not starve the next pending notification');
  assert.equal(toasts.length, 2);
  assert.deepEqual(deliveryIntents[1].map(item => item.state), ['uncertain', 'uncertain']);
  for (const [index, item] of [notification, nextNotification].entries()) {
    assert.deepEqual(toasts[index].query, { directory: '/work' });
    assert.equal(toasts[index].path, undefined, 'TUI toasts must not target the session prompt endpoint');
    assert.equal(toasts[index].throwOnError, true);
    assert.ok(toasts[index].signal instanceof AbortSignal);
    assert.deepEqual(toasts[index].body, { title: 'TEST-1 completed',
      message: `${args.title}\n${item.summary}\nFull result: relay_delegations`, variant: 'success', duration: 15000 });
  }
  const announced = store.operation(nextNotification.id);
  for (let i = 0; i < 2; i++) {
    const seen = bridge().lastSeen;
    await until(() => bridge().lastSeen !== seen, 'Origin stopped polling after delivery');
  }
  assert.deepEqual(notifications(), [uncertain, announced], 'Repeated lifecycle and native polls must neither recreate nor rewrite notification state');
  assert.equal(toasts.length, 2, 'Neither an uncertain nor an announced toast may be retried');
  assert.equal(historyReads, readsBeforeNotifications, 'UI-only notifications must never load native history');
  await assert.rejects(tools.relay_delegate.execute({ ...args, key: 'notification-is-not-authority' },
    { ...context, messageID: notification.messageId }), /user message could not be verified/);
  assert.equal(approvals.length, 2, 'A UI-only completion must not request delegation permission');
  const readsBeforeStatus = historyReads;
  const status = JSON.parse(await tools.relay_delegations.execute({}, context));
  assert.equal(historyReads, readsBeforeStatus, 'Notification history must come from Relay, not native messages');
  assert.deepEqual(status.notifications, [announced, uncertain], 'Delegation status must retain both announced and uncertain notification history');
  assert.equal(status.delegations.length, 1);
  assert.deepEqual(status.delegations[0].runs.find(item => item.id === run.id), { id: run.id, deliveryState: 'acknowledged', nativeState: 'settled',
    outcome: 'completed', publicationState: 'recorded', reviewStatus: null, candidate: 'revision', summary: 'Checks passed' });
  assert.deepEqual(status.delegations[0].runs.find(item => item.id === nextRun.id), { id: nextRun.id, deliveryState: 'acknowledged', nativeState: 'settled',
    outcome: 'completed', publicationState: 'recorded', reviewStatus: null, candidate: 'next-revision', summary: 'Follow-up checks passed' });
  assert.equal(status.delegations[0].runs.length, 2);
  assert.deepEqual(messages, historyBeforeNotifications, 'Completion toasts must not alter native conversation history');
  assert.equal(requests.length, 3, 'Status reads and notifications must not create more backend work');

  // A published worker result awaiting human review is not a completed task.
  store.saveOperation({ ...store.operation(`opencode-bridge:${configured.worker.bindingId}`), lastSeen: new Date().toISOString() });
  const reviewRun = store.dispatch({ ...run.request, runId: 'backend-worker-review' });
  store.acknowledge(reviewRun.id);
  store.submit(reviewRun.id, { key: 'review-result', candidate: 'review-revision', summary: 'Ready for human review' });
  store.publication(reviewRun.id, { state: 'recorded' });
  store.settle(reviewRun.id, { outcome: 'completed', evidence: 'Fixture review candidate finished' });
  store.recordReview(reviewRun.id, { interactionId: 'review', status: 'pending', candidate: 'review-revision' });
  reviewIssue = { ...delegated.receipt, status: 'in_review' };
  reviewItem = { id: 'review', kind: 'request_confirmation', resolverPolicy: 'human_only', status: 'pending', createdAt: new Date().toISOString(),
    idempotencyKey: `relay-review:${reviewRun.id}:${digest(store.run(reviewRun.id).result)}`,
    payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'review-revision', label: reviewRun.id } } };
  store.saveOperation({ id: `review-disposition:${reviewRun.id}`, runId: reviewRun.id, state: 'waiting',
    candidate: 'review-revision', interactionId: 'review' });
  const reviewNotifications = () => notifications().filter(item => item.runId === reviewRun.id);
  const reviewWrites = () => requests.slice(3).filter(item => item.method !== 'GET');
  const readsBeforeReviewToast = historyReads;
  await until(() => reviewNotifications()[0]?.state === 'announced', 'Origin did not receive its review-ready toast');
  const reviewNotification = reviewNotifications()[0];
  assert.equal(reviewNotification.kind, 'review');
  assert.equal(reviewNotification.candidate, 'review-revision');
  assert.equal(reviewNotification.interactionId, 'review');
  assert.deepEqual(reviewNotification.origin, notification.origin);
  assert.equal(toasts.length, 3);
  assert.deepEqual(toasts[2].query, { directory: '/work' });
  assert.equal(toasts[2].path, undefined);
  assert.deepEqual(toasts[2].body, { title: 'TEST-1 awaiting your review',
    message: `${args.title}\nReady for human review\nReview here: relay_reviews`, variant: 'info', duration: 15000 });
  assert.equal(deliveryIntents[2].find(item => item.id === reviewNotification.id).state, 'uncertain');
  assert.equal(historyReads, readsBeforeReviewToast, 'Review toasts must not load native history');
  assert.deepEqual(messages, historyBeforeNotifications, 'Review toasts must not append native messages');
  assert.equal(approvals.length, 2, 'Review-ready notification must not request permission or accept the candidate');
  assert.deepEqual(reviewNotifications(), [reviewNotification], 'No completion notification before acceptance');
  assert.equal(store.operation(`completion:${reviewRun.id}`), null);
  assert.equal(reviewIssue.status, 'in_review');
  assert.deepEqual(reviewWrites(), []);

  const selected = { scope: 'delegated', runId: reviewRun.id, taskId: 'task', identifier: 'TEST-1', title: args.title,
    interactionId: 'review', candidate: 'review-revision', summary: 'Ready for human review' };
  assert.deepEqual(JSON.parse(await tools.relay_reviews.execute({}, context)), { reviews: [selected] });
  const reviewSource = { info: { id: 'review-human', role: 'user', sessionID: 'conversation', time: { created: Date.now() } },
    parts: [{ type: 'text', text: 'Accept this result please' }] };
  assert.ok(reviewSource.info.time.created > Date.parse(reviewItem.createdAt));
  assert.ok(reviewSource.info.time.created <= Date.now());
  messages.push(reviewSource, { info: { id: 'review-turn', role: 'assistant', sessionID: 'conversation', parentID: 'review-human' }, parts: [] });
  const reviewContext = { ...context, messageID: 'review-turn' };
  await assert.rejects(tools.relay_review.execute({ decision: 'accept' }, { ...reviewContext,
    ask: async () => { throw new Error('Permission denied'); } }), /Permission denied/);
  for (const change of ['text', 'id']) {
    await assert.rejects(tools.relay_review.execute({ decision: 'accept' }, { ...reviewContext, ask: async () => {
      if (change === 'text') reviewSource.parts[0].text = 'Do not accept this result';
      else reviewSource.info.id = 'changed-human';
    } }), /user message changed; nothing was sent/);
    reviewSource.parts[0].text = 'Accept this result please'; reviewSource.info.id = 'review-human';
  }

  // Reusing the interaction ID must not authorise a candidate replaced during permission.
  const originalRun = store.run(reviewRun.id), originalReview = structuredClone(reviewItem);
  try {
    await assert.rejects(tools.relay_review.execute({ decision: 'accept' }, { ...reviewContext, ask: async permission => {
      assert.equal(permission.metadata.candidate, 'review-revision');
      const result = { ...originalRun.result, candidate: 'replacement-revision' };
      store.save({ ...originalRun, result, review: { ...originalRun.review, candidate: result.candidate } }, 'fixture.candidate_replaced');
      reviewItem.idempotencyKey = `relay-review:${reviewRun.id}:${digest(result)}`;
      reviewItem.payload.target.revisionId = result.candidate;
    } }), { code: 'stale_candidate' });
  } finally {
    store.save(originalRun, 'fixture.candidate_restored'); reviewItem = originalReview;
  }
  assert.deepEqual(reviewWrites(), [], 'Denied permission, changed source and changed candidate must never post acceptance');
  assert.equal(store.operation(`harness-review:${digest(['company', 'review'])}`), null);
  assert.equal(store.operation(`completion:${reviewRun.id}`), null);
  assert.deepEqual(reviewNotifications(), [reviewNotification]);

  const historyBeforeAcceptance = structuredClone(messages);
  const decision = { interactionId: 'review', candidate: 'review-revision', decision: 'accept',
    sourceMessageId: 'review-human', sourceDigest: digest('Accept this result please'), state: 'uncertain' };
  if (loseAcceptanceResponse) {
    await assert.rejects(tools.relay_review.execute({ decision: 'accept' }, reviewContext), { code: 'paperclip_error' });
    assert.equal(reviewItem.status, 'accepted');
    assert.equal(reviewIssue.status, 'done', 'The backend completes the issue before the lost response is retried');
    const intent = store.operation(`harness-review:${digest(['company', 'review'])}`);
    assert.equal(intent.state, 'uncertain');
    assert.equal(intent.receipt, undefined);
    assert.deepEqual(JSON.parse(await tools.relay_reviews.execute({}, reviewContext)), { reviews: [], decisions: [decision] });
    const approvalsBeforeRetry = approvals.length;
    for (const change of ['text', 'id', 'decision']) {
      try {
        if (change === 'text') reviewSource.parts[0].text = 'Accept the changed result please';
        if (change === 'id') {
          reviewSource.info.id = 'another-review-human';
          messages.at(-1).info.parentID = reviewSource.info.id;
        }
        await assert.rejects(tools.relay_review.execute({ decision: change === 'decision' ? 'reject' : 'accept' }, reviewContext),
          /No unique pending item/);
      } finally {
        reviewSource.parts[0].text = 'Accept this result please';
        reviewSource.info.id = 'review-human';
        messages.at(-1).info.parentID = 'review-human';
      }
      assert.deepEqual(store.operation(intent.id), intent, 'Changed source or decision cannot adopt the uncertain intent');
    }
    assert.equal(approvals.length, approvalsBeforeRetry, 'Nonmatching retries must fail before requesting permission');
    // An accepted status on a different candidate is not confirmation of this intent.
    try {
      reviewItem.payload.target.revisionId = 'different-revision';
      await assert.rejects(tools.relay_review.execute({ decision: 'accept' }, reviewContext), { code: 'review_not_found' });
      assert.deepEqual(store.operation(intent.id), intent, 'Reconciliation requires the exact backend candidate');
    } finally {
      reviewItem.payload.target.revisionId = 'review-revision';
    }
    assert.deepEqual(reviewWrites(), [{ method: 'POST', path: '/api/issues/task/interactions/review/accept', body: {} }]);
  }
  const receipt = JSON.parse(await tools.relay_review.execute({ decision: 'accept' }, { ...reviewContext, ask: async permission => {
    await reviewContext.ask(permission);
    if (loseAcceptanceResponse) reviewItem.resolvedByUserId = 'local-user';
  } }));
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.interactionId, 'review');
  assert.deepEqual(approvals.at(-1), { permission: 'relay_review', patterns: ['review'], always: [], metadata: {
    ...(loseAcceptanceResponse ? decision : selected), decision: 'accept', sourceMessageId: 'review-human', sourceText: 'Accept this result please',
  } });
  const accepted = store.operation(`harness-review:${digest(['company', 'review'])}`);
  assert.equal(accepted.state, 'recorded');
  assert.deepEqual(accepted.request, { bindingId: configured.origin.bindingId, conversationId: 'conversation',
    companyId: 'company', taskId: 'task', sessionCreatedAt: 123,
    interactionId: 'review', candidate: 'review-revision', sourceMessageId: 'review-human',
    sourceDigest: digest('Accept this result please'), decision: 'accept', reason: null });
  assert.deepEqual(accepted.receipt, receipt);
  assert.equal(store.run(reviewRun.id).review.status, 'accepted');
  assert.deepEqual(JSON.parse(await tools.relay_review.execute({ decision: 'accept' }, reviewContext)), receipt,
    'The same real human source may retry a recorded acceptance without another backend POST');
  await until(() => reviewNotifications().some(item => item.id.startsWith('completion-notification:') && item.state === 'announced'),
    'Accepted candidate did not complete and notify its origin chat');
  assert.equal(reviewIssue.status, 'done');
  assert.equal(store.operation(`completion:${reviewRun.id}`).state, 'recorded');
  assert.deepEqual(reviewWrites(), [
    { method: 'POST', path: '/api/issues/task/interactions/review/accept', body: {} },
    ...(loseAcceptanceResponse ? [] : [{ method: 'PATCH', path: '/api/issues/task', body: { status: 'done' } }]),
  ]);
  assert.equal(toasts.length, 4);
  assert.deepEqual(toasts[3].body, { title: 'TEST-1 completed',
    message: `${args.title}\nReady for human review\nFull result: relay_delegations`, variant: 'success', duration: 15000 });
  assert.deepEqual(JSON.parse(await tools.relay_reviews.execute({}, reviewContext)),
    { reviews: [], decisions: [{ ...decision, state: 'recorded', receipt }] });
  assert.equal(store.operation(delegated.id).request.relayReviewPolicy, 'none');
  await hooks.dispose();
  assert.deepEqual(prompts, [], 'Notifications and reviews must never call the native prompt endpoint, even with noReply');
  assert.deepEqual(normalPrompts, [], 'Notifications and reviews must never start a promptAsync model turn');
  assert.deepEqual(messages, historyBeforeAcceptance, 'Acceptance and completion must not alter native conversation history');
  assert.deepEqual(nativeSession, sessionBeforeNotifications, 'Notifications and reviews must not alter the native model, variant or agent');
});
}

test('worker tools validate native authority, remain read-only on inspection and refuse preparation without configured scope', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-workers-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const directory = join(root, 'relay');
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  const pane = { agent: 'opencode', agent_session: { value: 'conversation', kind: 'id' },
    terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ result: { agents: [pane] } }))});\n`, { mode: 0o700 });
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  const requests = [];
  const backend = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/companies/company') res.end(JSON.stringify({ id: 'company' }));
    else if (req.method === 'GET' && req.url === '/api/agents/worker') res.end(JSON.stringify({ id: 'worker', companyId: 'company' }));
    else if (req.method === 'GET' && req.url === '/api/issues/parent') res.end(JSON.stringify({ id: 'parent', companyId: 'company', status: 'in_progress' }));
    else if (req.method === 'POST' && req.url === '/api/companies/company/issues') res.end(JSON.stringify({ ...body, id: 'child', companyId: 'company' }));
    else { res.statusCode = 404; res.end(JSON.stringify({ message: 'Unexpected backend request' })); }
  });
  let service, hooks;
  t.after(async () => {
    await hooks?.dispose(); await service?.close(); await new Promise(resolve => backend.close(resolve));
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const auth = join(root, 'backend.json'); writeFileSync(auth, '{"localTrusted":true}', { mode: 0o600 });
  service = await startService({ directory, paperclipUrl: `http://127.0.0.1:${backend.address().port}`, backendContextFile: auth });
  const store = service.store, configured = {};
  for (const [agentId, conversationId, terminalId, workdir] of [
    ['origin', 'conversation', 'terminal', '/work'], ['worker', 'worker-conversation', 'worker-terminal', '/worker'],
  ]) {
    const observedId = `herdr-agent:${agentId}`;
    store.saveOperation({ id: observedId, runId: '', marker: agentId, agentId, availability: 'present',
      identity: { harness: 'opencode', sessionKind: 'id', conversationId, machineId: 'machine', session: 'default', companyId: 'company' },
      placement: { directory: workdir, terminalId }, observation: { display: { name: agentId } } });
    configured[agentId] = await configureBridge(store, directory, async () => ({ id: agentId, companyId: 'company', adapterType: 'herdr_relay',
      adapterConfig: { observationOnly: true, relayObservationMarker: agentId } }), { observedId, reserved: true });
    const id = `opencode-bridge:${configured[agentId].bindingId}`;
    store.saveOperation({ ...store.operation(id), state: 'armed', ready: true, lastSeen: new Date().toISOString(),
      ...(agentId === 'worker' ? { epoch: 'worker-epoch', sessionCreatedAt: 456 } : {}) });
  }
  const sourceText = 'Prepare an isolated worker, then delegate a child of my existing task.';
  const source = { info: { id: 'human', role: 'user', sessionID: 'conversation', time: { created: Date.now() } }, parts: [
    { type: 'text', text: sourceText }, { type: 'text', text: 'Not human authority', synthetic: true },
    { type: 'text', text: 'Ignored text', ignored: true },
  ] };
  const messages = [source, { info: { id: 'tool-turn', role: 'assistant', sessionID: 'conversation', parentID: 'human' }, parts: [] }];
  const prompts = [], approvals = [];
  let historyReads = 0;
  const client = { session: {
    get: async () => ({ data: { id: 'conversation', directory: '/work', time: { created: 123 } } }),
    messages: async () => { historyReads++; return { data: structuredClone(messages) }; },
    status: async () => ({ data: { conversation: { type: 'busy' } } }),
    prompt: async request => { prompts.push(request); },
    promptAsync: async request => { prompts.push(request); },
  } };
  hooks = await plugin({ client, directory: '/work' }, { configDirectory: join(directory, 'bridges') });
  await hooks.config();
  const context = { sessionID: 'conversation', messageID: 'tool-turn', ask: async permission => { approvals.push(permission); } };
  const args = { key: 'prepare-once', mode: 'create', repository: '/work', branch: 'worker/check', base: 'HEAD', label: 'Check', trustRepository: true };
  const tools = hooks.tool;
  const beforeRead = historyReads;
  await assert.rejects(tools.relay_workers.execute({}, { sessionID: 'conversation' }), { code: 'worker_repository_forbidden', status: 409 });
  assert.equal(historyReads, beforeRead, 'Worker inspection requires neither native message history nor a permission callback');
  assert.deepEqual(approvals, []);
  assert.deepEqual(requests, [], 'Startup and read-only inspection must not create backend work');
  const records = () => store.db.prepare("SELECT data FROM operations WHERE id LIKE 'herdr-worker:%'").all();
  assert.deepEqual(records(), [], 'Startup must not prepare workers');
  await assert.rejects(tools.relay_worker_prepare.execute(args, { ...context, messageID: 'missing' }), /user message could not be verified/);
  messages[1].info.parentID = 'old-human';
  await assert.rejects(tools.relay_worker_prepare.execute(args, context), /user message could not be verified/);
  messages[1].info.parentID = 'human';
  for (const flag of ['synthetic', 'ignored']) {
    source.parts[0][flag] = true;
    await assert.rejects(tools.relay_worker_prepare.execute(args, context), /user message could not be verified/);
    delete source.parts[0][flag];
  }
  assert.deepEqual(approvals, [], 'Unverified text must fail before asking permission');
  await assert.rejects(tools.relay_worker_prepare.execute(args, { ...context, ask: async () => { throw new Error('Permission denied'); } }), /Permission denied/);
  for (const change of ['text', 'id']) {
    try {
      await assert.rejects(tools.relay_worker_prepare.execute(args, { ...context, ask: async () => {
        if (change === 'text') source.parts[0].text = 'Changed request';
        else source.info.id = 'new-human';
      } }), /User message changed; no delegation sent/);
    } finally { source.parts[0].text = sourceText; source.info.id = 'human'; }
  }
  await assert.rejects(tools.relay_worker_prepare.execute(args, context), { code: 'worker_repository_forbidden', status: 409 });
  assert.deepEqual(approvals, [{ permission: 'relay_worker_prepare', patterns: ['/work'], always: [],
    metadata: { ...args, sourceMessageId: 'human', sourceText } }]);
  assert.deepEqual(records(), [], 'Permission alone must not grant repository scope');
  assert.deepEqual(requests, []);
  assert.deepEqual(store.runs(), []);
  assert.deepEqual(prompts, [], 'Startup, inspection and refused preparation must not start native work');

  store.saveOperation({ id: 'operator-task:parent', runId: '', state: 'recorded',
    request: { companyId: 'company', body: { assigneeAgentId: 'origin' }, origin: {
      bindingId: configured.origin.bindingId, conversationId: 'conversation', sessionCreatedAt: 123,
      sourceMessageId: 'earlier-human', sourceDigest: digest('Create the parent task'),
    } }, receipt: { id: 'parent', companyId: 'company', assigneeAgentId: 'origin' } });
  const childArgs = { key: 'child-once', targetBindingId: configured.worker.bindingId,
    title: 'Check the change', description: 'Run checks.', parentTaskId: 'parent' };
  const delegated = JSON.parse(await tools.relay_delegate.execute(childArgs, context));
  assert.equal(approvals.at(-1).metadata.parentTaskId, 'parent');
  assert.equal(store.operation(delegated.id).request.body.parentId, 'parent');
  assert.equal(requests.at(-2).path, '/api/issues/parent');
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).body.parentId, 'parent');
  assert.equal(requests.at(-1).body.parentTaskId, undefined);
  const requestCount = requests.length;
  assert.deepEqual(JSON.parse(await tools.relay_delegate.execute(childArgs, context)), delegated);
  assert.equal(requests.length, requestCount, 'Retry preserves the parent without creating another child');
});

for (const decision of ['accept', 'reject']) {
test(`answer tool reads the current native message, asks permission and resolves only its exact waiting question (review: ${decision})`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-answer-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  const pane = { agent: 'opencode', agent_session: { value: 'conversation', kind: 'id' }, terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ result: { agents: [pane] } }))});\n`, { mode: 0o700 });
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  let question, posts = 0;
  const issue = { id: 'task', companyId: 'company', assigneeAgentId: 'agent', status: 'in_progress' };
  const requests = [];
  const backend = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined,
      executionRunId: issue.executionRunId });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      posts++;
      question.status = req.url.endsWith('/accept') ? 'accepted' : req.url.endsWith('/reject') ? 'rejected' : 'answered';
      question.result = { version: 1, outcome: question.status, ...JSON.parse(body) };
      question.resolvedByUserId = 'local-user';
      question.resolvedByAgentId = null;
      question.resolvedByRunId = null;
      if (question.status === 'rejected') issue.executionRunId = 'backend-rejection-continuation';
    }
    res.end(JSON.stringify(req.url.endsWith('/interactions') ? [question] : req.method === 'POST' ? question : issue));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const auth = join(root, 'backend.json'); writeFileSync(auth, '{"localTrusted":true}');
  const service = await startService({ directory: join(root, 'relay'), paperclipUrl: `http://127.0.0.1:${backend.address().port}`, backendContextFile: auth });
  let hooks;
  t.after(async () => {
    await hooks?.dispose(); await service.close(); await new Promise(resolve => backend.close(resolve));
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  const store = service.store;
  store.saveOperation({ id: 'herdr-agent:test', runId: '', marker: 'marker', agentId: 'agent', availability: 'present',
    identity: { harness: 'opencode', sessionKind: 'id', conversationId: 'conversation', machineId: 'machine', session: 'default', companyId: 'company' },
    placement: { directory: '/work', terminalId: 'terminal' }, observation: { display: { name: 'worker' } } });
  const api = async () => ({ id: 'agent', companyId: 'company', adapterType: 'herdr_relay', adapterConfig: { observationOnly: true, relayObservationMarker: 'marker' } });
  const configured = await configureBridge(store, join(root, 'relay'), api, { observedId: 'herdr-agent:test', reserved: true });
  const bridgeId = `opencode-bridge:${configured.bindingId}`;
  store.saveOperation({ ...store.operation(bridgeId), state: 'armed', lastSeen: new Date().toISOString() });
  const run = store.dispatch({ bindingId: configured.bindingId, bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  store.acknowledge(run.id); store.ask(run.id, { key: 'city', question: 'Which city?' });
  store.questionReceipt(run.id, { state: 'recorded', interactionId: 'question' });
  store.settle(run.id, { outcome: 'waiting', evidence: 'Fixture waiting' });
  question = { id: 'question', ...store.run(run.id).waiting.request, status: 'pending' };
  const messages = [
    { info: { id: 'human', role: 'user', sessionID: 'conversation', time: { created: Date.now() + 1 } }, parts: [{ type: 'text', text: 'What if I answer here?' }] },
    { info: { id: 'tool-turn', role: 'assistant', sessionID: 'conversation', parentID: 'human' }, parts: [] },
  ];
  const client = { session: {
    get: async () => ({ data: { id: 'conversation', directory: '/work', time: { created: 123 } } }),
    messages: async () => ({ data: structuredClone(messages) }), status: async () => ({ data: { conversation: { type: 'busy' } } }),
  } };
  hooks = await plugin({ client, directory: '/work' }, { configFile: configured.bridgeConfigFile });
  const approvals = [];
  const context = { sessionID: 'conversation', messageID: 'tool-turn', ask: async permission => { approvals.push(permission); } };
  assert.equal(JSON.parse(await hooks.tool.relay_questions.execute({}, context)).questions.length, 1);
  const denied = { ...context, ask: async () => { throw new Error('Permission denied'); } };
  await assert.rejects(hooks.tool.relay_answer.execute({ answer: 'Johannesburg' }, denied), /Permission denied/);
  assert.equal(posts, 0); assert.equal(approvals.length, 0);
  messages[0].parts[0].text = 'Use Johannesburg please';
  assert.equal(JSON.parse(await hooks.tool.relay_answer.execute({ answer: 'Johannesburg' }, context)).answered, true);
  assert.equal(approvals[0].permission, 'relay_answer');
  assert.equal(approvals[0].metadata.answer, 'Johannesburg');
  assert.equal(posts, 1);
  await assert.rejects(hooks.tool.relay_answer.execute({ answer: 'Johannesburg' }, context), /No unique pending item/);
  assert.equal(posts, 1);
  await assert.rejects(hooks.tool.relay_answer.execute({}, { ...context, sessionID: 'foreign' }));
  const completed = store.dispatch({ ...run.request, runId: 'continuation' });
  store.acknowledge(completed.id);
  store.submit(completed.id, { key: 'one', candidate: 'candidate', summary: 'Johannesburg result' });
  store.publication(completed.id, { state: 'recorded' });
  store.settle(completed.id, { outcome: 'completed', evidence: 'Fixture terminal' });
  store.recordReview(completed.id, { interactionId: 'review', status: 'pending', candidate: 'candidate' });
  question = { id: 'review', kind: 'request_confirmation', resolverPolicy: 'human_only', status: 'pending', createdAt: new Date(Date.now() - 1000).toISOString(),
    idempotencyKey: `relay-review:${completed.id}:${digest(store.run(completed.id).result)}`,
    payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'candidate', label: completed.id } } };
  messages[0].info.id = 'approval'; messages[0].info.time.created = Date.now();
  const sourceText = decision === 'accept' ? 'accpeted' : 'Reject this result. Add the missing regression test.';
  const args = { decision, ...(decision === 'reject' ? { reason: 'Add the missing regression test.' } : {}) };
  messages[0].parts[0].text = sourceText; messages[1].info.parentID = 'approval';
  assert.equal(JSON.parse(await hooks.tool.relay_reviews.execute({}, context)).reviews.length, 1);
  await assert.rejects(hooks.tool.relay_review.execute(args, denied), /Permission denied/);
  assert.equal(posts, 1);
  const receipt = JSON.parse(await hooks.tool.relay_review.execute(args, context));
  assert.equal(receipt.status, decision === 'accept' ? 'accepted' : 'rejected');
  assert.equal(receipt.interactionId, 'review');
  assert.equal(approvals.at(-1).permission, 'relay_review');
  assert.equal(approvals.at(-1).metadata.candidate, 'candidate');
  assert.equal(approvals.at(-1).metadata.sourceText, sourceText);
  const reviewPost = requests.findIndex(request => request.method === 'POST' && request.path.endsWith(`/review/${decision}`));
  assert.ok(reviewPost >= 0);
  assert.deepEqual(requests[reviewPost].body, decision === 'reject' ? { reason: args.reason } : {});
  assert.deepEqual(requests.slice(reviewPost + 1), [
    { method: 'GET', path: '/api/issues/task', body: undefined, executionRunId: issue.executionRunId },
    { method: 'GET', path: '/api/issues/task/interactions', body: undefined, executionRunId: issue.executionRunId },
  ], 'The committed decision is read back after the POST, even when rejection starts a continuation');
  if (decision === 'reject') {
    assert.equal(issue.executionRunId, 'backend-rejection-continuation');
    assert.equal(question.result.reason, args.reason);
  }
  const recorded = store.operation(`harness-review:${digest(['company', 'review'])}`);
  assert.equal(recorded.state, 'recorded');
  assert.deepEqual(recorded.receipt, receipt);
  assert.equal(store.run(completed.id).review.status, receipt.status);
  assert.deepEqual(JSON.parse(await hooks.tool.relay_review.execute(args, context)), receipt,
    'The exact human decision remains retryable after readback without another POST');
  assert.equal(posts, 2);
});
}

test('coordinator tools require permission and re-read the latest native human message before grant and revoke', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-coordinator-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const directory = join(root, 'relay');
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  const pane = { agent: 'opencode', agent_session: { value: 'conversation', kind: 'id' },
    terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ result: { agents: [pane] } }))});\n`, { mode: 0o700 });
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  const requests = [];
  const backend = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/issues/parent') {
      res.end(JSON.stringify({ id: 'parent', companyId: 'company', assigneeAgentId: 'reviewer', status: 'in_progress' }));
    } else if (req.method === 'GET' && req.url === '/api/companies/company') res.end(JSON.stringify({ id: 'company' }));
    else if (req.method === 'GET' && req.url === '/api/agents/worker') res.end(JSON.stringify({ id: 'worker', companyId: 'company' }));
    else if (req.method === 'POST' && req.url === '/api/companies/company/issues') res.end(JSON.stringify({ ...body, id: 'child', companyId: 'company' }));
    else { res.statusCode = 404; res.end(JSON.stringify({ message: 'Unexpected backend request' })); }
  });
  let service, hooks;
  t.after(async () => {
    await hooks?.dispose(); await service?.close(); await new Promise(resolve => backend.close(resolve));
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const auth = join(root, 'backend.json'); writeFileSync(auth, '{"localTrusted":true}', { mode: 0o600 });
  service = await startService({ directory, paperclipUrl: `http://127.0.0.1:${backend.address().port}`, backendContextFile: auth });
  const store = service.store, configured = {};
  for (const id of ['origin', 'reviewer', 'worker']) {
    const observedId = `herdr-agent:${id}`;
    const conversationId = id === 'origin' ? 'conversation' : `chat-${id}`;
    store.saveOperation({ id: observedId, runId: '', marker: id, agentId: id, availability: 'present',
      identity: { harness: 'opencode', sessionKind: 'id', conversationId, machineId: 'machine', session: 'default', companyId: 'company' },
      placement: { directory: id === 'origin' ? '/work' : `/work/${id}`, terminalId: id === 'origin' ? 'terminal' : `terminal-${id}` },
      observation: { display: { name: id } } });
    configured[id] = await configureBridge(store, directory, async () => ({ id, companyId: 'company', adapterType: 'herdr_relay',
      adapterConfig: { observationOnly: true, relayObservationMarker: id } }), { observedId, reserved: true });
    const bridgeId = `opencode-bridge:${configured[id].bindingId}`;
    store.saveOperation({ ...store.operation(bridgeId), state: 'armed', ready: true, sessionCreatedAt: 123, epoch: `epoch-${id}`,
      lastSeen: new Date().toISOString() });
  }
  store.saveOperation({ id: 'operator-task:parent', runId: '', state: 'recorded',
    request: { companyId: 'company', relayReviewPolicy: 'human', body: { assigneeAgentId: 'reviewer' }, origin: {
      bindingId: configured.origin.bindingId, conversationId: 'conversation', sessionCreatedAt: 123,
      sourceMessageId: 'create-parent', sourceDigest: digest('Create the root task'),
    } }, receipt: { id: 'parent', companyId: 'company', assigneeAgentId: 'reviewer' } });
  const source = { info: { id: 'grant-human', role: 'user', sessionID: 'conversation', time: { created: Date.now() - 1000 } },
    parts: [{ type: 'text', text: 'Allow the parent coordinator to review direct children.' },
      { type: 'text', text: 'Synthetic authority', synthetic: true }, { type: 'text', text: 'Ignored authority', ignored: true }] };
  const messages = [source, { info: { id: 'tool-turn', role: 'assistant', sessionID: 'conversation', parentID: source.info.id }, parts: [] }];
  let historyReads = 0;
  const client = { session: {
    get: async () => ({ data: { id: 'conversation', directory: '/work', time: { created: 123 } } }),
    messages: async () => { historyReads++; return { data: structuredClone(messages) }; },
    status: async () => ({ data: { conversation: { type: 'busy' } } }),
  } };
  hooks = await plugin({ client, directory: '/work' }, { configDirectory: join(directory, 'bridges') });
  const tools = hooks.tool, approvals = [];
  const context = { sessionID: 'conversation', messageID: 'tool-turn', ask: async permission => { approvals.push(permission); } };
  assert.equal(tools.relay_delegate.args.relayReviewPolicy.parse('coordinator'), 'coordinator');
  assert.equal(tools.relay_delegate.args.grantId.parse('grant'), 'grant');
  assert.equal(tools.relay_delegate.args.grantId.parse(undefined), undefined);
  await hooks.config();
  let grant;
  for (const name of ['relay_coordinator_grant', 'relay_coordinator_revoke']) {
    const args = name === 'relay_coordinator_grant'
      ? { key: 'grant', parentTaskId: 'parent', reviewerBindingId: configured.reviewer.bindingId }
      : { grantId: grant.grantId };
    if (grant) {
      source.info.id = 'revoke-human'; source.info.time.created = Date.now();
      source.parts[0].text = 'Revoke that coordinator review grant.'; messages[1].info.parentID = source.info.id;
    }
    const original = structuredClone(source), beforeRequests = requests.length, beforeApprovals = approvals.length;
    const beforeGrant = grant && store.operation(grant.grantId);
    await assert.rejects(tools[name].execute(args, { ...context, messageID: 'missing' }), /user message could not be verified/);
    messages[1].info.parentID = 'older-human';
    await assert.rejects(tools[name].execute(args, context), /user message could not be verified/);
    messages[1].info.parentID = source.info.id;
    for (const flag of ['synthetic', 'ignored']) {
      source.parts[0][flag] = true;
      await assert.rejects(tools[name].execute(args, context), /user message could not be verified/);
      delete source.parts[0][flag];
    }
    assert.equal(approvals.length, beforeApprovals, 'Invalid source must fail before permission');
    await assert.rejects(tools[name].execute(args, { ...context, ask: async () => { throw new Error('Permission denied'); } }), /Permission denied/);
    for (const change of ['text', 'id', 'latest', 'synthetic', 'ignored']) {
      try {
        await assert.rejects(tools[name].execute(args, { ...context, ask: async () => {
          if (change === 'text') source.parts[0].text = 'Changed instruction';
          else if (change === 'id') source.info.id = 'changed-human';
          else if (change === 'latest') messages.push({ info: { ...source.info, id: 'newer-human' }, parts: source.parts });
          else source.parts[0][change] = true;
        } }), /User message changed; no delegation sent/);
      } finally {
        Object.assign(source, structuredClone(original)); messages.splice(2);
      }
    }
    assert.equal(requests.length, beforeRequests, 'Denied or changed source must not reach the backend');
    if (grant) assert.deepEqual(store.operation(grant.grantId), beforeGrant);
    else assert.equal(store.db.prepare("SELECT count(*) AS count FROM operations WHERE id LIKE 'coordinator-review-grant:%'").get().count, 0);
    const beforeReads = historyReads;
    const receipt = JSON.parse(await tools[name].execute(args, context));
    assert.equal(historyReads - beforeReads, 2, 'Read source before permission and again immediately before sending');
    assert.deepEqual(approvals.at(-1), { permission: 'relay_coordinator_review', patterns: [args.parentTaskId ?? args.grantId], always: [],
      metadata: { ...args, sourceMessageId: source.info.id, sourceText: source.parts[0].text } });
    assert.equal(receipt.state, grant ? 'revoked' : 'active');
    assert.deepEqual(JSON.parse(await tools[name].execute(args, context)), receipt, 'Exact retries are idempotent');
    if (!grant) {
      grant = receipt;
      const delegated = JSON.parse(await tools.relay_delegate.execute({ key: 'child', targetBindingId: configured.worker.bindingId,
        title: 'Independent check', description: 'Check the change.', parentTaskId: 'parent',
        relayReviewPolicy: 'coordinator', grantId: grant.grantId }, context));
      assert.equal(store.operation(delegated.id).request.relayReviewPolicy, 'coordinator');
      assert.equal(store.operation(delegated.id).request.relayReviewGrantId, grant.grantId);
      assert.equal(requests.at(-1).body.relayReviewPolicy, undefined);
      assert.equal(requests.at(-1).body.grantId, undefined);
      assert.equal(requests.at(-1).body.relayReviewGrantId, undefined);
    }
  }
  assert.equal(requests.filter(request => request.method !== 'GET').length, 1, 'Only child creation writes to the backend');
});
