import React from 'react';
import { Box, Text, useInput } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import { wrapBoardText } from './task-board-view.mjs';

const h = React.createElement;
export const decisionText = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
  .replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
export function BoardDecisionModal({ modal, setModal, submit, width, height }) {
  const item = modal.item;
  const accent = item.kind === 'review' ? 'magenta' : item.kind === 'question' ? 'yellow' : 'cyan';
  const actions = item.disabled || item.kind === 'question' ? [] : item.kind === 'review'
    ? ['Accept result', 'Request changes'] : item.kind === 'reminder' ? ['Acknowledge reminder']
      : [item.action === 'dismiss' ? 'Dismiss refused decision' : 'Retry original decision'];
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.ctrl && input === 't') { setModal(value => ({ ...value, technical: !value.technical, scroll: 0 })); return; }
    if (key.escape) {
      if (modal.stage !== 'confirm' || modal.locked) setModal(null);
      else setModal(value => ({ ...value, stage: ['question', 'review'].includes(item.kind) ? 'edit' : 'inspect', field: 'text', error: '', scroll: 0 }));
      return;
    }
    if (key.pageDown || key.pageUp) { setModal(value => ({ ...value, scroll: Math.max(0, value.scroll + (key.pageDown ? 5 : -5)) })); return; }
    if (modal.stage === 'inspect') {
      if (input === 't') { setModal(value => ({ ...value, technical: !value.technical, scroll: 0 })); return; }
      if (key.downArrow || input === 'j') setModal(value => ({ ...value, index: Math.min(actions.length - 1, value.index + 1) }));
      if (key.upArrow || input === 'k') setModal(value => ({ ...value, index: Math.max(0, value.index - 1) }));
      if (key.return && actions.length) setModal(value => ({ ...value, stage: ['question', 'review'].includes(item.kind) ? 'edit' : 'confirm', scroll: 0 }));
      return;
    }
    if (modal.stage === 'confirm') { if (key.return) void submit(modal); return; }
    if (item.kind === 'review') {
      if (key.tab) { setModal(value => ({ ...value, field: value.field === 'decision' ? 'text' : 'decision' })); return; }
      if (modal.field === 'decision' && (key.downArrow || key.upArrow || key.leftArrow || key.rightArrow)) {
        setModal(value => ({ ...value, index: key.downArrow || key.rightArrow ? 1 : 0, scroll: 0 })); return;
      }
      if (key.return && modal.field === 'decision') { setModal(value => ({ ...value, field: 'text' })); return; }
    }
    if (key.return && !key.shift) {
      if (!modal.text.trim()) { setModal(value => ({ ...value, error: item.kind === 'question' ? 'An answer is required.' : 'A review reason is required.' })); return; }
      setModal(value => ({ ...value, stage: 'confirm', error: '', scroll: 0 })); return;
    }
    const text = key.backspace || key.delete ? [...modal.text].slice(0, -1).join('') : key.return && key.shift ? `${modal.text}\n`
      : input && !key.ctrl && !key.meta ? `${modal.text}${decisionText(input)}` : modal.text;
    if (text.length <= 4000) setModal(value => ({ ...value, text, field: 'text', error: '', scroll: 0 }));
  });
  const w = Math.max(32, Math.min(100, width - 2)), size = Math.max(10, Math.min(height - 2, 27));
  const columns = Math.max(8, w - 6), viewport = Math.max(2, size - actions.length - 9);
  const lines = value => wrapBoardText(value, columns);
  const effect = item.kind === 'review' ? modal.index === 0 ? item.acceptEffect : item.rejectEffect : item.effect;
  const content = [...lines(item.stateLabel), ...lines(item.from ? `From ${item.from}` : ''),
    ...(item.locationLabel ? lines(item.locationLabel) : []), '', ...lines(item.summary),
    ...(item.context ? ['', ...lines(`Context: ${item.context}`)] : []),
    ...(modal.technical ? ['', ...lines(`Identity: ${item.entityId}`), ...lines(`Revision: ${item.revision ?? 'stored operation'}`),
      ...lines(`Candidate: ${item.candidate ?? 'none'}`), ...lines(`Digest: ${item.resultDigest ?? 'not supplied'}`)] : []),
    ...(modal.stage !== 'inspect' && ['question', 'review'].includes(item.kind) ? ['', item.kind === 'question' ? 'Your answer' : 'Review reason',
      ...lines(`${modal.text}${modal.stage === 'edit' && modal.field !== 'decision' ? '▏' : ''}`)] : []),
    ...(modal.stage === 'confirm' ? ['', ...lines(effect ?? item.summary)] : [])];
  const start = Math.min(modal.scroll, Math.max(0, content.length - viewport));
  const editStart = modal.stage === 'edit' && modal.scroll === 0 ? Math.max(0, content.length - viewport) : start;
  return h(Box, { position: 'absolute', left: Math.max(0, Math.floor((width - w) / 2)), top: Math.max(0, Math.floor((height - size) / 2)),
    width: w, height: size, borderStyle: 'round', borderColor: 'gray', backgroundColor: 'black', paddingX: 2,
    flexDirection: 'column', overflow: 'hidden' },
  h(Text, { bold: true, color: accent, wrap: 'truncate-end' }, decisionText(item.title)),
  h(Box, { height: viewport, flexDirection: 'column', overflow: 'hidden' },
    ...content.slice(editStart, editStart + viewport).map((line, i) => h(Text, { key: i, wrap: 'truncate-end' }, line || ' '))),
  ...actions.map((action, i) => h(Text, { key: action, inverse: modal.index === i && (modal.field === 'decision' || modal.stage !== 'edit'), bold: modal.index === i,
    color: modal.index === i ? accent : undefined, dimColor: modal.index !== i }, `${item.kind === 'review' ? modal.index === i ? '● ' : '○ ' : ''}[ ${action} ]`)),
  h(Text, { color: modal.error ? 'red' : accent, wrap: 'truncate-end' }, modal.error || (modal.stage === 'confirm' ? 'Confirm this exact decision' : modal.stage === 'edit' ? `${modal.text.length}/4000` : `${editStart + 1}–${Math.min(content.length, editStart + viewport)} / ${content.length}`)),
  h(Box, { flexGrow: 1 }),
  h(Text, { dimColor: true, wrap: 'truncate-end' }, modal.busy ? 'Publishing confirmed decision…' : modal.locked ? 'Enter retry original decision · Esc close'
    : modal.stage === 'inspect' ? 'Enter open · t details · PgUp/PgDn · Esc later'
      : modal.stage === 'edit' ? item.kind === 'review' && modal.field === 'decision' ? '↑↓ choose · Type reason · Enter reason · Esc cancel'
        : w < 80 ? 'Type · Enter preview · Esc cancel' : `Type · ${item.kind === 'review' ? 'Tab decision' : 'Ctrl+T details'} · Enter preview · Esc cancel`
        : 'Enter confirm · PgUp/PgDn · Esc back'));
}
