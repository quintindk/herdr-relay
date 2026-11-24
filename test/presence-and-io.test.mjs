import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentDeletionPreview } from '../src/agent-lifecycle.mjs';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { digest } from '../src/protocol.mjs';
import { onlineRequester } from '../src/run-result-notifications.mjs';

const owner = { type: 'user', id: 'owner' }, node = { type: 'node', id: 'node' };
const machine = { hostname: 'desktop', platform: 'linux' };
const totalWrites = store => store.db.prepare('SELECT total_changes() AS n').get().n;
const count = (store, table) => store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const ledger = store => ['changes', 'receipts', 'entities'].map(table => count(store, table));
const persisted = (store, kind, id) => JSON.parse(store.db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get(kind, id).data);
const cursorAt = (store, after) => Buffer.from(JSON.stringify({ instance: store.instance, after })).toString('base64url');

function backend(t, path = ':memory:', { standing = false } = {}) {
  const store = new BackendStore(path); t.after(() => store.close());
  let key = 0;
  const command = (actor, action, payload) => store.command(actor, { key: `command:${++key}`, action, payload });
  command(owner, 'node.enrol', { id: 'node', name: 'Node' });
  const details = { id: 'agent', nodeId: 'node', directory: '/workspace', name: 'Agent' };
  if (standing) {
    command(owner, 'agent.enrol', details);
    command(owner, 'agent.attach', { id: 'agent', directory: details.directory, bindingId: 'binding', expectedBindingRevision: 0, conversationId: 'chat' });
  } else command(node, 'agent.register', { ...details, mode: 'interactive' });
  const heartbeat = (fields = {}) => command(node, 'node.heartbeat', { id: 'node', ...fields });
  const advertise = (fields = {}) => command(node, 'agent.advertise', { id: 'agent', availability: 'available',
    expectedRevision: store.get('agent', 'agent', true, true).revision, ...fields });
  return { store, command, heartbeat, advertise };
}

test('unchanged presence refreshes all read views and liveness guards without writes or write transactions', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T08:00:00Z') });
  const { store, heartbeat, advertise } = backend(t, ':memory:', { standing: true });
  const binding = { conversationId: 'chat', bindingRevision: 1 };
  const firstNode = heartbeat({ machine }), firstAgent = advertise(binding);
  const before = ledger(store), writes = totalWrites(store), transactions = t.mock.method(store, 'transaction');
  t.mock.timers.tick(16000);
  assert.equal(onlineRequester(store, { agentId: 'agent' }), null);
  assert.equal(agentDeletionPreview(store, store.get('agent', 'agent')).eligible, true);
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(1000);
    const nextNode = heartbeat(i ? {} : { machine: { platform: 'linux', hostname: 'desktop' } }), nextAgent = advertise(binding);
    for (const [kind, first, next] of [['node', firstNode, nextNode], ['agent', firstAgent, nextAgent]]) {
      assert.deepEqual(next, { ...first, lastSeenAt: new Date().toISOString() });
      assert.deepEqual(store.get(kind, next.id), next);
      assert.deepEqual(store.all(kind), [next]);
      assert.deepEqual(store.query(kind).items, [next]);
      assert.deepEqual(persisted(store, kind, next.id), first);
    }
    assert.deepEqual(onlineRequester(store, { agentId: 'agent' }), nextAgent);
    assert.deepEqual(agentDeletionPreview(store, nextAgent).blockers, [{ kind: 'agent_online', ids: ['agent'] }]);
  }
  assert.equal(transactions.mock.callCount(), 0);
  assert.deepEqual(ledger(store), before);
  assert.equal(totalWrites(store), writes);
  const { collections, presence } = store.snapshot();
  assert.deepEqual(collections.node, [firstNode]);
  assert.deepEqual(collections.agent, [firstAgent]);
  assert.deepEqual(presence, { nodes: { node: store.get('node', 'node').lastSeenAt }, agents: { agent: store.get('agent', 'agent').lastSeenAt } });
});

