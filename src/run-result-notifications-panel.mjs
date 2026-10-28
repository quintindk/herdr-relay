import React from 'react';
import { Box, Text, useInput } from 'ink';
import { decisionText } from './task-board-decision.mjs';
import { modalSize } from './board-text.mjs';
import { wrapBoardText } from './task-board-view.mjs';

const h = React.createElement;
export function RunResultNotificationsPanel({ modal, setModal, submit, width, height }) {
  const { width: w, height: size } = modalSize(width, height, 94, 26), columns = Math.max(1, w - 6);
  const title = wrapBoardText('Run result notifications', columns);
  const hint = modal.busy ? 'Saving settings…' : modal.locked ? 'Enter retry original settings · Esc close; inspect Inbox if refused'
    : modal.confirm ? 'PgUp/Dn inspect · Enter confirm · Backspace edit · Esc cancel' : '↑↓ select · Space toggle · PgUp/Dn · Enter preview · Esc cancel';
  const footer = wrapBoardText(hint, columns), viewport = Math.max(1, size - title.length - footer.length - 2);
  const content = [];
  const add = (text, index) => wrapBoardText(text, columns).forEach(text => content.push({ text, index }));
  add(modal.scheduleId); add('After completed/failed results only. Not run-start alerts.'); add('');
  add(`[${modal.policy.inbox ? 'x' : ' '}] Save run results to Inbox`, 0);
  add(`[${modal.policy.requester ? 'x' : ' '}] Message requester when online`, 1);
  add('Inbox persists until read. Requester delivery is best-effort.');
  add('Future runs only. No worker, grant or cron replacement.');
  add(modal.error || (modal.confirm ? 'Confirm these exact settings?' : 'Both settings are independent.'));
  const selected = content.findIndex(line => line.index === modal.index);
  const start = Math.max(0, Math.min(modal.scroll ?? Math.max(0, selected - Math.floor(viewport / 2)), content.length - viewport));
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.escape) { setModal(null); return; }
    if (key.pageDown || key.pageUp) { setModal(value => ({ ...value, scroll: Math.max(0, Math.min(content.length - viewport, start + (key.pageDown ? viewport : -viewport))) })); return; }
    if (modal.confirm || modal.locked) {
      if (key.return) void submit(modal);
      else if (!modal.locked && key.backspace) setModal(value => ({ ...value, confirm: false }));
      return;
    }
    if (key.upArrow || key.downArrow || key.tab) setModal(value => ({ ...value, index: value.index === 0 ? 1 : 0, scroll: undefined }));
    if (input === ' ') setModal(value => ({ ...value, policy: { ...value.policy,
      [value.index === 0 ? 'inbox' : 'requester']: !value.policy[value.index === 0 ? 'inbox' : 'requester'] } }));
    if (key.return) setModal(value => ({ ...value, confirm: true, scroll: Math.max(0, content.length - viewport) }));
  });
  return h(Box, { position: 'absolute', left: Math.max(0, Math.floor((width - w) / 2)), top: Math.max(0, Math.floor((height - size) / 2)),
    width: w, height: size, borderStyle: 'round', borderColor: 'cyan', backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' },
  ...title.map((text, i) => h(Text, { key: `title:${i}`, bold: true, color: 'cyan', wrap: 'truncate-end', flexShrink: 0 }, text)),
  h(Box, { height: viewport, flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }, ...content.slice(start, start + viewport).map((line, i) =>
    h(Text, { key: i, inverse: line.index !== undefined && modal.index === line.index, wrap: 'truncate-end' }, line.text || ' '))),
  ...footer.map((text, i) => h(Text, { key: `footer:${i}`, dimColor: true, wrap: 'truncate-end', flexShrink: 0 }, decisionText(text))));
}
