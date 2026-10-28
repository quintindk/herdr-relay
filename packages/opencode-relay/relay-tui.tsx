/** @jsxImportSource @opentui/solid */
import { Plugin } from '@opencode/plugin/tui';
import { setupTui } from './tui-setup.mjs';
import { AttachmentSidebar } from './attachment-sidebar.tsx';

export default Plugin.define({
  id: 'herdr.relay.tui',
  setup: ctx => setupTui(ctx, { renderAttachment: props => <AttachmentSidebar {...props} /> }),
});
