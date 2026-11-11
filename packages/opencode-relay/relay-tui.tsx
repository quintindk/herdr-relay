/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, Show } from 'solid-js';
import { setupTui } from './tui-setup.mjs';
import { AttachmentSidebar } from './attachment-sidebar.tsx';
import { watchClock } from './status-clock.mjs';

function StatusClock(props) {
  const [time, setTime] = createSignal('');
  onCleanup(watchClock({ update: setTime }));
  props.record(time());
  return <text fg={props.theme.text.muted ?? props.theme.text.base} marginLeft={1} flexShrink={0}>{time()}</text>;
}

/** @type {import('@opencode/plugin/tui').Plugin.Definition} */
const plugin = {
  id: 'herdr.relay.tui',
  setup: ctx => setupTui(ctx, {
    renderAttachment: props => <AttachmentSidebar {...props} />,
    renderClock: props => <Show when={props.visible}><StatusClock {...props} /></Show>,
  }),
};

export default plugin;
