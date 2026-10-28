import React from 'react';
import { Box, Text, useInput } from 'ink';
import { decisionText } from './task-board-decision.mjs';

const h = React.createElement;
export function RunResultNotificationsPanel({ modal, setModal, submit, width, height }) {
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.escape) { setModal(null); return; }
    if (modal.confirm || modal.locked) {
      if (key.return) void submit(modal);
      else if (!modal.locked && key.backspace) setModal(value => ({ ...value, confirm: false }));
      return;
    }
    if (key.upArrow || key.downArrow || key.tab) setModal(value => ({ ...value, index: value.index === 0 ? 1 : 0 }));
    if (input === ' ') setModal(value => ({ ...value, policy: { ...value.policy,
      [value.index === 0 ? 'inbox' : 'requester']: !value.policy[value.index === 0 ? 'inbox' : 'requester'] } }));
    if (key.return) setModal(value => ({ ...value, confirm: true }));
  });
  const w = Math.max(40, Math.min(94, width - 2)), size = Math.min(17, height - 2);
  return h(Box, { position: 'absolute', left: Math.max(0, Math.floor((width - w) / 2)), top: Math.max(0, Math.floor((height - size) / 2)),
    width: w, height: size, borderStyle: 'round', borderColor: 'cyan', backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' },
  h(Text, { bold: true, color: 'cyan' }, 'Run result notifications'),
  h(Text, { wrap: 'truncate-end' }, decisionText(modal.scheduleId)),
  h(Text, { dimColor: true }, 'After completed/failed results only. Not run-start alerts.'),
  h(Text, null, ' '),
  ...[['inbox', 'Save run results to Inbox'], ['requester', 'Message requester when online']].map(([key, label], index) =>
    h(Text, { key, inverse: modal.index === index, bold: modal.index === index }, `[${modal.policy[key] ? 'x' : ' '}] ${label}`)),
  h(Text, { dimColor: true }, 'Inbox persists until read. Requester delivery is best-effort.'),
  h(Text, { dimColor: true }, 'Future runs only. No worker, grant or cron replacement.'),
  h(Box, { flexGrow: 1 }),
  h(Text, { color: modal.error ? 'red' : 'cyan', wrap: 'truncate-end' }, modal.error || (modal.confirm ? 'Confirm these exact settings?' : 'Both settings are independent.')),
  h(Text, { dimColor: true }, modal.busy ? 'Saving settings…' : modal.locked ? 'Enter retry original settings · Esc close; inspect Inbox if refused'
    : modal.confirm ? 'Enter confirm · Backspace edit · Esc cancel' : '↑↓ select · Space toggle · Enter preview · Esc cancel'));
}
