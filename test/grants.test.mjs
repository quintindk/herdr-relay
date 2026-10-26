import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { bootstrapNode } from '../src/node-bootstrap.mjs';
import { issueGrantApprovalSession } from '../src/grants.mjs';
import { backendMaintenanceBlockers } from '../src/upgrade-safety.mjs';
import { NodeJournal } from '../src/node-journal.mjs';

function fixture(t) {
  const store = new BackendStore(':memory:'); t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token), actors = {}, operators = {};
  const command = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  for (const id of ['source', 'destination']) {
    const bundle = bootstrapNode(store, owner, { key: id, id, name: id, mode: 'roots', roots: ['/work'], maxAgents: 25 });
    actors[id] = store.authenticate(bundle.nodeToken); operators[id] = store.authenticate(bundle.operatorToken);
  }
  command(operators.source, 'agent', 'agent.enrol', { id: 'mason', name: 'Mason', nodeId: 'source', directory: '/work/project' });
  command(operators.source, 'attach', 'agent.attach', { id: 'mason', expectedBindingRevision: 0, conversationId: 'ses_mason', directory: '/work/project', bindingId: 'mason-binding' });
  const uiSession = issueGrantApprovalSession(store, operators.source, { terminalId: 'human-terminal' });
  const ui = store.authenticate(uiSession.token);
  const prepare = (id, extra = {}) => command(actors.source, `prepare-${id}`, 'interactive.request', { id, nodeId: 'destination', requesterAgentId: 'mason',
    sourceConversationId: 'ses_mason', sourceBindingRevision: 1, directory: `/work/${id}`, name: id, createDirectory: true, ...extra });
  const decide = (request, decision, extra = {}) => command(ui, `decision-${request.id}`, 'grant.request_decide', {
    id: request.id, expectedRevision: request.revision, requestHash: request.requestHash, decision, ...extra });
  return { store, owner, actors, operators, ui, uiSession, command, prepare, decide };
}

