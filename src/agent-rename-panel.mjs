import React from 'react';
import { Box, Text, useInput } from 'ink';
import { BoardText, appendBoardInput, modalSize } from './board-text.mjs';
import { agentName } from './agent-name.mjs';

const h = React.createElement;

export function AgentRenamePanel({ modal, setModal, submit, close, width, height }) {
  const { width: w, height: size } = modalSize(width, height, 80, 23);
  const columns = Math.max(1, w - 6), rows = Math.max(1, size - 7);
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.escape) {
      if (modal.confirm && !modal.locked) setModal(value => ({ ...value, confirm: false, error: '', scroll: 0 }));
      else close();
      return;
    }
    if (!modal.preview) return;
    if (key.pageDown || key.pageUp) {
      setModal(value => ({ ...value, scroll: Math.max(0, (value.scroll || 0) + (key.pageDown ? rows : -rows)) })); return;
    }
    if (key.return) {
      if (modal.confirm) { if (modal.refused) close(); else void submit(modal); return; }
      try {
        const name = agentName(modal.name.trim());
        if (name === modal.preview.name) throw Error('Enter a different name, or Esc to cancel');
        setModal(value => ({ ...value, name, confirm: true, error: '', scroll: 0 }));
      } catch (error) { setModal(value => ({ ...value, error: error.message })); }
      return;
    }
    if (modal.confirm || modal.locked) return;
    if (key.ctrl && input === 'u') { setModal(value => ({ ...value, name: '', error: '', scroll: 0 })); return; }
    if (/[\r\n\t\u2028\u2029]/.test(input)) { setModal(value => ({ ...value, error: 'The agent name must be a single line' })); return; }
    const name = appendBoardInput(modal.name, input, key, 256);
    if (name !== modal.name) setModal(value => ({ ...value, name, error: '', scroll: 0 }));
  });
  const text = modal.preview ? `Current name: ${modal.preview.name}\nNode: ${modal.preview.nodeId}\nWorkspace: ${modal.preview.directory || 'Not advertised'}\n\n` +
    `${modal.confirm ? 'New name' : 'Edit name'} (${modal.name.length}/256)\n${modal.name}${!modal.confirm ? '▏' : ''}\n\n` +
    'Only the Relay name changes. Agent identity, receiving chat, workspace, permissions and schedules stay unchanged. Native chat titles and Herdr workspace labels are not renamed.'
    : modal.busy ? 'Loading the current agent name…' : 'Rename preview is unavailable. Close this panel and inspect the reported error.';
  return h(Box, { position: 'absolute', width: w, height: size, left: Math.max(0, Math.floor((width - w) / 2)), top: Math.max(0, Math.floor((height - size) / 2)),
    borderStyle: 'round', borderColor: 'cyan', backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' },
  h(Text, { bold: true, color: 'cyan' }, modal.confirm ? 'Confirm agent rename' : 'Rename Relay agent'),
  h(BoardText, { text, columns, rows, scroll: modal.scroll || 0 }),
  h(BoardText, { text: modal.error || (modal.busy ? 'Waiting for acknowledgement…' : ''), columns, rows: 2, color: 'red' }),
  h(Box, { flexGrow: 1 }),
  h(Text, { dimColor: true, wrap: 'wrap' }, modal.refused ? 'Enter inspect refusal · Esc Inbox' : modal.locked ? 'Enter retry original · Esc Inbox'
    : modal.confirm ? 'PgUp/Dn inspect · Enter apply · Esc edit' : 'Ctrl+U clear · PgUp/Dn · Enter review · Esc cancel'));
}
