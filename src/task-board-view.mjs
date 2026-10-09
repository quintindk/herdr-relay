import { stripVTControlCharacters } from 'node:util';
import { StringDecoder } from 'node:string_decoder';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const keyOf = (...parts) => JSON.stringify(parts);
const clean = value => stripVTControlCharacters(String(value ?? ''))
  .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
  .replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
const statusOf = task => String(task.status ?? 'unknown').toLowerCase();
const done = task => ['done', 'completed', 'cancelled', 'canceled'].includes(statusOf(task));
const active = task => ['in_progress', 'active', 'running'].includes(statusOf(task));
const review = task => ['in_review', 'review', 'needs_review'].includes(statusOf(task));
const counts = tasks => ({ total: tasks.length, open: tasks.filter(task => !done(task)).length,
  active: tasks.filter(active).length, blocked: tasks.filter(task => statusOf(task) === 'blocked').length,
  review: tasks.filter(review).length });

function cellWidth(grapheme) {
  if (/\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(grapheme)) return 2;
  const visible = [...grapheme].filter(char => !/[\p{Mark}\p{Format}]/u.test(char));
  if (!visible.length) return 0;
  return visible.some(char => {
    const cp = char.codePointAt(0);
    return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1b000 && cp <= 0x1b2ff) || (cp >= 0x20000 && cp <= 0x3fffd));
  }) ? 2 : 1;
}

function widthOf(text) {
  return [...segmenter.segment(text)].reduce((sum, { segment }) => sum + cellWidth(segment), 0);
}

function fit(value, width, unicode = false) {
  const text = clean(value);
  if (width <= 0) return '';
  if (widthOf(text) <= width) return text + ' '.repeat(width - widthOf(text));
  let result = ''; let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const cells = cellWidth(segment);
    if (used + cells > width - 1) break;
    result += segment; used += cells;
  }
  return result + (unicode ? '…' : '~') + ' '.repeat(width - used - 1);
}

function validate(value) {
  if (!value || ['companies', 'agents', 'projects', 'tasks'].some(name => !Array.isArray(value[name]))) {
    throw new TypeError('Invalid task board data: expected companies, agents, projects and tasks arrays');
  }
  for (const name of ['companies', 'agents', 'projects', 'tasks']) {
    if (value[name].some(item => !item || typeof item.id !== 'string' ||
      (name !== 'companies' && typeof item.companyId !== 'string'))) {
      throw new TypeError(`Invalid task board ${name}: expected string IDs and company scope`);
    }
  }
  return value;
}

