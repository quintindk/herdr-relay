import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { buildBoardRows, renderTaskBoard, watchTaskBoard } from '../src/task-board-view.mjs';

const now = Date.parse('2026-10-07T10:00:00Z');
const task = (id, extra = {}) => ({ id, companyId: 'c', identifier: `R-${id}`, title: `Task ${id}`, status: 'todo', priority: 'medium', ...extra });
const board = (tasks = []) => ({ companies: [{ id: 'c', name: 'Acme' }],
  agents: [{ id: 'a', companyId: 'c', name: 'Ada', availability: 'idle', bridgeState: 'connected', nativeState: 'idle' },
    { id: 'b', companyId: 'c', name: 'Babbage', availability: 'busy', bridgeState: 'connected', nativeState: 'running' }],
  projects: [{ id: 'p', companyId: 'c', name: 'Engine' }], tasks, fetchedAt: new Date(now).toISOString(), warnings: [] });
const sample = () => board([
  task('1', { title: 'Choose release', assigneeUserId: 'local-board', status: 'in_review' }),
  task('2', { title: 'Build engine', assigneeAgentId: 'a', status: 'in_progress', projectId: 'p' }),
  task('3', { title: 'Check valves', assigneeAgentId: 'a', parentId: '2', status: 'blocked', priority: 'high' }),
  task('4', { title: 'Publish notes', assigneeAgentId: 'b', parentId: '2' }),
]);

test('plain narrow frame snapshot has a compact hierarchy and fixed geometry', () => {
  const frame = renderTaskBoard(sample(), { width: 50, height: 18, now });
  assert.equal(frame.text.split('\n').map(line => line.trimEnd()).join('\n'), [
    'RELAY / TASKS               1 companies / 2 agents',
    'OPEN 4   ACTIVE 1   BLOCKED 1   REVIEW 1',
    'FETCHED 0s ago / completed hidden / idle hidden',
    '--------------------------------------------------',
    '> - Human: Board (local-board)       1 open / Acme',
    '  `-. R-1 Choose release                 REVIEW',
    '  - Ada / idle                       2 open / Acme',
    '  `-- R-2 Build engine [+1/2 open]       ACTIVE',
    '    `-. R-3 Check valves                 BLOCKED !',
    '  - Babbage / busy                   1 open / Acme',
    '  `-- R-2 [via Ada] Build engine [+1/1 ~ ACTIVE',
    '    `-. R-4 Publish notes                TODO',
    '', '', '',
    '--------------------------------------------------',
    'j/k move  Enter fold  / find  Tab detail  q quit',
    '1-8/8 / READ ONLY / h done / i idle / r refresh',
  ].join('\n'));
  assert.equal(frame.rows.length, 8);
  assert.equal(frame.selectedId, frame.rows[0].id);
});

