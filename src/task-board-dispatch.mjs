import React from 'react';
import { Box, Text, useInput } from 'ink';
import { decisionText } from './task-board-decision.mjs';
import { wrapBoardText } from './task-board-view.mjs';
import { BoardText, modalSize, appendBoardInput } from './board-text.mjs';

const h = React.createElement;
export function assignmentRows(agents, columns) {
  const rows = []; let node;
  agents.forEach((agent, index) => {
    if (agent.kind !== 'human' && agent.nodeId !== node) {
      node = agent.nodeId;
      for (const text of wrapBoardText(`${agent.nodeName || 'Unknown node'}${agent.locality === 'local' ? ' · this node' : ''}`, columns)) rows.push({ text, heading: true });
    }
    const text = agent.kind === 'human' ? 'You (human)' : `  ${agent.displayName || agent.name} · ${agent.availabilityLabel || agent.availability || 'Unknown'} · ${agent.mode || 'Unknown mode'}\n  ${agent.directory || 'Workspace not advertised'}`;
    for (const line of wrapBoardText(text, columns)) rows.push({ text: line, index });
  });
  return rows;
}

export function NativeDispatchModal({ modal, setModal, submit, prepareHuman, width, height }) {
  const agent = modal.agents[modal.index], human = agent?.kind === 'human';
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.escape) { if (modal.stage !== 'select' && !modal.locked) setModal({ ...modal, stage: 'select', scroll: 0 }); else setModal(null); return; }
    if (modal.locked) return;
    if (modal.stage === 'select') {
      if (key.downArrow || input === 'j') setModal({ ...modal, index: Math.min(modal.agents.length - 1, modal.index + 1) });
      if (key.upArrow || input === 'k') setModal({ ...modal, index: Math.max(0, modal.index - 1) });
      if (key.return) {
        if (human) void prepareHuman(modal);
        else setModal({ ...modal, stage: 'handover', text: '', error: '', scroll: 0 });
      }
      return;
    }
    if (key.pageDown || key.pageUp) { setModal({ ...modal, scroll: Math.max(0, (modal.scroll || 0) + (key.pageDown ? 5 : -5)) }); return; }
    if (key.return && !key.shift) {
      if (human && modal.preview?.alreadyHuman) { setModal(null); return; }
      if (!modal.text.trim()) { setModal({ ...modal, error: human ? 'A handback reason is required' : 'A handover is required' }); return; }
      if (human && modal.stage !== 'confirm') setModal({ ...modal, stage: 'confirm', scroll: 0 });
      else void submit(modal);
      return;
    }
    if (modal.stage === 'confirm') return;
    setModal({ ...modal, text: appendBoardInput(modal.text, input, key, human ? 2000 : 4000), scroll: 0 });
  });
  const { width: w, height: size } = modalSize(width, height, 96, 27), columns = Math.max(1, w - 6);
  const rows = assignmentRows(modal.agents, columns), selected = rows.findIndex(row => row.index === modal.index);
  const viewport = Math.max(1, size - 9), start = Math.max(0, Math.min(selected - 1, rows.length - viewport));
  const title = modal.stage === 'select' ? 'Assign task' : human ? 'Take back from agent → Todo' : 'Send task';
  const content = human ? modal.preview?.alreadyHuman ? 'Already with you. No outstanding assignment was found. No operation will be created.'
    : `From: ${modal.preview?.workerName || 'Selected worker'} · ${modal.preview?.nodeName || 'Selected node'}\nWithdraw this assignment and return the task to Todo. Unanswered questions are superseded, not answered. History is preserved. Native process termination is not claimed.\n\nReason\n${modal.text}${modal.stage !== 'confirm' ? '▏' : ''}\n${modal.stage === 'confirm' ? '\nConfirm this exact handback.' : ''}`
    : `To: ${agent.displayName || agent.name} · ${agent.nodeName || agent.nodeId}\n${agent.directory || ''}\n\nHandover\n${modal.text}▏`;
  return h(Box, { position: 'absolute', left: Math.max(0, Math.floor((width - w) / 2)), top: Math.max(0, Math.floor((height - size) / 2)),
    width: w, height: size, borderStyle: 'round', borderColor: 'cyan', backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' },
  h(Text, { bold: true, color: 'cyan' }, title),
  h(BoardText, { text: decisionText(modal.task.title), columns, rows: 2 }),
  modal.stage === 'select' ? h(Box, { height: viewport, flexDirection: 'column', overflow: 'hidden' },
    ...rows.slice(start, start + viewport).map((row, i) => h(Text, { key: i, bold: row.heading, color: row.heading ? 'cyan' : undefined,
      inverse: row.index === modal.index, wrap: 'truncate-end' }, row.text)))
    : h(BoardText, { text: content, columns, rows: viewport, scroll: modal.scroll || 0, tail: modal.stage !== 'confirm' && !modal.scroll && !modal.preview?.alreadyHuman }),
  h(Text, { color: 'red', wrap: 'wrap' }, decisionText(modal.error || '')),
  h(Text, { dimColor: true, wrap: 'wrap' }, modal.busy ? 'Inspecting/publishing…' : modal.locked ? 'Esc close · Reconcile the original request in Inbox' : modal.stage === 'select'
    ? '↑↓ select · Enter inspect · Esc cancel' : modal.preview?.alreadyHuman ? 'Enter/Esc close' : modal.stage === 'confirm'
      ? 'Enter confirm · Esc back' : human ? 'Type reason · PgUp/Dn · Enter preview · Esc back' : 'Enter send · Shift+Enter newline · PgUp/Dn · Esc back'));
}
