/** @jsxImportSource @opentui/solid */
import { attachmentView } from './attachment-status.mjs';

export function AttachmentSidebar(props) {
  const view = () => attachmentView(props.status(), props.sessionID);
  return <box flexDirection="column" marginTop={1} paddingLeft={1}>
    <text fg={props.theme.text.action?.primary?.base ?? props.theme.text.base}>◆ {view().title}</text>
    <text fg={props.theme.text.base}>{view().identity}</text>
    <text fg={props.theme.text.feedback?.[view().tone]?.base ?? props.theme.text.base}>{view().icon} {view().label}</text>
    <text fg={props.theme.text.muted ?? props.theme.text.base}>{view().detail}</text>
  </box>;
}
