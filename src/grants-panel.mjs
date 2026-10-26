import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { randomUUID } from 'node:crypto';
import { decisionText } from './task-board-decision.mjs';
import { wrapBoardText } from './task-board-view.mjs';
import { grantDate } from './grants-view.mjs';
import { canonicalDirectory, withinRoots } from './interactive-contract.mjs';

const h = React.createElement, clean = value => decisionText(value).trim();
export const nativeBoardViews = ['tasks', 'agents', 'inbox', 'grants', 'schedules'];
export const nativeBoardTabs = (board, offline, loaded) => [['tasks', 'Tasks'], ['agents', 'Agents'],
  ['inbox', `Inbox (${offline ? '?' : !loaded ? '…' : board.inbox?.length ?? 0})`],
  ['grants', `Grants (${offline ? '?' : !loaded ? '…' : !board.grantsAvailable ? '?' : board.grants?.pending?.length ?? 0})`], ['schedules', 'Schedule']];

function GrantDialog({ modal, setModal, submit, board, width, height }) {
  const item = modal.item, creating = modal.creating;
  const choices = modal.loadingFailed ? [] : creating ? ['Create standing permission'] : item?.kind === 'publication' ? [item.action === 'dismiss' ? 'Dismiss refused decision' : 'Retry original decision'] :
    item?.section === 'pending' ? ['Approve once', 'Allow this scope', 'Reject'] : item?.section === 'active' ? ['Revoke'] : [];
  const agents = modal.agents ?? board.agents.filter(a => a.mode === 'interactive' && a.standingGrant), nodes = modal.nodes ?? board.nodes ?? [];
  const requester = agents[modal.agentIndex ?? 0], node = nodes[modal.nodeIndex ?? 0];
  const scopeEditing = creating || item?.section === 'pending' && modal.index === 1 && (item.scope?.roots?.length ?? 0) === 1;
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
    if (key.return && choices.length) { setModal({ ...modal, confirm: true, error: '' }); return; }
    if (['root', 'profile', 'limit', 'reason'].includes(modal.field)) {
      const name = modal.field, current = modal[name] ?? '';
      const value = key.backspace || key.delete ? [...current].slice(0, -1).join('') : input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input) ? current + input : current;
      if (value.length <= (name === 'reason' ? 4000 : 4096)) setModal({ ...modal, [name]: value, ...(name === 'root' ? { rootEdited: true } : {}) });
    }
  });
  const w = Math.max(16, Math.min(104, width - 2)), size = Math.max(10, Math.min(height - 2, 34));
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
  const lines = details.filter(Boolean).flatMap(line => wrapBoardText(clean(line), w - 6));
  const viewport = Math.max(2, size - (choices.length ? choices.length + 9 : 6)), offset = Math.min(modal.scroll, Math.max(0, lines.length - viewport));
  return h(Box, { position: 'absolute', left: Math.max(0, Math.floor((width - w) / 2)), top: Math.max(0, Math.floor((height - size) / 2)),
    width: w, height: size, borderStyle: 'round', borderColor: 'yellow', backgroundColor: 'black', paddingX: 2, flexDirection: 'column', overflow: 'hidden' },
  h(Text, { bold: true, color: 'yellow' }, creating ? 'New interactive provisioning permission' : clean(item?.title ?? 'Grants')),
  h(Box, { height: viewport, flexDirection: 'column', overflow: 'hidden' }, ...lines.slice(offset, offset + viewport).map((line, i) => h(Text, { key: i, wrap: 'truncate-end' }, line))),
  ...choices.map((choice, i) => h(Text, { key: choice, inverse: modal.index === i && modal.field === 'choice', bold: modal.index === i, color: modal.index === i ? 'yellow' : undefined }, `${modal.index === i ? '●' : '○'} ${choice}`)),
  choices.length && item?.kind !== 'publication' ? h(Text, { inverse: modal.field === 'reason', wrap: 'truncate-end' }, mark('reason', `Reason (optional): ${modal.reason ?? ''}`)) : null,
  modal.error ? h(Text, { color: 'red', wrap: 'wrap' }, clean(modal.error)) : modal.confirm ? h(Text, { bold: true, color: 'yellow' }, `Confirm: ${choices[modal.index]}`) : null,
  h(Box, { flexGrow: 1 }),
  h(Text, { dimColor: true, wrap: 'truncate-end' }, modal.locked ? 'Unconfirmed decision retained. Esc close; reconcile it in Grants → Pending.' : modal.confirm ? 'Enter apply · Esc back' :
    choices.length ? 'Esc close · Enter review · Tab edit · PgUp/Dn' : 'Esc close · PgUp/Dn scroll · t details'));
}

