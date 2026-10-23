import { digest, requireValue } from '../../src/protocol.mjs';
import { headlessSessionPermissions } from '../../src/headless-permissions.mjs';
import { accessReferences, checkHeadlessAccess, nativeMcpTools } from './headless-access.mjs';
import { workerConnection } from './worker-context.mjs';
import { call } from '../../src/client.mjs';

export async function mcpExecutionScope(ctx, context, { connection = workerConnection, request = call } = {}) {
  const worker = connection(ctx.options, context.sessionID);
  requireValue(worker.headlessSetupId && worker.sessionId === context.sessionID, 'headless_mcp_scope_required', 'Exact headless worker required', 403);
  const current = await request(worker, 'POST', '/work/current', { sessionId: context.sessionID });
  const run = { executionId: current.execution.id, runId: current.execution.runId };
  const scope = await request(worker, 'POST', '/work/mcp-access', run);
  requireValue(scope.id === worker.headlessSetupId && scope.sessionId === context.sessionID, 'headless_scope_mismatch', 'Exact MCP execution scope required', 403);
  const check = await checkHeadlessAccess(ctx, accessReferences(scope));
  requireValue(check.allowed, check.blocker, 'Approved model/capability is unavailable', 403);
  const session = await ctx.session.get({ sessionID: context.sessionID });
  requireValue(session.id === context.sessionID && session.location?.directory === scope.directory && ctx.location?.directory === scope.directory,
    'headless_scope_mismatch', 'Headless MCP calls must stay in the approved session and workspace', 403);
  requireValue(session.model?.providerID === scope.model.providerID && session.model?.id === scope.model.id,
    'headless_model_changed', 'Headless session must retain its authorised model', 403);
  return { scope, worker, run };
}

export async function syncMcpPermissions(ctx, context, scope, catalog) {
  const permissions = headlessSessionPermissions(scope, scope.permissions.mcp ? catalog.tools : []);
  await ctx.session.update({ sessionID: context.sessionID, permissions });
}

export function registerMcpTools(editor, ctx, dependencies = {}) {
  const request = dependencies.request ?? call;
  const authority = context => mcpExecutionScope(ctx, context, dependencies);
  editor.add({ name: 'relay_mcp_tools', description: 'Inspect the headless grant’s general MCP allow/deny policy and current native MCP tool catalogue. No external tool is executed. MCP allowed includes write-capable tools and subsequently configured tools. Does not grant shell or local file access.', options: { codemode: false },
    input: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_input, context) {
      const { scope } = await authority(context);
      const catalog = scope.permissions.mcp ? await nativeMcpTools(ctx) : { servers: [], tools: [] };
      await syncMcpPermissions(ctx, context, scope, catalog);
      const tools = catalog.tools.map(tool => ({ id: tool.id, server: tool.options.namespace, description: tool.description, input: tool.input }));
      return { content: JSON.stringify({ mcpAllowed: scope.permissions.mcp, tools, businessCoverageVerified: false }),
        metadata: { headlessMcpAllowed: scope.permissions.mcp, headlessSetupId: scope.id, headlessMcpCatalogDigest: digest(tools) } };
    } });
  editor.add({ name: 'relay_mcp_call', description: 'Invoke one current native MCP tool under the exact active headless grant with MCP allowed. Uses the existing authenticated MCP transport, including write-capable tools. Does not expose native shell, file, configuration or authentication APIs. MCP providers may themselves expose powerful actions. Never automatically retry uncertain external effects.', options: { codemode: false },
    input: { type: 'object', properties: { tool: { type: 'string', minLength: 1, maxLength: 256 }, arguments: { type: 'object', maxProperties: 64, additionalProperties: true }, sourceNamespace: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['tool', 'arguments'], additionalProperties: false },
    async execute(input, context) {
      let { scope, worker, run } = await authority(context);
      const permitted = current => {
        requireValue(current.permissions.mcp === true, 'headless_mcp_not_granted', 'MCP is denied by this grant', 403);
        requireValue(!current.readiness, 'headless_probe_external_effect_forbidden', 'Readiness may inspect the catalogue, not execute external tools', 403);
        requireValue(!current.outcomeStaged, 'headless_outcome_staged', 'Finish the native turn after submitting its outcome', 403);
        requireValue(input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments) && JSON.stringify(input.arguments).length <= 16000,
          'invalid_mcp_arguments', 'Bounded structured MCP arguments required');
        if (input.sourceNamespace) requireValue(current.capabilities?.sourceNamespaces.includes(input.sourceNamespace), 'headless_source_forbidden', 'Observation namespace must be explicitly granted', 403);
      };
      permitted(scope);
      let catalog = await nativeMcpTools(ctx);
      requireValue(catalog.tools.some(tool => tool.id === input.tool), 'headless_mcp_tool_forbidden', 'Select an exact current native MCP tool ID', 403);
      await syncMcpPermissions(ctx, context, scope, catalog);
      await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, action: input.tool, resources: ['*'],
        source: { type: 'tool', messageID: context.messageID, id: context.id } });
      // Recheck after a potentially asynchronous permission decision. No cached
      // authorisation or credentials are accepted as an outage workaround.
      ({ scope, worker, run } = await authority(context)); permitted(scope);
      catalog = await nativeMcpTools(ctx);
      const tool = catalog.tools.find(tool => tool.id === input.tool);
      requireValue(tool?.execute, 'headless_mcp_tool_forbidden', 'Native MCP tool is no longer available', 403);
      const result = await tool.execute(input.arguments, context);
      let observation;
      if (input.sourceNamespace) {
        try { observation = await request(worker, 'POST', '/work/headless-observation', { ...run, payload: {
          id: context.id, namespace: input.sourceNamespace, inputDigest: digest({ tool: input.tool, arguments: input.arguments }), outputDigest: digest(result) } }); }
        catch { observation = { confirmed: false, warning: 'External tool returned, but observation recording is unconfirmed. Do not repeat a write merely to record evidence.' }; }
      }
      const content = Array.isArray(result.content) ? [...result.content] : [{ type: 'text', text: String(result.content ?? '') }];
      if (result.output !== undefined) content.push({ type: 'text', text: JSON.stringify(result.output) });
      if (observation) content.push({ type: 'text', text: JSON.stringify({ relayHeadlessObservation: observation }) });
      return { content, metadata: { ...(result.metadata ?? {}), headlessMcpTool: input.tool, ...(observation ? { headlessObservationConfirmed: observation.confirmed === true } : {}) } };
    } });
}
