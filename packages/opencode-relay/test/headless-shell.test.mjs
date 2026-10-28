import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHeadlessPermissionTools } from '../headless-shell.mjs';
import { headlessSessionPermissions } from '../../../src/headless-permissions.mjs';

function fixture() {
  const f = { calls: [], checks: [], tools: [], updates: [], revoked: false,
    scope: { id: 'setup', sessionId: 'session', directory: '/workspace', contract: '.opencode/skills/job/SKILL.md',
      permissions: { mcp: false, shell: true }, model: { providerID: 'fixture', id: 'model', integrationID: 'auth', connectionId: 'selected' } } };
  const shell = { id: 'shell', name: 'shell', input: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async (input, context) => { f.calls.push({ input, sessionID: context.sessionID }); return { content: 'fixture output', metadata: { native: true } }; } };
  const ctx = { options: {}, location: { directory: '/workspace' },
    provider: { get: async () => ({ data: { integrationID: 'auth' } }) },
    integration: { connection: { active: async () => ({ type: 'credential', id: 'selected' }) } },
    model: { list: async () => ({ data: [{ providerID: 'fixture', id: 'model' }] }) },
    session: { hook() {}, get: async () => ({ id: 'session', location: { directory: '/workspace' }, model: f.scope.model }), update: async input => f.updates.push(input) },
    tool: { hook() {}, list: async () => f.native },
    mcp: { list: () => assert.fail('Shell-only permission must not inspect MCP') },
    permission: { assert: async input => { f.checks.push(input); await f.onPermission?.(); } } };
  f.native = [shell]; f.ctx = ctx;
  const request = async (_worker, _method, path) => {
    if (f.revoked) throw Object.assign(Error('Revoked'), { code: 'headless_grant_inactive' });
    if (path === '/work/current') return { execution: { id: 'execution', runId: 'run' } };
    assert.equal(path, '/work/headless-access'); return structuredClone(f.scope);
  };
  registerHeadlessPermissionTools({ get: name => name === 'shell' ? shell : undefined, add: tool => f.tools.push(tool) }, ctx,
    { request, connection: () => ({ sessionId: 'session', headlessSetupId: 'setup' }) });
  f.invoke = (name, input = {}) => f.tools.find(tool => tool.name === name).execute(input, { sessionID: 'session', agent: 'agent', messageID: 'message', id: 'call' });
  return f;
}

test('shell capability inspection is effect-free and uses the native input schema', async () => {
  const f = fixture();
  assert.deepEqual(JSON.parse((await f.invoke('relay_headless_permissions')).content).permissions, { mcp: false, shell: true });
  assert.equal(f.calls.length, 0); assert.equal(f.checks.length, 0);
  assert.deepEqual(f.tools.find(tool => tool.name === 'relay_shell_call').input, f.native[0].input);
  const result = await f.invoke('relay_shell_call', { command: 'fixture only' });
  assert.equal(result.content, 'fixture output'); assert.equal(result.metadata.headlessShellCall, true);
  assert.deepEqual(f.calls, [{ input: { command: 'fixture only' }, sessionID: 'session' }]);
  assert.equal(f.checks[0].action, 'shell');
  const permissions = headlessSessionPermissions(f.scope);
  assert.ok(permissions.some(rule => rule.action === 'shell' && rule.resource === '*' && rule.effect === 'allow'));
  assert.equal(permissions.some(rule => ['write', 'edit', 'execute'].includes(rule.action) && rule.effect === 'allow'), false);
});

test('denied shell, readiness and staged results never dispatch commands', async () => {
  for (const [field, value, code] of [['shell', false, 'headless_shell_not_granted'], ['readiness', true, 'headless_probe_external_effect_forbidden'], ['outcomeStaged', true, 'headless_outcome_staged']]) {
    const f = fixture();
    if (field === 'shell') f.scope.permissions.shell = value;
    else f.scope[field] = value;
    await f.invoke('relay_headless_permissions');
    await assert.rejects(f.invoke('relay_shell_call', { command: 'fixture only' }), { code });
    assert.equal(f.calls.length, 0);
  }
});

test('revocation and workspace changes during permission evaluation block shell dispatch', async () => {
  for (const mode of ['revoke', 'move']) {
    const f = fixture();
    f.onPermission = () => { if (mode === 'revoke') f.revoked = true; else f.ctx.location.directory = '/elsewhere'; };
    await assert.rejects(f.invoke('relay_shell_call', { command: 'fixture only' }), { code: mode === 'revoke' ? 'headless_grant_inactive' : 'headless_scope_mismatch' });
    assert.equal(f.calls.length, 0);
  }
});

test('namespaced shell lookalikes cannot acquire the native shell capability', async () => {
  const f = fixture(); f.native[0].options = { namespace: 'external' };
  await assert.rejects(f.invoke('relay_shell_call', { command: 'fixture only' }), { code: 'native_shell_unavailable' });
  assert.equal(f.calls.length, 0);
});
