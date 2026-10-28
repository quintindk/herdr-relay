import { workerConnection } from './worker-context.mjs';
import { call } from '../../src/client.mjs';
import { stripVTControlCharacters } from 'node:util';

export async function readAttachmentStatus(ctx, { sessionId }, { connection = workerConnection, request = call } = {}) {
  const session = await ctx.session.get({ sessionID: sessionId });
  if (session.id !== sessionId || session.location?.directory !== ctx.location.directory) throw Error('Attachment status belongs to another workspace');
  const base = { sessionId, state: 'not_attached', agentName: null, agentId: null, generation: null, obligations: 0 };
  let worker;
  try { worker = connection(ctx.options, sessionId); }
  catch (error) { return { ...base, state: error.code === 'relay_not_attached' ? 'not_attached' : 'unavailable' }; }
  try {
    const status = await request(worker, 'POST', '/agent/status', {});
    if (status.sessionId !== sessionId || status.agentId !== worker.agentId || typeof status.receivingHere !== 'boolean') throw Error('Attachment identity changed');
    return { ...base, state: status.receivingHere ? 'attached' : status.receiver?.state === 'pending' ? 'pending' : 'not_attached',
      agentId: status.agentId, agentName: status.agentName ?? null, nodeName: status.nodeName ?? null,
      generation: status.receiver?.generation ?? null, obligations: status.obligations.length };
  } catch { return { ...base, state: 'unavailable' }; }
}

export function watchAttachmentStatus({ selectedSession, load, update, subscribe, observeSelection, interval = setInterval, clear = clearInterval }) {
  let closed = false, busy = false, generation = 0, previous = selectedSession();
  const reset = () => { if (!closed) update({ sessionId: selectedSession(), state: selectedSession() ? 'checking' : 'no_session' }); };
  const track = selected => { if (previous !== selected) { previous = selected; generation++; reset(); } };
  const stopSelection = observeSelection(track);
  const stopConnection = subscribe(() => { generation++; reset(); });
  const tick = async () => {
    if (closed) return;
    track(selectedSession());
    if (closed || busy || !selectedSession()) return;
    const session = selectedSession(), revision = generation;
    busy = true;
    try {
      const status = await load(session);
      if (status.sessionId !== session) throw Error('Attachment status belongs to another chat');
      if (!closed && revision === generation && selectedSession() === session && status.sessionId === session) update(status);
    } catch { if (!closed && revision === generation && selectedSession() === session) update({ sessionId: session, state: 'unavailable' }); }
    finally { busy = false; }
  };
  reset();
  const timer = interval(() => { void tick(); }, 2000); timer.unref?.(); void tick();
  return { refresh: tick, stop: () => { closed = true; generation++; clear(timer); stopConnection(); stopSelection(); } };
}

export function attachmentView(status, sessionId) {
  if (!sessionId || status.sessionId !== sessionId) return { title: 'Relay', label: 'Checking attachment…', detail: '', icon: '○', tone: 'info', identity: '' };
  const label = { attached: 'Attached · receiving here', not_attached: 'Not attached to this chat', pending: 'Attachment pending',
    unavailable: 'Attachment status unavailable', checking: 'Checking attachment…' }[status.state] ?? 'Attachment status unavailable';
  const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 256);
  const name = clean(status.agentName), node = clean(status.nodeName);
  return { title: 'Relay', label, identity: [name, node].filter(Boolean).join(' · '),
    icon: status.state === 'attached' ? '●' : status.state === 'unavailable' ? '!' : status.state === 'pending' ? '◷' : '○',
    tone: status.state === 'attached' ? 'success' : status.state === 'unavailable' ? 'error' : status.state === 'pending' ? 'warning' : 'info',
    detail: status.state === 'attached' ? `${status.obligations ?? 0} outstanding` : status.state === 'not_attached' ? 'Use /relay-attach' : '' };
}
