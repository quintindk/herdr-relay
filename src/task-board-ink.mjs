import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import { randomUUID } from 'node:crypto';
import { buildBoardRows, wrapBoardText, taskBoardColumns } from './task-board-view.mjs';
import { BoardDecisionModal, decisionText } from './task-board-decision.mjs';

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
  const modalWidth = Math.max(44, Math.min(72, width - 4));
  const contentWidth = Math.max(1, modalWidth - 8);
  const commentBoxHeight = Math.min(6, Math.max(3, height - (status === 'blocked' && modal.needsDescriptor ? 19 : 17)));
  const commentLines = [];
  for (const paragraph of String(modal.comment ?? '').split(/\r?\n/)) {
    if (!paragraph) { commentLines.push(''); continue; }
    let line = '';
    for (const character of paragraph) {
      if (line.length >= contentWidth) { commentLines.push(line); line = ''; }
      line += character;
    }
    commentLines.push(line);
  }
  const visibleCommentLines = commentLines.slice(-Math.max(1, commentBoxHeight - 2));
  if (modal.field === 'comment' && visibleCommentLines.length) visibleCommentLines[visibleCommentLines.length - 1] += '▏';
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.escape) {
      if (modal.confirm) setModal(value => ({ ...value, confirm: false })); else setModal(null);
      return;
    }
    if (modal.confirm) { if (key.return || input === '\r' || input === '\n') void submit(modal); return; }
    if (key.tab) { setModal(value => ({ ...value, field: fields[(fields.indexOf(value.field) + 1) % fields.length] })); return; }
    if (modal.field === 'status' && (key.upArrow || key.downArrow || input === 'j' || input === 'k')) {
      const delta = key.downArrow || input === 'j' ? 1 : -1;
      setModal(value => ({ ...value, index: Math.max(0, Math.min(modal.options.length - 1, value.index + delta)) })); return;
    }
    if (modal.field === 'owner' && (key.upArrow || key.downArrow || input === 'j' || input === 'k' || input === ' ')) {
      setModal(value => ({ ...value, owner: value.owner === 'board' ? 'me' : 'board' })); return;
    }
    if (key.return || input === '\r' || input === '\n') {
      if (status === 'blocked' && modal.needsDescriptor && !modal.action.trim()) {
        setModal(value => ({ ...value, error: 'Required action is needed for Blocked' }));
      } else setModal(value => ({ ...value, confirm: true, error: '' }));
      return;
    }
    if (['action', 'comment'].includes(modal.field)) {
      const field = modal.field, limit = field === 'action' ? 2000 : 4000;
      const next = key.backspace || key.delete ? [...modal[field]].slice(0, -1).join('')
        : input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input) && modal[field].length < limit
          ? modal[field] + input : modal[field];
      if (next !== modal[field]) setModal(value => ({ ...value, [field]: next }));
    }
  });
  const modalHeight = Math.min(height - 2, 15 + commentBoxHeight + Math.max(0, modal.options.length - statuses.length) + (status === 'blocked' && modal.needsDescriptor ? 2 : 0));
  const selected = (active, text) => h(Text, { inverse: active, color: active ? 'cyan' : undefined, bold: active }, text);
  return h(Box, { position: 'absolute', width: modalWidth, height: modalHeight,
    left: Math.max(0, Math.floor((width - modalWidth) / 2)), top: Math.max(0, Math.floor((height - modalHeight) / 2)),
    borderStyle: 'round', borderColor: 'cyan', backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' },
  h(Text, { bold: true, color: 'cyan' }, `Change status · ${modal.task.identifier || modal.task.id}`),
  h(Box, { height: 1 }),
  ...modal.options.map((value, index) => selected(modal.field === 'status' && modal.index === index,
    `${modal.index === index ? '●' : '○'} ${labels[value]}`)),
  h(Box, { height: 1 }),
  ...(status === 'blocked' && modal.needsDescriptor ? [
    selected(modal.field === 'owner', `Waiting on  ${modal.owner === 'board' ? 'Board' : 'Me'}`),
    selected(modal.field === 'action', `Required action  ${modal.action}${modal.field === 'action' ? '▏' : ''}`),
  ] : []),
  status === 'delete' ? h(Text, { color: 'red' }, 'Permanently remove this task. This cannot be undone.') : h(Box, { flexDirection: 'column' },
  h(Box, { justifyContent: 'space-between' },
    h(Text, { bold: modal.field === 'comment', color: modal.field === 'comment' ? 'cyan' : undefined }, 'Comment (optional)'),
    h(Text, { dimColor: true }, `${modal.comment.length}/4000 · ${commentLines.length} line${commentLines.length === 1 ? '' : 's'}`)),
  h(Box, { height: commentBoxHeight, borderStyle: 'single', borderColor: modal.field === 'comment' ? 'cyan' : 'gray',
    paddingX: 1, flexDirection: 'column', overflow: 'hidden' },
  ...visibleCommentLines.map((line, index) => h(Text, { key: `${commentLines.length}:${index}`, wrap: 'truncate-end' }, line || ' ')))),
  modal.error ? h(Text, { color: 'red' }, modal.error)
    : modal.confirm ? h(Text, { bold: true, color: status === 'delete' ? 'red' : 'cyan' }, status === 'delete'
      ? `Confirm permanent deletion of ${modal.task.identifier || modal.task.id}` : `Confirm ${labels[modal.task.status] ?? modal.task.status} -> ${labels[status]}`)
      : h(Text, null, ' '),
  h(Box, { flexGrow: 1 }),
  h(Text, { dimColor: true }, modal.confirm ? 'Enter apply · Esc back' : '↑↓ select · Tab next · Enter review · Esc cancel'));
}

