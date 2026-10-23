import { connect } from 'node:net';
import { isAbsolute } from 'node:path';

let sequence = Date.now();
export const requestHerdr = (environment, method, params) => new Promise((resolve, reject) => {
  const id = `relay-tui-${++sequence}`, socket = connect(environment.HERDR_SOCKET_PATH);
  let data = '', done = false;
  const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
  const timer = setTimeout(() => finish(Error('Herdr request timed out')), 5000);
  socket.setEncoding('utf8'); socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
  socket.on('error', error => finish(error)); socket.on('close', () => finish(Error('Herdr disconnected')));
  socket.on('data', chunk => {
    data += chunk;
    if (data.length > 4 * 1024 * 1024) { finish(Error('Herdr response too large')); return; }
    const end = data.indexOf('\n'); if (end < 0) return;
    try { const response = JSON.parse(data.slice(0, end)); if (response.id !== id || response.error || !response.result) throw Error('Herdr refused request'); finish(null, response.result); }
    catch (error) { finish(error); }
  });
});

export async function renameHerdrWorkspace(ctx, receipt, { environment = process.env, current, request = requestHerdr } = {}) {
  if (environment.HERDR_ENV !== '1') return { state: 'not_in_herdr' };
  if (!isAbsolute(environment.HERDR_SOCKET_PATH ?? '') || !environment.HERDR_PANE_ID || !environment.HERDR_WORKSPACE_ID || !environment.HERDR_TAB_ID) throw Error('Herdr caller placement is unavailable');
  const name = receipt.agentName;
  if (typeof name !== 'string' || !name.trim() || name.length > 256 || /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(name)) throw Error('Agent name cannot be used as a workspace label');
  const check = () => { if (current && !current()) throw Error('Attachment presentation context changed'); };
  check();
  const snapshot = (await request(environment, 'session.snapshot', {})).snapshot;
  const pane = snapshot?.panes?.find(pane => pane.pane_id === environment.HERDR_PANE_ID);
  const workspace = snapshot?.workspaces?.find(workspace => workspace.workspace_id === environment.HERDR_WORKSPACE_ID);
  if (!pane || pane.workspace_id !== environment.HERDR_WORKSPACE_ID || pane.tab_id !== environment.HERDR_TAB_ID ||
    !workspace || pane.cwd !== (receipt.directory ?? ctx?.location?.directory)) throw Error('Herdr caller placement changed');
  if (ctx) {
    const session = await ctx.client.session.get({ sessionID: receipt.sessionId });
    if (session.id !== receipt.sessionId || session.location?.directory !== pane.cwd) throw Error('Receiving chat and Herdr workspace differ');
  } else {
    // A CLI has no authoritative TUI selection. Require Herdr's actual native
    // session report instead of manufacturing one from the CLI arguments.
    const agent = snapshot.agents?.find(agent => agent.pane_id === pane.pane_id);
    if (agent?.agent !== 'opencode' || agent.agent_session?.kind !== 'id' || agent.agent_session?.value !== receipt.sessionId) throw Error('Herdr has not confirmed this receiving chat');
  }
  check();
  if (workspace.label === name) return { state: 'already_named', workspaceId: pane.workspace_id };
  await request(environment, 'workspace.rename', { workspace_id: pane.workspace_id, label: name });
  return { state: 'renamed', workspaceId: pane.workspace_id };
}

// Only the actual local TUI reports which native session it displays. The node
// driver must never manufacture this evidence from its desired launch arguments.
export function registerHerdrSession(ctx, { selectedSession, record = () => {}, environment = process.env, interval = setInterval, clear = clearInterval }) {
  if (environment.HERDR_ENV !== '1' || !isAbsolute(environment.HERDR_SOCKET_PATH ?? '') || !environment.HERDR_PANE_ID || !ctx.data?.session?.status) return () => {};
  let closed = false, busy = false, reported, nextRetry = 0;
  const report = (method, params) => requestHerdr(environment, method, params);
  const tick = async () => {
    if (closed || busy || Date.now() < nextRetry) return;
    const selected = selectedSession();
    const fingerprint = selected;
    if (fingerprint === reported) return;
    busy = true;
    try {
      const snapshot = (await report('session.snapshot', {})).snapshot;
      const pane = snapshot?.panes?.find(p => p.pane_id === environment.HERDR_PANE_ID);
      if (!pane || pane.workspace_id !== environment.HERDR_WORKSPACE_ID || pane.tab_id !== environment.HERDR_TAB_ID) throw Error('Herdr caller placement changed');
      if (selected) {
        const session = await ctx.client.session.get({ sessionID: selected });
        if (session.location?.directory !== pane.cwd) throw Error('Native session and caller workspace differ');
      }
      if (closed || selectedSession() !== selected) return;
      // Herdr's installed OpenCode integration v12 defines this selection
      // source. A separate arbitrary source is acknowledged but is not the
      // native selection authority. Do not publish lifecycle or completion state.
      await report('pane.report_agent_session', { pane_id: pane.pane_id, source: 'herdr:opencode', agent: 'opencode',
        agent_session_id: selected, session_start_source: 'select' });
      if (!closed && selectedSession() === selected) reported = fingerprint;
      record({ type: 'herdr_session_reported', sessionId: selected, paneId: pane.pane_id });
    } catch { nextRetry = Date.now() + 5000; record({ type: 'herdr_session_report_failed', sessionId: selected }); }
    finally { busy = false; }
  };
  const timer = interval(() => tick(), 500); timer.unref?.(); void tick();
  return () => { closed = true; clear(timer); };
}
