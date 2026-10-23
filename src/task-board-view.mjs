import { stripVTControlCharacters } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';

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

/** Size the status column to its content, without taking space from long titles. */
export function taskBoardColumns(columns, statusLabels = []) {
  const available = Math.max(0, Math.floor(columns) - 4); // Borders and horizontal padding.
  const longest = Math.max(0, ...statusLabels.map(label => widthOf(clean(label))));
  const status = Math.min(longest, 48, Math.floor(available / 3));
  const gap = status && available > status ? 1 : 0;
  return { title: available - status - gap, status, gap };
}

/** Lossless cell-aware lines for scrollable decision editors and previews. */
export function wrapBoardText(value, columns) {
  const lines = [];
  for (const paragraph of String(value ?? '').split(/\r?\n/)) {
    let line = '', used = 0;
    for (const { segment } of segmenter.segment(clean(paragraph))) {
      const cells = cellWidth(segment);
      if (line && used + cells > columns) { lines.push(line); line = ''; used = 0; }
      line += segment; used += cells;
    }
    lines.push(line);
  }
  return lines;
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

function wrap(value, width, maxLines, unicode = false) {
  const words = clean(value).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = []; let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (widthOf(next) <= width) current = next;
    else {
      if (current) lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (words.join(' ') !== lines.join(' ') && lines.length) {
    lines[lines.length - 1] = fit(lines.at(-1), width, unicode).trimEnd().replace(/[~…]?$/, unicode ? '…' : '~');
  }
  return lines.map(value => fit(value, width, unicode));
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
  if (value.routines !== undefined && (!Array.isArray(value.routines) || value.routines.some(item => !item ||
    typeof item.id !== 'string' || typeof item.companyId !== 'string' || typeof item.title !== 'string' ||
    typeof item.state !== 'string' || (item.executionMode !== undefined &&
      !['headless', 'interactive_exact', 'interactive_folder', 'interactive_agent'].includes(item.executionMode)) ||
    typeof item.cron !== 'string' || typeof item.timezone !== 'string'))) {
    throw new TypeError('Invalid task board routines: expected safe routine projections');
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
  if (value.showEmptyLocalBoard !== false) {
    for (const company of companies) ensureGroup(company, 'human', 'local-board', 'Human: Board (local-board)');
  }
  for (const agent of value.agents) ensureGroup(agent.companyId, 'agent', agent.id, agent.name || agent.id, agent);
  const owners = new Map();
  for (const [id, task] of tasks) {
    let group;
    const executionAgentId = task.executionAgentId || task.assigneeAgentId;
    if (executionAgentId) {
      const agent = agents.get(keyOf(task.companyId, executionAgentId));
      group = ensureGroup(task.companyId, 'agent', executionAgentId,
        agent?.name || `Agent: ${executionAgentId} (missing)`, agent);
    } else if (task.assigneeUserId) {
      group = ensureGroup(task.companyId, 'human', task.assigneeUserId,
        task.assigneeUserId === 'local-board' ? 'Human: Board (local-board)' : `Human: ${task.assigneeUserId}`);
    } else group = ensureGroup(task.companyId, 'unassigned', '', 'Unassigned');
    owners.set(id, group);
    const searchable = [task.reference, task.identifier, task.source?.metadata?.identifier, task.title, task.descriptionPreview, task.status,
      task.attentionLabel, task.responsibleUserId, projects.get(keyOf(task.companyId, task.projectId))?.name, group.name, group.companyName].map(clean).join(' ').toLocaleLowerCase();
    if ((showDone || !done(task)) && (!filter || searchable.includes(filter))) group.assigned.push(id);
  }
  const rows = [];
  for (const group of groups.values()) {
    const busy = [group.agent?.availability, group.agent?.nativeState].some(state => /^(busy|working|running|active)$/i.test(state ?? ''));
    const present = group.agent?.availability === 'present';
    if (!group.assigned.length && !present && (filter || (!showIdle && !busy && group.kind !== 'human'))) continue;
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
  if (value.routines) {
    const routines = value.routines.filter(routine => options.showDone || routine.state !== 'cancelled')
      .sort((left, right) => (left.state === 'active' ? 0 : 1) - (right.state === 'active' ? 0 : 1) ||
        String(left.nextRunAt ?? '').localeCompare(String(right.nextRunAt ?? '')) || left.title.localeCompare(right.title));
    header.push(style(line(`CRON ${routines.length}${value.routines.length !== routines.length ? ` / ${value.routines.length} including cancelled` : ''}`), '1;35'));
    for (const routine of routines.slice(0, 4)) {
      const next = routine.nextRunAt ? clean(routine.nextRunAt).replace('T', ' ').replace('.000Z', 'Z') : 'no next run';
      header.push(line(pair(`${clean(routine.state).toUpperCase()} ${routine.title}`,
        `${routine.executionMode ?? 'legacy'} / ${routine.cron} / ${routine.timezone} / ${routine.target || 'unresolved'} / ${next}`)));
    }
    if (routines.length > 4) header.push(style(line(`+ ${routines.length - 4} more cron routines`), '2'));
  }
  header.push(style(rule, '2'));
  const assignment = options.assignmentPrompt;
  const selectedReview = selected?.type === 'task' && review(selected.task) && options.detailData?.review;
  const actions = `${options.canAssign ? '  a assign' : ''}${options.canStatus ? '  s status' : ''}${selectedReview ? '  A approve  F feedback  R reject' : ''}`;
  const footer = [style(rule, '2'), line(assignment ? 'j/k select agent  Enter assign / Esc cancel'
    : options.statusModal ? options.statusModal.phase === 'confirm' ? 'Enter apply status / Esc back'
      : 'j/k select  Tab next field  Enter review  Esc cancel'
      : options.feedbackEditing ? 'Type rejection feedback  Enter save / Esc cancel'
      : options.reviewPrompt ? `Enter ${options.reviewPrompt.decision} / Esc cancel` : width >= 84
          ? `j/k move  Enter fold  h done  i idle  / search  r refresh  Tab detail${actions}  q quit`
          : `j/k move  Enter fold  / find  Tab detail${actions}  q quit`)];
  const detail = [];
  if (!assignment && options.detail && selected && height >= 14) {
    detail.push(style(line(selectedReview ? 'DETAIL / REVIEW' : 'DETAIL / READ ONLY'), '1;36'));
    if (selected.type === 'task') {
      const data = options.detailData;
      const task = data?.task?.id === selected.taskId ? data.task : selected.task;
      detail.push(line(`${task.identifier || task.id} / ${task.title || 'Untitled'}`));
      detail.push(line(`${selected.owner} / ${task.status || 'unknown'} / ${selected.projectName || 'no project'}`));
      if (options.detailLoading) detail.push(style(line('Loading full details and comments...'), '2'));
      else if (data?.error) detail.push(style(line(`DETAIL FAILED / ${data.error}`), '33'));
      else {
        detail.push(...wrap(task.description ?? task.descriptionPreview ?? 'No description.', width, 2, unicode));
        if (data?.review) {
          detail.push(style(line(`CANDIDATE ${data.review.candidate}`), '35'));
          detail.push(...wrap(data.review.summary || 'No candidate summary.', width, 1, unicode));
        }
        detail.push(style(line('LAST COMMENTS'), '1;36'));
        for (const comment of data?.comments ?? []) {
          const author = comment.authorUserId || comment.authorAgentId || 'system';
          detail.push(...wrap(`${author} ${comment.createdAt || ''} / ${comment.body}`, width, 1, unicode));
        }
        if (!data?.comments?.length) detail.push(style(line('No comments.'), '2'));
      }
      if (options.feedbackEditing || options.feedback) detail.push(line(`FEEDBACK ${options.feedback || ''}${options.feedbackEditing ? '_' : ''}`));
      if (wide) detail.push(style(line(`Updated ${task.updatedAt || 'unknown'} / ${selected.companyId}`), '2'));
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
  let body = visibleRows.map(row => {
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
  if (assignment) {
    const title = assignment.task.identifier || assignment.task.id;
    body = [style(line(`ASSIGN ${title} / ${assignment.task.title || 'Untitled'}`), '1;36'),
      ...assignment.agents.slice(0, Math.max(0, capacity - 1)).map((agent, index) => {
        const mark = index === assignment.index ? (unicode ? '▸' : '>') : ' ';
        const state = `${clean(agent.availability || 'unknown')} / ${clean(agent.nativeState || 'unknown')}`;
        const text = pair(`${mark} ${clean(agent.name || agent.id)}`, state);
        return style(line(text), index === assignment.index ? '36;7' : '0');
      })];
  }
  if (options.statusModal) {
    const modal = options.statusModal;
    const labels = { backlog: 'Backlog', todo: 'Todo', in_progress: 'Active', blocked: 'Blocked', in_review: 'In review', done: 'Done', cancelled: 'Cancelled' };
    const boxWidth = Math.min(width, 72), inner = Math.max(1, boxWidth - 4);
    const box = text => `│ ${fit(text, inner, unicode)} │`;
    const top = `┌${(unicode ? '─' : '-').repeat(boxWidth - 2)}┐`, bottom = `└${(unicode ? '─' : '-').repeat(boxWidth - 2)}┘`;
    const lines = [top, box(`CHANGE STATUS / ${modal.task.identifier || modal.task.id}`), box('')];
    modal.statuses.forEach((status, index) => lines.push(box(`${modal.field === 'status' && index === modal.index ? '>' : ' '} ${labels[status]}`)));
    lines.push(box(''));
    if (modal.statuses[modal.index] === 'blocked' && modal.needsDescriptor) {
      lines.push(box(`${modal.field === 'owner' ? '>' : ' '} Waiting on: ${modal.owner === 'board' ? 'Board' : 'Me'}`));
      lines.push(box(`${modal.field === 'action' ? '>' : ' '} Required action: ${modal.action}${modal.field === 'action' ? '_' : ''}`));
    }
    lines.push(box(`${modal.field === 'comment' ? '>' : ' '} Comment (optional): ${modal.comment}${modal.field === 'comment' ? '_' : ''}`));
    if (modal.phase === 'confirm') lines.push(box(`Confirm ${labels[modal.task.status] ?? modal.task.status} -> ${labels[modal.statuses[modal.index]]}`));
    lines.push(bottom);
    const left = Math.max(0, Math.floor((width - boxWidth) / 2));
    body = [...Array(Math.max(0, Math.floor((capacity - lines.length) / 2))).fill(' '.repeat(width)),
      ...lines.map(value => `${' '.repeat(left)}${value}`.padEnd(width))];
    while (body.length < capacity) body.push(' '.repeat(width));
  }
  if (!rows.length && capacity) body.push(style(line('No tasks match. / clears search; h shows completed.'), '2'));
  while (body.length < capacity) body.push(' '.repeat(width));
  const position = rows.length && capacity ? `${offset + 1}-${offset + visibleRows.length}/${rows.length}` : `0/${rows.length}`;
  footer.push(line(assignment ? `AGENT ${assignment.index + 1}/${assignment.agents.length}`
    : options.statusModal ? `STATUS ${options.statusModal.task.identifier || options.statusModal.task.id}`
    : options.reviewPrompt ? `${options.reviewPrompt.decision.toUpperCase()} ${options.reviewPrompt.identifier} / ${options.reviewPrompt.candidate}`
    : options.notice || (options.searching ? `/${clean(options.filter)}_  Enter apply / Esc clear`
    : `${position} / ${options.canStatus ? 'TASKS' : 'READ ONLY'}${options.filter ? ` / filter: ${clean(options.filter)}` : ''}${!wide ? ' / h done / i idle / r refresh' : ''}`)));
  const lines = [...header, ...body, ...detail, ...footer].slice(0, height);
  while (lines.length < height) lines.push(' '.repeat(width));
  return { text: lines.join('\n'), rows, visibleRows, selectedId, offset };
}
/** Retained for direct library consumers; the CLI no longer exposes this renderer. */
export async function watchTaskBoard(read, { input = process.stdin, output = process.stdout, interval = 5000,
  inspectTask, detailTask, reviewTask, assignTask, statusTask } = {}) {
  const tty = Boolean(input.isTTY && output.isTTY);
  const empty = { companies: [], agents: [], projects: [], tasks: [], warnings: [], fetchedAt: null };
  let value = empty; let hasSnapshot = false; let offline = '';
  let stopped = false; let timer; let escapeTimer; let reading = false; let again = false;
  let selectedId; let offset = 0; let showDone = false; let showIdle = false; let detail = false;
  let searching = false; let filter = ''; let frame; let pending = '';
  let assignment; let assigning = false; let notice = '';
  let detailData; let detailLoading = false; let detailGeneration = 0;
  let feedback = ''; let feedbackEditing = false; let feedbackBefore = ''; let reviewPrompt; let reviewing = false;
  let statusModal; let changingStatus = false;
  const canAssign = typeof inspectTask === 'function' && typeof assignTask === 'function';
  const canStatus = typeof inspectTask === 'function' && typeof statusTask === 'function';
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
      selectedId, offset, showDone, showIdle, filter, detail, searching, offline, hasSnapshot,
      canAssign, canStatus, assignmentPrompt: assigning ? null : assignment,
      notice, detailData, detailLoading, feedback, feedbackEditing, reviewPrompt, statusModal };
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
  const loadDetail = async () => {
    const row = frame?.rows.find(row => row.id === selectedId);
    const generation = ++detailGeneration;
    detailData = undefined; feedback = ''; reviewPrompt = null;
    if (!detail || row?.type !== 'task' || typeof detailTask !== 'function') { detailLoading = false; draw(); return; }
    detailLoading = true; draw();
    try {
      const result = await detailTask({ companyId: row.companyId, taskId: row.taskId }, controller.signal);
      if (stopped || generation !== detailGeneration || selectedId !== row.id) return;
      if (result.task?.id !== row.taskId || result.task.companyId !== row.companyId || !result.revision) throw Error('Detail identity is not confirmed');
      detailData = result;
    } catch (error) {
      if (!stopped && generation === detailGeneration) detailData = { error: clean(error.message || error.code || 'detail failed') };
    } finally {
      if (!stopped && generation === detailGeneration) { detailLoading = false; draw(); }
    }
  };
  const refresh = async () => {
    if (stopped) return;
    if (reading) { again = true; return; }
    clearTimeout(timer); reading = true;
    try {
      const next = validate(await read(controller.signal));
      // Reject unusable snapshots before replacing the last frame, not merely on transport success.
      buildBoardRows(next);
      if (!stopped) {
        value = next;
        hasSnapshot = true; offline = '';
      }
    } catch (error) {
      if (!stopped) offline = clean(error?.message || error?.code || 'read failed');
    } finally { reading = false; }
    if (stopped) return;
    try { draw(); } catch (error) { fail(error); return; }
    if (!tty) { stop(); return; }
    if (again) { again = false; void refresh(); }
    else timer = setTimeout(() => { void refresh(); }, Math.max(10, Number(interval) || 5000));
  };
  const prepareAssign = () => {
    const row = frame?.rows.find(row => row.id === selectedId);
    if (!canAssign || assigning || row?.type !== 'task') return;
    const agents = value.agents.filter(agent => agent.companyId === row.companyId && agent.availability === 'present')
      .sort((left, right) => clean(left.name || left.id).localeCompare(clean(right.name || right.id)) || left.id.localeCompare(right.id));
    if (!agents.length) { notice = 'ASSIGN FAILED / no present agents in this company'; draw(); return; }
    const index = Math.max(0, agents.findIndex(agent => agent.id === row.task.assigneeAgentId));
    assignment = { task: row.task, companyId: row.companyId, taskId: row.taskId, agents, index }; notice = ''; draw();
  };
  const confirmAssign = async () => {
    if (!assignment || assigning) return;
    const selected = assignment, agent = selected.agents[selected.index];
    assigning = true; notice = `Assigning ${selected.task.identifier || selected.task.id} to ${agent.name || agent.id}...`; draw();
    try {
      const snapshot = await inspectTask({ companyId: selected.companyId, taskId: selected.taskId }, controller.signal);
      if (stopped) return;
      if (snapshot.task?.id !== selected.taskId || snapshot.task.companyId !== selected.companyId || !snapshot.revision) {
        throw Error('Assignment preview identity is not confirmed');
      }
      const result = await assignTask({ companyId: selected.companyId, taskId: selected.taskId,
        expectedRevision: snapshot.revision, key: randomUUID(), reason: 'Assigned from the task board',
        payload: { assigneeAgentId: agent.id } }, controller.signal);
      if (stopped) return;
      if (result.outcome?.confirmed !== true || result.task?.assigneeAgentId !== agent.id) throw Error('Assignment is not confirmed');
      value = { ...value, tasks: value.tasks.map(task => task.id === selected.taskId && task.companyId === selected.companyId
        ? { ...task, assigneeAgentId: agent.id, assigneeUserId: null } : task) };
      notice = `Assigned ${selected.task.identifier || selected.task.id} to ${agent.name || agent.id}`;
    } catch (error) { if (!stopped) notice = `ASSIGN FAILED / ${clean(error.message)}`; }
    finally { assignment = null; assigning = false; if (!stopped) { draw(); void refresh(); } }
  };
  const prepareStatus = async () => {
    const row = frame?.rows.find(row => row.id === selectedId);
    if (!canStatus || changingStatus) return;
    if (row?.type !== 'task') { notice = 'STATUS UNAVAILABLE / select a task'; draw(); return; }
    changingStatus = true; notice = `Inspecting ${row.task.identifier || row.taskId}...`; draw();
    try {
      const snapshot = await inspectTask({ companyId: row.companyId, taskId: row.taskId }, controller.signal);
      if (stopped) return;
      if (snapshot.task?.id !== row.taskId || snapshot.task.companyId !== row.companyId || !snapshot.revision) throw Error('Status preview identity is not confirmed');
      if (!snapshot.task.assigneeUserId || snapshot.task.assigneeAgentId) throw Error('Status change requires a human-owned task');
      if (snapshot.interactions?.some(item => item.status === 'pending')) throw Error('Resolve the pending candidate or interaction first');
      const statuses = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'];
      const needsDescriptor = !(snapshot.task.blockedByIssueIds?.length || snapshot.task.blockedBy?.length || snapshot.task.unblockDescriptor);
      statusModal = { task: snapshot.task, revision: snapshot.revision, key: randomUUID(), statuses,
        index: Math.max(0, statuses.indexOf(snapshot.task.status)), field: 'status', phase: 'edit', comment: '',
        needsDescriptor, owner: snapshot.task.unblockDescriptor?.owner === 'board' ? 'board' : 'me',
        action: snapshot.task.unblockDescriptor?.action ?? '' };
      notice = '';
    } catch (error) { if (!stopped) notice = `STATUS FAILED / ${clean(error.message)}`; }
    finally { changingStatus = false; if (!stopped) draw(); }
  };
  const confirmStatus = async () => {
    if (!statusModal || changingStatus || statusModal.phase !== 'confirm') return;
    const selected = statusModal, status = selected.statuses[selected.index];
    changingStatus = true; notice = `Changing ${selected.task.identifier || selected.task.id} to ${status}...`; draw();
    try {
      const payload = { status, ...(selected.comment.trim() ? { comment: selected.comment.trim() } : {}) };
      if (status === 'blocked' && selected.needsDescriptor) payload.unblockDescriptor = {
        owner: selected.owner === 'board' ? 'board' : { userId: selected.task.assigneeUserId }, action: selected.action.trim(),
      };
      const result = await statusTask({ companyId: selected.task.companyId, taskId: selected.task.id,
        expectedRevision: selected.revision, key: selected.key, reason: 'Status changed from the task board', payload }, controller.signal);
      if (stopped) return;
      if (result.state !== 'recorded' || result.outcome?.confirmed !== true || result.task?.status !== status) throw Error('Status change is not confirmed');
      value = { ...value, tasks: value.tasks.map(task => task.id === selected.task.id && task.companyId === selected.task.companyId
        ? { ...task, status } : task) };
      notice = `Changed ${selected.task.identifier || selected.task.id} to ${status}`; detailData = undefined;
      statusModal = null;
    } catch (error) { if (!stopped) notice = `STATUS FAILED / ${clean(error.message)}`; }
    finally {
      changingStatus = false;
      if (!stopped) { draw(); void refresh(); if (detail) void loadDetail(); }
    }
  };
  const prepareReview = decision => {
    const row = frame?.rows.find(row => row.id === selectedId);
    const candidate = detailData?.review;
    if (reviewing || row?.type !== 'task' || !review(row.task) || !candidate || typeof reviewTask !== 'function') return;
    if (decision === 'reject' && !feedback.trim()) { notice = 'REJECT NEEDS FEEDBACK / press F first'; draw(); return; }
    reviewPrompt = { decision, companyId: row.companyId, taskId: row.taskId, identifier: row.task.identifier || row.taskId,
      runId: candidate.runId, interactionId: candidate.interactionId, candidate: candidate.candidate,
      expectedRevision: detailData.revision, reason: decision === 'reject' ? feedback.trim() : undefined, key: randomUUID() };
    notice = ''; draw();
  };
  const confirmReview = async () => {
    if (!reviewPrompt || reviewing) return;
    const selected = reviewPrompt;
    reviewing = true; notice = `${selected.decision === 'accept' ? 'Approving' : 'Rejecting'} ${selected.identifier}...`; draw();
    try {
      const result = await reviewTask({ action: selected.decision, companyId: selected.companyId, taskId: selected.taskId,
        runId: selected.runId, interactionId: selected.interactionId, candidate: selected.candidate,
        expectedRevision: selected.expectedRevision, key: selected.key, ...(selected.reason ? { reason: selected.reason } : {}) }, controller.signal);
      if (stopped) return;
      if (result.state !== 'recorded' || result.receipt?.status !== (selected.decision === 'accept' ? 'accepted' : 'rejected')) {
        throw Error('Review decision is not confirmed');
      }
      notice = `${selected.decision === 'accept' ? 'Approved' : 'Rejected'} ${selected.identifier}`;
      detailData = undefined; feedback = '';
    } catch (error) { if (!stopped) notice = `REVIEW FAILED / ${clean(error.message)}`; }
    finally {
      reviewPrompt = null; reviewing = false;
      if (!stopped) { draw(); void refresh(); void loadDetail(); }
    }
  };
  const handle = key => {
    if (key === '\x03') { stop(); return; }
    if (statusModal) {
      const modal = statusModal, status = modal.statuses[modal.index];
      if (key === '\x1b') {
        if (modal.phase === 'confirm') modal.phase = 'edit'; else statusModal = null;
        notice = ''; draw(); return;
      }
      if (modal.phase === 'confirm') { if (key === '\r' || key === '\n') void confirmStatus(); return; }
      const fields = ['status', ...(status === 'blocked' && modal.needsDescriptor ? ['owner', 'action'] : []), 'comment'];
      if (key === '\r' || key === '\n') {
        if (status === 'blocked' && modal.needsDescriptor && !modal.action.trim()) notice = 'STATUS NEEDS REQUIRED ACTION';
        else { modal.phase = 'confirm'; notice = ''; }
      } else if (key === '\t') modal.field = fields[(fields.indexOf(modal.field) + 1) % fields.length];
      else if (modal.field === 'status' && ['j', 'k', '\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB'].includes(key)) {
        modal.index = Math.max(0, Math.min(modal.statuses.length - 1, modal.index + (['j', '\x1b[B', '\x1bOB'].includes(key) ? 1 : -1)));
        modal.field = 'status';
      } else if (modal.field === 'owner' && ['j', 'k', ' ', '\x1b[A', '\x1b[B'].includes(key)) modal.owner = modal.owner === 'board' ? 'me' : 'board';
      else if (['action', 'comment'].includes(modal.field)) {
        if (key === '\x7f' || key === '\b') modal[modal.field] = [...segmenter.segment(modal[modal.field])].slice(0, -1).map(part => part.segment).join('');
        else if (!key.startsWith('\x1b') && !/[\x00-\x1f\x7f]/.test(key) && modal[modal.field].length < (modal.field === 'action' ? 2000 : 4000)) modal[modal.field] += clean(key);
      }
      draw();
      return;
    }
    if (feedbackEditing) {
      if (key === '\x1b') { feedback = feedbackBefore; feedbackEditing = false; notice = ''; draw(); }
      else if (key === '\r' || key === '\n') { feedbackEditing = false; notice = feedback.trim() ? 'Feedback saved; press R to reject' : ''; draw(); }
      else if (key === '\x7f' || key === '\b') feedback = [...segmenter.segment(feedback)].slice(0, -1).map(part => part.segment).join('');
      else if (!key.startsWith('\x1b') && !/[\x00-\x1f\x7f]/.test(key) && feedback.length < 4000) feedback += clean(key);
      if (feedbackEditing) draw();
      return;
    }
    if (reviewPrompt) {
      if (key === '\x1b') { reviewPrompt = null; notice = ''; draw(); }
      else if (key === '\r' || key === '\n') void confirmReview();
      return;
    }
    if (assignment) {
      if (key === '\x1b') { assignment = null; notice = ''; draw(); }
      else if (['j', 'k', '\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB'].includes(key)) {
        assignment.index = Math.max(0, Math.min(assignment.agents.length - 1,
          assignment.index + (['j', '\x1b[B', '\x1bOB'].includes(key) ? 1 : -1))); draw();
      } else if (key === '\r' || key === '\n') void confirmAssign();
      return;
    }
    if (!searching && key === 'q') { stop(); return; }
    if (assigning || reviewing || changingStatus) return;
    notice = '';
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
    else if (key === '\t') { detail = !detail; if (detail) void loadDetail(); else { detailData = undefined; detailGeneration++; } }
    else if (key === '/') searching = true;
    else if (key === '\x1b') { filter = ''; searching = false; offset = 0; }
    else if (key === 'r') { void refresh(); return; }
    else if (key === 'a') { prepareAssign(); return; }
    else if (key === 's') { void prepareStatus(); return; }
    else if (key === 'A') { prepareReview('accept'); return; }
    else if (key === 'F' && detailData?.review) { feedbackBefore = feedback; feedbackEditing = true; notice = ''; draw(); return; }
    else if (key === 'R') { prepareReview('reject'); return; }
    draw();
    if (detail && ['j', 'k', '\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB'].includes(key)) void loadDetail();
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
