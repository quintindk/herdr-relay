import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { checkHeadlessAccess } from '../packages/opencode-relay/headless-access.mjs';
import { digest } from '../src/protocol.mjs';
import { headlessProbeId } from '../src/headless-setup-contract.mjs';
import { tickHeadlessSetups } from '../src/node-headless-setup.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { NativeReceivers } from '../src/native-receivers.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function fixture(t) {
  const store = new BackendStore(':memory:'); t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token);
  const command = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  command(owner, 'node', 'node.enrol', { id: 'surface', name: 'Surface' });
  const node = store.authenticate(store.enrolCredential(owner, 'surface', 'node-token').token);
  command(owner, 'mason', 'agent.enrol', { id: 'mason', nodeId: 'surface', name: 'Mason', directory: '/work/twd' });
  command(owner, 'attach', 'agent.attach', { id: 'mason', expectedBindingRevision: 0, conversationId: 'ses_mason', directory: '/work/twd', bindingId: 'binding_mason' });
  const grant = { id: 'approved-grant', requesterAgentId: 'mason', nodeId: 'surface', name: 'approved-worker', directory: '/work/twd',
    model: { providerID: 'provider', id: 'model', integrationID: 'model-auth', connectionId: 'credential-ref' },
    permissions: { mcp: true, shell: false },
    contract: '.opencode/skills/approved-job/SKILL.md', schedule: { id: 'approved-job', cron: '0 7-18 * * 1-5', timezone: 'Africa/Johannesburg', reviewPolicy: 'none' } };
  const request = { grantId: grant.id, requesterAgentId: 'mason', sourceConversationId: 'ses_mason', sourceBindingRevision: 1 };
  return { store, owner, node, command, grant, request };
}

test('headless setup requires an explicit grant and exact coordinator, reuses stable workspace/name and cannot replace Mason', t => {
  const f = fixture(t), { command: c, owner, node, grant, request } = f;
  assert.throws(() => c(node, 'self-grant', 'headless.grant', grant), { code: 'forbidden' });
  c(owner, 'grant', 'headless.grant', grant);
  assert.throws(() => c(node, 'spoof', 'headless.request', { ...request, sourceConversationId: 'other' }), { code: 'headless_requester_scope' });
  const setup = c(node, 'request', 'headless.request', request);
  assert.notEqual(setup.agentId, 'mason'); assert.equal(setup.state, 'requested');
  assert.equal(c(node, 'another-key', 'headless.request', request).id, setup.id);
  assert.equal(f.store.all('headless_setup').length, 1); assert.equal(f.store.all('schedule').length, 0);
  assert.throws(() => c(node, 'activate-without-probe', 'headless.activate', { id: setup.id, receipt: {
    nativeTerminalId: 'idle', permissionsToolCallId: 'tool', permissions: grant.permissions, accessDigest: 'ref' } }));
});

test('new grants require boolean MCP and shell permissions and reject connector-specific fields', t => {
  const f = fixture(t);
  for (const [index, permissions] of [{}, { mcp: '*' }, { mcp: true, allowedServers: ['one'] }, { mcp: true, shell: 'yes' }].entries()) {
    assert.throws(() => f.command(f.owner, `bad-${index}`, 'headless.grant', { ...f.grant, permissions }), { code: 'invalid_headless_permissions' });
  }
  assert.throws(() => f.command(f.owner, 'connector-fields', 'headless.grant', { ...f.grant, connector: { server: 'one' } }), { code: 'invalid_headless_setup' });
  const grant = f.command(f.owner, 'denied-policy', 'headless.grant', { ...f.grant, permissions: { mcp: false } });
  assert.deepEqual(grant.permissions, { mcp: false, shell: false });
  const allowed = f.command(f.owner, 'shell-policy', 'headless.grant', { ...f.grant, id: 'shell-grant', permissions: { mcp: true, shell: true } });
  assert.deepEqual(allowed.permissions, { mcp: true, shell: true });
  assert.equal(f.store.all('headless_setup').length, 0); assert.equal(f.store.all('schedule').length, 0);
});

