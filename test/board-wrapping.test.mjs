import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import { wrapBoardText, truncateBoardText } from '../src/task-board-view.mjs';
import { appendBoardInput } from '../src/board-text.mjs';
import { routineDetailLayout } from '../src/board-detail-layout.mjs';
import { layoutBoardRows, boardRowViewport } from '../src/board-row-layout.mjs';
import { assignmentRows } from '../src/task-board-dispatch.mjs';

for (const columns of [4, 18, 40, 74, 120]) test(`word wrapping preserves all text and terminal-cell boundaries at ${columns} columns`, () => {
  for (const text of ['alpha beta gamma delta with  two spaces ', '界界 e\u0301 🙂 👨‍👩‍👧‍👦 suffix', `https://example.test/${'x'.repeat(270)}`]) {
    const lines = wrapBoardText(text, columns);
    assert.equal(lines.join(''), text);
    assert.ok(lines.every(line => stringWidth(line) <= columns));
  }
  assert.deepEqual(wrapBoardText('first\n\nthird', columns).filter(line => !line), ['']);
});

test('editor cursor wraps before drawing; paste/newlines and grapheme deletion survive unchanged', () => {
  assert.deepEqual(wrapBoardText('abcd▏', 4), ['abcd', '▏']);
  assert.equal(appendBoardInput('', 'first\r\nsecond', {}, 4000), 'first\nsecond');
  assert.equal(appendBoardInput('text', '', { return: true, shift: true }, 4000), 'text\n');
  assert.equal(appendBoardInput('a👨‍👩‍👧‍👦', '', { backspace: true }, 4000), 'a');
  assert.equal(appendBoardInput('ae\u0301', '', { backspace: true }, 4000), 'a');
  assert.equal(appendBoardInput('abcd', 'e', {}, 4), 'abcd');
});

test('cron detail maps every wrapped summary line to its occurrence without flattening paragraphs', () => {
  const entries = [{ run: { id: 'one', nativeOccurrence: true, status: 'completed', summary: 'First paragraph.\n\n' + 'Long source evidence '.repeat(30) } },
    { run: { id: 'two', nativeOccurrence: true, status: 'failed', summary: 'SECOND_OCCURRENCE_END' } }];
  const { lines, ranges } = routineDetailLayout({ title: 'job', runs: [], cron: '* * * * *', timezone: 'Africa/Johannesburg', targetAgentId: 'long-target'.repeat(10) }, entries, 24);
  assert.ok(ranges[1].start > ranges[0].start + 20);
  assert.ok(lines.slice(ranges[0].start, ranges[0].end).every(line => line.occurrenceIndex === 0));
  assert.ok(lines.slice(ranges[1].start, ranges[1].end).every(line => line.occurrenceIndex === 1));
  assert.ok(lines.every(line => stringWidth(line.text) <= 24));
  assert.ok(lines.slice(ranges[0].start, ranges[0].end).some(line => !line.text));
});

test('wrapped list rows retain text and selection through long cards and resize', () => {
  const rows = [{ type: 'inbox', item: { title: 'Long title '.repeat(12), summary: 'Full report '.repeat(150), stateLabel: 'Unread' } }];
  for (const columns of [24, 80]) {
    const blocks = layoutBoardRows(rows, { columns, native: true, rowText: () => '', statusLabel: () => '' });
    const collected = new Set();
    for (let offset = 0; offset < blocks[0].length; offset += 6) for (const line of boardRowViewport(blocks, 0, 7, offset)) {
      assert.equal(line.rowIndex, 0); assert.ok(stringWidth(line.text) <= columns - 4); collected.add(line.text);
    }
    assert.ok(blocks[0].every(line => collected.has(line.text)));
  }
});

test('single-line truncation uses literal dots and never splits wide or joined graphemes', () => {
  const text = '界界 e\u0301 🙂 👨‍👩‍👧‍👦 suffix';
  const boundaries = new Set(['']);
  let prefix = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    prefix += segment; boundaries.add(prefix);
  }
  for (const columns of [0, 1, 2, 3, 4, 8, 12, 18, 40]) {
    const result = truncateBoardText(text, columns);
    assert.ok(stringWidth(result) <= columns, result);
    if (stringWidth(text) <= columns) assert.equal(result, text);
    else {
      const suffix = '.'.repeat(Math.min(3, columns));
      assert.ok(result.endsWith(suffix));
      assert.ok(boundaries.has(suffix ? result.slice(0, -suffix.length) : result));
    }
  }
  assert.equal(truncateBoardText('exact', 5), 'exact');
  assert.equal(truncateBoardText('first\nsecond\x1b[31m', 30), 'first second');
});

for (const native of [true, false]) test(`Tasks rows and group headings stay single-line through resize (${native ? 'native' : 'combined'} board)`, () => {
  const rows = [{ type: 'group', name: 'Owner '.repeat(30) },
    { type: 'task', task: { reference: 'REL-32', title: 'Long title '.repeat(40) } },
    { type: 'task', task: { reference: 'ABCDEFGHIJKLMNOP-9007199254740991', title: '界👨‍👩‍👧‍👦'.repeat(30) } }];
  for (const columns of [4, 18, 24, 40, 74, 120]) {
    const blocks = layoutBoardRows(rows, { columns, native,
      rowText: row => row.type === 'group' ? row.name : `${row.task.reference} ${row.task.title}`,
      statusLabel: () => 'Blocked · '.repeat(20) });
    assert.ok(blocks.every(block => block.length === 1));
    for (const [line] of blocks) {
      if (line.text !== undefined) {
        assert.ok(line.text.endsWith('...') || columns < 7);
        assert.ok(stringWidth(line.text) <= Math.max(1, columns - (native ? 4 : 2)));
      } else {
        assert.ok(line.left.endsWith('...')); assert.ok(line.right.endsWith('...'));
        assert.ok(stringWidth(line.left) <= line.leftWidth); assert.ok(stringWidth(line.right) <= line.rightWidth);
        assert.ok(line.leftWidth + line.gap + line.rightWidth <= columns - 4);
      }
    }
    assert.deepEqual(boardRowViewport(blocks, 2, 2).map(line => line.rowIndex), [1, 2]);
  }
});

test('assignment headings group exact node identities and keep human outside node groups', () => {
  const lines = assignmentRows([{ kind: 'human', id: 'human' },
    { id: 'a', displayName: 'Mason', nodeId: 'one', nodeName: 'Evo', locality: 'local', directory: '/work/one' },
    { id: 'b', displayName: 'Mason', nodeId: 'two', nodeName: 'Surface1', directory: '/work/two' }], 30);
  assert.equal(lines[0].text, 'You (human)');
  assert.ok(lines.some(line => line.heading && /Evo · this node/.test(line.text)));
  assert.ok(lines.some(line => line.heading && /Surface1/.test(line.text)));
  assert.ok(lines.filter(line => line.heading).every(line => line.index === undefined));
});