test('wide colour frame exposes projects, Unicode branches, state colours and selected detail', () => {
  const value = sample();
  const selectedId = buildBoardRows(value).find(row => row.taskId === '3').id;
  const frame = renderTaskBoard(value, { width: 100, height: 24, now, colour: true, detail: true, selectedId });
  assert.match(frame.text, /\x1b\[33;7m/);
  assert.match(frame.text, /\x1b\[35m/);
  assert.match(frame.text, /└─/);
  assert.match(frame.text, /Engine/);
  assert.match(frame.text, /DETAIL \/ READ ONLY/);
  assert.match(frame.text, /Ada \/ blocked \/ no project/);
  assert.equal(frame.text.split('\n').length, 24);
  assert.ok(frame.text.split('\n').every(line => stripVTControlCharacters(line).length === 100));
});

test('ownership distinguishes board, humans, unassigned, missing agents and idle agents', () => {
  const value = board([task('board', { assigneeUserId: 'local-board' }), task('human', { assigneeUserId: 'quintin' }),
    task('none'), task('missing', { assigneeAgentId: 'absent' })]);
  const rows = buildBoardRows(value);
  assert.deepEqual(rows.filter(row => row.type === 'group').map(row => row.name), [
    'Human: Board (local-board)', 'Babbage', 'Human: quintin', 'Unassigned', 'Agent: absent (missing)',
  ]);
  assert.equal(rows.filter(row => row.type === 'task').length, 4);
  assert.ok(buildBoardRows(value, { showIdle: true }).some(row => row.name === 'Ada'));
});

test('completed ancestors remain context across assignment, filters and collapse', () => {
  const value = board([task('1', { assigneeAgentId: 'a', status: 'done' }),
    task('2', { assigneeAgentId: 'b', parentId: '1' }), task('3', { assigneeAgentId: 'b', parentId: '2', status: 'in_review' })]);
  const rows = buildBoardRows(value);
  const parent = rows.find(row => row.taskId === '1');
  assert.equal(parent.context, true); assert.equal(parent.owner, 'Ada');
  assert.deepEqual(parent.counts, { total: 2, open: 2, active: 0, blocked: 0, review: 1 });
  assert.equal(parent.descendants, 2);
  const filtered = buildBoardRows(value, { filter: 'Task 3' });
  assert.deepEqual(filtered.filter(row => row.task).map(row => [row.taskId, row.context]), [['1', true], ['2', true], ['3', false]]);
  const expanded = new Set(rows.filter(row => row.expandable && row.id !== parent.id).map(row => row.id));
  assert.deepEqual(buildBoardRows(value, { expanded }).filter(row => row.task).map(row => row.taskId), ['1']);
  assert.equal(buildBoardRows(value, { showDone: true }).filter(row => row.taskId === '1').length, 2);
  assert.equal(buildBoardRows(value, { filter: 'no match' }).length, 0);
});

test('company-scoped IDs never join foreign tasks, owners or projects; orphans and cycles survive', () => {
  const value = board([task('same', { assigneeAgentId: 'a', parentId: 'foreign', projectId: 'p' }),
    task('same', { companyId: 'd', assigneeAgentId: 'a', parentId: 'loop', projectId: 'p' }),
    task('loop', { companyId: 'd', assigneeAgentId: 'a', parentId: 'same' }),
    task('foreign', { companyId: 'd', parentId: 'foreign' })]);
  value.companies.push({ id: 'd', name: 'Other' });
  value.agents.push({ id: 'a', companyId: 'd', name: 'Foreign Ada' });
  value.projects.push({ id: 'p', companyId: 'd', name: 'Other project' });
  const rows = buildBoardRows(value).filter(row => row.task);
  assert.equal(rows.length, 4); assert.equal(new Set(rows.map(row => row.id)).size, 4);
  const local = rows.find(row => row.companyId === 'c');
  assert.equal(local.anomaly, 'orphan'); assert.equal(local.owner, 'Ada'); assert.equal(local.projectName, 'Engine');
  assert.equal(rows.find(row => row.taskId === 'same' && row.companyId === 'd').owner, 'Foreign Ada');
  assert.equal(rows.filter(row => row.anomaly === 'cycle').length, 2);
});

test('status labels and overview use the whole snapshot, not duplicated context or search hits', () => {
  const value = board(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled', 'custom_status'].map((status, i) => task(String(i), { status })));
  const frame = renderTaskBoard(value, { width: 100, height: 24, now, showDone: true });
  for (const label of ['BACKLOG', 'TODO', 'ACTIVE', 'REVIEW', 'BLOCKED', 'DONE', 'CANCEL', 'CUSTOM~']) assert.ok(frame.text.includes(label), label);
  assert.match(frame.text, /OPEN 6   ACTIVE 1   BLOCKED 1   REVIEW 1/);
  assert.equal(buildBoardRows(value).filter(row => row.task).length, 6);
  assert.match(renderTaskBoard(sample(), { filter: 'valves', now }).text, /OPEN 4   ACTIVE 1   BLOCKED 1   REVIEW 1/);
});

test('hostile source fields cannot emit terminal controls or bidi overrides', () => {
  const hostile = '\x1b[2J\x1b]52;c;YQ==\x07BAD\n\r\t\x00\x9b\u202e\u2066';
  const value = board([task('bad', { title: hostile, identifier: hostile, descriptionPreview: hostile, status: hostile, updatedAt: hostile })]);
  value.companies[0].name = hostile; value.warnings = [hostile];
  const rows = buildBoardRows(value);
  for (const colour of [false, true]) {
    const frame = renderTaskBoard(value, { colour, now, detail: true, selectedId: rows.find(row => row.task).id, offline: hostile });
    const plain = stripVTControlCharacters(frame.text);
    assert.doesNotMatch(plain, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e\u2066]/);
    if (!colour) assert.equal(frame.text, plain);
    else assert.doesNotMatch(frame.text.replace(/\x1b\[[0-9;]+m/g, ''), /\x1b/);
  }
});

test('CJK, combining accents and joined emoji truncate by terminal cells, never wrap', () => {
  const value = board([task('1', { title: '界'.repeat(100) }), task('2', { title: 'e\u0301'.repeat(100) }),
    task('3', { title: '👩‍💻'.repeat(100) }), task('4', { title: '🇿🇦'.repeat(100) })]);
  const cells = text => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)]
    .reduce((sum, { segment }) => sum + (/界|\p{Emoji_Presentation}/u.test(segment) ? 2 : 1), 0);
  for (const width of [1, 12, 50, 100]) for (const height of [1, 5, 18, 30]) {
    const frame = renderTaskBoard(value, { width, height, now });
    assert.equal(frame.text.split('\n').length, height);
    assert.ok(frame.text.split('\n').every(line => cells(line) === width), `${width}x${height}`);
    assert.doesNotMatch(frame.text, /\uFFFD/);
  }
});

test('selection stays in view, offsets clamp, stale selection falls back and input is immutable', () => {
  const value = board(Array.from({ length: 50 }, (_, i) => task(String(i), { assigneeAgentId: 'a' })));
  const before = structuredClone(value);
  const rows = buildBoardRows(value);
  const frame = renderTaskBoard(value, { height: 12, now, selectedId: rows.at(-1).id });
  assert.ok(frame.visibleRows.some(row => row.id === frame.selectedId));
  assert.ok(frame.offset > 0);
  assert.equal(renderTaskBoard(value, { selectedId: 'gone', offset: 999, now }).offset, 0);
  assert.equal(renderTaskBoard(value, { offset: -8, now }).offset, 0);
  assert.deepEqual(value, before);
});

test('ordinary selections retain inverse video and sibling branches retain continuation guides', () => {
  const value = board([task('1'), task('2', { parentId: '1' }), task('3')]);
  const selectedId = buildBoardRows(value).find(row => row.taskId === '2').id;
  const frame = renderTaskBoard(value, { width: 100, height: 20, now, colour: true, selectedId });
  assert.match(frame.text, /\x1b\[0;7m/);
  assert.deepEqual(stripVTControlCharacters(frame.text).split('\n').filter(line => /R-[123]/.test(line))
    .map(line => line.slice(0, 42).trimEnd()), [
    '  ├─▾ R-1 Task 1 [+1/2 open]',
    '▸ │ └─· R-2 Task 2',
    '  └─· R-3 Task 3',
  ]);
});

test('deep task chains do not recurse and rendered indentation stays bounded', () => {
  const value = board(Array.from({ length: 3000 }, (_, index) => task(String(index), {
    assigneeAgentId: 'a', parentId: index ? String(index - 1) : null,
  })));
  const rows = buildBoardRows(value);
  assert.equal(rows.filter(row => row.task).length, 3000);
  assert.equal(rows.find(row => row.taskId === '0').descendants, 2999);
  const frame = renderTaskBoard(value, { width: 50, height: 12, now, selectedId: rows.at(-1).id });
  assert.ok(frame.text.includes('R-2999'));
  assert.ok(frame.text.split('\n').every(line => line.length === 50));
});

function streams(tty = true) {
  const input = new EventEmitter(); const output = new EventEmitter();
  input.isTTY = output.isTTY = tty; input.isRaw = false; input.paused = true; input.readableFlowing = null;
  input.raw = []; input.setRawMode = flag => { input.isRaw = flag; input.raw.push(flag); };
  input.resume = () => { input.paused = false; input.readableFlowing = true; };
  input.pause = () => { input.paused = true; input.readableFlowing = false; };
  input.isPaused = () => input.paused;
  output.columns = 100; output.rows = 24; output.chunks = [];
  output.write = text => { output.chunks.push(text); output.emit('written', text); return true; };
  return { input, output };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function screen(output) {
  let lines = [];
  for (const chunk of output.chunks) {
    if (chunk.includes('\x1b[2J')) lines = stripVTControlCharacters(chunk).split('\r\n');
    else for (const match of chunk.matchAll(/\x1b\[(\d+);1H([\s\S]*?)(?=\x1b\[\d+;1H|$)/g)) {
      lines[Number(match[1]) - 1] = stripVTControlCharacters(match[2]);
    }
  }
  return lines.join('\n');
}

test('non-TTY reads exactly once, remains ASCII/plain and never touches raw mode', async () => {
  const io = streams(false); let reads = 0;
  await watchTaskBoard(() => { reads++; return sample(); }, io);
  assert.equal(reads, 1); assert.deepEqual(io.input.raw, []);
  assert.doesNotMatch(io.output.chunks.join(''), /\x1b|└|─|▾/);
  assert.equal(io.input.listenerCount('data'), 0);
});

test('split UTF-8 search input is decoded without replacement characters', async t => {
  const io = streams();
  const running = watchTaskBoard(() => board([task('1', { title: '界 view' })]), { ...io, interval: 60_000 });
  t.after(() => io.input.emit('data', '\x03'));
  await tick(); io.input.emit('data', '/');
  const bytes = Buffer.from('界');
  io.input.emit('data', bytes.subarray(0, 1)); io.input.emit('data', bytes.subarray(1));
  assert.match(io.output.chunks.at(-1), /\/界_/);
  assert.doesNotMatch(io.output.chunks.at(-1), /\uFFFD/);
  io.input.emit('data', '\x03'); await running;
});

test('TTY navigation, folding, search, details, idle/completed toggles, resize and quit restore state', async t => {
  const io = streams(); const signals = process.listenerCount('SIGTERM');
  const running = watchTaskBoard(async () => sample(), { ...io, interval: 60_000 });
  t.after(() => io.input.emit('data', 'q'));
  await tick();
  const latest = () => screen(io.output);
  io.input.emit('data', ' '); assert.doesNotMatch(latest(), /Choose release/);
  io.input.emit('data', '\r'); assert.match(latest(), /Choose release/);
  io.input.emit('data', '\x1b['); io.input.emit('data', 'Bj\t');
  assert.match(latest(), /DETAIL \/ READ ONLY/);
  io.input.emit('data', 'hi'); assert.match(latest(), /completed shown \/ idle shown/);
  io.input.emit('data', '/valves'); assert.match(latest(), /filter|\/valves_/); assert.doesNotMatch(latest(), /Choose release/);
  io.input.emit('data', '\x7f\r'); assert.match(latest(), /filter: valve/);
  io.input.emit('data', '\x1b'); await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(latest(), /Choose release/);
  io.output.columns = 50; io.output.emit('resize'); assert.match(latest(), /j\/k move  Enter fold  \/ find/);
  io.input.emit('data', 'q'); await running;
  assert.deepEqual(io.input.raw, [true, false]); assert.equal(io.input.paused, true);
  assert.match(io.output.chunks[0], /\x1b\[\?1049h/); assert.match(io.output.chunks.at(-1), /\x1b\[\?1049l/);
  assert.equal(io.input.listenerCount('data'), 0); assert.equal(io.output.listenerCount('resize'), 0);
  assert.equal(process.listenerCount('SIGTERM'), signals);
});

test('failed and malformed refreshes retain the last good snapshot with explicit offline age', async t => {
  const io = streams(); let calls = 0;
  const running = watchTaskBoard(async () => {
    calls++;
    if (calls === 2) throw new Error('network\x1b[2J unavailable');
    if (calls === 3) return { tasks: [] };
    return { ...sample(), fetchedAt: new Date(Date.now() - 120_000).toISOString() };
  }, { ...io, interval: 60_000 });
  t.after(() => io.input.emit('data', 'q'));
  await tick(); io.input.emit('data', 'r'); await tick();
  assert.match(io.output.chunks.at(-1), /OFFLINE \/ last good 2m ago \/ network unavailable/);
  assert.match(screen(io.output), /Build engine/);
  io.input.emit('data', 'r'); await tick();
  assert.match(screen(io.output), /OFFLINE/); assert.match(screen(io.output), /Build engine/);
  io.input.emit('data', 'r'); await tick(); assert.doesNotMatch(io.output.chunks.at(-1), /OFFLINE/);
  io.input.emit('data', 'q'); await running;
  assert.equal(calls, 4);
});

test('unchanged refreshes emit nothing and navigation repaints only the two selected rows', async t => {
  const io = streams(); const value = { ...sample(), fetchedAt: null };
  const running = watchTaskBoard(() => value, { ...io, interval: 60_000 });
  t.after(() => io.input.emit('data', 'q'));
  await tick();
  const writes = io.output.chunks.length;
  io.input.emit('data', 'r'); await tick();
  io.input.emit('data', 'x');
  assert.equal(io.output.chunks.length, writes);
  io.input.emit('data', 'j');
  const update = io.output.chunks.at(-1);
  assert.doesNotMatch(update, /\x1b\[2J|RELAY \/ TASKS/);
  assert.deepEqual([...update.matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1])), [5, 6]);
  assert.equal(screen(io.output), stripVTControlCharacters(renderTaskBoard(value, {
    width: 100, height: 24, colour: true, selectedId: buildBoardRows(value)[1].id,
  }).text));
  io.input.emit('data', 'q'); await running;
});

test('refresh changes and removals overwrite affected rows while resize repaints the viewport', async t => {
  const io = streams(); let value = { ...sample(), fetchedAt: null };
  const running = watchTaskBoard(() => value, { ...io, interval: 60_000 });
  t.after(() => io.input.emit('data', 'q'));
  await tick(); io.input.emit('data', 'j');
  const selectedId = buildBoardRows(value)[1].id;
  value = structuredClone(value); value.tasks[0].title = 'Short';
  io.input.emit('data', 'r'); await tick();
  assert.deepEqual([...io.output.chunks.at(-1).matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1])), [6]);
  assert.equal(screen(io.output), stripVTControlCharacters(renderTaskBoard(value, {
    width: 100, height: 24, colour: true, selectedId,
  }).text));
  value = { ...value, tasks: value.tasks.slice(0, 1) };
  io.input.emit('data', 'r'); await tick();
  assert.doesNotMatch(io.output.chunks.at(-1), /\x1b\[2J/);
  assert.doesNotMatch(screen(io.output), /Build engine|Check valves|Publish notes/);
  assert.equal(screen(io.output), stripVTControlCharacters(renderTaskBoard(value, {
    width: 100, height: 24, colour: true, selectedId,
  }).text));
  io.output.columns = 50; io.output.rows = 12; io.output.emit('resize');
  assert.match(io.output.chunks.at(-1), /\x1b\[H\x1b\[2J/);
  assert.equal(screen(io.output), stripVTControlCharacters(renderTaskBoard(value, {
    width: 50, height: 12, colour: true, selectedId,
  }).text));
  io.input.emit('data', 'q'); await running;
});

test('quit interrupts a hung read and prevents late writes; prior raw/flowing state is preserved', async () => {
  const io = streams(); io.input.isRaw = true; io.input.paused = false; io.input.readableFlowing = true;
  let resolve;
  const running = watchTaskBoard(() => new Promise(done => { resolve = done; }), io);
  io.input.emit('data', '\x03'); await running;
  const writes = io.output.chunks.length;
  resolve(sample()); await tick();
  assert.equal(io.output.chunks.length, writes); assert.deepEqual(io.input.raw, [true, true]);
  assert.equal(io.input.paused, false);
});

test('quit pauses fresh non-flowing stdin and aborts the pending refresh', async () => {
  const io = streams(); io.input.paused = false;
  let signal;
  const running = watchTaskBoard(value => { signal = value; return new Promise(() => {}); }, io);
  io.input.emit('data', 'q'); await running;
  assert.equal(signal.aborted, true);
  assert.equal(io.input.paused, true);
  assert.equal(io.input.readableFlowing, false);
});

test('SIGTERM, input end and output failure clean up without waiting for refresh', async () => {
  for (const mode of ['signal', 'end', 'error', 'setup']) {
    const io = streams();
    if (mode === 'setup') io.input.setRawMode = flag => { io.input.raw.push(flag); if (flag) throw new Error('raw failed'); };
    const running = watchTaskBoard(() => new Promise(() => {}), io);
    if (mode === 'signal') process.emit('SIGTERM');
    if (mode === 'end') io.input.emit('end');
    if (mode === 'error') io.output.emit('error', new Error('broken pipe'));
    if (['error', 'setup'].includes(mode)) await assert.rejects(running, /broken pipe|raw failed/);
    else await running;
    assert.deepEqual(io.input.raw, [true, false]);
    assert.equal(io.input.listenerCount('data'), 0);
    assert.match(io.output.chunks.at(-1), /\x1b\[\?1049l/);
  }
});

test('initial errors are explicit, refreshes never overlap, and polling stops on quit', async t => {
  const io = streams(); let reads = 0; let release;
  const running = watchTaskBoard(async () => {
    reads++;
    if (reads === 1) throw new Error('offline');
    if (reads === 2) return new Promise(resolve => { release = resolve; });
    return sample();
  }, { ...io, interval: 15 });
  t.after(() => io.input.emit('data', 'q'));
  await tick(); assert.match(io.output.chunks.at(-1), /OFFLINE \/ no snapshot/);
  io.input.emit('data', 'rrr'); await tick(); assert.equal(reads, 2);
  release(sample()); await tick(); assert.equal(reads, 3);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(reads >= 4);
  io.input.emit('data', 'q'); await running; const stoppedAt = reads;
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(reads, stoppedAt);
});
