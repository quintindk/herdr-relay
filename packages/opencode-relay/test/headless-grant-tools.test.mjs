import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHeadlessGrantTools } from '../headless-grant-tools.mjs';

test('plugin grant methods use the existing agent connector, not CLI or owner context', async () => {
  const tools = [], calls = [], worker = { sessionId: 'session', agentId: 'coordinator', token: 'fixture' };
  registerHeadlessGrantTools({ add: tool => tools.push(tool) }, { options: {} }, {
    connection: (_options, sessionId) => { assert.equal(sessionId, 'session'); return worker; },
    request: async (...args) => { calls.push(args); return { state: 'recorded', receipt: { state: 'active' } }; },
  });
  const grant = tools.find(tool => tool.name === 'relay_headless_grant');
  assert.equal(grant.input.properties.payload.required.includes('requesterAgentId'), false);
  assert.equal(grant.input.properties.payload.required.includes('nodeId'), false);
  const input = { key: 'once', payload: { id: 'grant' } };
  await grant.execute(input, { sessionID: 'session' });
  assert.deepEqual(calls[0], [worker, 'POST', '/agent/headless-grant', input]);
  await tools.find(tool => tool.name === 'relay_headless_revoke').execute({ key: 'revoke', payload: { id: 'grant', expectedRevision: 1 } }, { sessionID: 'session' });
  assert.equal(calls[1][2], '/agent/headless-revoke');
});
