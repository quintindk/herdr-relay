import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { registerHerdrSession, renameHerdrWorkspace } from '../herdr-session.mjs';

async function fixture(t, { wrongDirectory = false, wrongPane = false } = {}) {
  const root = mkdtempSync('/tmp/opencode/herdr-report-'), socket = join(root, 'herdr.sock');
  const f = { selected: 'ses_a', requests: [], records: [] };
  const server = createServer(connection => connection.on('data', data => {
    const request = JSON.parse(String(data)); f.requests.push(request);
    const result = request.method === 'session.snapshot' ? { snapshot: { panes: [{ pane_id: wrongPane ? 'other' : 'w1:p1',
      workspace_id: 'w1', tab_id: 'w1:t1', cwd: root }] } } : { type: 'ok' };
    connection.write(`${JSON.stringify({ id: request.id, result })}\n`);
  }));
  await new Promise(resolve => server.listen(socket, resolve));
  const ctx = { data: { session: { status: () => 'idle' } }, client: { session: { get: async () => ({ location: { directory: wrongDirectory ? '/elsewhere' : root } }) } } };
  f.stop = registerHerdrSession(ctx, { selectedSession: () => f.selected, record: e => f.records.push(e),
    environment: { HERDR_ENV: '1', HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1' },
    interval: callback => { f.tick = callback; return {}; }, clear: () => {} });
  for (let i = 0; i < 100 && !f.records.length; i++) await setImmediate();
  t.after(async () => { f.stop(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('actual TUI selection uses the installed Herdr OpenCode source contract without fabricating lifecycle or completion', async t => {
  const f = await fixture(t);
  const reports = () => f.requests.filter(r => r.method !== 'session.snapshot');
  assert.equal(reports().length, 1);
  assert.deepEqual(reports()[0].params, { pane_id: 'w1:p1', source: 'herdr:opencode', agent: 'opencode', agent_session_id: 'ses_a', session_start_source: 'select' });
  await f.tick(); assert.equal(reports().length, 1);
  f.selected = 'ses_b'; await f.tick();
  assert.equal(reports().length, 2); assert.equal(reports()[1].params.agent_session_id, 'ses_b');
  assert.ok(reports().every(r => r.method === 'pane.report_agent_session' && !Object.hasOwn(r.params, 'state')));
});

for (const option of ['wrongDirectory', 'wrongPane']) test(`native selection cannot report into ${option}`, async t => {
  const f = await fixture(t, { [option]: true });
  assert.equal(f.requests.filter(r => r.method !== 'session.snapshot').length, 0);
  assert.equal(f.records.at(-1).type, 'herdr_session_report_failed');
});

test('reporter is inert outside an explicitly identified Herdr TUI', () => {
  let timer = false;
  const close = registerHerdrSession({}, { selectedSession: () => 'session', environment: {}, interval: () => { timer = true; } });
  close(); assert.equal(timer, false);
});

function renameFixture() {
  const f = { current: true, calls: [], snapshot: { panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/work' }],
    workspaces: [{ workspace_id: 'w1', label: 'Old name' }], agents: [{ pane_id: 'w1:p1', agent: 'opencode', agent_session: { kind: 'id', value: 'a' } }] } };
  f.ctx = { location: { directory: '/work' }, client: { session: { get: async () => ({ id: 'a', location: { directory: '/work' } }) } } };
  f.receipt = { sessionId: 'a', agentName: 'Mason', directory: '/work' };
  f.options = { environment: { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/fixture/herdr.sock', HERDR_PANE_ID: 'w1:p1', HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1' },
    current: () => f.current, request: async (_env, method, params) => { f.calls.push({ method, params }); return { snapshot: f.snapshot }; } };
  return f;
}

test('confirmed attachment renames only the caller workspace and setting the same name is idempotent', async () => {
  const f = renameFixture();
  assert.equal((await renameHerdrWorkspace(f.ctx, f.receipt, f.options)).state, 'renamed');
  assert.deepEqual(f.calls.at(-1), { method: 'workspace.rename', params: { workspace_id: 'w1', label: 'Mason' } });
  f.calls.length = 0; f.snapshot.workspaces[0].label = 'Mason';
  assert.equal((await renameHerdrWorkspace(f.ctx, f.receipt, f.options)).state, 'already_named');
  assert.equal(f.calls.some(call => call.method === 'workspace.rename'), false);
});

for (const change of ['pane', 'workspace', 'tab', 'directory', 'session', 'late-switch']) test(`workspace naming refuses changed ${change} without mutating Herdr`, async () => {
  const f = renameFixture();
  if (change === 'pane') f.snapshot.panes[0].pane_id = 'other';
  if (change === 'workspace') f.snapshot.panes[0].workspace_id = 'other';
  if (change === 'tab') f.snapshot.panes[0].tab_id = 'other';
  if (change === 'directory') f.snapshot.panes[0].cwd = '/elsewhere';
  if (change === 'session') f.ctx.client.session.get = async () => ({ id: 'b' });
  if (change === 'late-switch') f.ctx.client.session.get = async () => { f.current = false; return { id: 'a', location: { directory: '/work' } }; };
  await assert.rejects(renameHerdrWorkspace(f.ctx, f.receipt, f.options));
  assert.equal(f.calls.some(call => call.method === 'workspace.rename'), false);
});

test('CLI naming requires actual Herdr native selection evidence and stays inert outside Herdr', async () => {
  const f = renameFixture();
  assert.equal((await renameHerdrWorkspace(null, f.receipt, f.options)).state, 'renamed');
  f.calls.length = 0; f.snapshot.agents[0].agent_session.value = 'another-chat';
  await assert.rejects(renameHerdrWorkspace(null, f.receipt, f.options)); assert.equal(f.calls.some(call => call.method === 'workspace.rename'), false);
  assert.equal((await renameHerdrWorkspace(null, f.receipt, { environment: {} })).state, 'not_in_herdr');
});