test('only successful probe evidence activates one schedule, and revocation pauses it without borrowing owner context', t => {
  const f = fixture(t), { command: c, owner, node, grant, request, store } = f;
  grant.schedule.runResultNotifications = { inbox: true, requester: false };
  c(owner, 'grant', 'headless.grant', grant); const setup = c(node, 'request', 'headless.request', request);
  const agent = c(node, 'register', 'headless.register', { id: setup.id });
  c(node, 'advertise', 'agent.advertise', { id: agent.id, expectedRevision: agent.revision, availability: 'available', conversationId: setup.sessionId, bindingRevision: 1 });
  const probe = c(node, 'probe', 'headless.probe', { id: setup.id });
  assert.equal(probe.reviewPolicy, 'none'); assert.equal(store.all('schedule').length, 0);
  // Store-fixture terminal evidence only. Real process acceptance is a separate smoke.
  store.save('execution', { ...probe, state: 'completed', result: { candidate: 'headless-readiness' } });
  const ready = c(node, 'activate', 'headless.activate', { id: setup.id, receipt: { nativeTerminalId: 'idle', permissionsToolCallId: 'tool',
    permissions: grant.permissions, accessDigest: 'refs' } });
  assert.equal(ready.state, 'ready'); const schedule = store.get('schedule', grant.schedule.id);
  assert.equal(schedule.definition.targetAgentId, setup.agentId); assert.equal(schedule.definition.enabled, true);
  assert.equal(schedule.definition.targetConversationId, undefined);
  assert.deepEqual(schedule.definition.runResultNotifications, grant.schedule.runResultNotifications);
  assert.equal(store.all('notification').length, 0, 'Readiness is not a cron result');
  c(owner, 'revoke', 'headless.revoke', { id: grant.id, expectedRevision: 1 });
  assert.equal(store.get('schedule', grant.schedule.id).definition.enabled, false);
  assert.throws(() => c(node, 'retry-after-revocation', 'headless.request', request), { code: 'headless_grant_inactive' });
});

test('headless request can select run result reporting without changing its grant, worker permissions or existing setup', t => {
  const f = fixture(t), { command: c, owner, node, grant, request, store } = f;
  c(owner, 'grant', 'headless.grant', grant);
  const policy = { inbox: true, requester: true };
  const setup = c(node, 'setup', 'headless.request', { ...request, runResultNotifications: policy });
  assert.deepEqual(setup.runResultNotifications, policy);
  assert.deepEqual(store.get('headless_grant', grant.id).permissions, grant.permissions);
  assert.equal(store.get('headless_grant', grant.id).revision, 1);
  assert.throws(() => c(node, 'bad-existing', 'headless.request', { ...request, runResultNotifications: { inbox: false, requester: true } }), { code: 'headless_setup_conflict' });
  assert.throws(() => c(node, 'bad-shape', 'headless.request', { ...request, runResultNotifications: { inbox: true, onStart: true } }), { code: 'invalid_run_result_notifications' });
  assert.equal(c(node, 'inspect-same', 'headless.request', request).id, setup.id);
});

test('connection checks pin only the model, expose no secrets and do not couple MCP permission to a particular server', async () => {
  const refs = { model: { providerID: 'provider', id: 'model', integrationID: 'auth', connectionId: 'selected' }, permissions: { mcp: true } };
  let active = 'selected', status = 'connected';
  const ctx = { session: { hook() {}, update() {} }, provider: { get: async () => ({ data: { integrationID: 'auth', settings: { apiKey: 'NEVER-EXPOSE' } } }) },
    integration: { connection: { active: async () => ({ type: 'credential', id: active }), resolve: () => assert.fail('Do not resolve credentials') } },
    credential: { list: () => assert.fail('Credential list includes secrets') }, model: { list: async () => ({ data: [{ providerID: 'provider', id: 'model' }] }) },
    mcp: { list: async () => ({ data: [{ name: 'arbitrary', status: { status } }] }) }, tool: { hook() {}, list: async () => [{ id: 'arbitrary_read', options: { namespace: 'arbitrary' } }] } };
  const result = await checkHeadlessAccess(ctx, refs); assert.equal(result.allowed, true); assert.doesNotMatch(JSON.stringify(result), /NEVER-EXPOSE/);
  active = 'other'; assert.equal((await checkHeadlessAccess(ctx, refs)).blocker, 'model_connection_unavailable');
  active = 'selected'; status = 'needs_auth'; const unavailable = await checkHeadlessAccess(ctx, refs);
  assert.equal(unavailable.allowed, true); assert.deepEqual(unavailable.mcpToolIds, []);
});

