import React from 'react';
import { Box, Text, useInput } from 'ink';
import { BoardText, appendBoardInput, modalSize } from './board-text.mjs';
import { wrapBoardText } from './task-board-view.mjs';

const h = React.createElement;
const hint = modal => modal.busy ? 'Waiting for acknowledgement…' : modal.refused ? 'Enter inspect refusal · Esc Inbox'
  : modal.locked ? 'Enter retry original · Esc Inbox' : modal.preview?.eligible === false ? 'r refresh preview · PgUp/Dn inspect blockers · Esc close'
    : modal.confirm ? 'PgUp/Dn inspect · Enter apply · Esc edit'
    : 'Tab field · ↑↓/Space choose · Ctrl+U clear · Enter review · Esc cancel';

function Panel({ title, lines, modal, width, height, colour = 'cyan' }) {
  const { width: w, height: size } = modalSize(width, height, 100, 32), columns = Math.max(1, w - 6);
  const footer = hint(modal), footerRows = wrapBoardText(footer, columns).length;
  const viewport = Math.max(1, size - 6 - footerRows);
  const wrapped = lines.flatMap(line => wrapBoardText(line.text ?? line, columns).map(text => ({ text, field: line.field })));
  const focus = wrapped.findLastIndex(line => line.field === modal.field);
  const start = modal.scroll === undefined ? modal.confirm ? 0 : Math.max(0, Math.min(wrapped.length - viewport, focus - viewport + 1))
    : Math.max(0, Math.min(modal.scroll, wrapped.length - viewport));
  return h(Box, { position: 'absolute', width: w, height: size, left: Math.max(0, Math.floor((width - w) / 2)), top: Math.max(0, Math.floor((height - size) / 2)),
    borderStyle: 'round', borderColor: colour, backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' },
  h(BoardText, { text: title, columns, rows: 2, bold: true, color: colour }),
  h(Box, { height: viewport, flexShrink: 0, flexDirection: 'column', overflow: 'hidden' }, ...wrapped.slice(start, start + viewport).map((line, i) =>
    h(Text, { key: i, wrap: 'truncate-end', inverse: !modal.confirm && line.field === modal.field }, line.text || ' '))),
  h(BoardText, { text: modal.error || '', columns, rows: 2, color: 'red' }),
  h(BoardText, { text: footer, columns, rows: footerRows, dimColor: true }));
}

export function LifecycleDeletePanel({ modal, setModal, submit, refresh, close, width, height }) {
  const p = modal.preview, deleting = modal.operation === 'delete', agent = modal.kind === 'agent';
  useInput((input, key) => {
    if (key.escape && (!modal.busy || !modal.confirm && !modal.locked)) {
      if (modal.confirm && !modal.locked) setModal(value => ({ ...value, confirm: false, scroll: undefined })); else close();
      return;
    }
    if (modal.busy) return;
    if (key.pageDown || key.pageUp) { setModal(value => ({ ...value, scroll: Math.max(0, (value.scroll ?? 0) + (key.pageDown ? 6 : -6)) })); return; }
    if (key.return && modal.refused) { close(); return; }
    if (!p?.eligible) { if (input === 'r') void refresh?.(modal); return; }
    if (key.return && !key.shift) {
      if (modal.confirm || modal.locked) void submit(modal);
      else if (deleting && !modal.reason.trim()) setModal(value => ({ ...value, error: 'A deletion reason is required' }));
      else setModal(value => ({ ...value, confirm: true, error: '', scroll: 0 }));
      return;
    }
    if (modal.confirm || modal.locked || !deleting) return;
    const reason = key.ctrl && input === 'u' ? '' : appendBoardInput(modal.reason, input, key, 2000);
    if (reason !== modal.reason) setModal(value => ({ ...value, reason, error: '', scroll: undefined }));
  });
  const action = deleting ? 'Delete' : modal.operation === 'pause' ? 'Pause' : 'Resume';
  const lines = p ? [p.name, `Node: ${p.nodeId}`, ...(agent ? [`Workspace: ${p.directory || 'Not advertised'}`] :
    [`Cron: ${p.definition.cron || p.definition.at}`, `Timezone: ${p.definition.timezone || 'Africa/Johannesburg'}`]), '',
  ...(p.blockers ?? []).map(item => `Blocked: ${item.kind.replaceAll('_', ' ')} (${item.ids.join(', ')})`),
  agent ? 'Removes the inactive directory entry and fences new Relay work. Agent identity, receiving-chat records and audit history are retained. No native process or workspace is deleted.' :
    deleting ? 'Cancels future ticks after acknowledgement by the owning node. Past runs remain available with h. Already admitted work is not interrupted.' :
      'Changes future ticks after acknowledgement by the owning node. Existing work and run history are unchanged.',
  ...(deleting ? [{ field: 'reason', text: `Reason\n${modal.reason}${!modal.confirm && !modal.locked ? '▏' : ''}` }] : []),
  modal.busy ? '' : modal.confirm ? `Confirm ${modal.operation} of this exact ${agent ? 'agent' : 'schedule'}?` : 'No change has been submitted.'] : [modal.busy ? 'Loading the current deletion preview…' : 'Preview unavailable. Close and inspect the error.'];
  return h(Panel, { title: `${modal.confirm ? 'Confirm: ' : ''}${action} ${agent ? 'inactive agent' : 'schedule'}`, lines, modal, width, height, colour: deleting ? 'yellow' : 'cyan' });
}

export function scheduleFormPayload(modal) {
  const reminder = modal.intent === 'reminder', agent = modal.candidates.agents[modal.targetIndex];
  return { id: modal.id, definition: { nodeId: reminder ? modal.candidates.nodes[modal.nodeIndex]?.id : agent?.nodeId,
    ...(reminder ? {} : { targetAgentId: agent?.id }), intent: modal.intent, instructions: modal.instructions,
    cron: modal.cron, timezone: modal.timezone, enabled: modal.enabled, reviewPolicy: reminder ? 'none' : modal.reviewPolicy } };
}

export function ScheduleCreatePanel({ modal, setModal, preview, submit, close, width, height }) {
  const fields = ['kind', modal.intent === 'reminder' ? 'node' : 'target', 'id', 'cron', 'timezone', 'instructions',
    ...(modal.intent === 'job' ? ['review'] : []), 'enabled'];
  useInput((input, key) => {
    if (key.escape && (!modal.busy || !modal.confirm && !modal.locked)) {
      if (modal.confirm && !modal.locked) setModal(value => ({ ...value, confirm: false, preview: null, scroll: undefined })); else close();
      return;
    }
    if (modal.busy) return;
    if (key.pageDown || key.pageUp) { setModal(value => ({ ...value, scroll: Math.max(0, (value.scroll ?? 0) + (key.pageDown ? 6 : -6)) })); return; }
    if (modal.refused && key.return) { close(); return; }
    if (!modal.candidates) return;
    if (key.return && !key.shift) { if (modal.confirm || modal.locked) void submit(modal); else void preview(modal); return; }
    if (modal.confirm || modal.locked) return;
    if (key.tab) { setModal(value => ({ ...value, field: fields[(fields.indexOf(value.field) + (key.shift ? fields.length - 1 : 1)) % fields.length], scroll: undefined })); return; }
    const delta = key.downArrow ? 1 : key.upArrow ? -1 : 0;
    if ((delta || input === ' ') && ['kind', 'review', 'enabled'].includes(modal.field)) {
      setModal(value => ({ ...value, ...(value.field === 'kind' ? { intent: value.intent === 'job' ? 'reminder' : 'job' } :
        value.field === 'review' ? { reviewPolicy: value.reviewPolicy === 'human' ? 'none' : 'human' } : { enabled: !value.enabled }), scroll: undefined })); return;
    }
    if (delta && ['target', 'node'].includes(modal.field)) {
      const name = modal.field === 'target' ? 'targetIndex' : 'nodeIndex', values = modal.field === 'target' ? modal.candidates.agents : modal.candidates.nodes;
      setModal(value => ({ ...value, [name]: Math.max(0, Math.min(values.length - 1, value[name] + delta)), scroll: undefined })); return;
    }
    if (['id', 'cron', 'timezone', 'instructions'].includes(modal.field)) {
      if (modal.field !== 'instructions' && /[\r\n\t\u2028\u2029]/.test(input)) { setModal(value => ({ ...value, error: 'This field must be a single line' })); return; }
      const value = key.ctrl && input === 'u' ? '' : appendBoardInput(modal[modal.field], input, key, modal.field === 'instructions' ? 16000 : 256);
      setModal(current => ({ ...current, [current.field]: value, error: '', scroll: undefined }));
    }
  });
  const c = modal.candidates, agent = modal.confirm && modal.preview?.target || c?.agents[modal.targetIndex],
    node = modal.confirm && modal.preview?.node || c?.nodes[modal.nodeIndex];
  const edit = (field, label, value) => ({ field, text: `${label}: ${value}${!modal.confirm && !modal.locked && modal.field === field ? '▏' : ''}` });
  const lines = c ? [edit('kind', 'Kind', modal.intent === 'job' ? 'Existing interactive agent job' : 'Human reminder'),
    modal.intent === 'job' ? edit('target', 'Agent', agent ? `${agent.name} (${agent.id}) · ${agent.nodeId} · ${agent.directory}` : 'No eligible agents') : edit('node', 'Node', node?.name ?? 'No eligible nodes'),
    edit('id', 'Name / ID', modal.id), edit('cron', 'Cron (five fields)', modal.cron), edit('timezone', 'Timezone', modal.timezone),
    edit('instructions', modal.intent === 'job' ? 'Instructions (Shift+Enter for newline)' : 'Reminder text', modal.instructions),
    ...(modal.intent === 'job' ? [edit('review', 'Result review', modal.reviewPolicy === 'human' ? 'Human' : 'None')] : []),
    edit('enabled', 'Activation', modal.enabled ? 'Enabled after node acknowledgement' : 'Paused; use p to resume later'),
    '', 'Independent headless workers use their separate approved setup flow.',
    ...(modal.preview ? ['Next runs (clock previews, not admission receipts)', ...modal.preview.nextRuns.map(run =>
      `${new Date(run).toLocaleString('en-GB', { timeZone: modal.preview.definition.timezone, hour12: false })} ${modal.preview.definition.timezone}`),
    ...modal.preview.warnings] : [])] : [modal.busy ? 'Loading permitted nodes and enrolled agents…' : 'Creation is unavailable. Close and inspect the error.'];
  return h(Panel, { title: modal.confirm ? 'Confirm new cron schedule' : 'Create cron schedule', lines, modal, width, height });
}
