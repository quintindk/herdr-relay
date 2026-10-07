import { stripVTControlCharacters } from 'node:util';
import { observedAgents } from './herdr-agents.mjs';
import { RelayError, requireValue, text } from './protocol.mjs';

// Called by the operator-authorised Relay service, never by a direct browser client.
// Only collection/company GETs are issued here. Paperclip 2026.1001.0 can still
// revalidate recovery actions (and write activity) during collection GETs.
// Its issue list defaults to 500, caps limit at 1000, supports ascending UUID
// afterId pagination, and truncates descriptions to 1200 characters. Do not
// replace previews with per-issue GETs, which also perform revalidation.
export async function taskBoard(store, api, { companyId } = {}) {
  if (companyId !== undefined) text(companyId, 'companyId');
  const warnings = [];
  const valid = condition => requireValue(condition, 'invalid_backend_response', 'Invalid Paperclip task board response', 502);
  const string = value => { valid(typeof value === 'string'); return value; };
  const id = value => { valid(typeof value === 'string' && value.trim().length > 0); return value; };
  const optional = value => value == null ? null : string(value);
  const label = value => stripVTControlCharacters(string(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 240);
  const get = async path => {
    try { return await api('GET', path); }
    catch { throw new RelayError('backend_unavailable', 'Paperclip task board could not be refreshed', 502); }
  };
  const list = value => { valid(Array.isArray(value)); return value; };
  const scoped = (row, expected) => {
    valid(row && typeof row === 'object' && !Array.isArray(row));
    id(row.id);
    valid(row.companyId === expected);
    return row;
  };
  const unique = rows => {
    valid(new Set(rows.map(row => row.id)).size === rows.length);
    return rows;
  };
  const company = row => {
    valid(row && typeof row === 'object' && !Array.isArray(row));
    return { id: id(row.id), name: label(row.name) };
  };
  const bindings = store.bindings();
  let companyIds = companyId === undefined ? [...new Set(bindings.map(binding => id(binding.config.companyId)))] : [companyId];
  let companies;
  if (!companyIds.length) {
    companies = unique(list(await get('/api/companies')).map(company));
    if (companies.length > 100) warnings.push('Company limit reached: only the first 100 companies are included.');
    companies = companies.slice(0, 100);
  } else {
    if (companyIds.length > 100) warnings.push('Company limit reached: only the first 100 companies are included.');
    companyIds = companyIds.slice(0, 100);
    companies = [];
    for (const companyId of companyIds) {
      const row = company(await get(`/api/companies/${encodeURIComponent(companyId)}`));
      valid(row.id === companyId);
      companies.push(row);
    }
  }

  const agents = [], projects = [], tasks = [];
  const observations = observedAgents(store);
  for (const { id: companyId } of companies) {
    const path = `/api/companies/${encodeURIComponent(companyId)}`;
    const companyAgents = unique(list(await get(`${path}/agents`)).map(row => scoped(row, companyId)));
    for (const row of companyAgents) {
      const matches = observations.filter(item => item.identity?.companyId === companyId && item.agentId === row.id);
      const observed = matches.length === 1 ? matches[0] : null;
      const age = Date.now() - Date.parse(observed?.updatedAt);
      const fresh = observed?.state === 'recorded' && !observed.error && age >= 0 && age < 15000;
      const availability = fresh && ['present', 'offline', 'unknown'].includes(observed.availability) ? observed.availability : 'unknown';
      const binding = bindings.find(item => item.config.companyId === companyId && item.config.agentId === row.id);
      const bridge = binding ? store.operation(`opencode-bridge:${binding.id}`) : null;
      const bridgeAge = Date.now() - Date.parse(bridge?.lastSeen);
      agents.push({ id: row.id, companyId,
        name: label(fresh && availability === 'present' && typeof observed.observation?.display?.name === 'string'
          ? observed.observation.display.name : row.name),
        availability,
        bridgeState: bridge?.state === 'armed'
          ? (bridgeAge >= 0 && bridgeAge < 10000 ? 'armed' : 'unavailable')
          : bridge?.state === 'configured' ? 'configured' : null,
        nativeState: fresh && availability === 'present' && typeof observed.observation?.state === 'string'
          ? label(observed.observation.state) : 'unknown' });
    }
    projects.push(...unique(list(await get(`${path}/projects?includeArchived=true`)).map(row => {
      scoped(row, companyId);
      return { id: row.id, companyId, name: label(row.name) };
    })));

    let afterId, count = 0;
    while (count < 10000) {
      const query = new URLSearchParams({ limit: '1000', sortField: 'id', sortDir: 'asc', includePluginOperations: 'true' });
      if (afterId) query.set('afterId', afterId);
      const page = list(await get(`${path}/issues?${query}`));
      valid(page.length <= 1000);
      for (const row of page) {
        scoped(row, companyId);
        // Reject repeated/non-advancing pages instead of looping or silently losing issues.
        valid(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id) && (!afterId || row.id > afterId));
        afterId = row.id;
        tasks.push({ id: row.id, companyId, identifier: optional(row.identifier), title: string(row.title),
          status: string(row.status), priority: string(row.priority), parentId: optional(row.parentId),
          assigneeAgentId: optional(row.assigneeAgentId), assigneeUserId: optional(row.assigneeUserId),
          projectId: optional(row.projectId), descriptionPreview: optional(row.description), updatedAt: optional(row.updatedAt) });
      }
      count += page.length;
      if (page.length < 1000) break;
      if (count === 10000) warnings.push(`Issue limit reached for company ${companyId}: 10000 issues returned; more may exist.`);
    }
  }
  // Totals count returned rows, not an invented server count beyond the caps.
  return { companies, agents, projects, tasks,
    totals: { companies: companies.length, agents: agents.length, projects: projects.length, tasks: tasks.length },
    fetchedAt: new Date().toISOString(), warnings };
}
