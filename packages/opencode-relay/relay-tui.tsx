/** @jsxImportSource @opentui/solid */
import { setupTui } from './tui-setup.mjs';
import { AttachmentSidebar } from './attachment-sidebar.tsx';

/** @type {import('@opencode/plugin/tui').Plugin.Definition} */
const plugin = {
  id: 'herdr.relay.tui',
  setup: ctx => setupTui(ctx, { renderAttachment: props => <AttachmentSidebar {...props} /> }),
};

export default plugin;