test('each durable presence field bumps revision once and persists across reopen without events or receipts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-presence-')), path = join(directory, 'backend.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { store, heartbeat, advertise } = backend(t, path);
  const before = ledger(store), writes = totalWrites(store);
  const updatedNode = heartbeat({ machine });
  assert.equal(updatedNode.revision, 2);
  assert.deepEqual(persisted(store, 'node', 'node'), updatedNode);
  let agent = store.get('agent', 'agent');
  for (const patch of [{ availability: 'available' }, { conversationId: 'chat' }, { bindingRevision: 1 }, { availability: 'busy' }]) {
    const previous = agent;
    agent = advertise({ availability: previous.availability, conversationId: previous.conversationId ?? undefined,
      bindingRevision: previous.bindingRevision ?? undefined, ...patch });
    assert.equal(agent.revision, previous.revision + 1);
    for (const [key, value] of Object.entries(patch)) assert.equal(agent[key], value);
    assert.deepEqual(persisted(store, 'agent', 'agent'), agent);
  }
  assert.deepEqual(ledger(store), before);
  assert.equal(totalWrites(store) - writes, 5);
  const reopened = new BackendStore(path);
  try {
    assert.deepEqual(reopened.get('node', 'node'), updatedNode);
    assert.deepEqual(reopened.get('agent', 'agent'), agent);
    assert.deepEqual(ledger(reopened), before);
  } finally { reopened.close(); }
});

test('presence and deletion retain validation and deleted agents never refresh', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T08:00:00Z') });
  const { store, command, heartbeat, advertise } = backend(t, ':memory:', { standing: true });
  const originalNode = heartbeat(), agent = advertise({ availability: 'offline', conversationId: 'chat', bindingRevision: 1 });
  const before = ledger(store), writes = totalWrites(store);
  t.mock.timers.tick(16000);
  assert.throws(() => store.command(node, { key: 'bad key', action: 'node.heartbeat', payload: { id: 'node' } }), { code: 'invalid_key' });
  assert.throws(() => command({ ...owner, scope: { kind: 'node_operator' } }, 'agent.advertise', { id: 'agent' }), { code: 'forbidden' });
  assert.throws(() => command({ type: 'node', id: 'other' }, 'node.heartbeat', { id: 'node' }), { code: 'forbidden' });
  assert.throws(() => heartbeat({ machine: { hostname: '' } }), { code: 'invalid_request' });
  assert.throws(() => advertise({ expectedRevision: agent.revision - 1 }), { code: 'stale_revision' });
  assert.throws(() => advertise({ availability: 'invented' }), { code: 'invalid_advertisement' });
  assert.throws(() => advertise({ conversationId: 'other' }), { code: 'conversation_adoption_required' });
  assert.throws(() => advertise({ conversationId: 'chat', bindingRevision: 2 }), { code: 'stale_binding' });
  const remove = expectedRevision => command(owner, 'agent.delete', { id: 'agent', expectedRevision, reason: 'Retired' });
  assert.throws(() => remove(agent.revision - 1), { code: 'stale_revision' });
  assert.equal(store.nodePresence.get('node'), originalNode.lastSeenAt);
  assert.equal(store.agentPresence.get('agent'), agent.lastSeenAt);
  assert.deepEqual(ledger(store), before);
  assert.equal(totalWrites(store), writes);

  const deleted = remove(agent.revision), afterDeletion = ledger(store);
  assert.equal(store.agentPresence.has('agent'), false);
  assert.equal(store.get('agent', 'agent', false), null);
  assert.deepEqual(advertise({ expectedRevision: agent.revision }), deleted);
  assert.throws(() => command({ type: 'node', id: 'other' }, 'agent.advertise', { id: 'agent', expectedRevision: 1, availability: 'offline' }), { code: 'forbidden' });
  assert.equal(store.agentPresence.has('agent'), false);
  assert.deepEqual(ledger(store), afterDeletion);
});

test('outer transaction rollback does not leak changed or unchanged presence and commit publishes it', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T08:00:00Z') });
  const { store, heartbeat, advertise } = backend(t);
  const firstNode = heartbeat({ machine }), firstAgent = advertise();
  const before = ledger(store);
  t.mock.timers.tick(1000);
  for (const change of [false, true]) {
    assert.throws(() => store.transaction(() => {
      heartbeat({ machine: change ? { hostname: 'different' } : machine });
      advertise({ availability: change ? 'busy' : 'available' });
      throw Error('rollback');
    }), /rollback/);
    assert.deepEqual(store.get('node', 'node'), firstNode);
    assert.deepEqual(store.get('agent', 'agent'), firstAgent);
    assert.deepEqual(ledger(store), before);
  }
  const [nextNode, nextAgent] = store.transaction(() => [heartbeat(), advertise()]);
  assert.notEqual(nextNode.lastSeenAt, firstNode.lastSeenAt);
  assert.notEqual(nextAgent.lastSeenAt, firstAgent.lastSeenAt);
  assert.deepEqual(store.get('node', 'node'), nextNode);
  assert.deepEqual(store.get('agent', 'agent'), nextAgent);
});

