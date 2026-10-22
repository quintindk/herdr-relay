import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { registerHerdrSession } from '../herdr-session.mjs';

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
