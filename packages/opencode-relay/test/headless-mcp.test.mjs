import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeMcpTools } from '../headless-access.mjs';
import { registerMcpTools } from '../headless-mcp.mjs';
import { headlessSessionPermissions, validateHeadlessPermissions } from '../../../src/headless-permissions.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import serverPlugin from '../server.mjs';

function fixture() {
  const f = { calls: [], permissionChecks: [], updates: [], registrations: [], revoked: false, catalogReads: 0,
    scope: { id: 'setup', sessionId: 'session', directory: '/workspace', contract: '.opencode/skills/job/SKILL.md',
      permissions: { mcp: true, shell: false }, model: { providerID: 'fixture', id: 'model', integrationID: 'auth', connectionId: 'selected' }, readiness: false },
    servers: [{ name: 'records', status: { status: 'connected' } }], native: [] };
  f.tool = (id, server) => ({ id, name: id.slice(server.length + 1), description: 'Disposable external tool', input: { type: 'object', properties: {} }, options: { namespace: server, codemode: true },
    execute: async (input, context) => { f.calls.push({ id, input, sessionId: context.sessionID }); return { content: 'External reply', metadata: { providerReply: true } }; } });
  f.native.push(f.tool('records_read', 'records'), f.tool('records_send', 'records'),
    { id: 'shell', name: 'shell', execute: () => assert.fail('Never invoke native shell') },
    { id: 'records_fake', name: 'records_fake', execute: () => assert.fail('A name prefix is not MCP provenance') });
  const ctx = { options: {}, location: { directory: '/workspace' },
    provider: { get: async () => ({ data: { integrationID: 'auth' } }) },
    integration: { connection: { active: async () => ({ type: 'credential', id: 'selected' }), resolve: () => assert.fail('Never resolve credentials') } },
    credential: { list: () => assert.fail('Never enumerate credentials') }, model: { list: async () => ({ data: [{ providerID: 'fixture', id: 'model' }] }) },
    session: { hook() {}, get: async () => ({ id: 'session', location: { directory: '/workspace' }, model: f.scope.model }), update: async input => f.updates.push(input) },
    mcp: { list: async () => { f.catalogReads++; return { data: f.servers }; } },
    tool: { hook() {}, list: async () => f.native },
    permission: { assert: async input => { f.permissionChecks.push(input); await f.onPermission?.(); } },
  };
  const request = async (_connection, _method, path) => {
    if (f.revoked) throw Object.assign(Error('Revoked'), { code: 'headless_grant_inactive' });
    if (path === '/work/current') return { execution: { id: 'execution', runId: 'run' } };
    if (path === '/work/mcp-access') return structuredClone(f.scope);
    if (path === '/work/headless-observation') { if (f.evidenceFailure) throw Error('Offline after provider reply'); return { confirmed: true }; }
    assert.fail(`Unexpected connector route ${path}`);
  };
  registerMcpTools({ add: tool => f.registrations.push(tool) }, ctx, { request, connection: () => ({ sessionId: 'session', headlessSetupId: 'setup' }) });
  f.ctx = ctx;
  f.invoke = (tool, input = {}) => f.registrations.find(candidate => candidate.name === tool).execute(input, { sessionID: 'session', agent: 'agent', messageID: 'message', id: 'call' });
  return f;
}

test('MCP is one explicit boolean permission, not a service/tool allowlist', () => {
  assert.deepEqual(validateHeadlessPermissions({ mcp: false }), { mcp: false, shell: false });
  assert.deepEqual(validateHeadlessPermissions({ mcp: true, shell: false }), { mcp: true, shell: false });
  for (const permissions of [{}, { mcp: '*' }, { mcp: true, servers: ['example'] }, { mcp: true, shell: true }])
    assert.throws(() => validateHeadlessPermissions(permissions), { code: 'invalid_headless_permissions' });
});

test('MCP allowed includes reads and writes through the existing transport with native permission checks', async () => {
  const f = fixture();
  const catalog = JSON.parse((await f.invoke('relay_mcp_tools')).content);
  assert.equal(catalog.mcpAllowed, true); assert.deepEqual(catalog.tools.map(tool => tool.id), ['records_read', 'records_send']);
  assert.equal(f.calls.length, 0, 'Catalogue inspection is non-mutating');
  for (const tool of ['records_read', 'records_send']) await f.invoke('relay_mcp_call', { tool, arguments: { fixture: true } });
  assert.deepEqual(f.calls.map(call => call.id), ['records_read', 'records_send']);
  assert.ok(f.calls.every(call => call.sessionId === 'session'));
  assert.deepEqual(f.permissionChecks.map(check => check.action), ['records_read', 'records_send']);
  const permissions = f.updates.at(-1).permissions;
  assert.ok(permissions.some(rule => rule.action === '*' && rule.effect === 'deny'));
  assert.equal(permissions.some(rule => ['shell', 'write', 'edit', 'execute'].includes(rule.action) && rule.effect === 'allow'), false);
});

test('MCP denied exposes no catalogue and cannot invoke external tools', async () => {
  const f = fixture(); f.scope.permissions.mcp = false;
  const catalog = JSON.parse((await f.invoke('relay_mcp_tools')).content);
  assert.equal(catalog.mcpAllowed, false); assert.deepEqual(catalog.tools, []); assert.equal(f.catalogReads, 0);
  await assert.rejects(f.invoke('relay_mcp_call', { tool: 'records_send', arguments: {} }), { code: 'headless_mcp_not_granted' });
  assert.equal(f.calls.length, 0);
});

