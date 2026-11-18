import assert from 'node:assert/strict';
import test from 'node:test';
import { accessReferences, checkHeadlessAccess, inspectHeadlessConnections } from '../headless-access.mjs';
import { headlessGrantInput } from '../headless-grant-tools.mjs';

function fixture() {
  const f = { integrationID: 'current-auth-client', active: { type: 'credential', id: 'current-sign-in' },
    models: [{ providerID: 'approved-provider', id: 'approved-model' }], lookups: [] };
  f.refs = { model: { providerID: 'approved-provider', id: 'approved-model', integrationID: 'old-auth-client', connectionId: 'old-sign-in' },
    permissions: { mcp: false, shell: false } };
  f.ctx = {
    session: { hook() {}, update() {} }, tool: { hook() {} },
    provider: { get: async ({ providerID }) => {
      assert.equal(providerID, 'approved-provider'); return { data: { integrationID: f.integrationID, settings: { apiKey: 'DO-NOT-EXPOSE' } } };
    } },
    integration: { connection: { active: async integrationID => {
      f.lookups.push(integrationID); assert.equal(integrationID, f.integrationID); return f.active;
    }, resolve: () => assert.fail('Never resolve credential values') } },
    credential: { list: () => assert.fail('Never enumerate credentials') },
    model: { list: async () => ({ data: f.models }) },
  };
  f.check = () => checkHeadlessAccess(f.ctx, f.refs);
  return f;
}

test('all grants follow repeated active sign-in and auth-client changes for their approved provider', async () => {
  const f = fixture(), expected = await f.check();
  assert.equal(expected.allowed, true);
  for (const [integrationID, connectionId] of [['current-auth-client', 'second-sign-in'], ['replacement-auth-client', 'third-sign-in']]) {
    f.integrationID = integrationID; f.active = { type: 'credential', id: connectionId };
    assert.deepEqual(await f.check(), expected);
    assert.equal(f.lookups.at(-1), integrationID);
  }
  assert.deepEqual(f.refs.model, { providerID: 'approved-provider', id: 'approved-model', integrationID: 'old-auth-client', connectionId: 'old-sign-in' });
  assert.doesNotMatch(JSON.stringify(expected), /DO-NOT-EXPOSE|sign-in|auth-client/);
});

test('provider/model-only grants need no connection pin, policy flag or coordinator', async () => {
  const f = fixture();
  f.refs.model = { providerID: 'approved-provider', id: 'approved-model' };
  assert.equal((await f.check()).allowed, true);
  assert.deepEqual(headlessGrantInput.properties.model.required, ['providerID', 'id']);
  assert.deepEqual(accessReferences({ ...f.refs, model: { ...f.refs.model, integrationID: 'obsolete', connectionId: 'obsolete' } }), f.refs);
});

test('the same provider can switch between OAuth/key credentials and its active environment connection', async () => {
  const f = fixture(), expected = await f.check();
  f.active = { type: 'env', name: 'PROVIDER_API_KEY' };
  assert.deepEqual(await f.check(), expected);
  f.active = { type: 'credential', id: 'new-oauth-connection', method: 'oauth' };
  assert.deepEqual(await f.check(), expected);
  f.active = { type: 'env', name: 'PROVIDER_API_KEY', status: { status: 'needs_auth' } };
  assert.equal((await f.check()).blocker, 'model_connection_unavailable');
});

test('connection discovery reports the active environment reference without reading its value', async () => {
  const f = fixture();
  f.active = { type: 'env', name: 'PROVIDER_API_KEY' };
  f.ctx.provider.list = async () => ({ data: [{ id: 'approved-provider', integrationID: f.integrationID }] });
  f.ctx.mcp = { list: async () => ({ data: [] }) };
  f.ctx.tool.list = async () => [];
  assert.deepEqual(await inspectHeadlessConnections(f.ctx), { models: [{ providerID: 'approved-provider', id: 'approved-model',
    integrationID: 'current-auth-client', connectionId: 'PROVIDER_API_KEY' }], servers: [] });
});

test('missing or unhealthy active authentication never falls back to another connection or provider', async () => {
  const f = fixture();
  for (const active of [null, { type: 'credential', id: 'broken', status: { type: 'needs_auth' } }, { type: 'environment', id: 'other' }]) {
    f.active = active;
    assert.equal((await f.check()).blocker, 'model_connection_unavailable');
  }
  f.integrationID = undefined;
  const lookups = f.lookups.length;
  assert.equal((await f.check()).blocker, 'model_connection_unavailable');
  assert.equal(f.lookups.length, lookups);
});

test('the approved model cannot be substituted with another provider or model', async () => {
  const f = fixture();
  for (const models of [[{ providerID: 'other-provider', id: 'approved-model' }], [{ providerID: 'approved-provider', id: 'other-model' }], []]) {
    f.models = models;
    assert.equal((await f.check()).blocker, 'model_unavailable');
  }
});

test('invalid permissions and unavailable native shell stay denied after a sign-in change', async () => {
  const f = fixture();
  f.refs.permissions = { mcp: false, shell: 'yes' };
  assert.equal((await f.check()).blocker, 'invalid_headless_permissions');
  f.refs.permissions = { mcp: false, shell: true };
  f.ctx.tool.list = async () => [];
  assert.equal((await f.check()).blocker, 'native_shell_unavailable');
});