test('explicit retry preserves worker identity, retains the failed attempt and refuses unsettled readiness work', t => {
  const f = fixture(t), { command: c, owner, node, grant, request, store } = f;
  c(owner, 'grant', 'headless.grant', grant); const first = c(node, 'request', 'headless.request', request);
  c(node, 'block', 'headless.block', { id: first.id, reason: 'connector_unavailable' });
  const second = c(node, 'retry', 'headless.request', { ...request, retry: true });
  assert.equal(second.agentId, first.agentId); assert.equal(second.sessionId, first.sessionId); assert.equal(second.attempt, 2);
  assert.notEqual(headlessProbeId(first), headlessProbeId(second));
  store.save('execution', { id: headlessProbeId(second), revision: 1, state: 'accepted', originNodeId: 'surface' });
  c(node, 'block-again', 'headless.block', { id: first.id, reason: 'readiness_timeout' });
  assert.throws(() => c(node, 'retry-unsettled', 'headless.request', { ...request, retry: true }), { code: 'headless_probe_unsettled' });
  assert.equal(store.all('agent').length, 1); assert.equal(store.all('schedule').length, 0);
});

test('a model success claim without actual native permission inspection never activates the schedule', async t => {
  const f = fixture(t), root = mkdtempSync('/tmp/opencode/setup-proof-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contractDirectory = join(root, '.opencode/skills/approved-job'); mkdirSync(contractDirectory, { recursive: true });
  writeFileSync(join(contractDirectory, 'SKILL.md'), 'Read fixture only');
  const grant = { ...f.grant, directory: root }, setup = { id: 'setup-proof', nodeId: 'surface', agentId: 'headless', directory: root, grantId: grant.id, state: 'requested', attempt: 1 };
  const journal = new NodeJournal(':memory:', { nodeId: 'surface', instanceId: 'backend' }); t.after(() => journal.close());
  const records = new NativeReceivers(journal);
  records.put(`headless-setup:${setup.id}`, setup);
  records.put(`headless-op:${setup.id}`, { phase: 'checking', deadline: Date.now() + 10000, contractDigest: digest('Read fixture only') });
  journal.save({ id: headlessProbeId(setup), state: 'native_finished', execution: { id: headlessProbeId(setup), state: 'completed' },
    invocation: { messageId: 'user' }, observation: { state: 'finished', outcome: 'succeeded', messageId: 'idle' } });
  const mutations = [];
  const api = async (method, path, body) => {
    if (method === 'POST') { mutations.push(body); return { id: setup.id, state: 'blocked' }; }
    return path.endsWith('/authority') ? { setup, grant } : { id: headlessProbeId(setup), state: 'completed' };
  };
  const client = { rpc: () => ({ check: async () => ({ allowed: true, accessDigest: 'refs', blocker: 'none' }) }) };
  const binding = { native: { snapshot: async () => ({ idle: true, inbox: [], messages: [
    { id: 'user', type: 'user' }, { id: 'assistant', type: 'assistant', content: [{ type: 'text', text: 'All access is verified.' },
      { type: 'tool', name: 'relay_work_submit', state: { status: 'completed' } }] }, { id: 'idle', type: 'idle', outcome: 'succeeded' },
  ] }) } };
  await tickHeadlessSetups(journal, api, { identityVersion: 2 }, () => assert.fail('No binding creation'), async () => binding, { native: async () => ({ client }) });
  assert.deepEqual(mutations.map(m => m.action), ['headless.block']);
  assert.equal(mutations[0].payload.reason, 'permissions_readiness_not_proven');
});
