import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoOpenCodeDecisions } from '../src/upgrade-native-decisions.mjs';

function client({ forms = [], permissions = [] } = {}) {
  return { debug: { location: { list: async () => [{ directory: '/fixture' }] } },
    form: { list: async () => ({ data: forms }) }, permission: { request: { list: async () => ({ data: permissions }) } } };
}
test('plugin upgrade inspection reads pending native decisions without approving, cancelling or exposing their contents', async () => {
  const result = await assertNoOpenCodeDecisions({}, { clients: [client()] });
  assert.deepEqual(result, { servicesChecked: 1, locationsChecked: 1, pendingForms: 0, pendingPermissions: 0, outboxesChecked: 0 });
  for (const value of [client({ forms: [{ privateBody: 'must not appear in errors' }] }), client({ permissions: [{ privateBody: 'must not appear in errors' }] })]) {
    await assert.rejects(assertNoOpenCodeDecisions({}, { clients: [value] }), error => {
      assert.equal(error.code, 'upgrade_pending_decisions'); assert.doesNotMatch(error.message, /must not appear/); return true;
    });
  }
});
test('unavailable/unsupported native inspection is not counted as an empty success', async () => {
  const value = client(); value.form.list = async () => { throw Error('private response'); };
  await assert.rejects(assertNoOpenCodeDecisions({}, { clients: [value] }), error => {
    assert.equal(error.code, 'upgrade_plugin_state_unavailable'); assert.doesNotMatch(error.message, /private response/); return true;
  });
});