function AssignmentModal({ modal, setModal, submit, width, height }) {
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.escape) { setModal(null); return; }
    if (key.downArrow || input === 'j') setModal(value => ({ ...value, index: Math.min(value.agents.length - 1, value.index + 1) }));
    if (key.upArrow || input === 'k') setModal(value => ({ ...value, index: Math.max(0, value.index - 1) }));
    if (key.return || input === '\r' || input === '\n') void submit(modal);
  });
  const modalWidth = Math.max(44, Math.min(72, width - 4));
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
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.escape) {
      if (modal.confirm) setModal(value => ({ ...value, confirm: false })); else setModal(null);
      return;
    }
    if (modal.confirm) { if (key.return || input === '\r' || input === '\n') void submit(modal); return; }
    if (modal.decision === 'reject') {
      if (key.return || input === '\r' || input === '\n') {
        if (modal.reason.trim()) setModal(value => ({ ...value, confirm: true, error: '' }));
        else setModal(value => ({ ...value, error: 'Rejection feedback is required' }));
        return;
      }
      const reason = key.backspace || key.delete ? [...modal.reason].slice(0, -1).join('')
        : input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input) && modal.reason.length < 4000
          ? modal.reason + input : modal.reason;
      if (reason !== modal.reason) setModal(value => ({ ...value, reason }));
      return;
    }
    if (key.return || input === '\r' || input === '\n') setModal(value => ({ ...value, confirm: true }));
  });
  const modalWidth = Math.max(44, Math.min(72, width - 4));
  return h(Box, { position: 'absolute', width: modalWidth, height: Math.min(height - 2, 12),
    left: Math.max(0, Math.floor((width - modalWidth) / 2)), top: Math.max(0, Math.floor((height - 12) / 2)),
    borderStyle: 'round', borderColor: 'magenta', backgroundColor: 'black', paddingX: 2, flexDirection: 'column' },
  h(Text, { bold: true, color: 'magenta' }, `${modal.decision === 'accept' ? 'Approve' : 'Reject'} · ${modal.identifier}`),
  h(Text, { dimColor: true }, `Candidate ${modal.candidate}`), h(Box, { height: 1 }),
  modal.decision === 'reject' ? h(Text, { inverse: !modal.confirm }, `Feedback  ${modal.reason}${!modal.confirm ? '▏' : ''}`) : null,
  modal.confirm ? h(Text, { bold: true, color: 'magenta' }, `Confirm ${modal.decision}`) : null,
  modal.error ? h(Text, { color: 'red' }, modal.error) : null,
  h(Box, { flexGrow: 1 }),
  h(Text, { dimColor: true }, modal.confirm ? 'Enter apply · Esc back' : modal.decision === 'reject' ? 'Type feedback · Enter review · Esc cancel' : 'Enter review · Esc cancel'));
}

