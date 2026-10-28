import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import { randomUUID } from 'node:crypto';
import { buildBoardRows, buildAgentRows, wrapBoardText } from './task-board-view.mjs';
import { BoardDecisionModal, decisionText } from './task-board-decision.mjs';
import { GrantsPanel, nativeBoardTabs, nativeBoardViews } from './grants-panel.mjs';
import { NativeDispatchModal } from './task-board-dispatch.mjs';
import { RunResultNotificationsPanel } from './run-result-notifications-panel.mjs';
import { BoardText, modalSize, appendBoardInput } from './board-text.mjs';
import { routineDetailLayout } from './board-detail-layout.mjs';
import { layoutBoardRows, boardRowViewport } from './board-row-layout.mjs';

const h = React.createElement;
const statuses = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'];
const labels = { backlog: 'Backlog', todo: 'Todo', in_progress: 'Active', blocked: 'Blocked',
  in_review: 'In review', done: 'Done', cancelled: 'Cancelled', delete: 'Delete permanently' };
const terminal = status => ['done', 'cancelled'].includes(status);
const clean = value => decisionText(value).trim();
const lastSeenLabel = value => Number.isFinite(Date.parse(value)) ? `${new Date(value).toLocaleString('en-GB', {
  timeZone: 'Africa/Johannesburg', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})} SAST` : 'Not yet reported';
const taskCounts = tasks => ({ open: tasks.filter(task => !terminal(task.status)).length,
  active: tasks.filter(task => task.status === 'in_progress').length,
  blocked: tasks.filter(task => task.status === 'blocked').length,
  review: tasks.filter(task => task.status === 'in_review').length });
export const taskRowStyle = (task, overlay = false, context = false) => ({
  color: task.status === 'blocked' ? 'yellow' : task.status === 'in_progress' ? 'cyan'
    : task.status === 'in_review' ? 'magenta' : undefined,
  dimColor: overlay || terminal(task.status) || context,
});

function StatusModal({ modal, setModal, submit, width, height }) {
  const status = modal.options[modal.index];
  const fields = ['status', ...(status === 'blocked' && modal.needsDescriptor ? ['owner', 'action'] : []), ...(status === 'delete' ? [] : ['comment'])];
  const { width: modalWidth, height: modalHeight } = modalSize(width, height, 72, 24);
  const contentWidth = Math.max(1, modalWidth - 6), viewport = Math.max(1, modalHeight - 8);
  const content = [];
  const add = (text, field, option) => wrapBoardText(text, contentWidth).forEach(line => content.push({ text: line, field, option }));
  if (modal.confirm) add(status === 'delete' ? `Confirm permanent deletion of ${modal.task.identifier || modal.task.id}. This cannot be undone.`
    : `Confirm ${labels[modal.task.status] || modal.task.status} → ${labels[status]}`, 'confirm');
  else modal.options.forEach((value, index) => add(`${modal.index === index ? '●' : '○'} ${labels[value]}`, 'status', index));
  if (status === 'blocked' && modal.needsDescriptor) {
    add(`Waiting on ${modal.owner === 'board' ? 'Board' : 'Me'}`, 'owner');
    add(`Required action\n${modal.action}${!modal.confirm && modal.field === 'action' ? '▏' : ''}`, 'action');
  }
  if (status !== 'delete') add(`Comment (optional) · ${modal.comment.length}/4000 · ${wrapBoardText(modal.comment, contentWidth).length} lines\n${modal.comment}${!modal.confirm && modal.field === 'comment' ? '▏' : ''}`, 'comment');
  const focused = content.findLastIndex(line => line.field === modal.field && (line.option === undefined || line.option === modal.index));
  const maxScroll = Math.max(0, content.length - viewport);
  const start = modal.scroll === undefined ? modal.confirm ? 0 : Math.max(0, Math.min(maxScroll, focused - viewport + 1)) : Math.min(modal.scroll, maxScroll);
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.escape) {
      if (modal.confirm) setModal(value => ({ ...value, confirm: false, scroll: undefined })); else setModal(null);
      return;
    }
    if (key.pageDown || key.pageUp) { setModal(value => ({ ...value, scroll: Math.max(0, Math.min(maxScroll, start + (key.pageDown ? viewport : -viewport))) })); return; }
    if (modal.confirm) { if (key.return || input === '\r' || input === '\n') void submit(modal); return; }
    if (key.tab) { setModal(value => ({ ...value, field: fields[(fields.indexOf(value.field) + (key.shift ? fields.length - 1 : 1)) % fields.length], scroll: undefined })); return; }
    if (modal.field === 'status' && (key.upArrow || key.downArrow || input === 'j' || input === 'k')) {
      const delta = key.downArrow || input === 'j' ? 1 : -1;
      setModal(value => ({ ...value, index: Math.max(0, Math.min(modal.options.length - 1, value.index + delta)), scroll: undefined })); return;
    }
    if (modal.field === 'owner' && (key.upArrow || key.downArrow || input === 'j' || input === 'k' || input === ' ')) {
      setModal(value => ({ ...value, owner: value.owner === 'board' ? 'me' : 'board' })); return;
    }
    if ((key.return || input === '\r' || input === '\n') && !key.shift) {
      if (status === 'blocked' && modal.needsDescriptor && !modal.action.trim()) {
        setModal(value => ({ ...value, error: 'Required action is needed for Blocked' }));
      } else setModal(value => ({ ...value, confirm: true, error: '', scroll: 0 }));
      return;
    }
    if (['action', 'comment'].includes(modal.field)) {
      const field = modal.field, limit = field === 'action' ? 2000 : 4000;
      const next = appendBoardInput(modal[field], input, key, limit);
      if (next !== modal[field]) setModal(value => ({ ...value, [field]: next, scroll: undefined }));
    }
  });
  return h(Box, { position: 'absolute', width: modalWidth, height: modalHeight,
    left: Math.max(0, Math.floor((width - modalWidth) / 2)), top: Math.max(0, Math.floor((height - modalHeight) / 2)),
    borderStyle: 'round', borderColor: 'cyan', backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' },
  h(BoardText, { text: `Change status · ${modal.task.identifier || modal.task.id}\n${modal.field === 'comment' ? `Comment (optional) · ${modal.comment.length}/4000 · ${wrapBoardText(modal.comment, contentWidth).length} lines` : ''}`,
    columns: contentWidth, rows: 2, bold: true, color: 'cyan' }),
  h(Box, { height: viewport, flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }, ...content.slice(start, start + viewport).map((line, index) =>
    h(Text, { key: index, wrap: 'truncate-end', inverse: !modal.confirm && line.field === modal.field && (line.option === undefined || line.option === modal.index) }, line.text || ' '))),
  h(BoardText, { text: modal.error || `${start + 1}-${Math.min(content.length, start + viewport)}/${content.length}`, columns: contentWidth, rows: 1, color: modal.error ? 'red' : 'gray' }),
  h(Text, { dimColor: true, wrap: 'wrap' }, modal.confirm ? 'PgUp/Dn inspect · Enter apply · Esc back' : '↑↓ select · Tab field · PgUp/Dn · Enter review · Esc cancel'));
}

