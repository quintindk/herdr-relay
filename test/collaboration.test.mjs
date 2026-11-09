import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickNode } from '../src/node-execution.mjs';
import { collaborationRequest, collaborationReceiptMatches } from '../src/collaboration.mjs';

function fixture(t, options = {}) {
  const store = new BackendStore(':memory:'), owner = store.authenticate(store.bootstrap().token);
  let serial = 0;
  const cmd = (actor, action, payload, key = `fixture-${++serial}`) => store.command(actor, { key, action, payload });
  const nodes = {}, journals = {}, sends = { a: [], b: [] };
  for (const id of ['a', 'b', 'other']) {
    cmd(owner, 'node.enrol', { id: `node-${id}`, name: id });
    nodes[id] = store.authenticate(store.enrolCredential(owner, `node-${id}`, `credential-${id}`).token);
    cmd(nodes[id], 'agent.register', { id, nodeId: `node-${id}`, name: id, mode: 'interactive' });
    if (id !== 'other') journals[id] = new NodeJournal(':memory:', { nodeId: `node-${id}`, instanceId: store.instance });
  }
  cmd(owner, 'task.create', { id: 'root', title: 'Collaborative work' });
  const root = cmd(owner, 'execution.request', { id: 'parent', taskId: 'root', taskRevision: 1, targetAgentId: 'a',
    instructions: 'Use the peer result to finish the goal', reviewPolicy: options.reviewPolicy ?? 'none', allowDelegation: true,
    collaboration: { peerAgentIds: ['b'], maxRounds: options.maxRounds ?? 2, timeoutSeconds: options.timeoutSeconds ?? 600 } });
  const f = { store, owner, nodes, journals, sends, cmd, root };
  f.api = id => async (method, path, body) => {
    if (method === 'POST') return store.command(nodes[id], body);
    const url = new URL(path, 'http://fixture');
    if (url.pathname === '/v1/info') return { instanceId: store.instance, protocol: 'relay/0.2' };
    if (url.pathname === '/v1/events') return store.events({ cursor: url.searchParams.get('cursor') ?? undefined });
    const [, , collection, entityId] = url.pathname.split('/');
    const kind = collection === 'executions' ? 'execution' : 'task';
    return entityId ? store.get(kind, entityId) : store.query(kind, { limit: Number(url.searchParams.get('limit') ?? 100), cursor: url.searchParams.get('cursor') ?? undefined });
  };
  f.bindings = Object.fromEntries(['a', 'b'].map(id => [id, { id: `binding-${id}`, agentId: id, identity: { sessionId: `session-${id}` },
    native: { snapshot: async () => ({ idle: true, inbox: [], messages: [] }), send: async invocation => {
      sends[id].push(invocation);
      const work = journals[id].works().find(work => work.invocation?.messageId === invocation.messageId);
      if (id === 'a') {
        if (sends.a.length === 1 || options.retryFailure && sends.a.length === 2) {
          const retry = sends.a.length > 1;
          f.child = cmd(nodes.a, 'execution.delegate', { id: retry ? 'retry-child' : 'child', parentExecutionId: work.id, expectedRevision: work.execution.revision,
            taskId: retry ? 'retry-peer-task' : 'peer-task', title: 'Peer check', instructions: 'Perform the bounded peer check', targetAgentId: 'b' }, retry ? 'delegate-retry' : 'delegate-once');
          if (options.prematureResult) journals.a.save({ ...work, staged: { kind: 'result', key: 'too-early', payload: { candidate: 'provisional', summary: 'Unverified provisional report' } } });
        } else journals.a.save({ ...work, staged: { kind: 'result', key: 'final', payload: { candidate: 'final-report', summary: 'Integrated actual peer outcome' } } });
      } else if (options.peerOutcome !== 'missing' || options.retryFailure && sends.b.length > 1) journals.b.save({ ...work, staged: { kind: 'result', key: 'peer-result',
        payload: { candidate: 'peer-report', summary: 'Peer check complete' } } });
    } }, observe: () => ({ state: 'finished', outcome: id === 'b' && options.peerOutcome === 'failed' ? 'failed' : 'succeeded',
      messageId: `terminal-${id}-${sends[id].length}` }) }]));
  f.tick = async id => tickNode(journals[id], f.api(id), async () => f.bindings[id]);
  f.run = async () => {
    for (let tick = 0; tick < 30 && !['completed', 'in_review', 'failed', 'cancelled'].includes(store.get('execution', root.id).state); tick++) {
      await f.tick('a'); await f.tick('b');
    }
    return store.get('execution', root.id);
  };
  t.after(() => { for (const journal of Object.values(journals)) journal.close(); store.close(); });
  return f;
}

