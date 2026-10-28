import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { reconcileScheduleDefinitions } from '../src/node-automation.mjs';

test('schedule transfer cannot activate until its source acknowledges fencing, then installs only on destination', async () => {
  const backend = new BackendStore(':memory:');
  const owner = backend.authenticate(backend.bootstrap().token);
  const cmd = (actor, action, payload) => backend.command(actor, { key: crypto.randomUUID(), action, payload });
  const nodes = ['a', 'b'].map(id => {
    cmd(owner, 'node.enrol', { id, name: id });
    const actor = backend.authenticate(backend.enrolCredential(owner, id, id).token);
    cmd(actor, 'agent.register', { id: `agent-${id}`, nodeId: id, name: id, mode: 'headless' });
    return actor;
  });
  const source = new NodeJournal(':memory:', { nodeId: 'a', instanceId: backend.instance });
  const target = new NodeJournal(':memory:', { nodeId: 'b', instanceId: backend.instance });
  try {
    let schedule = cmd(owner, 'schedule.install', { id: 'job', definition: { nodeId: 'a', targetAgentId: 'agent-a',
      instructions: 'Work', enabled: true, cron: '0 * * * *' } });
    source.consume(backend.events()); reconcileScheduleDefinitions(source);
    await source.flush(async (_m, _p, body) => backend.command(nodes[0], body));
    schedule = cmd(owner, 'schedule.transfer_request', { id: schedule.id, expectedRevision: schedule.revision, targetNodeId: 'b', targetAgentId: 'agent-b' });
    assert.throws(() => cmd(owner, 'schedule.transfer_activate', { id: schedule.id, expectedRevision: schedule.revision }), { code: 'source_not_fenced' });
    source.consume(backend.events()); reconcileScheduleDefinitions(source);
    assert.equal(JSON.parse(source.db.prepare('SELECT data FROM schedules').get().data).state, 'transferring');
    await source.flush(async (_m, _p, body) => backend.command(nodes[0], body));
    schedule = backend.get('schedule', 'job');
    assert.equal(schedule.transfer.state, 'fenced');
    schedule = cmd(owner, 'schedule.transfer_activate', { id: schedule.id, expectedRevision: schedule.revision });
    assert.equal(schedule.definition.nodeId, 'b');
    target.consume(backend.events()); reconcileScheduleDefinitions(target);
    assert.equal(JSON.parse(target.db.prepare('SELECT data FROM schedules').get().data).state, 'active');
  } finally { source.close(); target.close(); backend.close(); }
});