function AssignmentModal({ modal, setModal, submit, width, height }) {
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.escape) { setModal(null); return; }
    if (key.downArrow || input === 'j') setModal(value => ({ ...value, index: Math.min(value.agents.length - 1, value.index + 1) }));
    if (key.upArrow || input === 'k') setModal(value => ({ ...value, index: Math.max(0, value.index - 1) }));
    if (key.return || input === '\r' || input === '\n') void submit(modal);
  });
  const modalWidth = Math.max(8, Math.min(72, width - 2));
  return h(Box, { position: 'absolute', width: modalWidth, height: Math.min(height - 2, Math.max(9, modal.agents.length + 6)),
    left: Math.max(0, Math.floor((width - modalWidth) / 2)), top: Math.max(0, Math.floor((height - Math.max(9, modal.agents.length + 6)) / 2)),
    borderStyle: 'round', borderColor: 'cyan', backgroundColor: 'black', paddingX: 2, flexDirection: 'column' },
  h(Text, { bold: true, color: 'cyan' }, `Assign · ${modal.task.identifier || modal.task.id}`),
  h(Box, { height: 1 }),
  ...modal.agents.map((agent, index) => h(Text, { key: agent.id, inverse: modal.index === index,
    bold: modal.index === index, color: modal.index === index ? 'cyan' : undefined },
  `${modal.index === index ? '●' : '○'} ${agent.name || agent.id} · ${agent.availability}`)),
  modal.error ? h(Text, { color: 'red' }, modal.error) : null,
  h(Box, { flexGrow: 1 }), h(Text, { dimColor: true }, '↑↓ select · Enter assign · Esc cancel'));
}

function ReviewModal({ modal, setModal, submit, width, height }) {
  const { width: modalWidth, height: modalHeight } = modalSize(width, height, 72, 24);
  const columns = Math.max(1, modalWidth - 6), viewport = Math.max(1, modalHeight - 8);
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.escape) {
      if (modal.confirm) setModal(value => ({ ...value, confirm: false })); else setModal(null);
      return;
    }
    if (key.pageDown || key.pageUp) { setModal(value => ({ ...value, scroll: Math.max(0, (value.scroll || 0) + (key.pageDown ? viewport : -viewport)) })); return; }
    if (modal.confirm) { if (key.return || input === '\r' || input === '\n') void submit(modal); return; }
    if (modal.decision === 'reject') {
      if ((key.return || input === '\r' || input === '\n') && !key.shift) {
        if (modal.reason.trim()) setModal(value => ({ ...value, confirm: true, error: '' }));
        else setModal(value => ({ ...value, error: 'Rejection feedback is required' }));
        return;
      }
      const reason = appendBoardInput(modal.reason, input, key, 4000);
      if (reason !== modal.reason) setModal(value => ({ ...value, reason, scroll: 0 }));
      return;
    }
    if (key.return || input === '\r' || input === '\n') setModal(value => ({ ...value, confirm: true }));
  });
  return h(Box, { position: 'absolute', width: modalWidth, height: modalHeight,
    left: Math.max(0, Math.floor((width - modalWidth) / 2)), top: Math.max(0, Math.floor((height - modalHeight) / 2)),
    borderStyle: 'round', borderColor: 'magenta', backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' },
  h(BoardText, { text: `${modal.decision === 'accept' ? 'Approve' : 'Reject'} · ${modal.identifier}`, columns, rows: 2, bold: true, color: 'magenta' }),
  h(BoardText, { text: `Candidate ${modal.candidate}\n\nFeedback\n${modal.reason}${!modal.confirm ? '▏' : ''}${modal.error ? `\nError: ${modal.error}` : ''}`,
    columns, rows: viewport, scroll: modal.scroll || 0, tail: !modal.confirm && !modal.scroll }),
  modal.confirm ? h(Text, { bold: true, color: 'magenta' }, `Confirm ${modal.decision}`) : null,
  h(Box, { flexGrow: 1 }),
  h(Text, { dimColor: true }, modal.confirm ? 'Enter apply · Esc back' : modal.decision === 'reject' ? 'Type feedback · Enter review · Esc cancel' : 'Enter review · Esc cancel'));
}