test('collaboration request validates named peers and defaults to two bounded rounds', () => {
  assert.deepEqual(collaborationRequest({ peerAgentIds: ['b'] }), { peerAgentIds: ['b'], maxRounds: 2, timeoutSeconds: 600 });
  for (const input of [null, {}, { peerAgentIds: [] }, { peerAgentIds: ['b', 'b'] }, { peerAgentIds: ['wrong id'] },
    { peerAgentIds: ['b'], maxRounds: 0 }, { peerAgentIds: ['b'], maxRounds: 17 }, { peerAgentIds: ['b'], timeoutSeconds: 3601 },
    { peerAgentIds: ['b'], deadline: 'caller-controlled' }]) assert.throws(() => collaborationRequest(input), { code: 'invalid_collaboration' });
});

test('coordinator can use a remaining round after failure without reopening or hiding the failed attempt', async t => {
  const f = fixture(t, { peerOutcome: 'missing', retryFailure: true }), result = await f.run();
  assert.equal(result.state, 'completed'); assert.equal(f.sends.a.length, 3); assert.equal(f.sends.b.length, 2);
  assert.equal(f.store.get('execution', 'child').state, 'failed');
  assert.equal(f.store.get('execution', 'retry-child').state, 'completed');
  assert.equal(result.result.peerFailures[0].id, 'child');
  assert.equal(f.store.all('execution').filter(e => !e.parentExecutionId).length, 1);
});

test('a malformed or widened collaboration receipt cannot confirm a human handover', () => {
  const request = { peerAgentIds: ['b'], maxRounds: 2, timeoutSeconds: 600 }, created = '2026-11-09T10:00:00Z';
  const receipt = { ...request, deadline: '2026-11-09T10:10:00Z' };
  assert.equal(collaborationReceiptMatches(receipt, request, created), true);
  assert.equal(collaborationReceiptMatches({ ...receipt, maxRounds: 3 }, request, created), false);
  assert.equal(collaborationReceiptMatches({ ...receipt, peerAgentIds: ['other'] }, request, created), false);
  assert.equal(collaborationReceiptMatches({ ...receipt, deadline: '2026-11-09T10:11:00Z' }, request, created), false);
  assert.equal(collaborationReceiptMatches(receipt, request, undefined), false);
});

test('a workflow budget cannot be self-granted by a node or assigned to its own coordinator', t => {
  const f = fixture(t);
  f.cmd(f.owner, 'task.create', { id: 'another-task', title: 'Unrelated task' });
  const request = { id: 'another-run', taskId: 'another-task', taskRevision: 1, targetAgentId: 'a', instructions: 'Another goal',
    allowDelegation: true, collaboration: { peerAgentIds: ['b'] } };
  assert.throws(() => f.cmd(f.nodes.a, 'execution.request', request), { code: 'forbidden' });
  assert.throws(() => f.cmd(f.owner, 'execution.request', { ...request, collaboration: { peerAgentIds: ['a'] } }), { code: 'invalid_collaboration' });
  assert.throws(() => f.cmd(f.owner, 'execution.request', { ...request, allowDelegation: false }), { code: 'invalid_collaboration' });
});

test('coordinator delegates, automatically waits and resumes with a peer result under one execution', async t => {
  const f = fixture(t), result = await f.run();
  assert.equal(result.state, 'completed'); assert.equal(f.sends.a.length, 2); assert.equal(f.sends.b.length, 1);
  assert.equal(f.store.get('execution', 'child').state, 'completed');
  assert.equal(f.journals.a.work('parent').children[0].result.candidate, 'peer-report');
  assert.match(f.sends.a[1].prompt, /Peer outcomes for this job/);
  assert.equal(f.store.get('task', 'root').status, 'done');
  assert.equal(f.store.all('execution').filter(e => !e.parentExecutionId).length, 1);
});

for (const peerOutcome of ['failed', 'missing']) test(`a ${peerOutcome} peer resumes the coordinator with failure evidence instead of stalling`, async t => {
  const f = fixture(t, { peerOutcome }), result = await f.run();
  assert.equal(result.state, 'completed'); assert.equal(f.sends.a.length, 2); assert.equal(f.sends.b.length, 1);
  const child = f.store.get('execution', 'child');
  assert.equal(child.state, 'failed'); assert.equal(f.store.get('task', child.taskId).status, 'blocked');
  assert.equal(f.journals.a.work('parent').children[0].state, 'failed');
  assert.equal(result.result.peerFailures[0].id, child.id);
  assert.match(f.sends.a[1].prompt, peerOutcome === 'missing' ? /without a result or clarification/ : /failed/);
  assert.equal(child.result, undefined, 'Failure is not a fabricated successful peer result');
});