/** Visible, pre-scroll rows. IDs are opaque and company/group scoped. Omitted expanded means all open. */
export function buildBoardRows(value, options = {}) {
  validate(value);
  const { expanded, showDone = false, showIdle = false } = options;
  const filter = clean(options.filter).toLocaleLowerCase().trim();
  const companyNames = new Map(value.companies.map(company => [company.id, company.name || company.id]));
  const agents = new Map(value.agents.map(agent => [keyOf(agent.companyId, agent.id), agent]));
  const projects = new Map(value.projects.map(project => [keyOf(project.companyId, project.id), project]));
  const tasks = new Map(value.tasks.map(task => [keyOf(task.companyId, task.id), task]));
  const parents = new Map(); const anomalies = new Map();
  for (const [id, task] of tasks) {
    if (task.parentId == null || task.parentId === '') continue;
    const parent = keyOf(task.companyId, task.parentId);
    if (tasks.has(parent)) parents.set(id, parent);
    else anomalies.set(id, 'orphan');
  }
  // Cut one edge per cycle before building any group. Iterative walks also tolerate very deep trees.
  const visited = new Set();
  for (const id of tasks.keys()) {
    const path = new Set(); let current = id;
    while (current && !visited.has(current) && !path.has(current)) {
      path.add(current); current = parents.get(current);
    }
    if (path.has(current)) { parents.delete(current); anomalies.set(current, 'cycle'); }
    for (const member of path) visited.add(member);
  }
  const groups = new Map();
  const ensureGroup = (companyId, kind, ownerId, name, agent) => {
    const id = keyOf('group', companyId, kind, ownerId);
    if (!groups.has(id)) groups.set(id, { id, type: 'group', companyId,
      companyName: clean(companyNames.get(companyId) || companyId || 'Unknown company'),
      name: clean(name), agent, kind, depth: 0, assigned: [] });
    return groups.get(id);
  };
  const companies = new Set([...companyNames.keys(), ...value.agents.map(agent => agent.companyId),
    ...value.tasks.map(task => task.companyId)]);
  for (const company of companies) ensureGroup(company, 'human', 'local-board', 'Human: Board (local-board)');
  for (const agent of value.agents) ensureGroup(agent.companyId, 'agent', agent.id, agent.name || agent.id, agent);
  const owners = new Map();
  for (const [id, task] of tasks) {
    let group;
    if (task.assigneeAgentId) {
      const agent = agents.get(keyOf(task.companyId, task.assigneeAgentId));
      group = ensureGroup(task.companyId, 'agent', task.assigneeAgentId,
        agent?.name || `Agent: ${task.assigneeAgentId} (missing)`, agent);
    } else if (task.assigneeUserId) {
      group = ensureGroup(task.companyId, 'human', task.assigneeUserId,
        task.assigneeUserId === 'local-board' ? 'Human: Board (local-board)' : `Human: ${task.assigneeUserId}`);
    } else group = ensureGroup(task.companyId, 'unassigned', '', 'Unassigned');
    owners.set(id, group);
    const searchable = [task.identifier, task.title, task.descriptionPreview, task.status,
      projects.get(keyOf(task.companyId, task.projectId))?.name, group.name, group.companyName].map(clean).join(' ').toLocaleLowerCase();
    if ((showDone || !done(task)) && (!filter || searchable.includes(filter))) group.assigned.push(id);
  }
  const rows = [];
  for (const group of groups.values()) {
    const busy = [group.agent?.availability, group.agent?.nativeState].some(state => /^(busy|working|running|active)$/i.test(state ?? ''));
    if (!group.assigned.length && (filter || (!showIdle && !busy && group.kind !== 'human'))) continue;
    const included = new Set(); const matched = new Set(group.assigned);
    for (const id of group.assigned) {
      let current = id;
      while (current && !included.has(current)) { included.add(current); current = parents.get(current); }
    }
    const children = new Map();
    for (const id of included) {
      const parent = parents.get(id);
      const key = included.has(parent) ? parent : null;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(id);
    }
    const sort = ids => ids.sort((left, right) => {
      const a = tasks.get(left); const b = tasks.get(right);
      return clean(a.identifier || a.id).localeCompare(clean(b.identifier || b.id), 'en', { numeric: true }) || left.localeCompare(right);
    });
    for (const ids of children.values()) sort(ids);
    const flat = [];
    const roots = children.get(null) ?? [];
    const stack = roots.map((id, index) => ({ id, depth: 1, last: index === roots.length - 1, guides: [] })).reverse();
    while (stack.length) {
      const entry = stack.pop(); flat.push(entry);
      const siblings = children.get(entry.id) ?? [];
      for (let index = siblings.length - 1; index >= 0; index--) stack.push({ id: siblings[index],
        depth: entry.depth + 1, last: index === siblings.length - 1,
        guides: [...entry.guides, !entry.last].slice(0, 6) });
    }
    const subtree = new Map();
    for (const { id } of [...flat].reverse()) {
      const stats = counts(matched.has(id) ? [tasks.get(id)] : []);
      let descendants = 0;
      for (const child of children.get(id) ?? []) {
        const childStats = subtree.get(child);
        for (const field of Object.keys(stats)) stats[field] += childStats.counts[field];
        descendants += childStats.descendants + 1;
      }
      subtree.set(id, { counts: stats, descendants });
    }
    const groupRow = { ...group, counts: counts(group.assigned.map(id => tasks.get(id))),
      expandable: included.size > 0, expanded: expanded == null || expanded.has(group.id) };
    delete groupRow.assigned;
    rows.push(groupRow);
    if (!groupRow.expanded) continue;
    let collapsedDepth = Infinity;
    for (const { id, depth, last, guides } of flat) {
      if (depth > collapsedDepth) continue;
      collapsedDepth = Infinity;
      const task = tasks.get(id); const rowId = keyOf('task', group.id, task.id);
      const isExpanded = expanded == null || expanded.has(rowId);
      const expandable = (children.get(id)?.length ?? 0) > 0;
      rows.push({ id: rowId, type: 'task', companyId: task.companyId, groupId: group.id, taskId: task.id,
        task, depth, last, guides, owner: owners.get(id).name, context: !matched.has(id), anomaly: anomalies.get(id),
        projectName: clean(projects.get(keyOf(task.companyId, task.projectId))?.name),
        expandable, expanded: isExpanded, ...subtree.get(id) });
      if (expandable && !isExpanded) collapsedDepth = depth;
    }
  }
  return rows;
}

