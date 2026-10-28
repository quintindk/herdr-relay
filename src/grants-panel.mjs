import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { randomUUID } from 'node:crypto';
import { decisionText } from './task-board-decision.mjs';
import { wrapBoardText } from './task-board-view.mjs';
import { grantDate } from './grants-view.mjs';
import { canonicalDirectory, withinRoots } from './interactive-contract.mjs';
import { BoardText, modalSize, appendBoardInput } from './board-text.mjs';
import { boardRowViewport } from './board-row-layout.mjs';

const h = React.createElement, clean = value => decisionText(value).trim();
export const nativeBoardViews = ['tasks', 'agents', 'inbox', 'grants', 'schedules'];
export const nativeBoardTabs = (board, offline, loaded) => [['tasks', 'Tasks'], ['agents', 'Agents'],
  ['inbox', `Inbox (${offline ? '?' : !loaded ? '…' : board.inbox?.length ?? 0})`],
  ['grants', `Grants (${offline ? '?' : !loaded ? '…' : !board.grantsAvailable ? '?' : board.grants?.pending?.length ?? 0})`], ['schedules', 'Schedule']];

function GrantDialog({ modal, setModal, submit, board, width, height }) {
  const item = modal.item, creating = modal.creating;
  const choices = modal.loadingFailed ? [] : creating ? ['Create standing permission'] : item?.kind === 'publication' ? [item.action === 'dismiss' ? 'Dismiss refused decision' : 'Retry original decision'] :
    item?.section === 'pending' ? item.kind === 'headless_contract' ? ['Approve instruction revision', 'Reject'] : ['Approve once', 'Allow this scope', 'Reject'] : item?.section === 'active' ? ['Revoke'] : [];
  const agents = modal.agents ?? board.agents.filter(a => a.mode === 'interactive' && a.standingGrant), nodes = modal.nodes ?? board.nodes ?? [];
  const requester = agents[modal.agentIndex ?? 0], node = nodes[modal.nodeIndex ?? 0];
  const scopeEditing = creating || item?.kind === 'interactive' && item.section === 'pending' && modal.index === 1 && (item.scope?.roots?.length ?? 0) === 1;
  const fields = creating ? ['agent', 'node', 'root', 'profile', 'limit', 'directories', 'dispatch', 'replacement', 'reason'] :
    [...(choices.length ? ['choice'] : []), ...(scopeEditing ? ['root', 'limit'] : []), ...(choices.length && item?.kind !== 'publication' ? ['reason'] : [])];
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.escape) { if (modal.confirm && !modal.locked) setModal({ ...modal, confirm: false }); else setModal(null); return; }
    if (!choices.length && key.return) { setModal(null); return; }
    if (modal.locked) return;
    if (input === 't' && !['root', 'profile', 'limit', 'reason'].includes(modal.field)) { setModal({ ...modal, technical: !modal.technical }); return; }
    if (key.pageDown || key.pageUp) { setModal({ ...modal, scroll: Math.max(0, modal.scroll + (key.pageDown ? 6 : -6)) }); return; }
    if (modal.confirm) { if (key.return) void submit(modal); return; }
    if (key.tab && fields.length) { setModal({ ...modal, field: fields[(fields.indexOf(modal.field) + 1) % fields.length] }); return; }
    const delta = key.downArrow ? 1 : key.upArrow ? -1 : 0;
    if (delta && modal.field === 'choice') { setModal({ ...modal, index: Math.max(0, Math.min(choices.length - 1, modal.index + delta)) }); return; }
    if (delta && ['agent', 'node'].includes(modal.field)) {
      const name = `${modal.field}Index`, values = modal.field === 'agent' ? agents : nodes;
      setModal({ ...modal, [name]: Math.max(0, Math.min(values.length - 1, (modal[name] ?? 0) + delta)) }); return;
    }
    if ((input === ' ' || delta) && ['directories', 'dispatch', 'replacement'].includes(modal.field)) { setModal({ ...modal, [modal.field]: !modal[modal.field] }); return; }
    if (key.return && !key.shift && choices.length) { setModal({ ...modal, confirm: true, error: '', scroll: 0 }); return; }
    if (['root', 'profile', 'limit', 'reason'].includes(modal.field)) {
      const name = modal.field, current = modal[name] ?? '';
      const value = appendBoardInput(current, input, key, name === 'reason' ? 4000 : 4096);
      if (value.length <= (name === 'reason' ? 4000 : 4096)) setModal({ ...modal, [name]: value, ...(name === 'root' ? { rootEdited: true } : {}) });
    }
  });
  const { width: w, height: size } = modalSize(width, height, 104, 34);
  const columns = Math.max(1, w - 6);
  const title = creating ? 'New interactive provisioning permission' : item?.title ?? 'Grants';
  const titleRows = Math.min(2, wrapBoardText(title, columns).length);
  const choiceLines = choices.flatMap((choice, index) => wrapBoardText(`${modal.index === index ? '●' : '○'} ${choice}`, columns).map(text => ({ text, index })));
  const hint = modal.locked ? 'Unconfirmed decision retained. Esc close; reconcile it in Grants → Pending.' : modal.confirm ? 'Enter apply · Esc back' :
    choices.length ? 'Esc close · Enter review · Tab edit · PgUp/Dn' : 'Esc close · PgUp/Dn scroll · t details';
  const hintRows = wrapBoardText(hint, columns).length;
  const statusText = modal.error ? 'Error: inspect details' : modal.confirm ? `Confirm: ${choices[modal.index]}` : '';
  const statusRows = statusText ? wrapBoardText(statusText, columns).length : 0;
  const reasonRows = choices.length && item?.kind !== 'publication' ? 3 : 0;
  const mark = (field, value) => `${modal.field === field && !modal.confirm ? '› ' : '  '}${value}`;
  const details = creating ? [mark('agent', `Requesting agent: ${requester?.displayName ?? requester?.name ?? 'No enrolled interactive agents'}`),
    mark('node', `Destination: ${node?.name ?? 'No nodes'}`), mark('root', `Folder scope: ${modal.root}`), mark('profile', `Profile: ${modal.profile}`),
    mark('limit', `Node-wide agent limit: ${modal.limit}`), mark('directories', `Create folders: ${modal.directories ? 'Yes' : 'No'}`),
    mark('dispatch', `Assign work: ${modal.dispatch ? 'Yes' : 'No'}`), mark('replacement', `Replace existing receiving chats: ${modal.replacement ? 'Yes' : 'No'}`),
    'Review policy: human', 'Expiry: no expiry', 'This creates permission only. It does not itself open a new agent.'] : item ? [
    `Requesting agent: ${item.requesterName ?? item.from ?? 'This terminal'}`, `Destination: ${item.nodeName ?? 'Not applicable'} · ${item.machineName ?? ''}`,
    `State: ${item.stateLabel}`, ...(item.folders ?? []).map(folder => `Folder: ${folder}`), ...(item.actions ?? []).map(action => `Action: ${action}`),
    item.profiles?.length ? `Profiles: ${item.profiles.join(', ')}` : '', item.limits ?? '', `Expiry: ${grantDate(item.expiresAt)}`,
    ...(item.decidedBy ? [`Decided by: ${item.decidedBy}`, `When: ${item.at ? grantDate(item.at) : 'Not recorded'}`] : []),
    ...(item.topic ? [`Context: ${item.topic}`] : []), ...(item.reason ? [`Reason: ${item.reason}`] : []),
    ...(item.operation ? [`Preparation: ${item.operation.state}${item.operation.reason ? ` · ${item.operation.reason}` : ''}`] : []),
    ...(scopeEditing ? [mark('root', `Standing folder scope: ${modal.root}`), mark('limit', `Node-wide agent limit: ${modal.limit}`)] : []),
    ...(item.kind === 'publication' ? [item.context, item.summary] : []),
    ...(modal.technical ? [`Identity: ${item.entityId}`, `Revision: ${item.revision}`, `Node: ${item.nodeId ?? ''}`, `Request hash: ${item.requestHash ?? ''}`] : []),
  ] : ['Loading security item…'];
  const lines = [title, ...(modal.error ? ['Error', modal.error] : []), ...details.filter(Boolean), ...(modal.confirm && modal.reason ? [`Reason\n${modal.reason}`] : [])].flatMap(line => wrapBoardText(line, columns));
  const viewport = Math.max(1, size - 2 - titleRows - choiceLines.length - reasonRows - statusRows - hintRows), offset = Math.min(modal.scroll, Math.max(0, lines.length - viewport));
  return h(Box, { position: 'absolute', left: Math.max(0, Math.floor((width - w) / 2)), top: Math.max(0, Math.floor((height - size) / 2)),
    width: w, height: size, borderStyle: 'round', borderColor: 'yellow', backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' },
  h(BoardText, { text: title, columns, rows: titleRows, bold: true, color: 'yellow' }),
  h(Box, { height: viewport, flexDirection: 'column', overflow: 'hidden' }, ...lines.slice(offset, offset + viewport).map((line, i) => h(Text, { key: i, wrap: 'truncate-end' }, line))),
  ...choiceLines.map((choice, i) => h(Text, { key: i, wrap: 'truncate-end', flexShrink: 0, inverse: modal.index === choice.index && modal.field === 'choice',
    bold: modal.index === choice.index, color: modal.index === choice.index ? 'yellow' : undefined }, choice.text)),
  reasonRows ? h(BoardText, { text: mark('reason', `Reason (optional): ${modal.reason ?? ''}${modal.field === 'reason' && !modal.confirm ? '▏' : ''}`),
    columns, rows: reasonRows, tail: !modal.confirm, inverse: modal.field === 'reason' }) : null,
  statusRows ? h(BoardText, { text: statusText, columns, rows: statusRows, color: modal.error ? 'red' : 'yellow' }) : null,
  h(BoardText, { text: hint, columns, rows: hintRows, dimColor: true }));
}

