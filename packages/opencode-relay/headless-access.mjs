import { Rpc } from '@opencode/plugin/rpc';
import { digest } from '../../src/protocol.mjs';
import { validateHeadlessPermissions } from '../../src/headless-permissions.mjs';

const string = { type: 'string', minLength: 1, maxLength: 256 };
const model = { type: 'object', properties: { providerID: string, id: string, integrationID: string, connectionId: string }, required: ['providerID', 'id', 'integrationID', 'connectionId'], additionalProperties: false };
const permissions = { type: 'object', properties: { mcp: { type: 'boolean' }, shell: { type: 'boolean' } }, required: ['mcp'], additionalProperties: false };
export const HeadlessAccess = Rpc.define({ id: 'herdr.relay.headless.access', methods: {
  inspect: { input: { type: 'object', properties: {}, additionalProperties: false }, output: { type: 'object', properties: {
    models: { type: 'array', items: model },
    servers: { type: 'array', items: { type: 'object', properties: { server: string, tools: { type: 'array', items: string } }, required: ['server', 'tools'], additionalProperties: false } },
  }, required: ['models', 'servers'], additionalProperties: false } },
  check: { input: { type: 'object', properties: { model, permissions }, required: ['model', 'permissions'], additionalProperties: false },
    output: { type: 'object', properties: { allowed: { type: 'boolean' }, blocker: string, accessDigest: string,
      mcpToolIds: { type: 'array', items: string } }, required: ['allowed', 'blocker', 'accessDigest'], additionalProperties: false } },
}, events: {} });

export async function nativeMcpTools(ctx) {
  const servers = (await ctx.mcp.list()).data.filter(server => server.status?.status === 'connected');
  // OpenCode supplies these namespaces. Prefix lookalikes are not MCP tools.
  // Core namespaces cannot be reclassified by colliding MCP registrations.
  // Operator-installed host plugins are trusted code and need unique namespaces.
  if (servers.some(server => /^(opencode|browser|relay)([._-]|$)/.test(server.name))) throw Object.assign(Error('MCP namespace collides with a native core namespace'), { code: 'mcp_namespace_conflict' });
  const names = new Set(servers.map(server => server.name));
  const tools = (await ctx.tool.list()).filter(tool => names.has(tool.options?.namespace));
  for (const tool of tools) {
    const namespace = tool.options.namespace;
    if (typeof tool.id !== 'string' || !namespace || ![namespace, namespace.replace(/[^A-Za-z0-9_-]/g, '_')].some(prefix => tool.id.startsWith(`${prefix}_`) && tool.id.length > prefix.length + 1)) {
      throw Object.assign(Error('Native MCP namespace and effective tool ID differ'), { code: 'mcp_namespace_conflict' });
    }
    if (tool.options.permission && tool.options.permission !== tool.id) throw Object.assign(Error('MCP permission aliases cannot authorise native capabilities'), { code: 'mcp_permission_alias_forbidden' });
  }
  return { servers, tools };
}

export async function inspectHeadlessConnections(ctx) {
  const providers = (await ctx.provider.list()).data, candidates = (await ctx.model.list()).data;
  const models = [];
  for (const provider of providers.filter(provider => provider.integrationID)) {
    const active = await ctx.integration.connection.active(provider.integrationID);
    if (!active || active.type !== 'credential' || active.status) continue;
    for (const candidate of candidates.filter(candidate => candidate.providerID === provider.id)) models.push({ providerID: provider.id, id: candidate.id, integrationID: provider.integrationID, connectionId: active.id ?? active.name });
  }
  const catalog = await nativeMcpTools(ctx);
  const servers = catalog.servers.map(server => ({ server: server.name,
    tools: catalog.tools.filter(tool => tool.options.namespace === server.name).map(tool => tool.id) }));
  return { models, servers };
}

export const accessReferences = grant => ({ model: grant.model, permissions: validateHeadlessPermissions(grant.permissions) });

export async function nativeShellTool(ctx) {
  const tool = (await ctx.tool.list()).find(tool => tool.id === 'shell' && !tool.options?.namespace && (!tool.options?.permission || tool.options.permission === 'shell'));
  if (!tool?.execute) throw Object.assign(Error('Native shell tool is unavailable'), { code: 'native_shell_unavailable' });
  return tool;
}

// Model credential identity remains explicit. MCP is a general capability, not
// an integration/server/tool whitelist. No credential listing/resolution occurs.
export async function checkHeadlessAccess(ctx, refs) {
  const blocked = blocker => ({ allowed: false, blocker, accessDigest: digest(refs) });
  try {
    const policy = validateHeadlessPermissions(refs.permissions);
    if (!ctx.integration?.connection?.active || !ctx.session?.hook || !ctx.tool?.hook || !ctx.session?.update) return blocked('headless_plugin_upgrade_required');
    const provider = (await ctx.provider.get({ providerID: refs.model.providerID })).data;
    if (provider?.integrationID !== refs.model.integrationID) return blocked('model_integration_mismatch');
    const active = await ctx.integration.connection.active(refs.model.integrationID);
    if (!active || active.type !== 'credential' || active.status) return blocked('model_connection_unavailable');
    if (active.id !== refs.model.connectionId) return blocked('model_connection_changed');
    const models = (await ctx.model.list()).data;
    if (!models.some(model => model.providerID === refs.model.providerID && model.id === refs.model.id)) return blocked('model_unavailable');
    const catalog = policy.mcp ? await nativeMcpTools(ctx) : { tools: [] };
    if (policy.shell) await nativeShellTool(ctx);
    return { allowed: true, blocker: 'none', accessDigest: digest(refs), mcpToolIds: catalog.tools.map(tool => tool.id) };
  } catch (error) { return blocked(['mcp_namespace_conflict', 'mcp_permission_alias_forbidden', 'native_shell_unavailable', 'invalid_headless_permissions'].includes(error.code) ? error.code : 'integration_inspection_unavailable'); }
}
