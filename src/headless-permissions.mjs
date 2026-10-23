import { requireValue } from './protocol.mjs';

export function validateHeadlessPermissions(permissions) {
  requireValue(permissions && typeof permissions === 'object' && !Array.isArray(permissions) &&
    Object.keys(permissions).every(key => ['mcp', 'shell'].includes(key)) && typeof permissions.mcp === 'boolean' &&
    (permissions.shell === undefined || permissions.shell === false), 'invalid_headless_permissions',
  'Explicit MCP allow/deny required. Shell access is a separate unsupported capability and must remain denied');
  return { mcp: permissions.mcp, shell: false };
}

export function headlessSessionPermissions(grant, mcpTools = []) {
  const permissions = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: `${grant.directory}/${grant.contract}`, effect: 'allow' },
    ...['relay_work_read', 'relay_work_submit', 'relay_work_ask', 'relay_task_list', 'relay_task_inspect', 'relay_task_comments', 'relay_task_relations']
      .map(action => ({ action, resource: '*', effect: 'allow' }))];
  const actions = ['relay_mcp_tools', ...(grant.permissions.mcp ? ['relay_mcp_call', ...mcpTools.map(tool => tool.id)] : [])];
  if (grant.capabilities) actions.push('relay_headless_scope', 'relay_headless_capabilities',
    ...(grant.capabilities.taskActions.length ? ['relay_headless_task', 'relay_headless_reference_lookup'] : []),
    ...(grant.capabilities.artifacts ? ['relay_headless_artifacts'] : []));
  return [...permissions, ...[...new Set(actions)].map(action => ({ action, resource: '*', effect: 'allow' }))];
}
