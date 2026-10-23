import { headlessToolScope, syncHeadlessPermissions, assertHeadlessEffect } from './headless-scope.mjs';
import { nativeMcpTools, nativeShellTool } from './headless-access.mjs';

export function registerHeadlessPermissionTools(editor, ctx, dependencies = {}) {
  editor.add({ name: 'relay_headless_permissions', description: 'Inspect explicit headless MCP and shell permissions without executing external tools or commands. Shell allowed is full OS-user process/filesystem access, not an artifact-path sandbox.', options: { codemode: false },
    input: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_input, context) {
      const { scope } = await headlessToolScope(ctx, context, dependencies);
      const catalog = scope.permissions.mcp ? await nativeMcpTools(ctx) : { tools: [] };
      if (scope.permissions.shell) await nativeShellTool(ctx);
      await syncHeadlessPermissions(ctx, context, scope, catalog);
      return { content: JSON.stringify({ permissions: scope.permissions, mcpToolCount: catalog.tools.length, businessCoverageVerified: false }),
        metadata: { headlessPermissions: scope.permissions, headlessSetupId: scope.id } };
    } });
  const native = editor.get?.('shell') ?? editor.list?.().find(tool => tool.id === 'shell' && !tool.options?.namespace);
  editor.add({ name: 'relay_shell_call', description: 'Execute the native shell under explicit shell permission for this accepted headless run. Full OS-user access, including file writes outside artifact paths. Readiness and submitted outcomes cannot execute commands. Revocation prevents new dispatch, not effects or processes already started.', options: { codemode: false },
    input: native?.input ?? { type: 'object', properties: { command: { type: 'string', minLength: 1 } }, required: ['command'], additionalProperties: true },
    ...(native?.output ? { output: native.output } : {}),
    async execute(input, context) {
      let { scope } = await headlessToolScope(ctx, context, dependencies);
      assertHeadlessEffect(scope, 'shell');
      const catalog = scope.permissions.mcp ? await nativeMcpTools(ctx) : { tools: [] };
      await syncHeadlessPermissions(ctx, context, scope, catalog);
      await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, action: 'shell', resources: ['*'],
        source: { type: 'tool', messageID: context.messageID, id: context.id } });
      ({ scope } = await headlessToolScope(ctx, context, dependencies)); assertHeadlessEffect(scope, 'shell');
      const tool = await nativeShellTool(ctx), result = await tool.execute(input, context);
      return { ...result, metadata: { ...(result.metadata ?? {}), headlessShellCall: true } };
    } });
}