function ageOf(fetchedAt, now) {
  const time = typeof fetchedAt === 'number' ? fetchedAt : Date.parse(fetchedAt);
  if (!Number.isFinite(time)) return 'unknown age';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/** Pure frame renderer. rows contains all visible tree rows, visibleRows the viewport slice. */
export function renderTaskBoard(value, options = {}) {
  const dimension = (value, fallback) => Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
  const width = dimension(options.width, 100); const height = dimension(options.height, 30);
  const colour = options.colour ?? false; const unicode = options.unicode ?? colour;
  const rows = buildBoardRows(value, options);
  const selectedId = rows.some(row => row.id === options.selectedId) ? options.selectedId : rows[0]?.id ?? null;
  const selected = rows.find(row => row.id === selectedId);
  const wide = width >= 84;
  const style = (text, code) => colour ? `\x1b[${code}m${text}\x1b[0m` : text;
  const line = text => fit(text, width, unicode);
  const pair = (left, right) => {
    const rightWidth = Math.min(widthOf(clean(right)), Math.floor(width / 2));
    return fit(left, width - rightWidth - 1, unicode) + ' ' + fit(right, rightWidth, unicode);
  };
  const rule = (unicode ? '─' : '-').repeat(width);
  const overview = counts(value.tasks);
  const header = [style(pair('RELAY / TASKS', `${value.companies.length} companies / ${value.agents.length} agents`), '1;36'),
    line(`OPEN ${overview.open}   ACTIVE ${overview.active}   BLOCKED ${overview.blocked}   REVIEW ${overview.review}`)];
  const age = ageOf(value.fetchedAt, options.now ?? Date.now());
  const source = options.offline
    ? `OFFLINE / ${options.hasSnapshot === false ? 'no snapshot' : `last good ${age}`} / ${clean(options.offline)}`
    : options.hasSnapshot === false ? 'WAITING / no snapshot'
      : `FETCHED ${age} / completed ${options.showDone ? 'shown' : 'hidden'} / idle ${options.showIdle ? 'shown' : 'hidden'}`;
  header.push(style(line(source), options.offline ? '33' : '2'));
  if (value.warnings?.length) header.push(style(line(`WARNING / ${value.warnings.map(warning => clean(typeof warning === 'object' ? warning?.message ?? warning?.code ?? 'source warning' : warning)).join(' / ')}`), '33'));
  header.push(style(rule, '2'));
  const footer = [style(rule, '2'), line(width >= 84
    ? 'j/k move  Enter fold  h done  i idle  / search  Esc clear  r refresh  Tab detail  q quit'
    : 'j/k move  Enter fold  / find  Tab detail  q quit')];
  const detail = [];
  if (options.detail && selected && height >= 14) {
    detail.push(style(line('DETAIL / READ ONLY'), '1;36'));
    if (selected.type === 'task') {
      detail.push(line(`${selected.task.identifier || selected.task.id} / ${selected.task.title || 'Untitled'}`));
      detail.push(line(`${selected.owner} / ${selected.task.status || 'unknown'} / ${selected.projectName || 'no project'}`));
      detail.push(line(selected.task.descriptionPreview || 'No description preview.'));
      if (wide) detail.push(style(line(`Updated ${selected.task.updatedAt || 'unknown'} / ${selected.companyId}`), '2'));
    } else {
      detail.push(line(`${selected.name} / ${selected.companyName}`));
      detail.push(line(selected.agent ? `Availability ${selected.agent.availability || 'unknown'} / bridge ${selected.agent.bridgeState || 'unknown'} / native ${selected.agent.nativeState || 'unknown'}` : 'Human-owned tasks. No agent runtime.'));
    }
  }
  const capacity = Math.max(0, height - header.length - footer.length - detail.length - 1);
  const selectedIndex = rows.findIndex(row => row.id === selectedId);
  let offset = Math.max(0, Math.min(Math.floor(Number(options.offset) || 0), Math.max(0, rows.length - capacity)));
  if (options.selectedId && capacity) {
    if (selectedIndex < offset) offset = selectedIndex;
    if (selectedIndex >= offset + capacity) offset = selectedIndex - capacity + 1;
  }
  const visibleRows = rows.slice(offset, offset + capacity);
  const body = visibleRows.map(row => {
    const selected = row.id === selectedId;
    const mark = selected ? (unicode ? '▸' : '>') : ' ';
    const fold = row.expandable ? (row.expanded ? (unicode ? '▾' : '-') : (unicode ? '▸' : '+')) : (unicode ? '·' : '.');
    let text;
    if (row.type === 'group') {
      const state = row.agent ? ` / ${clean(row.agent.availability || 'unknown')}` : '';
      const label = `${mark} ${fold} ${row.name}${state}`;
      text = pair(label, `${row.counts.open} open / ${row.companyName}`);
    } else {
      const task = row.task;
      const guides = row.guides.map(continuation => continuation ? (unicode ? '│ ' : '| ') : '  ').join('');
      const branch = unicode ? (row.last ? '└─' : '├─') : (row.last ? '`-' : '|-');
      const tree = `${guides}${row.depth > 7 ? (unicode ? '… ' : '..') : ''}${branch}${fold} `;
      const context = row.context ? ` [via ${row.owner}]` : '';
      const anomaly = row.anomaly ? ` [${row.anomaly}]` : '';
      const subtree = row.descendants ? ` [+${row.descendants}/${row.counts.open} open]` : '';
      const title = `${mark} ${tree}${clean(task.identifier || task.id)}${context} ${clean(task.title || 'Untitled')}${anomaly}${subtree}`;
      const labels = { in_progress: 'ACTIVE', in_review: 'REVIEW', needs_review: 'REVIEW', cancelled: 'CANCEL', canceled: 'CANCEL', completed: 'DONE' };
      const status = labels[statusOf(task)] || clean(task.status || 'unknown').toUpperCase();
      const priority = ['urgent', 'high'].includes(String(task.priority).toLowerCase()) ? '!' : String(task.priority).toLowerCase() === 'low' ? '.' : ' ';
      const suffix = `${fit(status, 7, unicode)} ${priority}${wide ? `  ${fit(row.projectName || '-', 12, unicode)}` : ''}`;
      text = fit(title, Math.max(0, width - widthOf(suffix) - 1), unicode) + ' ' + suffix;
    }
    text = line(text);
    const tone = row.type === 'group' ? '1;36' : row.context || done(row.task) ? '2' : review(row.task) ? '35'
      : statusOf(row.task) === 'blocked' ? '33' : row.task.priority === 'urgent' ? '35'
        : row.task.priority === 'high' ? '33' : active(row.task) ? '36' : '0';
    return style(text, selected ? `${tone};7` : tone);
  });
  if (!rows.length && capacity) body.push(style(line('No tasks match. / clears search; h shows completed.'), '2'));
  while (body.length < capacity) body.push(' '.repeat(width));
  const position = rows.length && capacity ? `${offset + 1}-${offset + visibleRows.length}/${rows.length}` : `0/${rows.length}`;
  footer.push(line(options.searching ? `/${clean(options.filter)}_  Enter apply / Esc clear`
    : `${position} / READ ONLY${options.filter ? ` / filter: ${clean(options.filter)}` : ''}${!wide ? ' / h done / i idle / r refresh' : ''}`));
  const lines = [...header, ...body, ...detail, ...footer].slice(0, height);
  while (lines.length < height) lines.push(' '.repeat(width));
  return { text: lines.join('\n'), rows, visibleRows, selectedId, offset };
}

/** Resolves on quit, signal or stream close. Non-TTY reads once and emits plain text. */
export async function watchTaskBoard(read, { input = process.stdin, output = process.stdout, interval = 5000 } = {}) {
  const tty = Boolean(input.isTTY && output.isTTY);
  const empty = { companies: [], agents: [], projects: [], tasks: [], warnings: [], fetchedAt: null };
  let value = empty; let hasSnapshot = false; let offline = '';
  let stopped = false; let timer; let escapeTimer; let reading = false; let again = false;
  let selectedId; let offset = 0; let showDone = false; let showIdle = false; let detail = false;
  let searching = false; let filter = ''; let frame; let pending = '';
  let paintedLines; let paintedWidth; let paintedHeight;
  const collapsed = new Set();
  const controller = new AbortController();
  const decoder = new StringDecoder('utf8');
  const wasRaw = Boolean(input.isRaw); const wasFlowing = input.readableFlowing === true;
  let rawAttempted = false; let entered = false; let failure;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const stop = () => { stopped = true; clearTimeout(timer); clearTimeout(escapeTimer); controller.abort(); finish(); };
  const fail = error => { failure = error; stop(); };
  const draw = () => {
    if (stopped) return;
    const options = { width: output.columns || 100, height: output.rows || 30, colour: tty,
      selectedId, offset, showDone, showIdle, filter, detail, searching, offline, hasSnapshot };
    const all = buildBoardRows(value, options);
    options.expanded = new Set(all.filter(row => row.expandable && !collapsed.has(row.id)).map(row => row.id));
    frame = renderTaskBoard(value, options);
    selectedId = frame.selectedId; offset = frame.offset;
    if (!tty) { output.write(`${frame.text}\n`); return; }
    const lines = frame.text.split('\n');
    // Fixed-width rows overwrite old content without clearing the whole pane.
    const repaint = !paintedLines || paintedWidth !== options.width || paintedHeight !== options.height;
    const update = repaint ? `\x1b[H\x1b[2J${frame.text.replace(/\n/g, '\r\n')}`
      : lines.map((line, index) => line === paintedLines[index] ? '' : `\x1b[${index + 1};1H${line}`).join('');
    if (update) output.write(update);
    paintedLines = lines; paintedWidth = options.width; paintedHeight = options.height;
  };
  const refresh = async () => {
    if (stopped) return;
    if (reading) { again = true; return; }
    clearTimeout(timer); reading = true;
    try {
      const next = validate(await read(controller.signal));
      // Reject unusable snapshots before replacing the last frame, not merely on transport success.
      buildBoardRows(next);
      if (!stopped) { value = next; hasSnapshot = true; offline = ''; }
    } catch (error) {
      if (!stopped) offline = clean(error?.message || error?.code || 'read failed');
    } finally { reading = false; }
    if (stopped) return;
    try { draw(); } catch (error) { fail(error); return; }
    if (!tty) { stop(); return; }
    if (again) { again = false; void refresh(); }
    else timer = setTimeout(() => { void refresh(); }, Math.max(10, Number(interval) || 5000));
  };
  const handle = key => {
    if (key === '\x03' || (!searching && key === 'q')) { stop(); return; }
    if (searching) {
      if (key === '\x1b') { searching = false; filter = ''; }
      else if (key === '\r' || key === '\n') searching = false;
      else if (key === '\x7f' || key === '\b') filter = [...segmenter.segment(filter)].slice(0, -1).map(part => part.segment).join('');
      else if (!key.startsWith('\x1b') && !/[\x00-\x1f\x7f]/.test(key)) filter += clean(key);
      selectedId = undefined; offset = 0;
    } else if (['j', 'k', '\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB'].includes(key)) {
      const index = frame?.rows.findIndex(row => row.id === selectedId) ?? -1;
      const next = Math.max(0, Math.min((frame?.rows.length ?? 1) - 1, index + (['j', '\x1b[B', '\x1bOB'].includes(key) ? 1 : -1)));
      selectedId = frame?.rows[next]?.id;
    } else if (['\r', '\n', ' ', '\x1b[C', '\x1b[D', '\x1bOC', '\x1bOD'].includes(key)) {
      const row = frame?.rows.find(row => row.id === selectedId);
      if (row?.expandable) {
        if (['\x1b[C', '\x1bOC'].includes(key)) collapsed.delete(row.id);
        else if (['\x1b[D', '\x1bOD'].includes(key)) collapsed.add(row.id);
        else if (collapsed.has(row.id)) collapsed.delete(row.id);
        else collapsed.add(row.id);
      }
    } else if (key === 'h') showDone = !showDone;
    else if (key === 'i') showIdle = !showIdle;
    else if (key === '\t') detail = !detail;
    else if (key === '/') searching = true;
    else if (key === '\x1b') { filter = ''; searching = false; offset = 0; }
    else if (key === 'r') { void refresh(); return; }
    draw();
  };
  const onData = chunk => {
    try {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      clearTimeout(escapeTimer);
      while (pending && !stopped) {
        if (pending === '\x1b' || /^\x1b(?:\[[0-9;?]*|O)$/.test(pending)) {
          escapeTimer = setTimeout(() => {
            const escape = pending === '\x1b'; pending = '';
            if (!stopped && escape) { try { handle('\x1b'); } catch (error) { fail(error); } }
          }, 35);
          break;
        }
        const sequence = pending.match(/^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O[A-Z]|.)/s)?.[0];
        const key = sequence || String.fromCodePoint(pending.codePointAt(0));
        pending = pending.slice(key.length); handle(key);
      }
    } catch (error) { fail(error); }
  };
  const resize = () => { try { draw(); } catch (error) { fail(error); } };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  output.on('error', fail); output.on('close', stop);
  try {
    if (tty) {
      input.on('data', onData); input.on('end', stop); input.on('close', stop); input.on('error', fail);
      output.on('resize', resize);
      entered = true; output.write('\x1b[?1049h\x1b[?25l');
      rawAttempted = true; input.setRawMode(true); input.resume();
      draw();
    }
    void refresh();
    await finished;
    if (failure) throw failure;
  } finally {
    stop();
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    input.off('data', onData); input.off('end', stop); input.off('close', stop); input.off('error', fail);
    output.off('resize', resize); output.off('error', fail); output.off('close', stop);
    try { if (rawAttempted) input.setRawMode(wasRaw); }
    finally {
      // Fresh stdin is neither paused nor flowing. Stop the read we started so Node can exit.
      try { if (tty && !wasFlowing) input.pause(); }
      finally { if (entered && !output.destroyed) output.write('\x1b[0m\x1b[?25h\x1b[?1049l'); }
    }
  }
}
