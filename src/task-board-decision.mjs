import React from 'react';
import { Box, Text, useInput } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import { wrapBoardText } from './task-board-view.mjs';
import { BoardText, modalSize, appendBoardInput } from './board-text.mjs';

const h = React.createElement;
export const decisionText = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
  .replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
export function BoardDecisionModal({ modal, setModal, submit, width, height }) {
  const item = modal.item;
  const accent = item.kind === 'review' ? 'magenta' : item.kind === 'question' ? 'yellow' : 'cyan';
  const actions = item.disabled || item.kind === 'question' ? [] : item.kind === 'review'
    ? ['Accept result', 'Request changes'] : item.kind === 'run_result' ? ['Mark result read'] : item.kind === 'reminder' ? ['Acknowledge reminder']
      : [item.action === 'dismiss' ? 'Dismiss refused decision' : 'Retry original decision'];
  const { width: w, height: size } = modalSize(width, height);
  const columns = Math.max(1, w - 6);
  const lines = value => wrapBoardText(value, columns);
  const titleRows = Math.min(2, lines(item.title).length);
  const choices = actions.flatMap((action, index) => lines(`${item.kind === 'review' ? modal.index === index ? '● ' : '○ ' : ''}[ ${action} ]`).map(text => ({ text, index })));
  const hint = modal.busy ? 'Publishing confirmed decision…' : modal.locked ? 'Enter retry original decision · Esc close'
    : modal.stage === 'inspect' ? '↑↓ scroll · PgUp/PgDn · Home/End · Enter open · Esc later'
      : modal.stage === 'edit' ? item.kind === 'review' && modal.field === 'decision' ? 'PgUp/PgDn scroll · ↑↓ choose · Tab reason · Enter reason'
        : w < 80 ? '↑↓/PgUp/PgDn · Enter preview · Esc cancel' : `↑↓/PgUp/PgDn scroll · Home/End · ${item.kind === 'review' ? 'Tab decision' : 'Type answer'} · Enter preview`
        : '↑↓/PgUp/PgDn scroll · Home/End · Enter confirm · Esc back';
  const statusText = modal.error ? 'Error: inspect details above' : modal.stage === 'confirm' ? 'Confirm this exact decision' : modal.stage === 'edit' ? `${modal.text.length}/4000` : '';
  const hintRows = lines(hint).length, statusRows = statusText ? lines(statusText).length : 0;
  const viewport = Math.max(1, size - 2 - titleRows - choices.length - hintRows - statusRows - 1);
  const effect = item.kind === 'review' ? modal.index === 0 ? item.acceptEffect : item.rejectEffect : item.effect;
  const content = [...lines(item.title), ...(modal.error ? ['Error', ...lines(modal.error), ''] : []), ...lines(item.stateLabel), ...lines(item.from ? `From ${item.from}` : ''),
    ...(item.locationLabel ? lines(item.locationLabel) : []), '', ...lines(item.summary),
    ...(item.context ? ['', ...lines(`Context: ${item.context}`)] : []),
    ...(modal.technical ? ['', ...lines(`Identity: ${item.entityId}`), ...lines(`Revision: ${item.revision ?? 'stored operation'}`),
      ...lines(`Candidate: ${item.candidate ?? 'none'}`), ...lines(`Digest: ${item.resultDigest ?? 'not supplied'}`)] : []),
    ...(modal.stage !== 'inspect' && ['question', 'review'].includes(item.kind) ? ['', item.kind === 'question' ? 'Your answer' : 'Review reason',
      ...lines(`${modal.text}${modal.stage === 'edit' && modal.field !== 'decision' ? '▏' : ''}`)] : []),
    ...(modal.stage === 'confirm' ? ['', ...lines(effect ?? item.summary)] : [])];
  const maxScroll = Math.max(0, content.length - viewport);
  const start = modal.error && !modal.manualScroll ? 0 : modal.stage === 'edit' && !modal.manualScroll && modal.scroll === 0 ? maxScroll : Math.min(modal.scroll, maxScroll);
  useInput((input, key) => {
    if (modal.busy) return;
    if (key.ctrl && input === 't') { setModal(value => ({ ...value, technical: !value.technical, scroll: 0 })); return; }
    if (key.escape) {
      if (modal.stage !== 'confirm' || modal.locked) setModal(null);
      else setModal(value => ({ ...value, stage: ['question', 'review'].includes(item.kind) ? 'edit' : 'inspect', field: 'text', error: '', scroll: 0 }));
      return;
    }
    const choosingDecision = modal.stage === 'edit' && item.kind === 'review' && modal.field === 'decision';
    const lineDown = key.downArrow && !choosingDecision || modal.stage !== 'edit' && input === 'j';
    const lineUp = key.upArrow && !choosingDecision || modal.stage !== 'edit' && input === 'k';
    if (key.pageDown || key.pageUp || key.home || key.end || lineDown || lineUp) {
      const next = key.home ? 0 : key.end ? maxScroll : start + (key.pageDown ? viewport : key.pageUp ? -viewport : lineDown ? 1 : -1);
      setModal(value => ({ ...value, manualScroll: true, scroll: Math.max(0, Math.min(maxScroll, next)) })); return;
    }
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
    const text = appendBoardInput(modal.text, input, key, 4000);
    if (text.length <= 4000) setModal(value => ({ ...value, text, field: 'text', error: '', scroll: 0, manualScroll: false }));
  });
  return h(Box, { position: 'absolute', left: Math.max(0, Math.floor((width - w) / 2)), top: Math.max(0, Math.floor((height - size) / 2)),
    width: w, height: size, borderStyle: 'round', borderColor: 'gray', backgroundColor: 'black', paddingX: 2,
    flexDirection: 'column', overflow: 'hidden' },
  h(BoardText, { text: item.title, columns, rows: titleRows, bold: true, color: accent }),
  h(Box, { height: viewport, flexDirection: 'column', overflow: 'hidden' },
    ...content.slice(start, start + viewport).map((line, i) => h(Text, { key: i, wrap: 'truncate-end' }, line || ' '))),
  ...choices.map((choice, i) => h(Text, { key: i, wrap: 'truncate-end', flexShrink: 0,
    inverse: modal.index === choice.index && (modal.field === 'decision' || modal.stage !== 'edit'), bold: modal.index === choice.index,
    color: modal.index === choice.index ? accent : undefined, dimColor: modal.index !== choice.index }, choice.text)),
  h(Text, { color: accent }, `${start + 1}–${Math.min(content.length, start + viewport)}/${content.length}`),
  statusRows ? h(BoardText, { text: statusText, columns, rows: statusRows, color: modal.error ? 'red' : accent }) : null,
  h(BoardText, { text: hint, columns, rows: hintRows, dimColor: true }));
}
