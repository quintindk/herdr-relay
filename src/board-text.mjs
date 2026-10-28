import React from 'react';
import { Box, Text } from 'ink';
import { wrapBoardText } from './task-board-view.mjs';

const h = React.createElement;
export const modalSize = (width, height, maxWidth = 100, maxHeight = 27) => ({
  width: Math.max(8, Math.min(maxWidth, width - 2)), height: Math.max(6, Math.min(maxHeight, height - 2)),
});

/** Fixed-height, lossless text viewport shared by editors and read-only panels. */
export function BoardText({ text, columns, rows, scroll = 0, tail = false, ...style }) {
  const lines = wrapBoardText(text, columns);
  const start = tail ? Math.max(0, lines.length - rows) : Math.max(0, Math.min(scroll, lines.length - rows));
  return h(Box, { height: rows, flexDirection: 'column', flexShrink: 0, overflow: 'hidden' },
    ...lines.slice(start, start + rows).map((line, index) => h(Text, { ...style, key: index, wrap: 'truncate-end' }, line || ' ')));
}

export function appendBoardInput(current, input, key, limit) {
  const next = key.backspace || key.delete ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(current), s => s.segment).slice(0, -1).join('')
    : key.return && key.shift ? `${current}\n` : input && !key.ctrl && !key.meta ? current + input.replace(/\r\n?/g, '\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '') : current;
  return next.length <= limit ? next : current;
}
