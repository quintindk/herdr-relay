import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';

test('invalid cron and reminder execution settings are refused before schedule/event creation', () => {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  store.command(owner, { key: 'node', action: 'node.enrol', payload: { id: 'node', name: 'Node' } });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  store.command(node, { key: 'agent', action: 'agent.register', payload: { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' } });
  try {
    assert.throws(() => store.command(owner, { key: 'invalid', action: 'schedule.install', payload: { id: 'bad', definition: {
      nodeId: 'node', targetAgentId: 'agent', instructions: 'Work', enabled: true, cron: '@daily',
    } } }), { code: 'invalid_cron' });
    assert.equal(store.get('schedule', 'bad', false), null);
    assert.throws(() => store.command(owner, { key: 'reminder', action: 'schedule.install', payload: { id: 'bad-reminder', definition: {
      nodeId: 'node', targetAgentId: 'agent', intent: 'reminder', instructions: 'Remember', enabled: true, at: '2026-10-21T06:00:00Z',
    } } }), { code: 'invalid_schedule' });
  } finally { store.close(); }
});
