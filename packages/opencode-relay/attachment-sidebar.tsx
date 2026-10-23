/** @jsxImportSource @opentui/solid */
import { attachmentView } from './attachment-status.mjs';

export function AttachmentSidebar(props) {
  const view = () => attachmentView(props.status(), props.sessionID);
  return <box flexDirection="column" marginTop={1}>
    <text fg={props.theme.text.base}>{view().title}</text>
    <text fg={props.theme.text.base}>{view().label}</text>
    <text fg={props.theme.text.base}>{view().detail}</text>
  </box>;
}