test('subsequently configured MCP tools inherit the capability without amending a grant', async () => {
  const f = fixture(); await f.invoke('relay_mcp_tools');
  f.servers.push({ name: 'second', status: { status: 'connected' } }); f.native.push(f.tool('second_send', 'second'));
  await f.invoke('relay_mcp_call', { tool: 'second_send', arguments: {} });
  assert.equal(f.calls[0].id, 'second_send');
  assert.ok(f.updates.at(-1).permissions.some(rule => rule.action === 'second_send' && rule.effect === 'allow'));
});

test('native tools and name-prefix lookalikes cannot pass as MCP tools', async () => {
  const f = fixture();
  for (const tool of ['shell', 'records_fake', 'unregistered_send']) await assert.rejects(f.invoke('relay_mcp_call', { tool, arguments: {} }), { code: 'headless_mcp_tool_forbidden' });
  assert.equal(f.calls.length, 0);
});

test('namespace/permission aliases cannot authorise native capabilities', async () => {
  const f = fixture(); f.native[0].options.permission = 'shell';
  await assert.rejects(nativeMcpTools(f.ctx), { code: 'mcp_permission_alias_forbidden' });
  delete f.native[0].options.permission; f.native[0].id = 'shell';
  await assert.rejects(nativeMcpTools(f.ctx), { code: 'mcp_namespace_conflict' });
  f.servers.push({ name: 'opencode', status: { status: 'connected' } });
  await assert.rejects(nativeMcpTools(f.ctx), { code: 'mcp_namespace_conflict' });
});

test('readiness and staged outcomes cannot execute external effects', async () => {
  for (const [field, code] of [['readiness', 'headless_probe_external_effect_forbidden'], ['outcomeStaged', 'headless_outcome_staged']]) {
    const f = fixture(); f.scope[field] = true;
    assert.equal((await f.invoke('relay_mcp_tools')).metadata.headlessMcpAllowed, true);
    await assert.rejects(f.invoke('relay_mcp_call', { tool: 'records_send', arguments: {} }), { code });
    assert.equal(f.calls.length, 0);
  }
});

test('revocation during permission evaluation prevents dispatch and never uses cached approval', async () => {
  const f = fixture(); f.onPermission = () => { f.revoked = true; };
  await assert.rejects(f.invoke('relay_mcp_call', { tool: 'records_send', arguments: {} }), { code: 'headless_grant_inactive' });
  assert.equal(f.calls.length, 0);
});

test('a moved session or changed plugin location cannot use the original workspace grant', async () => {
  const f = fixture(); f.ctx.location.directory = '/another-workspace';
  await assert.rejects(f.invoke('relay_mcp_call', { tool: 'records_send', arguments: {} }), { code: 'headless_scope_mismatch' });
  assert.equal(f.calls.length, 0);
});

test('a provider reply is retained when evidence recording fails, without retrying the external write', async () => {
  const f = fixture(); f.scope.capabilities = { sourceNamespaces: ['external'], taskActions: ['task.create'] }; f.evidenceFailure = true;
  const result = await f.invoke('relay_mcp_call', { tool: 'records_send', arguments: {}, sourceNamespace: 'external' });
  assert.equal(result.metadata.headlessObservationConfirmed, false);
  assert.ok(JSON.stringify(result.content).includes('External reply')); assert.ok(JSON.stringify(result.content).includes('Do not repeat a write'));
  assert.equal(f.calls.length, 1);
});

test('MCP disabled never grants native shell, arbitrary file writes or generic Code Mode execution', () => {
  const scope = fixture().scope; scope.permissions.mcp = false;
  const permissions = headlessSessionPermissions(scope);
  assert.equal(permissions.some(rule => ['shell', 'write', 'edit', 'execute'].includes(rule.action) && rule.effect === 'allow'), false);
  assert.deepEqual(permissions.find(rule => rule.action === 'read'), { action: 'read', resource: '/workspace/.opencode/skills/job/SKILL.md', effect: 'allow' });
});

test('direct MCP calls cannot bypass the bridge, while native audit tools do not acquire an unrelated MCP outage dependency', async t => {
  const root = mkdtempSync('/tmp/opencode/mcp-hook-'), file = join(root, 'worker.json');
  writeFileSync(file, JSON.stringify({ socketPath: join(root, 'absent.sock'), token: 'fixture', agentId: 'agent', sessionId: 'session', headlessSetupId: 'setup' }), { mode: 0o600 });
  let before;
  const ctx = { options: { workerContextFile: file },
    session: { hook: async () => ({ dispose() {} }), get: () => assert.fail('Native platform audit tools should retain their own authority route') },
    tool: { transform: async edit => { edit({ add() {} }); return { dispose() {} }; },
      list: async () => [{ id: 'relay_headless_artifacts' }, { id: 'external_send', options: { namespace: 'external' } }],
      hook: async (_name, callback) => { before = callback; return { dispose() {} }; } },
    rpc: { register: async () => ({ dispose() {} }) } };
  const close = await serverPlugin.setup(ctx);
  t.after(async () => { await close(); rmSync(root, { recursive: true, force: true }); });
  await before({ sessionID: 'session', tool: 'relay_headless_artifacts' });
  await assert.rejects(before({ sessionID: 'session', tool: 'external_send' }), /use_relay_mcp_call/);
});