test('transaction-local presence immediately fences deletion and is discarded on rollback', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T08:00:00Z') });
  const { store, advertise, command } = backend(t);
  const stale = advertise();
  t.mock.timers.tick(16000);
  assert.equal(agentDeletionPreview(store, store.get('agent', 'agent')).eligible, true);
  assert.throws(() => store.transaction(() => {
    const fresh = advertise();
    assert.equal(fresh.revision, stale.revision);
    assert.deepEqual(store.get('agent', 'agent'), fresh);
    assert.throws(() => command(owner, 'agent.delete', { id: 'agent', expectedRevision: fresh.revision, reason: 'Remove' }), { code: 'agent_in_use' });
    throw Error('rollback');
  }), /rollback/);
  assert.deepEqual(store.get('agent', 'agent'), stale);
  assert.equal(agentDeletionPreview(store, store.get('agent', 'agent')).eligible, true);
});

test('snapshot recovery stays stable across heartbeats and separates mutable presence from immutable events', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T08:00:00Z') });
  const { store, advertise, heartbeat } = backend(t);
  const agentRecord = advertise(), nodeRecord = heartbeat({ machine });
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: store.instance });
  t.after(() => journal.close());
  const work = { id: 'work', state: 'pending', execution: { id: 'work', revision: 1 } };
  journal.save(work);
  t.mock.timers.tick(1000);
  const initialNode = heartbeat(), initialAgent = advertise();
  const first = store.snapshot(); journal.reconcileSnapshot(first);
  assert.deepEqual(journal.cached('node').map(row => row.entity), [initialNode]);
  assert.deepEqual(journal.cached('agent').map(row => row.entity), [initialAgent]);
  t.mock.timers.tick(1000);
  const liveNode = heartbeat(), liveAgent = advertise(), second = store.snapshot();
  assert.equal(JSON.stringify(first.collections), JSON.stringify(second.collections));
  assert.notDeepEqual(first.presence, second.presence);
  journal.reconcileSnapshot(second);
  assert.deepEqual(journal.cached('node').map(row => row.entity), [liveNode]);
  assert.deepEqual(journal.cached('agent').map(row => row.entity), [liveAgent]);
  assert.equal(count(journal, 'inbox'), 0);
  assert.equal(journal.cursor(), first.cursor);
  assert.deepEqual(journal.work(work.id), work);
  assert.throws(() => journal.reconcileSnapshot({ ...second, cursor: 'refused', collections: {
    ...second.collections, node: [nodeRecord], agent: [{ ...agentRecord, availability: 'offline' }],
  } }), { code: 'event_conflict' });
  assert.deepEqual(journal.cached('node').map(row => row.entity), [liveNode]);
  assert.equal(journal.cursor(), first.cursor);

  const task = { id: 'event', type: 'task.create', entityId: 'task', revision: 1, data: { id: 'task', revision: 1, title: 'Original' } };
  journal.consume({ items: [task], cursor: 'task-event' });
  assert.throws(() => journal.consume({ items: [{ ...task, data: { ...task.data, title: 'Different' } }], cursor: 'refused' }), { code: 'event_conflict' });
  assert.equal(journal.cursor(), 'task-event');
  assert.equal(count(journal, 'inbox'), 1);
});

test('compacted cursors retain the SQLite high-water mark and results use the real event sequence', async t => {
  const { store, command } = backend(t);
  const task = command(owner, 'task.create', { id: 'task', title: 'Task' });
  const execution = command(owner, 'execution.request', { id: 'exec', taskId: task.id, taskRevision: task.revision,
    targetAgentId: 'agent', instructions: 'Do work' });
  const admitted = command(node, 'execution.admit', { id: execution.id, expectedRevision: execution.revision, bindingId: 'binding', runId: 'run' });
  const intendedAt = '2026-11-24T08:00:00Z', scheduleId = 'schedule', id = `occurrence_${digest([scheduleId, intendedAt])}`;
  const schedule = command(owner, 'schedule.install', { id: scheduleId, definition: { nodeId: 'node', targetAgentId: 'agent',
    instructions: 'Scheduled work', at: intendedAt, enabled: true } });
  store.save('execution', { id, state: 'accepted', targetNodeId: 'node', localOccurrence: true, revision: 1 });
  store.db.prepare('UPDATE changes SET seq=10 WHERE seq=(SELECT MAX(seq) FROM changes)').run();
  store.db.prepare("UPDATE sqlite_sequence SET seq=5000 WHERE name='changes'").run();
  assert.equal(store.db.prepare('SELECT MAX(seq) AS seq FROM changes').get().seq, 10);
  assert.equal(store.highWaterSeq(), 5000);
  const cursor = cursorAt(store, 5000), journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: store.instance });
  t.after(() => journal.close());
  journal.reconcileSnapshot(store.snapshot());
  assert.equal(journal.cursor(), cursor);
  const poll = () => journal.poll(async (_method, path) => store.events({ cursor: new URL(path, 'http://relay').searchParams.get('cursor') }));
  await poll();
  assert.equal(journal.cursor(), cursor);
  assert.throws(() => store.events({ cursor: cursorAt(store, 5001) }), { code: 'invalid_cursor' });

  const evidence = { candidate: 'candidate', summary: 'Done', evidence: 'Observed result' };
  command(node, 'schedule.publish', { id, scheduleId, intendedAt, definitionRevision: schedule.revision, ...evidence });
  assert.equal(store.get('execution', id).result.sequence, 5001);
  const submitted = command(node, 'execution.submit', { id: execution.id, expectedRevision: admitted.revision, ...evidence });
  const submitEvent = store.db.prepare("SELECT seq FROM changes WHERE json_extract(data,'$.type')='execution.submit'").get();
  assert.equal(submitted.result.sequence, submitEvent.seq);
  await poll();
  assert.equal(journal.cursor(), cursorAt(store, store.highWaterSeq()));
  assert.equal(journal.work(execution.id).execution.result.sequence, submitEvent.seq);
});

