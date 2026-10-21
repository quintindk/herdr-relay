import assert from 'node:assert/strict';
import test from 'node:test';
import { configureV2WorkerSession, v2WorkerInstructions } from '../src/node-worker-instructions.mjs';

test('v2 worker instructions use actual scoped tools without shell transport', () => {
  const instructions = v2WorkerInstructions({});
  assert.match(instructions, /relay_work_read/);
  assert.match(instructions, /relay_work_submit/);
  assert.match(instructions, /relay_work_ask/);
  assert.doesNotMatch(instructions, /node-worker-cli|--context|--file|relay_delegate|relay_review_child/);
  assert.match(instructions, /Do not claim a submission succeeded/);
});

test('session permissions are applied only from explicit validated operator configuration', async () => {
  const calls = [];
  const binding = { identity: { sessionId: 'exact-session' }, native: { client: {
    session: { update: async input => calls.push(input) },
  } } };
  await configureV2WorkerSession(binding);
  assert.equal(calls.length, 0);
  await assert.rejects(configureV2WorkerSession(binding, [{ action: '*', resource: '*', effect: 'typo' }]), { code: 'invalid_permissions' });
  assert.equal(calls.length, 0);
  const permissions = [{ action: '*', resource: '*', effect: 'deny' },
    { action: 'relay_work_read', resource: '*', effect: 'allow' },
    { action: 'relay_work_submit', resource: '*', effect: 'allow' }];
  await configureV2WorkerSession(binding, permissions);
  assert.deepEqual(calls, [{ sessionID: 'exact-session', permissions }]);
});

test('v2 delegation instructions remain conditional on execution grants', () => {
  assert.match(v2WorkerInstructions({ allowDelegation: true }), /relay_delegate/);
  assert.match(v2WorkerInstructions({ childExecutionIds: ['child'] }), /relay_children/);
});
