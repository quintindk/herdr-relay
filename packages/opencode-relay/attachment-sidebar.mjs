import { createEffect, createRoot, createSignal } from 'solid-js';
import { RelaySpike } from './rpc.mjs';
import { watchAttachmentStatus } from './attachment-status.mjs';

export async function registerAttachmentSidebar(ctx, { selectedSession, record = () => {} }) {
  if (!ctx.ui.slot) return () => {};
  const { AttachmentSidebar } = await import('./attachment-sidebar.tsx');
  const [status, setStatus] = createSignal({ sessionId: null, state: 'checking' });
  const location = ctx.location ?? ctx.data.location.default();
  const watcher = watchAttachmentStatus({ selectedSession,
    load: sessionId => ctx.client.rpc(RelaySpike).attachment({ sessionId }, { location }),
    update: value => { setStatus(value); record({ type: 'attachment_sidebar', sessionId: value.sessionId, state: value.state }); },
    subscribe: callback => ctx.data.on('server.connected', callback),
    observeSelection: callback => createRoot(dispose => { createEffect(() => callback(selectedSession())); return dispose; }),
  });
  let remove;
  try { remove = ctx.ui.slot({ append: 'sidebar.content', render: props => {
    record({ type: 'attachment_sidebar_rendered', sessionId: props.sessionID });
    return AttachmentSidebar({ get sessionID() { return props.sessionID; }, status, get theme() { return ctx.theme; } });
  } }); } catch (error) { watcher.stop(); throw error; }
  return () => { watcher.stop(); remove(); };
}
