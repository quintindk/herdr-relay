import { digest, requireValue, RelayError } from './protocol.mjs';

const statuses = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
const valid = condition => requireValue(condition, 'invalid_backend_response', 'Invalid task query response', 502);
const request = (condition, message) => requireValue(condition, 'invalid_request', message);

// Backend date filters are JavaScript Dates. Reject finer input precision rather
// than silently moving a boundary. Audit continuation tokens retain all precision.
function timestamp(value, precision = 3) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match || (match[5]?.length ?? 0) > precision || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return NaN;
  const day = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== match[1]) return NaN;
  if (match[6].toUpperCase() !== 'Z' && (+match[6].slice(1, 3) > 23 || +match[6].slice(4) > 59)) return NaN;
  return Date.parse(value);
}

// Internal raw-row contract for reconciliation (including clientRequestId).
// Public callers must project fields. Bodies are never truncated here.
export async function readTaskComments(api, { companyId, taskId }) {
  request(string(companyId) && uuid(taskId), 'Server companyId and task UUID are required');
  const path = `/api/issues/${encodeURIComponent(taskId)}`;
  const task = await api('GET', path);
  requireValue(record(task) && task.id === taskId && task.companyId === companyId,
    'forbidden', 'Task must belong to the server company', 403);
  // No limit means the supported full collection. Supplying limit caps at 500;
  // after loses database microseconds when the backend constructs a JS Date.
  const rows = await api('GET', `${path}/comments?order=asc`);
  valid(Array.isArray(rows));
  requireValue(rows.length <= 10000, 'incomplete_query', 'Comment collection exceeds the 10000-row safety cap', 502);
  const seen = new Set();
  let previousTime = -Infinity;
  for (const row of rows) {
    valid(record(row) && uuid(row.id) && !seen.has(row.id) && row.companyId === companyId && row.issueId === taskId &&
      typeof row.body === 'string' && Number.isFinite(timestamp(row.createdAt, 6)));
    for (const field of ['authorAgentId', 'authorUserId', 'updatedAt', 'clientRequestId']) {
      valid(row[field] == null || typeof row[field] === 'string');
    }
    const at = timestamp(row.createdAt, 6);
    // Only reject provably backwards dates. Equal displayed milliseconds may
    // conceal distinct DB timestamps, so never sort them by UUID locally.
    valid(at >= previousTime);
    previousTime = at;
    seen.add(row.id);
  }
  return rows;
}