test('a provisional final report waits for pending peers and is preserved without publication', async t => {
  const f = fixture(t, { prematureResult: true }), result = await f.run();
  assert.equal(result.result.candidate, 'final-report');
  assert.equal(f.journals.a.work('parent').provisionalOutcomes[0].payload.candidate, 'provisional');
  assert.equal(f.journals.a.work('parent').provisionalOutcomes[0].reason, 'peer_results_pending');
});

test('human final review does not require human approval of an ordinary internal peer check', async t => {
  const f = fixture(t, { reviewPolicy: 'human' }), result = await f.run();
  assert.equal(result.state, 'in_review'); assert.equal(f.sends.a.length, 2);
  assert.equal(f.store.get('execution', 'child').reviewPolicy, 'none');
  assert.equal(f.store.get('execution', 'child').state, 'completed');
  assert.throws(() => f.cmd(f.nodes.a, 'execution.review', { id: result.id, expectedRevision: result.revision,
    candidate: result.result.candidate, decision: 'accept', reason: 'Self approval' }), { code: 'forbidden' });
});

test('named-peer and round limits are enforced and original-key retries consume no extra budget', async t => {
  const f = fixture(t, { maxRounds: 1 });
  const parent = f.cmd(f.nodes.a, 'execution.admit', { id: f.root.id, expectedRevision: f.root.revision, bindingId: 'binding-a', runId: 'initial-run' });
  const payload = { id: 'bounded-peer', parentExecutionId: parent.id, expectedRevision: parent.revision, taskId: 'bounded-task',
    title: 'Check', instructions: 'Check', targetAgentId: 'b' };
  const first = f.cmd(f.nodes.a, 'execution.delegate', payload, 'peer-once');
  assert.deepEqual(f.cmd(f.nodes.a, 'execution.delegate', payload, 'peer-once'), first);
  assert.throws(() => f.cmd(f.nodes.a, 'execution.delegate', { ...payload, id: 'wrong-peer', taskId: 'wrong-task', targetAgentId: 'other' }), { code: 'collaboration_peer_not_allowed' });
  assert.throws(() => f.cmd(f.nodes.a, 'execution.delegate', { ...payload, id: 'too-many', taskId: 'too-many-task' }), { code: 'collaboration_round_limit' });
  assert.equal(f.store.all('execution').length, 2);
  assert.throws(() => f.cmd(f.nodes.b, 'execution.delegate', { ...payload, parentExecutionId: first.id, expectedRevision: first.revision }), { code: 'delegation_not_authorised' });
  assert.throws(() => f.cmd(f.nodes.other, 'execution.delegate', { ...payload, id: 'foreign', taskId: 'foreign-task' }), { code: 'forbidden' });
});

test('deadline requests cancellation of the bounded job and its unstarted peers without replay', async t => {
  const f = fixture(t, { timeoutSeconds: 1 });
  await f.tick('a'); await f.tick('a');
  await new Promise(resolve => setTimeout(resolve, 1100));
  await f.tick('a'); await f.tick('a');
  assert.equal(f.store.get('execution', 'child').state, 'cancelled');
  assert.equal(f.store.get('execution', 'child').cancellationRequested, true);
  assert.equal(f.store.get('execution', f.root.id).state, 'cancelled');
  assert.equal(f.sends.b.length, 0); assert.equal(f.sends.a.length, 1);
});

test('human cancellation of a collaborative job stops new peer work', async t => {
  const f = fixture(t);
  await f.tick('a'); await f.tick('a');
  const parent = f.store.get('execution', f.root.id);
  f.cmd(f.owner, 'execution.cancel', { id: parent.id, expectedRevision: parent.revision, reason: 'Stop this job' });
  assert.equal(f.store.get('execution', 'child').state, 'cancelled');
  await f.tick('a');
  assert.equal(f.sends.b.length, 0);
});

test('cancellation never discards a peer result already returned', async t => {
  const f = fixture(t);
  await f.tick('a'); await f.tick('a'); await f.tick('b'); await f.tick('b');
  const child = f.store.get('execution', 'child'), parent = f.store.get('execution', f.root.id);
  assert.equal(child.state, 'completed');
  f.cmd(f.owner, 'execution.cancel', { id: parent.id, expectedRevision: parent.revision, reason: 'Stop this job' });
  assert.deepEqual(f.store.get('execution', child.id), child);
});