function AgentDetailModal({ detail, close, width, height }) {
  const [scroll, setScroll] = useState(0), [technical, setTechnical] = useState(false);
  const w = Math.max(32, Math.min(100, width - 2)), size = Math.max(10, Math.min(height - 2, 26)), viewport = Math.max(2, size - 6);
  const agent = detail.data?.agent;
  const lines = (agent ? [
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
  h(Text, { bold: true, color: 'cyan', wrap: 'truncate-end' }, clean(agent?.displayName || agent?.name || 'Agent')),
  h(Box, { height: viewport, flexDirection: 'column', overflow: 'hidden' }, ...lines.slice(start, start + viewport).map((line, i) => h(Text, { key: i, wrap: 'truncate-end' }, line || ' '))),
  h(Box, { flexGrow: 1 }), h(Text, { dimColor: true }, `${start + 1}-${Math.min(lines.length, start + viewport)}/${lines.length}`),
  h(Text, { dimColor: true, wrap: 'truncate-end' }, 'j/k · PgUp/PgDn · t details · Esc close'));
}

function DetailModal({ detail, close, openOccurrence, openAction, review, width, height }) {
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
  const modalWidth = Math.max(52, Math.min(100, width - 4)), modalHeight = Math.max(12, Math.min(height - 2, 24));
  const contentWidth = Math.max(20, modalWidth - 6);
  const viewportHeight = Math.max(3, modalHeight - (detail.kind === 'task' ? 8 : 7));
  const wrapLines = value => wrapBoardText(value, contentWidth);
  let content = [], taskSections;
  if (!detail.loading && !detail.error && detail.kind === 'task') {
    const task = detail.data.task;
    const result = detail.data.result;
    taskSections = {
      Actions: [task.attentionLabel || 'Needs your attention', '', ...actions.flatMap((item, i) => [
        `${i === actionIndex ? '›' : ' '} ${item.kind === 'question' ? 'Answer question' : item.kind === 'review' ? 'Review result' : 'Acknowledge reminder'}`,
        ...wrapLines(item.summary), ''])],
      Overview: ['Title', ...wrapLines(task.title), '', ...(task.originKind === 'routine_execution' ? [`Routine occurrence ${task.originRunId}`, ''] : []),
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
  if (!detail.loading && !detail.error && detail.kind === 'routine') {
    const routine = detail.data;
    content = [`${routine.state} / backend ${routine.backendStatus} / ${routine.intent === 'reminder' ? 'human reminder' : routine.executionMode}`,
      `${routine.cron} · ${routine.timezone}`,
      `Next${routine.nextRunIsEstimate ? ' (clock preview)' : ''} ${routine.nextRunAt || 'none'} · target ${routine.targetAgentId || routine.targetBindingId || routine.targetDirectory || 'unresolved'}`,
      ...(routine.delivery ? [`Delivery ${routine.delivery.state}${routine.delivery.reason ? ` · ${routine.delivery.reason}` : ''}`] : []),
      '', `Recent occurrences (${routine.runs.length}${routine.runs.length === 50 ? '+' : ''})`,
      ...detail.occurrences.map(entry => entry.run.nativeOccurrence
        ? `${entry.run.triggeredAt || '-'}  ${entry.run.status}  ${entry.run.linkedIssueId || 'taskless'}  ${clean(entry.run.summary).replace(/[\u202a-\u202e\u2066-\u2069]/g, '')}`
        : `${entry.run.triggeredAt || '-'}  ${entry.run.status}  ${entry.task?.identifier || entry.run.linkedIssueId || 'unlinked'}  ${entry.task ? entry.task.status : entry.mismatch ? 'identity mismatch' : 'not on board'}`)];
  }
  content = content.flatMap(wrapLines);
  const scrollKey = detail.kind === 'task' ? taskTabs[tab] : 'Routine';
  const scroll = Math.min(scrolls[scrollKey] ?? 0, Math.max(0, content.length - viewportHeight));
  const setScroll = update => setScrolls(value => ({ ...value,
    [scrollKey]: typeof update === 'function' ? update(value[scrollKey] ?? 0) : update }));
  const occurrenceStart = detail.kind === 'routine' && detail.data ? 5 + (detail.data.delivery ? 1 : 0) : -1;
  const maxScroll = Math.max(0, content.length - viewportHeight);
  useInput((input, key) => {
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
      if (detail.kind === 'routine') {
        detail.setOccurrence(value => {
          const next = Math.max(0, Math.min(detail.occurrences.length - 1, value + delta));
          setScroll(offset => next + occurrenceStart < offset ? Math.max(0, next + occurrenceStart)
            : next + occurrenceStart >= offset + viewportHeight
              ? Math.min(maxScroll, next + occurrenceStart + 1 - viewportHeight) : offset);
          return next;
        });
      } else setScroll(value => Math.max(0, Math.min(maxScroll, value + delta)));
    };
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
    borderStyle: 'round', borderColor: 'magenta', backgroundColor: 'black', paddingX: 2, flexDirection: 'column' };
  if (detail.loading) return h(Box, box, h(Text, { color: 'magenta' }, 'Loading detail...'));
  if (detail.error) return h(Box, box, h(Text, { color: 'red' }, `Detail failed: ${detail.error}`), h(Box, { flexGrow: 1 }), h(Text, { dimColor: true }, 'Esc close'));
  if (detail.kind === 'task') {
    const task = detail.data.task;
    return h(Box, box,
      h(Text, { bold: true, color: 'magenta', wrap: 'truncate-end' }, detail.data.actions !== undefined ? decisionText(task.title) : `${task.identifier || task.id} · ${task.title}`),
      h(Text, { dimColor: true, wrap: 'truncate-end' }, `${task.status} · ${task.assigneeUserId || task.assigneeAgentId || 'unassigned'}`),
      h(Box, { gap: 2 }, ...taskTabs.map((name, index) => h(Text, { key: name, inverse: tab === index,
        bold: tab === index, color: tab === index ? 'cyan' : undefined }, ` ${name} `))),
      h(Box, { height: viewportHeight, flexDirection: 'column', overflow: 'hidden', marginTop: 1 },
        ...content.slice(scroll, scroll + viewportHeight).map((line, index) => h(Text, { key: `${scroll}:${index}`,
          bold: ['Summary', 'Submitted result', 'Deliverables', 'Checks'].includes(line),
          color: line.startsWith('Routine occurrence ') ? 'cyan' : undefined,
          dimColor: ['No comments.', 'No Relay result.'].includes(line) }, line || ' '))),
      h(Box, { justifyContent: 'space-between' },
         h(Text, { dimColor: true, wrap: 'truncate-end' }, `${actions.length && taskTabs[tab] === 'Actions' ? 'Enter act · ' : detail.data.review ? 'A approve · F/R reject · ' : ''}↑↓ scroll · PgUp/PgDn · Home/End · Tab section · Esc close`),
        h(Text, { dimColor: true }, `${content.length ? scroll + 1 : 0}-${Math.min(content.length, scroll + viewportHeight)}/${content.length}`)));
  }
  const routine = detail.data, occurrences = detail.occurrences;
  return h(Box, box,
    h(Text, { bold: true, color: 'magenta' }, `CRON · ${routine.title}`),
    h(Box, { height: viewportHeight, flexDirection: 'column', overflow: 'hidden', marginTop: 1 },
      ...content.slice(scroll, scroll + viewportHeight).map((line, index) => {
        const absolute = scroll + index, occurrenceIndex = absolute - occurrenceStart, entry = occurrenceIndex >= 0 ? occurrences[occurrenceIndex] : null;
        return h(Text, { key: `${scroll}:${index}`, wrap: 'truncate-end', bold: absolute === occurrenceStart - 1, inverse: occurrenceIndex === detail.occurrence,
          color: entry?.task ? 'cyan' : entry?.mismatch ? 'red' : undefined }, line || ' ');
      })),
    h(Box, { justifyContent: 'space-between' },
      h(Text, { dimColor: true }, 'j/k · PgUp/PgDn · Home/End scroll · o open task · Enter/Esc close'),
      h(Text, { dimColor: true }, `${content.length ? scroll + 1 : 0}-${Math.min(content.length, scroll + viewportHeight)}/${content.length}`)));
}

export function TaskBoardInkApp({ read, inspectTask, detailTask, detailAgent, detailRoutine, reviewTask, detailInbox, decideInbox, pendingDecisions,
  assignTask, statusTask, deleteTask, onQuit, interval = 5000, width: fixedWidth, height: fixedHeight }) {
  const window = useWindowSize(); const { exit } = useApp();
  const width = fixedWidth ?? window.columns ?? 100, height = fixedHeight ?? window.rows ?? 30;
  const [board, setBoard] = useState(() => ({ companies: [], agents: [], projects: [], tasks: [], routines: [],
    ...(pendingDecisions ? { inbox: pendingDecisions() } : {}), fetchedAt: null, warnings: [] }));
  const native = Array.isArray(board.inbox);
  const [view, setView] = useState('tasks');
  const [selectedNativeId, setSelectedNativeId] = useState(null);
  const [decisionModal, setDecisionModal] = useState(null);
  const [decisionReceipt, setDecisionReceipt] = useState(null);
  const [offline, setOffline] = useState(''); const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState(0); const [modal, setModal] = useState(null);
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
      } }
      if (!disposed) timer = setTimeout(refresh, interval);
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); active?.abort(); };
  }, [read, interval, refreshGeneration, pendingDecisions]);
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
  const agentRows = useMemo(() => board.agents.filter(agent => !filter || clean(`${agent.displayName || agent.name} ${agent.mode} ${agent.nodeName} ${agent.directory} ${agent.availabilityLabel} ${agent.locality ?? 'unknown'}`).toLowerCase().includes(filter.toLowerCase()))
    .map(agent => ({ id: `agent:${agent.id}`, type: 'agent', agent })), [board.agents, filter]);
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
      const snapshot = await inspectTask({ companyId: current.task.companyId, taskId: current.task.id });
      if (snapshot.task?.id !== current.task.id || snapshot.task.companyId !== current.task.companyId || !snapshot.revision) throw Error('Assignment preview identity is not confirmed');
      const result = await assignTask({ companyId: current.task.companyId, taskId: current.task.id,
        expectedRevision: snapshot.revision, key: randomUUID(), reason: 'Assigned from the Ink task board', payload: { assigneeAgentId: agent.id } });
      if (result.outcome?.confirmed !== true || result.task?.assigneeAgentId !== agent.id) throw Error('Assignment is not confirmed');
      setBoard(value => ({ ...value, tasks: value.tasks.map(task => task.id === current.task.id && task.companyId === current.task.companyId
        ? { ...task, assigneeAgentId: agent.id, assigneeUserId: null } : task) }));
      setNotice(`Assigned ${current.task.identifier || current.task.id} to ${agent.name || agent.id}`); setAssignment(null);
    } catch (error) { setAssignment({ ...current, busy: false, error: clean(error.message || error.code || 'assignment failed') }); }
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
    if (modal || assignment || reviewModal || detail || decisionModal) return;
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
      const views = ['tasks', 'agents', 'inbox', 'schedules'];
      setView(value => views[(views.indexOf(value) + (key.shift ? 3 : 1)) % 4]);
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
    if (input === ' ' || key.leftArrow || key.rightArrow) {
      const row = rows[selected];
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
    if (input === 'a') {
      if (native && !assignTask) { setNotice('Sending work requires an explicit execution request, not a responsibility change'); return; }
      const row = rows[selectedIndex];
      if (row?.type !== 'task') { setNotice('Select a task'); return; }
      const agents = board.agents.filter(agent => agent.companyId === row.companyId && agent.availability === 'present')
        .sort((left, right) => clean(left.name || left.id).localeCompare(clean(right.name || right.id)) || left.id.localeCompare(right.id));
      if (!agents.length) { setNotice('Assignment unavailable: no present agents in this company'); return; }
      setAssignment({ task: row.task, agents, index: Math.max(0, agents.findIndex(agent => agent.id === row.task.assigneeAgentId)), busy: false, error: '' });
      setNotice(''); return;
    }
    if (key.return || input === 'd' || key.tab) {
      const row = rows[selectedIndex]; if (!row || row.type === 'group') return;
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
  const visibleHeight = Math.max(1, Math.floor((height - (native ? decisionReceipt ? 9 : 8 : 6)) / (native && ['inbox', 'agents', 'schedules'].includes(view) ? 4 : 1))), start = Math.max(0, Math.min(selectedIndex - Math.floor(visibleHeight / 2), Math.max(0, rows.length - visibleHeight)));
  const visible = rows.slice(start, start + visibleHeight);
  const rowText = row => {
    if (row.type === 'section') return row.label;
    if (row.type === 'inbox') return `${row.item.kind === 'question' ? 'Question' : row.item.kind === 'review' ? 'Review' : row.item.kind === 'reminder' ? 'Reminder' : 'Publication'} · ${decisionText(row.item.title)}  · ${decisionText(row.item.summary)}`;
    if (row.type === 'routine') return `  ◆ ${row.routine.title}  [${row.routine.state}]  ${row.routine.cron}  next ${row.routine.nextRunAt || '-'}`;
    const fold = row.expandable ? row.expanded ? '▾' : '▸' : '·';
    if (row.type === 'group') return `${fold} ${row.name}${row.agent ? ` / ${row.agent.availability || 'unknown'}` : ''}  · ${row.counts.open} open`;
    const guides = row.guides.map(continuation => continuation ? '│ ' : '  ').join('');
    const branch = row.last ? '└─' : '├─';
    const context = row.context ? ` [via ${row.owner}]` : '';
    const anomaly = row.anomaly ? ` [${row.anomaly}]` : '';
    const subtree = row.descendants ? ` [+${row.descendants}/${row.counts.open} open]` : '';
    return `${guides}${branch}${fold} ${native ? '' : `${row.task.identifier || row.task.id}${context}  `}${clean(row.task.title)}${anomaly}${subtree}`;
  };
  if (quitting) return null;
  const summary = taskCounts(board.tasks);
  const overlay = Boolean(modal || assignment || reviewModal || detail || decisionModal);
  const localAgentCount = board.agents.filter(agent => agent.locality === 'local').length;
  const nativeCounts = view === 'agents'
    ? `${board.localNode ? `Local node: ${clean(board.localNode.name)} · ${localAgentCount} local` : 'Local node: not identified'} · ${board.agents.filter(a => a.mode === 'interactive').length} interactive   ${board.agents.filter(a => a.mode === 'headless').length} headless`
    : view === 'inbox' ? `${board.inbox?.filter(i => i.kind === 'question').length ?? 0} questions   ${board.inbox?.filter(i => i.kind === 'review').length ?? 0} reviews   ${board.inbox?.filter(i => i.kind === 'reminder').length ?? 0} reminders`
      : view === 'schedules' ? `${board.routines.filter(r => r.state === 'active').length} active   ${board.routines.filter(r => r.state === 'paused').length} paused`
        : `${summary.open} open   ${summary.active} active   ${summary.blocked} blocked   ${summary.review} in review`;
  const cardTitle = (title, active, color = 'cyan', local = false) => h(Box, { height: 1, overflow: 'hidden' },
    h(Text, { color: active ? color : 'gray' }, active ? '› ' : '  '),
    local ? h(Text, { bold: true, inverse: true, color: 'green', dimColor: overlay }, ' LOCAL ') : null,
    local ? h(Text, null, ' ') : null,
    h(Text, { bold: true, inverse: active, color: active ? color : undefined, dimColor: overlay, wrap: 'truncate-end' }, title));
  const emptyLabel = view === 'inbox' ? offline ? 'Inbox unavailable. Showing last known state.' : !loaded ? 'Loading inbox…' : 'No decisions need your attention.'
    : view === 'agents' ? 'No agents advertised.' : view === 'schedules' ? 'No schedules installed.' : showDone ? 'No matching tasks.' : 'No open tasks.';
  const statusLabel = task => native && task.attentionLabel
    ? `${labels[task.status] ?? task.status} · ${decisionText(task.attentionLabel)}` : `[${labels[task.status] ?? task.status}]`;
  const taskColumns = taskBoardColumns(width, visible.filter(row => row.type === 'task').map(row => statusLabel(row.task)));
  const background = h(Box, { width, height, flexDirection: 'column' },
    h(Box, { justifyContent: 'space-between' }, h(Text, { bold: true, color: 'cyan', dimColor: overlay }, native ? `RELAY / ${view === 'schedules' ? 'SCHEDULE' : view.toUpperCase()}` : 'RELAY / TASKS'),
      h(Text, { dimColor: true }, native ? offline ? 'Inbox unavailable: showing cached state' : !loaded ? 'Loading inbox…' : `${board.agents.length} agents · ${board.inbox.length} need attention` : `${board.companies.length} companies · ${board.agents.length} agents`)),
    native ? h(Box, { gap: 2 }, ...[['tasks', 'Tasks'], ['agents', 'Agents'], ['inbox', `Inbox (${offline ? '?' : !loaded ? '…' : board.inbox.length})`], ['schedules', 'Schedule']].map(([id, title]) =>
      h(Text, { key: id, inverse: view === id, bold: view === id, color: view === id ? 'cyan' : undefined, dimColor: view !== id || overlay }, ` ${title} `))) : null,
    native ? h(Box, { justifyContent: 'space-between', height: 1, overflow: 'hidden' },
      view === 'agents' && board.localNode ? h(Box, { flexShrink: 1, overflow: 'hidden' },
        h(Text, { bold: true, inverse: true, color: 'green', dimColor: overlay }, ' LOCAL '),
        h(Text, { color: 'green', bold: true, dimColor: overlay, wrap: 'truncate-end' }, ` ${clean(board.localNode.name)} · ${localAgentCount} ${localAgentCount === 1 ? 'agent' : 'agents'}`))
        : h(Text, { dimColor: true, wrap: 'truncate-end' }, nativeCounts),
      h(Text, { color: offline ? 'yellow' : 'gray', wrap: 'truncate-end' }, `${offline ? 'OFFLINE' : loaded ? '● LIVE' : 'LOADING'}${board.fetchedAt ? ` · last updated ${new Date(board.fetchedAt).toLocaleTimeString('en-GB', { timeZone: 'Africa/Johannesburg', hour12: false })} SAST` : ''}`))
      : h(Text, { dimColor: Boolean(modal || detail), wrap: 'truncate-end' }, `OPEN ${summary.open}  ACTIVE ${summary.active}  BLOCKED ${summary.blocked}  REVIEW ${summary.review}  ${offline ? `OFFLINE ${offline}` : loaded ? 'LIVE' : 'LOADING'}`),
    h(Box, { borderStyle: native ? 'round' : 'single', borderColor: native || modal || assignment || reviewModal ? 'gray' : 'cyan',
      paddingX: native ? 1 : 0, paddingTop: native ? 1 : 0, flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      !visible.length && native ? h(Box, { flexGrow: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'column' },
        h(Text, { dimColor: true, wrap: 'truncate-end' }, emptyLabel),
        h(Text, { dimColor: true, wrap: 'truncate-end' }, view === 'tasks' && !showDone ? 'Press h to include completed tasks.' : 'Tab switches views · r refreshes')) : null,
      ...visible.map((row, index) => {
        const active = start + index === selectedIndex && !modal && !assignment && !reviewModal && !detail && !decisionModal;
        if (row.type === 'agent') return h(Box, { key: row.id, height: 4, flexDirection: 'column', overflow: 'hidden' },
          cardTitle(`${clean(row.agent.displayName || row.agent.name)} · ${clean(row.agent.mode || 'Unknown mode')} · ${clean(row.agent.availabilityLabel || 'Unknown or stale')}`, active, 'cyan', row.agent.locality === 'local'),
          h(Text, { dimColor: true, wrap: 'truncate-end' }, `  Node: ${clean(row.agent.nodeName || 'Unknown')}${row.agent.locality === 'local' ? ' (local)' : row.agent.locality === 'remote' ? ' (remote)' : ''} · Machine: ${clean(row.agent.machineName || 'Not advertised')} · ${clean(row.agent.directory || 'Workspace not advertised')}`),
          h(Text, { dimColor: true, wrap: 'truncate-end' }, `  Last seen: ${lastSeenLabel(row.agent.lastSeenAt)}`));
        if (row.type === 'inbox') return h(Box, { key: row.id, height: 4, flexDirection: 'column', overflow: 'hidden' },
          cardTitle(`${row.item.kind === 'question' ? 'Question' : row.item.kind === 'review' ? 'Review' : row.item.kind === 'reminder' ? 'Reminder' : 'Publication'} · ${clean(row.item.title)}`, active, row.item.kind === 'review' ? 'magenta' : 'yellow'),
          h(Text, { wrap: 'truncate-end' }, `  ${clean(row.item.summary)}`),
          h(Text, { dimColor: true, wrap: 'truncate-end' }, `  ${clean(row.item.from)} · ${clean(row.item.stateLabel)}${row.item.locationLabel ? ` · ${clean(row.item.locationLabel)}` : ''}`));
        if (native && row.type === 'routine') return h(Box, { key: row.id, height: 4, flexDirection: 'column', overflow: 'hidden' },
          cardTitle(`${clean(row.routine.title)}  [${clean(row.routine.state)}]`, active, 'magenta'),
          h(Text, { dimColor: true, wrap: 'truncate-end' }, `  ${clean(row.routine.cron)} · ${clean(row.routine.timezone)}`),
          h(Text, { dimColor: true, wrap: 'truncate-end' }, `  Next ${row.routine.nextRunAt ? lastSeenLabel(row.routine.nextRunAt) : '—'} · ${clean(row.routine.target || 'Unresolved target')}`));
        const taskStyle = row.type === 'task' ? taskRowStyle(row.task, Boolean(modal || assignment || reviewModal || detail), row.context) : null;
        const tone = row.type === 'section' || row.type === 'group' ? 'cyan' : ['routine', 'inbox'].includes(row.type) ? 'magenta' : taskStyle.color;
        const dimmed = taskStyle?.dimColor ?? Boolean(modal || assignment || reviewModal || detail);
        return h(Box, { key: row.id, height: 1, overflow: 'hidden' },
          h(Box, { flexGrow: 1, flexShrink: 1, overflow: 'hidden' }, h(Text, { wrap: 'truncate-end', inverse: active,
            bold: row.type === 'section' || native && row.type === 'group', dimColor: dimmed || native && row.type === 'group' && !active, color: tone }, rowText(row))),
          row.type === 'task' ? h(Box, { width: native ? taskColumns.status : 13, marginLeft: native ? taskColumns.gap : 0,
            flexShrink: 0, justifyContent: 'flex-end' },
            h(Text, { inverse: active, dimColor: dimmed, color: tone, wrap: 'truncate-end' }, statusLabel(row.task))) : null);
      })),
    searching ? h(Text, { dimColor: Boolean(modal || detail) }, `/${filter}▏  Enter apply · Esc clear`) : notice
      ? h(Text, { dimColor: Boolean(modal || detail) }, notice.text)
      : native && decisionReceipt ? h(Box, { flexDirection: 'column', height: 3, overflow: 'hidden' },
        h(Text, { color: 'cyan', wrap: 'truncate-end' }, `✓ ${clean(decisionReceipt.message)}`),
        h(Text, { dimColor: true, wrap: 'truncate-end' }, decisionReceipt.kind === 'question' ? 'Any required review will appear in this Inbox.' : clean(decisionReceipt.title)),
        h(Text, { dimColor: true, wrap: 'truncate-end' }, 'Esc dismiss acknowledgement · Tab view · Enter open · q quit'))
      : h(Box, { flexDirection: 'column' },
        h(Text, { dimColor: Boolean(modal || detail) }, native ? 'j/k move · Enter open · Tab view · Space fold · / search' : 'j/k move · Enter/Tab detail · Space/←/→ fold · / search'),
        h(Text, { dimColor: Boolean(modal || assignment || reviewModal || detail) }, native && !assignTask
          ? 'h done · r refresh · s status · q quit' : 'h done · i idle · r refresh · a assign · s status · q quit')));
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
    assignment ? h(AssignmentModal, { modal: assignment, setModal: setAssignment, submit: submitAssignment, width, height }) : null,
    reviewModal ? h(ReviewModal, { modal: reviewModal, setModal: value => {
      if (typeof value === 'function') setReviewModal(current => { const next = value(current); if (next?.reason !== undefined) setReviewFeedback(next.reason); return next; });
      else { if (value?.reason !== undefined) setReviewFeedback(value.reason); setReviewModal(value); }
    }, submit: submitReview, width, height }) : null,
    detailView && !reviewModal && !decisionModal ? detailView.kind === 'agent'
      ? h(AgentDetailModal, { detail: detailView, close: () => setDetail(null), width, height })
      : h(DetailModal, { detail: detailView, close: () => setDetail(null), openOccurrence, openAction: openInbox, review: prepareReview, width, height }) : null,
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
