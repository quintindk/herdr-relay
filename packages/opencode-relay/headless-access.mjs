import { Rpc } from '@opencode/plugin/rpc';
import { digest } from '../../src/protocol.mjs';

const string = { type: 'string', minLength: 1, maxLength: 256 };
export const HeadlessAccess = Rpc.define({ id: 'herdr.relay.headless.access', methods: {
  inspect: { input: { type: 'object', properties: {}, additionalProperties: false }, output: { type: 'object', properties: {
    models: { type: 'array', items: { type: 'object', properties: { providerID: string, id: string, integrationID: string, connectionId: string }, required: ['providerID', 'id', 'integrationID', 'connectionId'], additionalProperties: false } },
    servers: { type: 'array', items: { type: 'object', properties: { server: string, tools: { type: 'array', items: string } }, required: ['server', 'tools'], additionalProperties: false } },
  }, required: ['models', 'servers'], additionalProperties: false } },
  check: { input: { type: 'object', properties: { model: { type: 'object', properties: { providerID: string, id: string, integrationID: string, connectionId: string },
    required: ['providerID', 'id', 'integrationID', 'connectionId'], additionalProperties: false }, workiq: { type: 'object', properties: {
      server: string, integrationID: string, connectionId: string, readTool: string }, required: ['server', 'readTool'], additionalProperties: false } },
    required: ['model', 'workiq'], additionalProperties: false },
  output: { type: 'object', properties: { allowed: { type: 'boolean' }, blocker: string, accessDigest: string }, required: ['allowed', 'blocker', 'accessDigest'], additionalProperties: false } },
}, events: {} });

export async function inspectHeadlessConnections(ctx) {
  const providers = (await ctx.provider.list()).data, candidates = (await ctx.model.list()).data;
  const models = [];
  for (const p of providers.filter(p => p.integrationID)) {
    const active = await ctx.integration.connection.active(p.integrationID);
    if (!active || active.type !== 'credential' || active.status) continue;
    for (const m of candidates.filter(m => m.providerID === p.id)) models.push({ providerID: p.id, id: m.id, integrationID: p.integrationID, connectionId: active.id ?? active.name });
  }
  const tools = (await ctx.tool.list()).map(t => t.id ?? t.name);
  const servers = (await ctx.mcp.list()).data.filter(s => s.status?.status === 'connected').map(s => ({ server: s.name,
    tools: tools.filter(t => t.startsWith(`${s.name.replace(/[^A-Za-z0-9_]/g, '_')}_`)) }));
  return { models, servers };
}

export const accessReferences = grant => ({ model: grant.model, workiq: { server: grant.workiq.server, readTool: grant.workiq.readTool,
  ...(grant.workiq.integrationID ? { integrationID: grant.workiq.integrationID, connectionId: grant.workiq.connectionId } : {}) } });

// Public connection metadata only. Never calls connection.resolve or credential.list.
export async function checkHeadlessAccess(ctx, refs) {
  const blocked = blocker => ({ allowed: false, blocker, accessDigest: digest(refs) });
  try {
    if (!ctx.integration?.connection?.active || !ctx.session?.hook) return blocked('headless_plugin_upgrade_required');
    const provider = (await ctx.provider.get({ providerID: refs.model.providerID })).data;
    if (provider?.integrationID !== refs.model.integrationID) return blocked('model_integration_mismatch');
    const active = await ctx.integration.connection.active(refs.model.integrationID);
    if (!active || active.type !== 'credential' || active.status || active.id !== refs.model.connectionId) return blocked('model_connection_unavailable');
    const models = (await ctx.model.list()).data;
    if (!models.some(m => m.providerID === refs.model.providerID && m.id === refs.model.id)) return blocked('model_unavailable');
    const server = (await ctx.mcp.list()).data.find(s => s.name === refs.workiq.server);
    if (!server || server.status?.status !== 'connected') return blocked('workiq_not_connected');
    if (refs.workiq.integrationID) {
      if (server.integrationID !== refs.workiq.integrationID) return blocked('workiq_integration_mismatch');
      const connection = await ctx.integration.connection.active(refs.workiq.integrationID);
      if (!connection || connection.type !== 'credential' || connection.status || connection.id !== refs.workiq.connectionId) return blocked('workiq_connection_unavailable');
    }
    if (!(await ctx.tool.list()).some(t => (t.id ?? t.name) === refs.workiq.readTool)) return blocked('workiq_read_tool_unavailable');
    return { allowed: true, blocker: 'none', accessDigest: digest(refs) };
  } catch { return blocked('integration_inspection_unavailable'); }
}