test('missing permission is durable normal state, not a provisioning effect, question or upgrade blocker', t => {
  const f = fixture(t), request = f.prepare('analysis');
  assert.equal(request.state, 'awaiting_approval'); assert.equal(request.permissionRequest, true);
  assert.equal(request.scope.maxAgents, 25, 'Default quota is the existing node-wide ceiling, not a hidden ten-agent cap');
  for (const kind of ['provision_request', 'provision_grant', 'execution', 'question', 'notification']) assert.equal(f.store.all(kind).length, 0);
  assert.equal(f.store.all('agent').length, 1); assert.deepEqual(backendMaintenanceBlockers(f.store.db), []);
  const journal = new NodeJournal(':memory:', { nodeId: 'destination', instanceId: f.store.instance }); t.after(() => journal.close());
  journal.reconcileSnapshot(f.store.snapshot());
  assert.equal(journal.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'interactive-request:%'").get().n, 0);
});

test('approve once atomically grants and resumes the exact saved request, with no duplicate on lost-reply replay', t => {
  const f = fixture(t), request = f.prepare('analysis');
  const approved = f.decide(request, 'approve_once');
  assert.equal(approved.state, 'approved'); assert.equal(approved.decision.decidedBy.type, 'human_tui');
  const provision = f.store.get('provision_request', request.id), grant = f.store.get('provision_grant', approved.grantId);
  assert.equal(provision.state, 'requested'); assert.equal(provision.approvalRequestId, request.id);
  assert.equal(grant.boundRequestId, request.id); assert.equal(grant.managed, true);
  assert.equal(provision.requesterNodeId, 'source'); assert.equal(provision.directory, request.directory);
  assert.deepEqual(f.decide(request, 'approve_once'), approved);
  assert.equal(f.store.all('provision_request').length, 1); assert.equal(f.store.all('provision_grant').length, 1);
  assert.equal(f.prepare('another').state, 'awaiting_approval', 'One-off approval is not a standing grant');
});

test('standing scope lets later matching preparations run without another request', t => {
  const f = fixture(t), request = f.prepare('analysis', { permissionScope: { roots: ['/work'], allowDispatch: true } });
  const approved = f.decide(request, 'allow_scope');
  assert.equal(f.store.get('provision_grant', approved.grantId).boundRequestId, undefined);
  const next = f.prepare('second');
  assert.equal(next.state, 'requested'); assert.equal(next.permissionRequest, undefined);
  assert.equal(f.store.all('grant_request').length, 1);
});

test('rejection resolves normally and changed previews or node-scope expansion cannot be approved', t => {
  const f = fixture(t), request = f.prepare('analysis');
  assert.throws(() => f.command(f.ui, 'bad-hash', 'grant.request_decide', { id: request.id, expectedRevision: 1, requestHash: 'changed', decision: 'approve_once' }), { code: 'stale_grant_request' });
  assert.throws(() => f.command(f.ui, 'outside', 'grant.request_decide', { id: request.id, expectedRevision: 1, requestHash: request.requestHash, decision: 'allow_scope', scope: { ...request.scope, roots: ['/outside'] } }), { code: 'grant_scope_outside_node' });
  const rejected = f.decide(request, 'reject', { reason: 'Use an existing agent' });
  assert.equal(rejected.state, 'rejected'); assert.equal(rejected.decision.reason, 'Use an existing agent');
  assert.equal(f.store.all('provision_grant').length, 0); assert.equal(f.store.all('provision_request').length, 0);
  assert.deepEqual(backendMaintenanceBlockers(f.store.db), []);
});

test('agent and generic node-operator commands cannot approve themselves or mint approval sessions', t => {
  const f = fixture(t), request = f.prepare('analysis');
  const payload = { id: request.id, expectedRevision: 1, requestHash: request.requestHash, decision: 'approve_once' };
  for (const actor of [f.actors.source, f.operators.source]) assert.throws(() => f.command(actor, 'self-approve', 'grant.request_decide', payload), { code: 'forbidden' });
  assert.throws(() => issueGrantApprovalSession(f.store, f.actors.source, { terminalId: 'agent' }), { code: 'forbidden' });
  assert.throws(() => f.command(f.ui, 'unrelated', 'node.enrol', { id: 'bad', name: 'Bad' }), { code: 'forbidden' });
});

test('human can create standing permission directly and it resumes matching pending operations', t => {
  const f = fixture(t), request = f.prepare('analysis');
  const grant = f.command(f.ui, 'create-standing', 'grant.create', { id: 'standing', requesterAgentId: 'mason', nodeId: 'destination', scope: { ...request.scope, roots: ['/work'] } });
  assert.deepEqual(grant.resumedRequestIds, [request.id]);
  assert.equal(f.store.get('grant_request', request.id).state, 'approved');
  assert.equal(f.store.get('provision_request', request.id).state, 'requested');
  const revoked = f.command(f.ui, 'revoke-standing', 'grant.revoke', { id: grant.id, kind: 'interactive', expectedRevision: 1 });
  assert.equal(revoked.state, 'revoked');
});

test('approval survives requester chat replacement without impersonating a new human message', t => {
  const f = fixture(t), request = f.prepare('analysis');
  f.command(f.operators.source, 'replace-chat', 'agent.attach', { id: 'mason', expectedBindingRevision: 1, conversationId: 'ses_new', directory: '/work/project', bindingId: 'new-binding' });
  f.decide(request, 'approve_once');
  const provision = f.store.get('provision_request', request.id);
  assert.equal(provision.sourceConversationId, 'ses_new');
  assert.equal(f.store.get('grant_request', request.id).operation.sourceConversationId, 'ses_mason');
});

test('saved request identity includes immutable preparation fields and requested permission scope', t => {
  const f = fixture(t), pending = f.prepare('analysis');
  for (const extra of [{ topic: 'Changed instructions' }, { instance: 'replace' }, { permissionScope: { roots: ['/work'] } }, { createDirectory: false }]) {
    assert.throws(() => f.command(f.actors.source, `changed-${Object.keys(extra)[0]}`, 'interactive.request', { ...pending.operation, ...extra }), { code: 'operation_conflict' });
  }
  f.decide(pending, 'approve_once');
  assert.equal(f.command(f.actors.source, 'same-after-approval', 'interactive.request', pending.operation).state, 'requested');
  assert.throws(() => f.command(f.actors.source, 'changed-after-approval', 'interactive.request', { ...pending.operation, topic: 'Different' }), { code: 'operation_conflict' });
  assert.equal(f.store.get('grant_request', pending.id).revision, 2, 'Approval is one request revision');
});

test('rejected and cancelled requests cannot be revived by a later matching grant or a new publication key', t => {
  const f = fixture(t), rejected = f.prepare('rejected'), cancelled = f.prepare('cancelled');
  f.decide(rejected, 'reject');
  f.command(f.actors.source, 'cancel', 'interactive.cancel', { id: cancelled.id, expectedRevision: 1, reason: 'Stop',
    requesterAgentId: 'mason', sourceConversationId: 'ses_mason', sourceBindingRevision: 1 });
  f.command(f.ui, 'new-scope', 'grant.create', { id: 'scope', requesterAgentId: 'mason', nodeId: 'destination', scope: { ...rejected.scope, roots: ['/work'] } });
  for (const original of [rejected, cancelled]) {
    const replay = f.command(f.actors.source, `retry-${original.id}`, 'interactive.request', original.operation);
    assert.equal(replay.state, original.id); assert.equal(f.store.get('provision_request', original.id, false), null);
  }
});

test('permission outcome snapshot recovery keeps one notice identity after delivery and later revisions', t => {
  const f = fixture(t), request = f.prepare('analysis'); f.decide(request, 'reject');
  const journal = new NodeJournal(':memory:', { nodeId: 'source', instanceId: f.store.instance }); t.after(() => journal.close());
  journal.reconcileSnapshot(f.store.snapshot());
  const rows = () => journal.db.prepare('SELECT * FROM notices').all();
  assert.equal(rows().length, 1); assert.equal(JSON.parse(rows()[0].data).kind, 'permission');
  const data = { ...JSON.parse(rows()[0].data), state: 'delivered' };
  journal.db.prepare('UPDATE notices SET state=?,data=? WHERE id=?').run(data.state, JSON.stringify(data), data.id);
  journal.reconcileSnapshot(f.store.snapshot());
  assert.equal(rows().length, 1); assert.equal(rows()[0].state, 'delivered');
});