// api is the server's authorised (method, path) client. companyId must come from
// server authority, never a native request/config. No native state is read here.
// complete means this scoped traversal is exhausted, not a transactional snapshot.
export async function queryTasks(api, input) {
  const filters = ['projectId', 'statuses', 'assigneeAgentId', 'assigneeUserId', 'parentId'];
  const fields = {
    list: filters,
    children: ['taskId', ...filters.filter(field => field !== 'parentId')],
    comments: ['taskId'],
    activity: ['taskId', 'from', 'to'],
  };
  request(record(input) && typeof input.kind === 'string' && Object.hasOwn(fields, input.kind), 'Unknown task query kind');
  request(Object.keys(input).every(field => ['companyId', 'kind', 'limit', 'cursor', ...fields[input.kind]].includes(field) &&
    input[field] !== undefined), 'Unsupported or undefined task query fields');
  input = structuredClone(input);
  const { companyId, kind, taskId } = input;
  request(string(companyId), 'Server companyId is required');
  for (const field of ['taskId', 'projectId', 'assigneeAgentId', 'assigneeUserId', 'parentId']) {
    if (Object.hasOwn(input, field)) request(string(input[field]) && !/[\x00-\x1f\x7f]/.test(input[field]),
      field === 'parentId' ? 'parentId must be an ID; root-only parentId: null is unsupported' : `${field} must be an ID`);
  }
  // These backend filters accept sentinel strings (for example "me" and "null").
  // IDs only keeps the Relay query independent of ambient backend identity.
  for (const field of ['projectId', 'assigneeAgentId', 'parentId']) {
    if (input[field] !== undefined) request(uuid(input[field]), `${field} must be a lowercase UUID`);
  }
  if (input.assigneeUserId !== undefined) request(input.assigneeUserId !== 'me', 'assigneeUserId must be explicit, not me');
  if (kind === 'children' || kind === 'comments' || taskId !== undefined) request(uuid(taskId), 'taskId must be a lowercase UUID');
  if (input.statuses !== undefined) {
    request(Array.isArray(input.statuses) && input.statuses.length > 0 && input.statuses.length <= statuses.length &&
      [...input.statuses].every(status => statuses.includes(status)) && new Set(input.statuses).size === input.statuses.length,
    'statuses must be a non-empty array of distinct task statuses');
    input.statuses.sort();
  }
  const max = kind === 'activity' ? 200 : kind === 'comments' ? 499 : 999;
  const limit = input.limit === undefined ? 50 : input.limit;
  request(Number.isSafeInteger(limit) && limit > 0 && limit <= max, `limit must be 1..${max}${kind === 'list' || kind === 'children' ? ' (one backend row is reserved for lookahead)' : ''}`);
  if (kind === 'activity') request(Number.isFinite(timestamp(input.from)) && Number.isFinite(timestamp(input.to)) &&
    timestamp(input.from) < timestamp(input.to), 'Activity requires explicit RFC3339 from < to, with at most millisecond precision');
  const order = kind === 'activity' ? 'createdAt:desc,id:desc' : kind === 'comments' ? 'createdAt:asc,id:asc' : 'id:asc';
  const { cursor, ...queryScope } = input;
  const scope = { ...queryScope, limit, order };
  const scopeDigest = digest(scope);
  const version = kind === 'comments' ? 2 : 1;
  const cursorValid = condition => requireValue(condition, 'invalid_cursor', 'Cursor is malformed, stale or belongs to another query');
  // This checksum detects corruption, NOT forgery. Cursors confer no authority:
  // scope always comes from the request and resource anchors are checked below.
  const encode = anchor => {
    const payload = { v: version, scope: scopeDigest, order, anchor };
    return Buffer.from(JSON.stringify({ ...payload, checksum: digest(payload) })).toString('base64url');
  };
  let anchor;
  if (cursor !== undefined) {
    cursorValid(typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 16384 && /^[A-Za-z0-9_-]+$/.test(cursor));
    let value;
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      cursorValid(bytes.toString('base64url') === cursor);
      value = JSON.parse(bytes.toString('utf8'));
    } catch { throw new RelayError('invalid_cursor', 'Cursor is not valid base64url JSON', 400); }
    cursorValid(record(value) && Object.keys(value).sort().join(',') === 'anchor,checksum,order,scope,v');
    const { checksum, ...payload } = value;
    cursorValid(value.v === version && value.scope === scopeDigest && value.order === order && checksum === digest(payload));
    anchor = value.anchor;
    cursorValid(kind === 'activity' ? typeof anchor === 'string' && anchor.length > 0 && anchor.length <= 8192 :
      kind === 'comments' ? record(anchor) && Object.keys(anchor).sort().join(',') === 'at,id,prefixDigest' && uuid(anchor.id) &&
        Number.isFinite(timestamp(anchor.at, 6)) && typeof anchor.prefixDigest === 'string' && /^[0-9a-f]{64}$/.test(anchor.prefixDigest) : uuid(anchor));
  }
  const get = path => api('GET', path);
  const companyPath = `/api/companies/${encodeURIComponent(companyId)}`;
  const scopedTask = async id => {
    const row = await get(`/api/issues/${encodeURIComponent(id)}`);
    requireValue(record(row) && row.id === id && row.companyId === companyId, 'forbidden', 'Task must belong to the server company', 403);
    return row;
  };
  if (kind === 'children' || (kind === 'activity' && taskId)) await scopedTask(taskId);
  const warnings = [];
  const result = (items, nextCursor) => ({ items, nextCursor, hasMore: nextCursor !== null, complete: nextCursor === null,
    fetchedAt: new Date().toISOString(), warnings, scope });

  if (kind === 'list' || kind === 'children') {
    const parentId = kind === 'children' ? taskId : input.parentId;
    const matches = row => (!input.statuses || input.statuses.includes(row.status)) &&
      ['projectId', 'assigneeAgentId', 'assigneeUserId'].every(field => input[field] === undefined || row[field] === input[field]) &&
      (parentId === undefined || row.parentId === parentId);
    if (anchor) cursorValid(matches(await scopedTask(anchor)));
    const params = new URLSearchParams({ limit: String(limit + 1), sortField: 'id', sortDir: 'asc', includePluginOperations: 'true' });
    for (const field of ['projectId', 'assigneeAgentId', 'assigneeUserId']) if (input[field] !== undefined) params.set(field, input[field]);
    if (parentId !== undefined) params.set('parentId', parentId);
    if (input.statuses) params.set('status', input.statuses.join(','));
    if (anchor) params.set('afterId', anchor);
    const page = await get(`${companyPath}/issues?${params}`);
    valid(Array.isArray(page) && page.length <= limit + 1);
    let previous = anchor;
    const items = page.map(row => {
      valid(record(row) && row.companyId === companyId && uuid(row.id) && (!previous || row.id > previous) && matches(row));
      previous = row.id;
      valid(typeof row.title === 'string' && statuses.includes(row.status) && ['critical', 'high', 'medium', 'low'].includes(row.priority));
      const item = { id: row.id, companyId, title: row.title, status: row.status, priority: row.priority };
      for (const field of ['identifier', 'parentId', 'projectId', 'assigneeAgentId', 'assigneeUserId', 'updatedAt']) {
        valid(row[field] == null || typeof row[field] === 'string');
        item[field] = row[field] ?? null;
      }
      valid(row.description == null || typeof row.description === 'string');
      item.descriptionPreview = row.description == null ? null : row.description.slice(0, 1200);
      return item;
    });
    if (page.length <= limit) {
      // The issue route can filter AFTER SQL LIMIT. Only the all-actors audit
      // route proves company_scope:read; require its full tier, not a short page.
      const proof = await get(`${companyPath}/audit/agent-actions?actorScope=all&entityType=issue&limit=1`);
      requireValue(record(proof) && proof.accessTier === 'full' && Array.isArray(proof.items),
        'incomplete_query', 'Full company audit access is required to establish issue-list exhaustion', 403);
    }
    warnings.push('Descriptions are previews (at most 1200 characters); use humanTask inspect for full text.',
      'Scope is backend-visible issues; hidden and conversation issues are excluded. Results are not a snapshot.');
    return result(items.slice(0, limit), page.length > limit ? encode(items[limit - 1].id) : null);
  }

  if (kind === 'comments') {
    const rows = await readTaskComments(api, { companyId, taskId });
    const positions = rows.map(row => [row.id, row.createdAt]);
    let start = 0;
    if (anchor) {
      const index = rows.findIndex(row => row.id === anchor.id);
      cursorValid(index >= 0 && rows[index].createdAt === anchor.at &&
        digest(positions.slice(0, index + 1)) === anchor.prefixDigest);
      start = index + 1;
    }
    const end = Math.min(start + limit, rows.length);
    const items = rows.slice(start, end).map(row => {
      const item = { id: row.id, taskId, companyId, body: row.body, createdAt: row.createdAt };
      for (const field of ['authorAgentId', 'authorUserId', 'updatedAt']) {
        item[field] = row[field] ?? null;
      }
      return item;
    });
    warnings.push('Comments are re-fetched on each page, not a snapshot. Complete means the current collection is exhausted.',
      'Edits are read fresh, not delivered incrementally. Restart traversal to re-read edits to earlier comments.');
    const last = items.at(-1);
    return result(items, end < rows.length ? encode({ id: last.id, at: last.createdAt,
      prefixDigest: digest(positions.slice(0, end)) }) : null);
  }

  const params = new URLSearchParams({ actorScope: 'all', entityType: 'issue', from: input.from, to: input.to, limit: String(limit) });
  if (taskId) params.set('entityId', taskId);
  if (anchor) params.set('cursor', anchor);
  const page = await get(`${companyPath}/audit/agent-actions?${params}`);
  requireValue(record(page) && page.accessTier === 'full', 'incomplete_query', 'Full audit access is required; basic attribution is incomplete', 403);
  valid(Array.isArray(page.items) && page.items.length <= limit &&
    (page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 8192)));
  valid(page.nextCursor === null || (page.items.length > 0 && page.nextCursor !== anchor));
  const seen = new Set();
  let previousTime = Infinity;
  const items = [];
  for (const row of page.items) {
    valid(record(row) && uuid(row.id) && !seen.has(row.id) && row.companyId === companyId && row.entityType === 'issue' &&
      uuid(row.entityId) && (!taskId || row.entityId === taskId) && ['agent', 'user', 'system', 'plugin'].includes(row.actorType) &&
      string(row.actorId) && string(row.action) && Number.isFinite(timestamp(row.createdAt)));
    seen.add(row.id);
    const at = timestamp(row.createdAt);
    valid(at <= previousTime && at >= timestamp(input.from) && at <= timestamp(input.to));
    previousTime = at;
    // The endpoint's upper bound is inclusive. Keep its cursor even when every
    // row is on that boundary; synthesising one from JSON dates loses precision.
    if (at === timestamp(input.to)) continue;
    valid(row.details == null || record(row.details));
    const details = row.details ?? {};
    valid(details.changes === undefined || record(details.changes));
    const changes = {};
    for (const field of ['status', 'priority', 'assigneeAgentId', 'assigneeUserId', 'projectId', 'parentId']) {
      const change = details.changes?.[field];
      valid(change === undefined || record(change));
      const from = change && Object.hasOwn(change, 'from') ? change.from :
        field === 'status' && Object.hasOwn(details, 'fromStatus') ? details.fromStatus : details._previous?.[field];
      const to = change && Object.hasOwn(change, 'to') ? change.to :
        field === 'status' && Object.hasOwn(details, 'toStatus') ? details.toStatus : details[field];
      if (from === undefined && to === undefined) continue;
      valid((from == null || typeof from === 'string') && (to == null || typeof to === 'string'));
      if (field === 'status') valid((from == null || statuses.includes(from)) && (to == null || statuses.includes(to)));
      if (field === 'priority') valid([from, to].every(value => value == null || ['critical', 'high', 'medium', 'low'].includes(value)));
      changes[field] = { from: from ?? null, to: to ?? null };
    }
    const status = changes.status;
    const transition = status?.to === 'done' && status.from !== 'done' ? 'completed' :
      ['done', 'cancelled'].includes(status?.from) && status?.to && !['done', 'cancelled'].includes(status.to) ? 'reopened' :
        row.action === 'issue.completed' ? 'completed' : row.action === 'issue.reopened' ? 'reopened' : null;
    const item = { id: row.id, taskId: row.entityId, actor: { type: row.actorType, id: row.actorId },
      action: row.action, at: row.createdAt, changes, transition };
    if (row.entity?.issue != null) {
      valid(record(row.entity.issue) && row.entity.issue.id === row.entityId);
      if (row.entity.issue.status !== undefined) {
        valid(statuses.includes(row.entity.issue.status));
        item.currentStatus = row.entity.issue.status;
      }
    }
    items.push(item);
  }
  warnings.push('Activity covers issue entities and [from,to), newest first. Details are restricted to status, priority and ownership changes.');
  return result(items, page.nextCursor === null ? null : encode(page.nextCursor));
}