export function GrantsPanel({ board, offline, loaded, width, height, detailGrant, decideGrant, createGrant, refresh, onView, onQuit, pendingGrantDecisions }) {
  const [section, setSection] = useState(0), [selected, setSelected] = useState(0), [filter, setFilter] = useState(''), [searching, setSearching] = useState(false);
  const [modal, setModal] = useState(null), [notice, setNotice] = useState('');
  const [rowScroll, setRowScroll] = useState(0);
  const sections = ['pending', 'active', 'history'], grants = board.grants ?? { pending: [], active: [], history: [] };
  const items = (grants[sections[section]] ?? []).filter(item => !filter || clean(`${item.title} ${item.summary} ${item.requesterName} ${item.nodeName} ${(item.folders ?? []).join(' ')}`).toLowerCase().includes(filter.toLowerCase()));
  const index = Math.min(selected, Math.max(0, items.length - 1));
  useEffect(() => { setSelected(0); }, [section, filter]);
  useEffect(() => { setRowScroll(0); }, [selected, section, filter, width, height]);
  const open = async item => {
    setModal({ item, busy: true, index: 0, field: 'choice', scroll: 0, reason: '', key: `human-grant:${randomUUID()}` });
    try {
      const fresh = await detailGrant({ id: item.id });
      setModal(value => value ? { ...value, item: fresh, busy: false, root: fresh.scope?.roots?.[0] ?? '', limit: String(fresh.scope?.maxAgents ?? '') } : value);
    } catch (error) { setModal(value => value ? { ...value, busy: false, loadingFailed: true, error: error.message } : value); }
  };
  const submit = async current => {
    let payload, scope;
    try {
      if (current.creating || current.item.section === 'pending' && current.index === 1 && current.item.kind === 'interactive') {
        const node = current.creating ? current.nodes?.[current.nodeIndex] : { id: current.item.nodeId };
        const ceiling = board.nodePolicies?.[node?.id];
        if (!ceiling) throw Error('Destination node workspace policy is unavailable. No decision was sent.');
        const roots = !current.creating && !current.rootEdited ? current.item.scope.roots : [current.root];
        const limit = Number(current.limit);
        if (!roots.every(root => canonicalDirectory(root) && (ceiling.mode === 'localUser' || withinRoots(root, ceiling.roots)))) throw Error('Folder scope is outside the destination node policy.');
        if (!Number.isSafeInteger(limit) || limit <= 0 || limit > ceiling.maxAgents) throw Error(`Node-wide limit must be 1..${ceiling.maxAgents}.`);
        scope = current.creating ? { mode: 'roots', roots, profiles: [current.profile], maxAgents: limit, allowNewEnrolments: true,
          allowCreateDirectories: current.directories, allowDispatch: current.dispatch, allowReplacement: current.replacement, reviewPolicy: 'human' } :
          { ...current.item.scope, roots, maxAgents: limit };
        if (current.creating) {
          const agent = current.agents[current.agentIndex];
          if (!agent || !/^[A-Za-z0-9_-]{1,64}$/.test(current.profile)) throw Error('An enrolled requester and valid profile are required.');
          payload = { id: current.entityId, requesterAgentId: agent.id, nodeId: node.id, scope, reason: current.reason ?? '' };
        }
      }
    } catch (error) { setModal({ ...current, confirm: false, error: error.message }); return; }
    setModal({ ...current, busy: true, locked: true, error: '' });
    try {
      const result = current.creating ? await createGrant({ key: current.key, payload }) : await decideGrant({ item: current.item, key: current.key,
        decision: (current.item?.kind === 'headless_contract' ? ['approve_once', 'reject'] : ['approve_once', 'allow_scope', 'reject'])[current.index], reason: current.reason, scope });
      if (result.state !== 'recorded') throw Error('Security decision is not confirmed');
      setModal(null); setNotice(result.message); refresh();
    } catch (error) { setModal({ ...current, busy: false, locked: true, error: error.message }); refresh(pendingGrantDecisions?.()); }
  };
  useInput((input, key) => {
    if (modal) return;
    if (searching) {
      if (key.escape) { setSearching(false); setFilter(''); }
      else if (key.return) setSearching(false);
      else if (key.backspace || key.delete) setFilter(v => [...v].slice(0, -1).join(''));
      else if (input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input)) setFilter(v => v + input);
      return;
    }
    if (key.tab) { onView(key.shift ? -1 : 1); return; }
    if (input === 'q' || key.escape) { onQuit(); return; }
    if (key.leftArrow || key.rightArrow || ['1', '2', '3'].includes(input)) { setSection(['1', '2', '3'].includes(input) ? Number(input) - 1 : (section + (key.rightArrow ? 1 : 2)) % 3); return; }
    if (key.downArrow || input === 'j') setSelected(v => Math.max(0, Math.min(items.length - 1, v + 1)));
    if (key.upArrow || input === 'k') setSelected(v => Math.max(0, v - 1));
    if (key.pageDown || key.pageUp) { setRowScroll(value => Math.max(0, Math.min(Math.max(0, (blocks[index]?.length || 0) - viewport), value + (key.pageDown ? viewport - 1 : 1 - viewport)))); return; }
    if (input === '/') setSearching(true);
    if (input === 'r') refresh();
    if (key.return && items[index] && detailGrant) void open(items[index]);
    if (input === 'n' && createGrant) {
      const agents = board.agents.filter(a => a.mode === 'interactive' && a.standingGrant), first = agents[0];
      const nodeIndex = Math.max(0, (board.nodes ?? []).findIndex(n => n.id === first?.nodeId));
      if (!board.grantsAvailable || !first) { setNotice('Grants management and an enrolled interactive agent are required.'); return; }
      setModal({ creating: true, agents, nodes: board.nodes ?? [], agentIndex: 0, nodeIndex, index: 0, field: 'agent', root: first.directory, profile: 'build',
        limit: String(board.nodePolicies?.[board.nodes[nodeIndex]?.id]?.maxAgents ?? ''), directories: false, dispatch: false, replacement: false,
        reason: '', scroll: 0, key: `human-grant:${randomUUID()}`, entityId: `permission_${randomUUID()}` });
    }
  });
  const header = ['RELAY / GRANTS', nativeBoardTabs(board, offline, loaded).map(([id, title]) => id === 'grants' ? `[${title}]` : title).join('  '),
    sections.map((name, i) => `${section === i ? '› ' : ''}${name[0].toUpperCase() + name.slice(1)} (${!loaded ? '…' : !board.grantsAvailable ? '?' : grants[name]?.length ?? 0})`).join('  '),
    offline ? 'OFFLINE · decisions remain retained for reconciliation' : 'Security requests and permissions. Folder scope is not an OS sandbox.'].flatMap(text => wrapBoardText(text, width));
  const footer = [searching ? `/${filter}▏` : notice || '←/→ or 1/2/3 sections · j/k move · Enter inspect · n new permission',
    'Tab main view · PgUp/Dn · / search · r refresh · q quit'].flatMap(text => wrapBoardText(text, width));
  const viewport = Math.max(1, height - header.length - footer.length - 2);
  const blocks = items.map(item => [item.title, `${item.requesterName ?? item.from ?? ''} → ${item.nodeName ?? 'This terminal'} · ${item.stateLabel}`,
    item.folders?.join('\n') || item.summary || '', ''].flatMap((text, field) => wrapBoardText(text, Math.max(1, width - 4)).map(text => ({ text, heading: field === 0 }))));
  const visible = boardRowViewport(blocks, index, viewport, rowScroll);
  return h(Box, { width, height, flexDirection: 'column' },
    ...header.map((line, i) => h(Text, { key: `header:${i}`, color: i === 0 ? 'yellow' : undefined, wrap: 'truncate-end', flexShrink: 0 }, line)),
    h(Box, { flexGrow: 1, borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexDirection: 'column', overflow: 'hidden' },
      !loaded ? h(Text, { dimColor: true }, 'Loading Grants…') : !board.grantsAvailable ? h(Text, { color: 'yellow' }, 'Backend upgrade required for Grants management.') : !items.length ? h(Text, { dimColor: true }, `No ${sections[section]} security items.`) : null,
      ...visible.map((line, i) => h(Text, { key: i, bold: line.heading, inverse: line.rowIndex === index && !modal,
        color: line.heading ? sections[section] === 'pending' ? 'yellow' : 'cyan' : undefined, wrap: 'truncate-end', flexShrink: 0 }, line.text || ' '))),
    ...footer.map((line, i) => h(Text, { key: `footer:${i}`, dimColor: !notice, color: notice ? 'cyan' : undefined, wrap: 'truncate-end', flexShrink: 0 }, line)),
    modal ? h(GrantDialog, { modal, setModal, submit, board, width, height }) : null);
}
