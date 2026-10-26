import React from 'react';
import { Box, Text, useInput } from 'ink';
import { decisionText } from './task-board-decision.mjs';
import { wrapBoardText } from './task-board-view.mjs';

const h = React.createElement;
export function NativeDispatchModal({ modal, setModal, submit, width, height }) {
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.escape) { if (modal.stage === 'handover' && !modal.locked) setModal({ ...modal, stage: 'select' }); else setModal(null); return; }
    if (modal.locked) return;
    if (modal.stage === 'select') {
      if (key.downArrow || input === 'j') setModal({ ...modal, index: Math.min(modal.agents.length - 1, modal.index + 1) });
      if (key.upArrow || input === 'k') setModal({ ...modal, index: Math.max(0, modal.index - 1) });
      if (key.return) setModal({ ...modal, stage: 'handover' });
      return;
    }
    if (key.return) { if (modal.text.trim()) void submit(modal); else setModal({ ...modal, error: 'A handover is required' }); return; }
    const text = key.backspace || key.delete ? [...modal.text].slice(0, -1).join('') :
      input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input) ? modal.text + input : modal.text;
    if (text.length <= 4000) setModal({ ...modal, text });
  });
  const w = Math.max(20, Math.min(92, width - 2)), size = Math.max(10, Math.min(24, height - 2));
  const agent = modal.agents[modal.index], count = Math.max(1, size - 8), start = Math.max(0, modal.index - Math.floor(count / 2));
  const lines = wrapBoardText(decisionText(`${modal.text}▏`), Math.max(8, w - 6));
  return h(Box, { position: 'absolute', left: Math.max(0, Math.floor((width - w) / 2)), top: Math.max(0, Math.floor((height - size) / 2)),
    width: w, height: size, borderStyle: 'round', borderColor: 'cyan', backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' },
    h(Text, { bold: true, color: 'cyan', wrap: 'truncate-end' }, `Send task · ${modal.task.identifier ?? modal.task.id}`),
    h(Text, { wrap: 'truncate-end' }, decisionText(modal.task.title)),
    h(Text, { dimColor: true, wrap: 'truncate-end' }, 'Human responsibility stays unchanged. Result completes the task without formal review.'),
    modal.stage === 'select' ? h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      ...modal.agents.slice(start, start + count).map((item, i) => h(Text, { key: item.id, inverse: start + i === modal.index, wrap: 'truncate-end' },
        decisionText(`${item.displayName ?? item.name} · ${item.nodeName ?? item.nodeId} · ${item.availabilityLabel ?? item.availability ?? 'Unknown'}`)))) :
      h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
        h(Text, { bold: true, wrap: 'truncate-end' }, decisionText(`To: ${agent.displayName ?? agent.name} · ${agent.nodeName ?? agent.nodeId}`)),
        h(Text, null, 'Handover'), ...lines.slice(-Math.max(1, size - 9)).map((line, index) => h(Text, { key: index, wrap: 'truncate-end' }, line))),
    modal.error ? h(Text, { color: 'red', wrap: 'truncate-end' }, decisionText(modal.error)) : null,
    h(Text, { dimColor: true, wrap: 'truncate-end' }, modal.locked ? 'Esc close · Reconcile the original request in Inbox' : modal.stage === 'select'
      ? '↑↓ select · Enter handover · Esc cancel' : 'Enter send · Esc back'));
}