export function GrantsPanel({ board, offline, loaded, width, height, detailGrant, decideGrant, createGrant, refresh, onView, onQuit, pendingGrantDecisions }) {
  const [section, setSection] = useState(0), [selected, setSelected] = useState(0), [filter, setFilter] = useState(''), [searching, setSearching] = useState(false);
  const [modal, setModal] = useState(null), [notice, setNotice] = useState('');
  const sections = ['pending', 'active', 'history'], grants = board.grants ?? { pending: [], active: [], history: [] };
  const items = (grants[sections[section]] ?? []).filter(item => !filter || clean(`${item.title} ${item.summary} ${item.requesterName} ${item.nodeName} ${(item.folders ?? []).join(' ')}`).toLowerCase().includes(filter.toLowerCase()));
  const index = Math.min(selected, Math.max(0, items.length - 1));
  useEffect(() => { setSelected(0); }, [section, filter]);
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
      if (current.creating || current.item.section === 'pending' && current.index === 1 && current.item.kind !== 'publication') {
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
        decision: ['approve_once', 'allow_scope', 'reject'][current.index], reason: current.reason, scope });
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
  const count = Math.max(1, Math.floor((height - 8) / 4)), start = Math.max(0, Math.min(index - Math.floor(count / 2), items.length - count));
  return h(Box, { width, height, flexDirection: 'column' },
    h(Text, { bold: true, color: 'yellow' }, 'RELAY / GRANTS'),
    h(Box, { gap: 2 }, ...nativeBoardTabs(board, offline, loaded).map(([id, title]) => h(Text, { key: id, inverse: id === 'grants', color: id === 'grants' ? 'yellow' : undefined }, ` ${title} `))),
    h(Box, { gap: 2 }, ...sections.map((name, i) => h(Text, { key: name, inverse: section === i, color: section === i ? 'yellow' : undefined }, ` ${name[0].toUpperCase() + name.slice(1)} (${!loaded ? '…' : !board.grantsAvailable ? '?' : grants[name]?.length ?? 0}) `))),
    h(Text, { dimColor: true }, offline ? 'OFFLINE · decisions remain retained for reconciliation' : 'Security requests and permissions. Folder scope is not an OS sandbox.'),
    h(Box, { flexGrow: 1, borderStyle: 'round', borderColor: 'gray', paddingX: 1, flexDirection: 'column', overflow: 'hidden' },
      !loaded ? h(Text, { dimColor: true }, 'Loading Grants…') : !board.grantsAvailable ? h(Text, { color: 'yellow' }, 'Backend upgrade required for Grants management.') : !items.length ? h(Text, { dimColor: true }, `No ${sections[section]} security items.`) : null,
      ...items.slice(start, start + count).map((item, i) => h(Box, { key: item.id, height: 4, flexDirection: 'column', overflow: 'hidden' },
        h(Text, { bold: true, inverse: start + i === index && !modal, color: sections[section] === 'pending' ? 'yellow' : 'cyan', wrap: 'truncate-end' }, clean(item.title)),
        h(Text, { wrap: 'truncate-end' }, `  ${clean(item.requesterName ?? item.from ?? '')} → ${clean(item.nodeName ?? 'This terminal')} · ${clean(item.stateLabel)}`),
        h(Text, { dimColor: true, wrap: 'truncate-end' }, `  ${clean(item.folders?.join(' · ') || item.summary || '')}`)))),
    h(Text, { color: notice ? 'cyan' : undefined, dimColor: !notice, wrap: 'truncate-end' }, searching ? `/${filter}▏` : notice || '←/→ or 1/2/3 sections · j/k move · Enter inspect · n new permission'),
    h(Text, { dimColor: true }, 'Tab main view · / search · r refresh · q quit'),
    modal ? h(GrantDialog, { modal, setModal, submit, board, width, height }) : null);
}