test('idle journal polling does not open a write transaction or change settings', async t => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  t.after(() => journal.close());
  const page = { items: [], cursor: 'same' };
  journal.consume(page);
  const transactions = t.mock.method(journal, 'transaction'), before = totalWrites(journal);
  journal.consume(page);
  await journal.poll(async (method, path) => {
    assert.equal(method, 'GET'); assert.equal(path, '/v1/events?cursor=same');
    return page;
  });
  assert.equal(totalWrites(journal), before);
  assert.equal(transactions.mock.callCount(), 0);
  assert.throws(() => journal.consume({ ...page, items: [{}] }), { code: 'invalid_events' });
});

test('legacy presence events project current revisions without growing the journal inbox', t => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  t.after(() => journal.close());
  const event = (type, id, revision, patch) => ({ type, id: `${type}:${id}:${revision}`, entityId: id, revision,
    data: { id, nodeId: 'node', revision, ...patch } });
  const nodeEvent = event('node.heartbeat', 'node', 2, { machine, lastSeenAt: '2026-11-24T08:00:00Z' });
  const agentEvent = event('agent.advertise', 'agent', 2, { availability: 'busy', lastSeenAt: '2026-11-24T08:00:00Z' });
  journal.consume({ items: [nodeEvent, agentEvent], cursor: 'first' });
  assert.deepEqual(journal.cached('node').map(item => item.entity), [nodeEvent.data]);
  assert.deepEqual(journal.cached('agent').map(item => item.entity), [agentEvent.data]);
  const writes = totalWrites(journal);
  journal.consume({ items: [nodeEvent, agentEvent], cursor: 'first' });
  assert.equal(totalWrites(journal), writes);
  assert.throws(() => journal.consume({ items: [{ ...agentEvent, revision: 3 }], cursor: 'refused' }), { code: 'invalid_events' });
  const stale = event('node.heartbeat', 'node', 1, { machine: { hostname: 'stale' } });
  const equal = { ...agentEvent, data: { ...agentEvent.data, lastSeenAt: '2026-11-24T08:00:01Z' } };
  journal.consume({ items: [stale, equal], cursor: 'first' });
  assert.equal(totalWrites(journal) - writes, 1);
  assert.deepEqual(journal.cached('node').map(item => item.entity), [nodeEvent.data]);
  assert.deepEqual(journal.cached('agent').map(item => item.entity), [equal.data]);
  const beforeConflict = journal.cached('node');
  const valid = { ...nodeEvent, data: { ...nodeEvent.data, lastSeenAt: '2026-11-24T08:00:02Z' } };
  const conflict = { ...equal, data: { ...equal.data, availability: 'offline' } };
  assert.throws(() => journal.consume({ items: [valid, conflict], cursor: 'refused' }), { code: 'event_conflict' });
  assert.equal(journal.cursor(), 'first');
  assert.deepEqual(journal.cached('node'), beforeConflict);
  assert.deepEqual(journal.cached('agent').map(item => item.entity), [equal.data]);
  const deleted = event('agent.advertise', 'agent', 3, { deletedAt: '2026-11-24T08:00:00Z' });
  journal.consume({ items: [deleted], cursor: 'second' });
  assert.equal(journal.cursor(), 'second');
  assert.deepEqual(journal.cached('agent'), []);
  assert.throws(() => journal.assertReceiver({ agentId: 'agent' }), { code: 'agent_deleted' });
  assert.equal(count(journal, 'inbox'), 0);
  journal.consume({ items: [event('node.enrol', 'another', 1, {})], cursor: 'third' });
  assert.equal(count(journal, 'inbox'), 1);
});