function AgentDetailModal({ detail, close, width, height }) {
  const [scroll, setScroll] = useState(0), [technical, setTechnical] = useState(false);
  const { width: w, height: size } = modalSize(width, height, 100, 26), viewport = Math.max(1, size - 8);
  const agent = detail.data?.agent;
  const lines = (agent ? [
    `Agent: ${agent.displayName || agent.name || 'Unknown agent'}`,
    `Mode: ${agent.mode || 'Unknown'}`, `Availability: ${agent.availabilityLabel || 'Unknown or stale'}`,
    `Node: ${agent.nodeName || 'Unknown node'}${agent.locality === 'local' ? ' (local node)' : agent.locality === 'remote' ? ' (remote node)' : ''}`, `Workspace: ${agent.directory || 'Not advertised'}`,
    `Machine: ${agent.machineName || 'Not advertised'}${agent.machinePlatform ? ` (${agent.machinePlatform})` : ''}`,
    `Agent last seen: ${lastSeenLabel(agent.lastSeenAt)}`, `Node last seen: ${lastSeenLabel(agent.nodeLastSeenAt)}`,
    `Capabilities: ${agent.capabilities?.length ? agent.capabilities.join(', ') : 'None advertised'}`,
    ...(agent.standingGrant ? [`Receiving chat: ${agent.conversationId || 'Not attached'}`, `Receiver generation: ${agent.bindingRevision ?? 0}`,
      `Persistent schedules: ${detail.data.persistentSchedules ?? 0}`,
      ...(detail.data.historicalAttempts?.length ? [`Historical pinned attempts: ${detail.data.historicalAttempts.length}. Attachment does not move or replay them.`] : [])] : []),
    '', 'Directory availability is advisory. It does not grant dispatch authority.', '',
    `Outstanding tasks (${detail.data.tasks.length})`,
    ...(detail.data.tasks.length ? detail.data.tasks.flatMap(t => [t.title, `  ${t.attentionLabel || 'State unavailable'}`]) : ['No outstanding tasks reported.']),
    ...(technical ? ['', `Agent identity: ${agent.id}`, `Node identity: ${agent.nodeId}`, `Conversation identity: ${agent.conversationId || 'None advertised'}`,
      `Binding revision: ${agent.bindingRevision ?? 'Unknown'}`, `Last reported availability: ${agent.reportedAvailability || 'unknown'}`] : []),
  ] : [detail.error ? `Agent detail unavailable: ${detail.error}` : 'Loading agent…']).flatMap(line => wrapBoardText(line, w - 6));
  const start = Math.min(scroll, Math.max(0, lines.length - viewport));
  useInput((input, key) => {
    if (key.escape || key.return || input === 'q') { close(); return; }
    if (input === 't') { setTechnical(value => !value); setScroll(0); return; }
    if (key.downArrow || input === 'j') setScroll(value => Math.min(Math.max(0, lines.length - viewport), value + 1));
    if (key.upArrow || input === 'k') setScroll(value => Math.max(0, value - 1));
    if (key.pageDown) setScroll(value => Math.min(Math.max(0, lines.length - viewport), value + viewport));
    if (key.pageUp) setScroll(value => Math.max(0, value - viewport));
  });
  return h(Box, { position: 'absolute', width: w, height: size, left: Math.max(0, Math.floor((width - w) / 2)), top: Math.max(0, Math.floor((height - size) / 2)),
    borderStyle: 'round', borderColor: 'cyan', backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' },
  h(Text, { bold: true, color: 'cyan' }, 'Agent details'),
  h(Box, { height: viewport, flexDirection: 'column', overflow: 'hidden' }, ...lines.slice(start, start + viewport).map((line, i) => h(Text, { key: i, wrap: 'truncate-end' }, line || ' '))),
  h(Box, { flexGrow: 1 }), h(Text, { dimColor: true }, `${start + 1}-${Math.min(lines.length, start + viewport)}/${lines.length}`),
  h(Text, { dimColor: true, wrap: 'truncate-end' }, 'j/k · PgUp/PgDn · t details · Esc close'));
}

function DetailModal({ detail, close, openOccurrence, openAction, review, openRunResultNotifications, width, height }) {
  const actions = detail.data?.actions ?? [];
  const taskTabs = [...(actions.length ? ['Actions'] : []), 'Overview', 'Result', 'Comments', ...(detail.data?.activity ? ['Activity'] : [])];
  const [tab, setTab] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);
  const [technical, setTechnical] = useState(false);
  const [scrolls, setScrolls] = useState({ Overview: 0, Result: 0, Comments: 0, Routine: 0 });
  const detailId = detail.row?.taskId ?? detail.row?.routine?.id ?? detail.data?.task?.id ?? detail.data?.scheduleId;
  useEffect(() => {
    setTab(0); setActionIndex(0); setTechnical(false); setScrolls({ Overview: 0, Result: 0, Comments: 0, Routine: 0 });
  }, [detail.kind, detailId]);
  const { width: modalWidth, height: modalHeight } = modalSize(width, height, 100, 26);
  const contentWidth = Math.max(1, modalWidth - 6);
  const title = detail.kind === 'task' ? detail.data?.actions !== undefined ? decisionText(detail.data?.task?.title) : `${detail.data?.task?.identifier || detail.data?.task?.id || 'Task'} · ${detail.data?.task?.title || ''}`
    : `CRON · ${detail.data?.title || ''}`;
  const titleRows = Math.min(3, wrapBoardText(title, contentWidth).length);
  const tabsText = taskTabs.map((name, i) => tab === i ? `[${name}]` : name).join(' · ');
  const tabsRows = wrapBoardText(tabsText, contentWidth).length;
  const footerText = detail.kind === 'task' ? `${actions.length && taskTabs[tab] === 'Actions' ? 'Enter act · ' : detail.data?.review ? 'A approve · F/R reject · ' : ''}↑↓ scroll · PgUp/PgDn · Home/End · Tab section · Esc close`
    : '↑↓ scroll · PgUp/PgDn · [/] occurrences · n notices · o task · Esc close';
  const footerRows = wrapBoardText(footerText, contentWidth).length;
  const viewportHeight = Math.max(1, modalHeight - 2 - titleRows - footerRows - 2 - (detail.kind === 'task' ? tabsRows + 1 : 0));
  const wrapLines = value => wrapBoardText(value, contentWidth);
  let content = [], taskSections;
  if (!detail.loading && !detail.error && detail.kind === 'task') {
    const task = detail.data.task;
    const result = detail.data.result;
    taskSections = {
      Actions: [task.attentionLabel || 'Needs your attention', '', ...actions.flatMap((item, i) => [
        `${i === actionIndex ? '›' : ' '} ${item.kind === 'question' ? 'Answer question' : item.kind === 'review' ? 'Review result' : 'Acknowledge reminder'}`,
        ...wrapLines(item.summary), ''])],
      Overview: [...(task.reference ? [`Reference: ${task.reference}`, ...(task.source?.metadata?.identifier ? [`Imported alias: ${task.source.metadata.identifier}`] : []), ''] : []),
        'Title', ...wrapLines(task.title), '', ...(task.originKind === 'routine_execution' ? [`Routine occurrence ${task.originRunId}`, ''] : []),
        ...(task.attentionLabel ? [task.attentionLabel, `Responsible: ${task.responsibleName || task.responsibleUserId || 'Not set'}`, `Worker: ${task.executionAgentName || 'None'}`, ''] : []),
        ...(task.executionNodeName ? [`Node: ${task.executionNodeName}`, `Machine: ${task.executionMachineName || 'Not advertised'}`, ''] : []),
        'Summary', '', ...wrapLines(task.description || 'No description.'), ...(technical ? ['', `Task identity: ${task.id}`] : [])],
      Result: result ? ['Submitted result', '', ...wrapLines(result.summary), '',
        ...(detail.data.actions !== undefined && !technical ? ['Exact candidate identity: press t for technical details'] : [`Candidate  ${result.candidate}`]),
        ...(result.deliverables ? ['', 'Deliverables', ...wrapLines(JSON.stringify(result.deliverables))] : []),
        ...(result.checks ? ['', 'Checks', ...wrapLines(JSON.stringify(result.checks))] : [])] : ['No Relay result.'],
      Comments: detail.data.comments?.length ? detail.data.comments.flatMap((comment, index) => [
        `${comment.authorUserId || comment.authorAgentId || 'system'}${comment.createdAt ? ` · ${comment.createdAt}` : ''}`,
        ...wrapLines(comment.body), ...(index < detail.data.comments.length - 1 ? [''] : [])]) : ['No comments.'],
      Activity: detail.data.activity?.length ? detail.data.activity.flatMap(wrapLines) : ['No recorded interactions.'],
    };
    content = taskSections[taskTabs[tab]];
  }
  const routineLayout = detail.kind === 'routine' && detail.data && !detail.loading && !detail.error
    ? routineDetailLayout(detail.data, detail.occurrences, contentWidth) : null;
  content = routineLayout ? routineLayout.lines.map(line => line.text) : content.flatMap(wrapLines);
  if (detail.error) content = wrapLines(`Detail failed: ${detail.error}`);
  const scrollKey = detail.kind === 'task' ? taskTabs[tab] : 'Routine';
  const scroll = Math.min(scrolls[scrollKey] ?? 0, Math.max(0, content.length - viewportHeight));
  const setScroll = update => setScrolls(value => ({ ...value,
    [scrollKey]: typeof update === 'function' ? update(value[scrollKey] ?? 0) : update }));
  const maxScroll = Math.max(0, content.length - viewportHeight);
  useInput((input, key) => {
    if (detail.kind === 'routine' && input === 'n') { openRunResultNotifications?.(detail.data); return; }
    if (detail.kind === 'task' && input === 't') { setTechnical(value => !value); return; }
    if (detail.kind === 'task' && taskTabs[tab] === 'Actions') {
      if (key.return) { void openAction(actions[actionIndex]); return; }
      if (key.downArrow || input === 'j') { setActionIndex(value => Math.min(actions.length - 1, value + 1)); return; }
      if (key.upArrow || input === 'k') { setActionIndex(value => Math.max(0, value - 1)); return; }
    }
    if (detail.kind === 'task' && ['A', 'F', 'R'].includes(input)) { review(input); return; }
    if (key.escape || input === 'q' || input === '\r' || input === '\n') close();
    if (detail.kind === 'task' && (key.tab || input === '\t')) {
      setTab(value => (value + (key.shift ? taskTabs.length - 1 : 1)) % taskTabs.length);
      return;
    }
    const move = delta => {
      const next = Math.max(0, Math.min(maxScroll, scroll + delta)); setScroll(next);
      if (routineLayout) {
        const index = routineLayout.lines.slice(next, next + viewportHeight).find(line => line.occurrenceIndex !== undefined)?.occurrenceIndex;
        if (index !== undefined) detail.setOccurrence(index);
      }
    };
    if (routineLayout && (input === '[' || input === ']')) {
      const next = Math.max(0, Math.min(detail.occurrences.length - 1, detail.occurrence + (input === ']' ? 1 : -1)));
      detail.setOccurrence(next); setScroll(Math.min(maxScroll, routineLayout.ranges[next]?.start ?? 0)); return;
    }
    if (key.downArrow || input === 'j') move(1);
    if (key.upArrow || input === 'k') move(-1);
    if (key.pageDown) move(viewportHeight);
    if (key.pageUp) move(-viewportHeight);
    if (key.home) { setScroll(0); if (detail.kind === 'routine') detail.setOccurrence(0); }
    if (key.end) { setScroll(maxScroll); if (detail.kind === 'routine') detail.setOccurrence(Math.max(0, detail.occurrences.length - 1)); }
    if (detail.kind === 'routine' && input === 'o') void openOccurrence();
  });
  const box = { position: 'absolute', width: modalWidth, height: modalHeight,
    left: Math.max(0, Math.floor((width - modalWidth) / 2)), top: Math.max(0, Math.floor((height - modalHeight) / 2)),
    borderStyle: 'round', borderColor: 'magenta', backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' };
  if (detail.loading) return h(Box, box, h(Text, { color: 'magenta' }, 'Loading detail...'));
  if (detail.error) return h(Box, box, h(Text, { color: 'red' }, 'Detail unavailable'),
    h(BoardText, { text: `Detail failed: ${detail.error}`, columns: contentWidth, rows: viewportHeight, scroll, color: 'red' }),
    h(Text, { dimColor: true }, 'PgUp/PgDn · Esc close'));
  if (detail.kind === 'task') {
    const task = detail.data.task;
    return h(Box, box,
      h(BoardText, { text: title, columns: contentWidth, rows: titleRows, bold: true, color: 'magenta' }),
      h(Text, { dimColor: true }, `${task.status} · ${task.responsibleName || 'Human responsibility'}`),
      h(BoardText, { text: tabsText, columns: contentWidth, rows: tabsRows, color: 'cyan' }),
      h(Box, { height: viewportHeight, flexDirection: 'column', overflow: 'hidden', marginTop: 1 },
        ...content.slice(scroll, scroll + viewportHeight).map((line, index) => h(Text, { key: `${scroll}:${index}`,
          bold: ['Summary', 'Submitted result', 'Deliverables', 'Checks'].includes(line),
          color: line.startsWith('Routine occurrence ') ? 'cyan' : undefined,
          dimColor: ['No comments.', 'No Relay result.'].includes(line) }, line || ' '))),
      h(BoardText, { text: footerText, columns: contentWidth, rows: footerRows, dimColor: true }),
      h(Text, { dimColor: true }, `${content.length ? scroll + 1 : 0}-${Math.min(content.length, scroll + viewportHeight)}/${content.length}`));
  }
  const occurrences = detail.occurrences;
  return h(Box, box,
    h(BoardText, { text: title, columns: contentWidth, rows: titleRows, bold: true, color: 'magenta' }),
    h(Box, { height: viewportHeight, flexDirection: 'column', overflow: 'hidden', marginTop: 1 },
      ...content.slice(scroll, scroll + viewportHeight).map((line, index) => {
        const meta = routineLayout.lines[scroll + index], occurrenceIndex = meta.occurrenceIndex, entry = occurrences[occurrenceIndex];
        return h(Text, { key: `${scroll}:${index}`, wrap: 'truncate-end', bold: meta.heading, inverse: occurrenceIndex !== undefined && occurrenceIndex === detail.occurrence,
          color: entry?.task ? 'cyan' : entry?.mismatch ? 'red' : undefined }, line || ' ');
      })),
    h(BoardText, { text: footerText, columns: contentWidth, rows: footerRows, dimColor: true }),
    h(Text, { dimColor: true }, `${content.length ? scroll + 1 : 0}-${Math.min(content.length, scroll + viewportHeight)}/${content.length}`));
}

export function TaskBoardInkApp({ read, inspectTask, detailTask, detailAgent, detailRoutine, reviewTask, detailInbox, decideInbox, pendingDecisions,
  detailGrant, decideGrant, createGrant, pendingGrantDecisions, updateRunResultNotifications, dispatchTask, prepareHandback, handbackTask, assignTask, statusTask, deleteTask, onQuit, interval = 5000, width: fixedWidth, height: fixedHeight }) {
  const window = useWindowSize(); const { exit } = useApp();
  const width = fixedWidth ?? window.columns ?? 100, height = fixedHeight ?? window.rows ?? 30;
  const [board, setBoard] = useState(() => ({ companies: [], agents: [], projects: [], tasks: [], routines: [],
    ...(pendingDecisions ? { inbox: pendingDecisions() } : {}), grants: { pending: [], active: [], history: [] }, nodes: [], fetchedAt: null, warnings: [] }));
  const native = Array.isArray(board.inbox);
  const [view, setView] = useState('tasks');
  const [selectedNativeId, setSelectedNativeId] = useState(null);
  const [decisionModal, setDecisionModal] = useState(null);
  const [settingsModal, setSettingsModal] = useState(null);
  const [decisionReceipt, setDecisionReceipt] = useState(null);
  const [offline, setOffline] = useState(''); const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState(0); const [modal, setModal] = useState(null);
  const [rowScroll, setRowScroll] = useState(0);
  useEffect(() => { setRowScroll(0); }, [selected, selectedNativeId, view, width, height]);
  const [assignment, setAssignment] = useState(null); const [reviewModal, setReviewModal] = useState(null);
  const [reviewFeedback, setReviewFeedback] = useState('');
  const [quitting, setQuitting] = useState(false);
  const [notice, updateNotice] = useState(null); const [showDone, setShowDone] = useState(false);
  const setNotice = text => updateNotice(text ? { text } : null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => updateNotice(null), 2000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [showIdle, setShowIdle] = useState(false); const [filter, setFilter] = useState(''); const [searching, setSearching] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set()); const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [detail, setDetail] = useState(null); const [occurrence, setOccurrence] = useState(0);
  useEffect(() => {
    let disposed = false, timer, active;
    const refresh = async () => {
      try {
        active = new AbortController(); const value = await read(active.signal);
        if (!disposed) { setBoard({ ...value, routines: value.routines ?? [], warnings: value.warnings ?? [] }); setOffline(''); setLoaded(true); }
      }
      catch (error) { if (!disposed) {
        setOffline(clean(error.message || error.code || 'offline'));
        if (pendingDecisions) setBoard(value => ({ ...value, inbox: [...pendingDecisions(), ...(value.inbox ?? []).filter(i => i.kind !== 'publication')] }));
        if (pendingGrantDecisions) setBoard(value => ({ ...value, grants: { ...value.grants,
          pending: [...pendingGrantDecisions(), ...(value.grants?.pending ?? []).filter(i => i.kind !== 'publication')] } }));
      } }
      if (!disposed) timer = setTimeout(refresh, interval);
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); active?.abort(); };
  }, [read, interval, refreshGeneration, pendingDecisions, pendingGrantDecisions]);
  const taskRows = useMemo(() => {
    const all = buildBoardRows(board, { showDone, showIdle, filter });
    const expanded = new Set(all.filter(row => row.expandable && !collapsed.has(row.id)).map(row => row.id));
    const rows = buildBoardRows(board, { showDone, showIdle, filter, expanded });
    return native ? rows.filter(row => row.type !== 'group' || row.counts.total > 0) : rows;
  }, [board, showDone, showIdle, filter, collapsed]);
  const routineRows = useMemo(() => board.routines.filter(routine => showDone || routine.state !== 'cancelled')
    .map(routine => ({ id: `cron:${routine.id}`, type: 'routine', routine })), [board.routines, showDone]);
  const inboxRows = useMemo(() => (board.inbox ?? []).filter(item => !filter || decisionText(`${item.title} ${item.summary} ${item.from} ${item.stateLabel}`).toLowerCase().includes(filter.toLowerCase()))
    .map(item => ({ id: item.id, type: 'inbox', item })), [board.inbox, filter]);
  const agentRows = useMemo(() => buildAgentRows(board, { filter, collapsed }), [board.agents, board.localNode, filter, collapsed]);
  const rows = useMemo(() => native ? view === 'inbox' ? inboxRows : view === 'agents' ? agentRows : view === 'schedules' ? routineRows : taskRows : [
    ...(routineRows.length ? [{ id: 'section:cron', type: 'section', label: `CRON · ${routineRows.length}` }, ...routineRows] : []),
    { id: 'section:tasks', type: 'section', label: `TASKS · ${taskRows.filter(row => row.type === 'task').length}` },
    ...taskRows,
  ], [native, view, inboxRows, agentRows, routineRows, taskRows]);
  const nativeIndex = selectedNativeId ? rows.findIndex(row => row.id === selectedNativeId) : -1;
  const selectedIndex = native ? nativeIndex >= 0 ? nativeIndex : Math.min(selected, Math.max(0, rows.length - 1)) : rows[selected]?.type === 'section'
    ? Math.max(0, rows.findIndex((row, index) => index >= selected && row.type !== 'section')) : selected;
  useEffect(() => {
    if (native && nativeIndex < 0 && rows[selectedIndex]) setSelectedNativeId(rows[selectedIndex].id);
  }, [native, nativeIndex, rows, selectedIndex]);
  useEffect(() => { setSelected(value => {
    value = Math.max(0, Math.min(rows.length - 1, value));
    if (rows[value]?.type !== 'section') return value;
    const next = rows.findIndex((row, index) => index >= value && row.type !== 'section');
    return next >= 0 ? next : Math.max(0, rows.findLastIndex(row => row.type !== 'section'));
  }); }, [rows]);
  const openInbox = async item => {
    if (!item || !detailInbox || !decideInbox) { setNotice('Decision interface unavailable'); return; }
    const requestId = randomUUID();
    setDecisionModal({ item: { ...item, summary: 'Loading current decision…', disabled: true }, requestId, stage: 'inspect', index: 0,
      text: '', scroll: 0, technical: false, key: `human-board:${randomUUID()}`, error: '', busy: true });
    try {
      const fresh = await detailInbox({ id: item.id });
      setDecisionModal(value => value?.requestId === requestId ? { ...value, item: fresh, busy: false,
        stage: !fresh.disabled && ['question', 'review'].includes(fresh.kind) ? 'edit' : 'inspect', field: fresh.kind === 'review' ? 'decision' : 'text' } : value);
    } catch (error) {
      setDecisionModal(value => value?.requestId === requestId ? { ...value, busy: false, error: decisionText(error.message) } : value);
    }
  };
  const submitDecision = async current => {
    setDecisionModal({ ...current, busy: true, locked: true, error: '' });
    try {
      const result = await decideInbox({ item: current.item, key: current.key, body: current.text,
        decision: current.index === 0 ? 'accept' : 'reject', reason: current.text });
      if (result.state !== 'recorded') throw Error('Decision is not confirmed');
      setDecisionModal(null); setDetail(null); setNotice('');
      setDecisionReceipt({ message: result.message || 'Decision recorded', title: current.item.title, kind: current.item.kind });
      setView('inbox'); setFilter(''); setSearching(false); setSelected(0); setSelectedNativeId(null);
      setBoard(value => ({ ...value, inbox: (value.inbox ?? []).filter(item => item.id !== current.item.id) }));
      setRefreshGeneration(value => value + 1);
    } catch (error) {
      setDecisionModal({ ...current, busy: false, locked: true, error: decisionText(error.message || 'Publication is not confirmed. Inspect Inbox.') });
      if (pendingDecisions) setBoard(value => ({ ...value, inbox: [...pendingDecisions(), ...(value.inbox ?? []).filter(i => i.kind !== 'publication')] }));
    }
  };
  const openRunResultNotifications = routine => {
    if (!updateRunResultNotifications || !routine || routine.intent === 'reminder' || routine.state === 'cancelled') { setNotice('Run result settings unavailable'); return; }
    setSettingsModal({ scheduleId: routine.id, expectedRevision: routine.revision,
      policy: { inbox: !!routine.runResultNotifications?.inbox, requester: !!routine.runResultNotifications?.requester },
      index: 0, confirm: false, key: `run-result-settings:${randomUUID()}`, busy: false, error: '' });
    setDetail(null);
  };
  const submitRunResultNotifications = async current => {
    setSettingsModal({ ...current, busy: true, error: '' });
    try {
      const result = await updateRunResultNotifications(current);
      if (result.state !== 'recorded') throw Error('Settings publication is not confirmed');
      setSettingsModal(null); setNotice(result.message); setRefreshGeneration(value => value + 1);
    } catch (error) { setSettingsModal({ ...current, busy: false, locked: true, error: clean(error.message || 'Inspect the original settings publication in Inbox') }); }
  };
  const submit = async current => {
    const status = current.options[current.index]; setModal({ ...current, busy: true, error: '' });
    try {
      if (status === 'delete') {
        const result = await deleteTask({ companyId: current.task.companyId, taskId: current.task.id,
          expectedRevision: current.revision, key: current.key, reason: 'Deleted from the Ink task board' });
        if (result.state !== 'recorded' || result.deleted !== true || result.outcome?.confirmed !== true ||
          result.task?.id !== current.task.id || result.task?.companyId !== current.task.companyId) throw Error('Deletion is not confirmed');
        setBoard(value => ({ ...value, tasks: value.tasks.filter(task => task.id !== current.task.id || task.companyId !== current.task.companyId) }));
        setNotice(`Deleted ${current.task.identifier || current.task.id}`); setModal(null);
        setRefreshGeneration(value => value + 1);
        return;
      }
      const payload = { status, ...(current.comment.trim() ? { comment: current.comment.trim() } : {}) };
      if (status === 'blocked' && current.needsDescriptor) payload.unblockDescriptor = {
        owner: current.owner === 'board' ? 'board' : { userId: current.task.assigneeUserId }, action: current.action.trim(),
      };
      const result = await statusTask({ companyId: current.task.companyId, taskId: current.task.id,
        expectedRevision: current.revision, key: current.key, reason: 'Status changed from the Ink task board', payload });
      if (result.state !== 'recorded' || result.outcome?.confirmed !== true || result.task?.status !== status) throw Error('Status change is not confirmed');
      setBoard(value => ({ ...value, tasks: value.tasks.map(task => task.id === current.task.id && task.companyId === current.task.companyId
        ? { ...task, status } : task) }));
      setNotice(`Changed ${current.task.identifier || current.task.id} to ${labels[status]}`); setModal(null);
    } catch (error) { setModal({ ...current, busy: false, error: clean(error.message || error.code || 'status failed') }); }
  };
  const submitAssignment = async current => {
    const agent = current.agents[current.index]; setAssignment({ ...current, busy: true, error: '' });
    try {
      if (current.native) {
        if (agent.kind === 'human') {
          const result = await handbackTask({ ...current.preview, key: current.key, reason: current.text });
          if (result.state !== 'recorded') throw Error('Handback is not confirmed');
          setNotice(result.message); setAssignment(null); setRefreshGeneration(value => value + 1); return;
        }
        const result = await dispatchTask({ taskId: current.task.id, expectedRevision: current.task.revision, instanceId: current.task.instanceId, key: current.key,
          payload: { targetAgentId: agent.id, instructions: current.text } });
        if (result.state !== 'recorded' || result.execution?.targetAgentId !== agent.id || result.execution?.taskId !== current.task.id) throw Error('Execution request is not confirmed');
        setNotice(result.message); setAssignment(null); setRefreshGeneration(value => value + 1); return;
      }
      const snapshot = await inspectTask({ companyId: current.task.companyId, taskId: current.task.id });
      if (snapshot.task?.id !== current.task.id || snapshot.task.companyId !== current.task.companyId || !snapshot.revision) throw Error('Assignment preview identity is not confirmed');
      const result = await assignTask({ companyId: current.task.companyId, taskId: current.task.id,
        expectedRevision: snapshot.revision, key: randomUUID(), reason: 'Assigned from the Ink task board', payload: { assigneeAgentId: agent.id } });
      if (result.outcome?.confirmed !== true || result.task?.assigneeAgentId !== agent.id) throw Error('Assignment is not confirmed');
      setBoard(value => ({ ...value, tasks: value.tasks.map(task => task.id === current.task.id && task.companyId === current.task.companyId
        ? { ...task, assigneeAgentId: agent.id, assigneeUserId: null } : task) }));
      setNotice(`Assigned ${current.task.identifier || current.task.id} to ${agent.name || agent.id}`); setAssignment(null);
    } catch (error) {
      const publications = current.native ? pendingDecisions?.() : null;
      const retained = current.native && (publications ? publications.some(item => item.key === current.key) : true);
      setAssignment({ ...current, busy: false, locked: retained, error: clean(error.message || error.code || 'assignment failed') });
      if (publications) setBoard(value => ({ ...value, inbox: [...publications, ...(value.inbox ?? []).filter(item => item.kind !== 'publication')] }));
      if (current.native) setRefreshGeneration(value => value + 1);
    }
  };
  const prepareHuman = async current => {
    setAssignment({ ...current, busy: true, error: '' });
    try {
      if (!prepareHandback || !handbackTask) throw Error('Human handback is unavailable on this board');
      const preview = await prepareHandback({ taskId: current.task.id });
      setAssignment({ ...current, task: preview.task || current.task, busy: false, stage: 'handback', preview, text: '', scroll: 0 });
    } catch (error) { setAssignment({ ...current, busy: false, error: clean(error.message) }); }
  };
  const prepareReview = key => {
    const nativeReview = detail?.data?.actions?.find(item => item.kind === 'review');
    if (nativeReview) { void openInbox(nativeReview); return; }
    const candidate = detail?.data?.review, task = detail?.data?.task;
    if (!candidate || !task || !reviewTask) { setNotice('No pending candidate'); return; }
    if (key === 'R' && !reviewFeedback.trim()) { setNotice('Rejection feedback is required; press F'); return; }
    const decision = key === 'A' ? 'accept' : 'reject';
    setReviewModal({ decision, reason: decision === 'reject' ? reviewFeedback : '', confirm: key === 'A' || key === 'R', busy: false, error: '',
      identifier: task.identifier || task.id, companyId: task.companyId, taskId: task.id, runId: candidate.runId,
      interactionId: candidate.interactionId, candidate: candidate.candidate, expectedRevision: detail.data.revision, key: randomUUID() });
  };
  const submitReview = async current => {
    setReviewModal({ ...current, busy: true, error: '' });
    try {
      const result = await reviewTask({ action: current.decision, companyId: current.companyId, taskId: current.taskId,
        runId: current.runId, interactionId: current.interactionId, candidate: current.candidate,
        expectedRevision: current.expectedRevision, key: current.key, ...(current.reason.trim() ? { reason: current.reason.trim() } : {}) });
      const expected = current.decision === 'accept' ? 'accepted' : 'rejected';
      if (result.state !== 'recorded' || result.receipt?.status !== expected) throw Error('Review decision is not confirmed');
      setReviewFeedback(''); setReviewModal(null); setDetail(null); setNotice(`${current.decision === 'accept' ? 'Approved' : 'Rejected'} ${current.identifier}`);
      setRefreshGeneration(value => value + 1);
    } catch (error) { setReviewModal({ ...current, busy: false, error: clean(error.message || error.code || 'review failed') }); }
  };
  useInput((input, key) => {
    if (native && view === 'grants') return;
    if (modal || assignment || reviewModal || detail || decisionModal || settingsModal) return;
    if (searching) {
      if (key.escape) { setSearching(false); setFilter(''); }
      else if (key.return) setSearching(false);
      else if (key.backspace || key.delete) setFilter(value => [...value].slice(0, -1).join(''));
      else if (input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input)) setFilter(value => value + input);
      setSelected(0); setSelectedNativeId(null); return;
    }
    if (key.escape && decisionReceipt) { setDecisionReceipt(null); return; }
    if (input === 'q' || key.escape) { setQuitting(true); (onQuit ?? exit)(); return; }
    if (input === 'h') { setShowDone(value => !value); return; }
    if (input === 'i') { if (native) setNotice('All enrolled agents, including stale reports, are listed in Agents'); else setShowIdle(value => !value); return; }
    if (input === '/') { setSearching(true); return; }
    if (input === 'r') { setRefreshGeneration(value => value + 1); return; }
    if (native && key.tab) {
      const views = nativeBoardViews;
      setView(value => views[(views.indexOf(value) + (key.shift ? views.length - 1 : 1)) % views.length]);
      setSelected(0); setSelectedNativeId(null); return;
    }
    const move = delta => setSelected(() => {
      let next = selectedIndex;
      do { next = Math.max(0, Math.min(rows.length - 1, next + delta)); }
      while (rows[next]?.type === 'section' && next > 0 && next < rows.length - 1);
      if (native) setSelectedNativeId(rows[next]?.id ?? null);
      return next;
    });
    if (key.upArrow || input === 'k') move(-1);
    if (key.downArrow || input === 'j') move(1);
    if (key.pageDown || key.pageUp) {
      setRowScroll(value => Math.max(0, Math.min(Math.max(0, (rowBlocks[selectedIndex]?.length || 0) - bodyHeight),
        value + (key.pageDown ? 1 : -1) * Math.max(1, bodyHeight - 1)))); return;
    }
    if (input === ' ' || key.leftArrow || key.rightArrow) {
      const row = rows[selectedIndex];
      if (key.leftArrow && row?.type === 'agent' && row.groupId) {
        setSelectedNativeId(row.groupId); setSelected(rows.findIndex(parent => parent.id === row.groupId)); return;
      }
      if (row?.expandable) setCollapsed(value => {
        const next = new Set(value);
        if (key.rightArrow) next.delete(row.id);
        else if (key.leftArrow) next.add(row.id);
        else if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
        return next;
      });
      return;
    }
    if (input === 's') {
      const row = rows[selectedIndex];
      if (row?.type !== 'task') { setNotice('Select a task'); return; }
      void inspectTask({ companyId: row.companyId, taskId: row.taskId }).then(snapshot => {
        if (snapshot.task?.id !== row.taskId || snapshot.task.companyId !== row.companyId || !snapshot.revision) throw Error('Status preview identity is not confirmed');
        const humanOwned = snapshot.task.assigneeUserId && !snapshot.task.assigneeAgentId;
        const pending = snapshot.interactions?.some(item => item.status === 'pending');
        const options = [...(humanOwned && !pending ? statuses : []), ...(deleteTask ? ['delete'] : [])];
        if (!options.length) throw Error(pending ? 'Resolve pending candidate or interaction first' : 'Task must be human-owned');
        setModal({ task: snapshot.task, revision: snapshot.revision, key: randomUUID(), options, index: Math.max(0, options.indexOf(snapshot.task.status)),
          field: 'status', comment: '', action: snapshot.task.unblockDescriptor?.action ?? '',
          owner: snapshot.task.unblockDescriptor?.owner === 'board' ? 'board' : 'me',
          needsDescriptor: !(snapshot.task.blockedByIssueIds?.length || snapshot.task.blockedBy?.length || snapshot.task.unblockDescriptor),
          confirm: false, busy: false, error: '' }); setNotice('');
      }).catch(error => setNotice(`Status unavailable: ${clean(error.message)}`));
    }
    if (native && view === 'schedules' && input === 'n') {
      const row = rows[selectedIndex]; if (row?.type === 'routine') openRunResultNotifications(row.routine); return;
    }
    if (input === 'a') {
      if (native && !dispatchTask) { setNotice('Native execution handover is unavailable'); return; }
      const row = rows[selectedIndex];
      if (row?.type !== 'task') { setNotice('Select a task'); return; }
      let agents = board.agents.filter(agent => agent.companyId === row.companyId && (native
        ? !agent.capabilities?.includes('observation_only') : agent.availability === 'present'))
        .sort((left, right) => (left.locality === 'local' ? 0 : 1) - (right.locality === 'local' ? 0 : 1) ||
          clean(left.nodeName || left.nodeId).localeCompare(clean(right.nodeName || right.nodeId)) ||
          (left.nodeId || '').localeCompare(right.nodeId || '') || clean(left.name || left.id).localeCompare(clean(right.name || right.id)) || left.id.localeCompare(right.id));
      if (native) agents = [{ id: 'human', kind: 'human', displayName: 'You (human)' }, ...agents];
      if (!agents.length) { setNotice('Assignment unavailable: no present agents in this company'); return; }
      setAssignment({ task: row.task, agents, index: Math.max(0, agents.findIndex(agent => agent.id === row.task.assigneeAgentId)), busy: false, error: '',
        ...(native ? { native: true, stage: 'select', text: '', key: `human-dispatch:${randomUUID()}` } : {}) });
      setNotice(''); return;
    }
    if (key.return || input === 'd' || key.tab) {
      const row = rows[selectedIndex]; if (!row || row.type === 'group') return;
      if (row.type === 'machine') {
        setCollapsed(value => { const next = new Set(value); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; }); return;
      }
      if (row.type === 'inbox') { void openInbox(row.item); return; }
      if (row.type === 'section') return;
      const requestId = randomUUID();
      setOccurrence(0); setDetail({ kind: row.type === 'routine' ? 'routine' : row.type === 'agent' ? 'agent' : 'task', row, requestId, loading: true });
      const request = row.type === 'routine'
        ? detailRoutine({ companyId: row.routine.companyId, scheduleId: row.routine.id })
        : row.type === 'agent' ? detailAgent ? detailAgent({ agentId: row.agent.id }) : Promise.reject(Error('Agent detail is unavailable'))
          : detailTask({ companyId: row.companyId, taskId: row.taskId });
      void request.then(data => setDetail(value => value?.requestId === requestId ? { ...value, loading: false, data } : value))
        .catch(error => setDetail(value => value?.requestId === requestId ? { ...value, loading: false, error: clean(error.message || error.code || 'detail failed') } : value));
    }
  });
  const rowText = row => {
    if (row.type === 'section') return row.label;
    if (row.type === 'inbox') return `${row.item.kind === 'question' ? 'Question' : row.item.kind === 'review' ? 'Review' : row.item.kind === 'run_result' ? 'Run result' : row.item.kind === 'reminder' ? 'Reminder' : 'Publication'} · ${decisionText(row.item.title)}  · ${decisionText(row.item.summary)}`;
    if (row.type === 'routine') return `  ◆ ${row.routine.title}  [${row.routine.state}]  ${row.routine.cron}  next ${row.routine.nextRunAt || '-'}`;
    const fold = row.expandable ? row.expanded ? '▾' : '▸' : '·';
    if (row.type === 'group') return `${fold} ${row.name}${row.agent ? ` / ${row.agent.availability || 'unknown'}` : ''}  · ${row.counts.open} open`;
    const guides = row.guides.map(continuation => continuation ? '│ ' : '  ').join('');
    const branch = row.last ? '└─' : '├─';
    const context = row.context ? ` [via ${row.owner}]` : '';
    const anomaly = row.anomaly ? ` [${row.anomaly}]` : '';
    const subtree = row.descendants ? ` [+${row.descendants}/${row.counts.open} open]` : '';
    if (native && row.task.reference) {
      const prefix = `${guides}${branch}${fold} ${row.task.reference}  `;
      // Reference identity takes precedence over optional tree guides and status.
      const safePrefix = prefix.length + 8 <= width - 4 ? prefix : `${row.task.reference}  `;
      return `${safePrefix}${clean(row.task.title)}${anomaly}${subtree}`;
    }
    return `${guides}${branch}${fold} ${native ? '' : `${row.task.identifier || row.task.id}${context}  `}${clean(row.task.title)}${anomaly}${subtree}`;
  };
  const statusLabel = task => native && task.attentionLabel
    ? `${labels[task.status] ?? task.status} · ${decisionText(task.attentionLabel)}` : `[${labels[task.status] ?? task.status}]`;
  const rowBlocks = layoutBoardRows(rows, { columns: width, native, rowText, statusLabel });
  if (quitting) return null;
  if (native && view === 'grants') return h(GrantsPanel, { board, offline, loaded, width, height, detailGrant, decideGrant, createGrant, pendingGrantDecisions,
    refresh: publications => { if (publications) setBoard(value => ({ ...value, grants: { ...value.grants,
      pending: [...publications, ...(value.grants?.pending ?? []).filter(i => i.kind !== 'publication')] } })); setRefreshGeneration(value => value + 1); },
    onView: delta => { setView(value => nativeBoardViews[(nativeBoardViews.indexOf(value) + delta + nativeBoardViews.length) % nativeBoardViews.length]); setSelected(0); setSelectedNativeId(null); },
    onQuit: () => { setQuitting(true); (onQuit ?? exit)(); } });
  const summary = taskCounts(board.tasks);
  const overlay = Boolean(modal || assignment || reviewModal || detail || decisionModal || settingsModal);
  const localAgentCount = board.agents.filter(agent => board.localNode && agent.nodeId === board.localNode.id).length;
  const nativeCounts = view === 'agents'
    ? `${board.localNode ? `Local node: ${clean(board.localNode.name)} · ${localAgentCount} local` : 'Local node: not identified'} · ${board.agents.filter(a => a.mode === 'interactive').length} interactive   ${board.agents.filter(a => a.mode === 'headless').length} headless`
    : view === 'inbox' ? `${board.inbox?.filter(i => i.kind === 'question').length ?? 0} questions   ${board.inbox?.filter(i => i.kind === 'review').length ?? 0} reviews   ${board.inbox?.filter(i => i.kind === 'run_result').length ?? 0} run results   ${board.inbox?.filter(i => i.kind === 'reminder').length ?? 0} reminders`
      : view === 'schedules' ? `${board.routines.filter(r => r.state === 'active').length} active   ${board.routines.filter(r => r.state === 'paused').length} paused`
        : `${summary.open} open   ${summary.active} active   ${summary.blocked} blocked   ${summary.review} in review`;
  const emptyLabel = view === 'inbox' ? offline ? 'Inbox unavailable. Showing last known state.' : !loaded ? 'Loading inbox…' : 'No decisions need your attention.'
    : view === 'agents' ? 'No agents advertised.' : view === 'schedules' ? 'No schedules installed.' : showDone ? 'No matching tasks.' : 'No open tasks.';
  const heading = native ? `RELAY / ${view === 'schedules' ? 'SCHEDULE' : view.toUpperCase()}` : 'RELAY / TASKS';
  const live = `${offline ? 'OFFLINE' : loaded ? '● LIVE' : 'LOADING'}${board.fetchedAt ? ` · last updated ${new Date(board.fetchedAt).toLocaleTimeString('en-GB', { timeZone: 'Africa/Johannesburg', hour12: false })} SAST` : ''}`;
  const header = [heading + ' · ' + (native ? offline ? 'Inbox unavailable: showing cached state' : `${board.agents.length} agents · ${board.inbox.length} need attention` : `${board.companies.length} companies · ${board.agents.length} agents`),
    ...(native ? [nativeBoardTabs(board, offline, loaded).map(([id, title]) => id === view ? `[${title}]` : title).join('  ')] : []),
    native ? `${view === 'agents' && board.localNode ? `LOCAL ${board.localNode.name} · ${localAgentCount} ${localAgentCount === 1 ? 'agent' : 'agents'} · ` : ''}${nativeCounts} · ${live}`
      : `OPEN ${summary.open}  ACTIVE ${summary.active}  BLOCKED ${summary.blocked}  REVIEW ${summary.review}  ${live}`]
    .flatMap(text => wrapBoardText(text, width));
  const footer = (searching ? [`/${filter}▏  Enter apply · Esc clear`] : notice ? [notice.text] : native && decisionReceipt
    ? [`✓ ${decisionReceipt.message}`, decisionReceipt.kind === 'question' ? 'Any required review will appear in this Inbox.' : decisionReceipt.title,
      'Esc dismiss acknowledgement · Tab view · Enter open · q quit']
    : [native ? 'j/k move · Enter open · Tab view · Space fold · / search' : 'j/k move · Enter/Tab detail · Space/←/→ fold · / search',
      native ? view === 'schedules' ? 'n run result notifications · PgUp/Dn · r refresh · q quit'
        : `h done · ${dispatchTask ? 'a assign · ' : ''}PgUp/Dn · r refresh · s status · q quit` : 'h done · i idle · r refresh · a assign · s status · q quit'])
    .flatMap(text => wrapBoardText(text, width));
  const bodyHeight = Math.max(1, height - header.length - footer.length - (native ? 3 : 2));
  const visible = boardRowViewport(rowBlocks, selectedIndex, bodyHeight, rowScroll);
  const background = h(Box, { width, height, flexDirection: 'column' },
    ...header.map((line, index) => h(Text, { key: `header:${index}`, wrap: 'truncate-end', flexShrink: 0, dimColor: overlay, color: index === 0 ? 'cyan' : undefined }, line)),
    h(Box, { borderStyle: native ? 'round' : 'single', borderColor: native || modal || assignment || reviewModal ? 'gray' : 'cyan',
      paddingX: native ? 1 : 0, paddingTop: native ? 1 : 0, flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      !visible.length && native ? h(Box, { flexGrow: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'column' },
        h(Text, { dimColor: true, wrap: 'wrap' }, emptyLabel),
        h(Text, { dimColor: true, wrap: 'wrap' }, view === 'tasks' && !showDone ? 'Press h to include completed tasks.' : 'Tab switches views · r refreshes')) : null,
      ...visible.map((line, index) => {
        const row = rows[line.rowIndex], active = line.rowIndex === selectedIndex && !overlay;
        const taskStyle = row.type === 'task' ? taskRowStyle(row.task, Boolean(modal || assignment || reviewModal || detail), row.context) : null;
        const tone = row.local ? 'green' : ['section', 'group', 'machine', 'agent'].includes(row.type) ? 'cyan' : ['routine', 'inbox'].includes(row.type) ? 'magenta' : taskStyle?.color;
        const dimmed = taskStyle?.dimColor ?? Boolean(modal || assignment || reviewModal || detail);
        const style = { inverse: active, dimColor: dimmed, color: tone, bold: line.heading && ['section', 'group', 'machine', 'inbox', 'routine'].includes(row.type), wrap: 'truncate-end' };
        return h(Box, { key: `${row.id}:${index}`, height: 1, flexShrink: 0 },
          h(Box, { width: line.leftWidth, flexGrow: line.leftWidth ? 0 : 1 }, h(Text, style, line.text ?? line.left ?? ' ')),
          line.rightWidth ? h(Box, { width: line.rightWidth, marginLeft: line.gap }, h(Text, style, line.right)) : null);
      })),
    ...footer.map((line, index) => h(Text, { key: `footer:${index}`, wrap: 'truncate-end', flexShrink: 0, dimColor: overlay || !notice && !decisionReceipt,
      color: notice || decisionReceipt ? 'cyan' : undefined }, line)));
  let detailView = detail;
  if (detail?.kind === 'routine' && detail.data) {
    const tasks = new Map(board.tasks.map(task => [`${task.companyId}:${task.id}`, task]));
    const occurrences = detail.data.runs.map(run => {
      const task = run.linkedIssueId ? tasks.get(`${detail.data.companyId}:${run.linkedIssueId}`) : null;
      const match = task && (run.nativeOccurrence ? run.nativeTaskId === task.id
        : task.origin?.kind === 'routine_execution' && task.origin.routineId === detail.data.routineId && task.origin.runId === run.id);
      return { run, task: match ? task : null, mismatch: Boolean(task && !match) };
    });
    detailView = { ...detail, occurrences, occurrence, setOccurrence };
  }
  const openOccurrence = async () => {
    const entry = detailView?.occurrences?.[occurrence]; if (!entry?.task) return;
    const row = { taskId: entry.task.id };
    setDetail({ kind: 'task', row, loading: true });
    try { setDetail({ kind: 'task', row, loading: false, data: await detailTask({ companyId: entry.task.companyId, taskId: entry.task.id }) }); }
    catch (error) { setDetail({ kind: 'task', row, loading: false, error: clean(error.message || error.code || 'detail failed') }); }
  };
  return h(Box, { width, height }, background,
    modal ? h(StatusModal, { modal, setModal, submit, width, height }) : null,
    assignment ? h(assignment.native ? NativeDispatchModal : AssignmentModal, { modal: assignment, setModal: setAssignment, submit: submitAssignment, prepareHuman, width, height }) : null,
    reviewModal ? h(ReviewModal, { modal: reviewModal, setModal: value => {
      if (typeof value === 'function') setReviewModal(current => { const next = value(current); if (next?.reason !== undefined) setReviewFeedback(next.reason); return next; });
      else { if (value?.reason !== undefined) setReviewFeedback(value.reason); setReviewModal(value); }
    }, submit: submitReview, width, height }) : null,
    detailView && !reviewModal && !decisionModal ? detailView.kind === 'agent'
      ? h(AgentDetailModal, { detail: detailView, close: () => setDetail(null), width, height })
      : h(DetailModal, { detail: detailView, close: () => setDetail(null), openOccurrence, openAction: openInbox, review: prepareReview, openRunResultNotifications, width, height }) : null,
    settingsModal ? h(RunResultNotificationsPanel, { modal: settingsModal, setModal: setSettingsModal, submit: submitRunResultNotifications, width, height }) : null,
    decisionModal ? h(BoardDecisionModal, { modal: decisionModal, setModal: setDecisionModal, submit: submitDecision, width, height }) : null);
}

export async function watchTaskBoardInk(read, options = {}) {
  let instance, resolveQuit;
  const input = options.input ?? process.stdin;
  const quit = new Promise(resolve => { resolveQuit = resolve; });
  instance = render(h(TaskBoardInkApp, { read, ...options, onQuit: () => {
    instance.cleanup(); input.pause?.(); input.unref?.(); resolveQuit();
    if (options.exitProcess) setImmediate(() => process.exit(0));
  } }), {
    stdin: input, stdout: options.output ?? process.stdout, stderr: options.error ?? process.stderr,
    alternateScreen: true, exitOnCtrlC: true,
  });
  try { await Promise.race([quit, instance.waitUntilExit()]); }
  finally {
    instance.cleanup(); input.pause?.(); input.unref?.();
    // Ink retains a read handle on the process TTY after alternate-screen cleanup.
    // This command owns stdin, so close that handle once the board exits.
    if (input === process.stdin) input.destroy?.();
  }
}
