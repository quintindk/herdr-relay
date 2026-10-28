import assert from 'node:assert/strict';
import test from 'node:test';
import { ingressCheckPassed } from '../src/backend-ingress.mjs';

test('ingress verification refuses origin authentication denial as proof of Access enforcement', () => {
  for (const name of ['unauthenticated', 'actor_only']) {
    assert.equal(ingressCheckPassed(name, { status: 401, relayDenied: true }), false);
    assert.equal(ingressCheckPassed(name, { status: 403, relayDenied: false }), true);
    assert.equal(ingressCheckPassed(name, { status: 200, protocol: 'relay/0.2' }), false);
  }
  assert.equal(ingressCheckPassed('access_only', { status: 401, relayDenied: true }), true);
  assert.equal(ingressCheckPassed('access_only', { status: 403, relayDenied: false }), false);
  assert.equal(ingressCheckPassed('access_and_actor', { status: 200, protocol: 'relay/0.2' }), true);
});
