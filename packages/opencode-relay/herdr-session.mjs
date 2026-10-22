import { connect } from 'node:net';
import { isAbsolute } from 'node:path';

// Only the actual local TUI reports which native session it displays. The node
// driver must never manufacture this evidence from its desired launch arguments.
export function registerHerdrSession(ctx, { selectedSession, record = () => {}, environment = process.env, interval = setInterval, clear = clearInterval }) {
  if (environment.HERDR_ENV !== '1' || !isAbsolute(environment.HERDR_SOCKET_PATH ?? '') || !environment.HERDR_PANE_ID || !ctx.data?.session?.status) return () => {};
  let closed = false, busy = false, reported, nextRetry = 0, sequence = Date.now();
  const report = (method, params) => new Promise((resolve, reject) => {
    const id = `relay-tui-${++sequence}`, socket = connect(environment.HERDR_SOCKET_PATH);
    let data = '', done = false;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(Error('Herdr session report timed out')), 5000);
    socket.setEncoding('utf8'); socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('error', error => finish(error)); socket.on('close', () => finish(Error('Herdr disconnected')));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) { finish(Error('Herdr response too large')); return; }
      const end = data.indexOf('\n'); if (end < 0) return;
      try { const response = JSON.parse(data.slice(0, end)); if (response.id !== id || response.error || !response.result) throw Error('Herdr refused session report'); finish(null, response.result); }
      catch (error) { finish(error); }
    });
  });
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
