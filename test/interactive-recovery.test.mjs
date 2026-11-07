import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { bootstrapNode } from '../src/node-bootstrap.mjs';
import { issueGrantApprovalSession, interactiveGrantCovers } from '../src/grants.mjs';
import { interactiveAuthority } from '../src/interactive-contract.mjs';
import { interactiveRepairPreview } from '../src/interactive-repair.mjs';
import { nodeEnrolmentUsage } from '../src/interactive-capacity.mjs';
import { buildGrantsView } from '../src/grants-view.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { definitivePublicationRefusal } from '../src/publication-outcomes.mjs';

function fixture(t, { ceiling = 13, existing = 12 } = {}) {
  const store = new BackendStore(':memory:'); t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token), nodes = {}, operators = {};
  let sequence = 0;
  const command = (actor, action, payload, key = `test-${++sequence}`) => store.command(actor, { key, action, payload });
  for (const id of ['source', 'destination']) {
    const bundle = bootstrapNode(store, owner, { key: id, id, name: id, mode: 'roots', roots: ['/work'], maxAgents: id === 'source' ? 100 : ceiling });
    nodes[id] = store.authenticate(bundle.nodeToken); operators[id] = store.authenticate(bundle.operatorToken);
  }
  command(operators.source, 'agent.enrol', { id: 'source-agent', name: 'Source', nodeId: 'source', directory: '/work/game' });
  command(operators.source, 'agent.attach', { id: 'source-agent', expectedBindingRevision: 0, conversationId: 'ses_source', bindingId: 'source-binding', directory: '/work/game' });
  for (let i = 0; i < existing; i++) command(operators.destination, 'agent.enrol', { id: `existing-${i}`, nodeId: 'destination', name: `Existing ${i}`, directory: `/work/existing-${i}` });
  const ui = store.authenticate(issueGrantApprovalSession(store, operators.source, { terminalId: 'human' }).token);
  const source = { requesterAgentId: 'source-agent', sourceConversationId: 'ses_source', sourceBindingRevision: 1 };
  const scope = { mode: 'roots', roots: ['/work/lab'], profiles: ['build'], maxAgents: ceiling, allowNewEnrolments: true,
    allowCreateDirectories: true, allowReplacement: false, allowDispatch: true, reviewPolicy: 'human' };
  const grant = (id, changes = {}) => command(ui, 'grant.create', { id, requesterAgentId: source.requesterAgentId, nodeId: 'destination', scope: { ...scope, ...changes } });
  const prepare = (id, extra = {}) => command(nodes.source, 'interactive.request', { id, nodeId: 'destination', directory: '/work/lab', name: id, createDirectory: true, ...source, ...extra });
  const approve = request => command(ui, 'grant.request_decide', { id: request.id, expectedRevision: request.revision, requestHash: request.requestHash, decision: 'approve_once' });
  const reserve = request => command(nodes.destination, 'interactive.reserve', { id: request.id, expectedRevision: store.get('provision_request', request.id).revision });
  const checkpoint = { protocol: 1, safe: true, phase: 'initial', unresolved: [] };
  const block = request => {
    let current = store.get('provision_request', request.id);
    current = command(nodes.destination, 'interactive.progress', { id: current.id, expectedRevision: current.revision, state: 'blocked', reason: 'agent_limit' });
    return command(nodes.destination, 'interactive.repair_checkpoint', { id: current.id, expectedRevision: current.revision, checkpoint });
  };
  const repair = (request, changes = {}, key) => {
    const preview = interactiveRepairPreview(store, owner, { id: request.id, scope: { ...scope, ...changes } });
    const payload = { id: `repair-${request.id}`, preparationId: request.id, expectedRevision: preview.expectedRevision,
      scope: preview.scope, previewHash: preview.previewHash };
    return { preview, payload, permission: command(ui, 'grant.repair_request', payload, key) };
  };
  return { store, owner, nodes, operators, ui, command, source, scope, grant, prepare, approve, reserve, block, repair, checkpoint };
}

test('a corrected ceiling queues new approval instead of reusing the approved one-agent node ceiling', t => {
  const f = fixture(t), original = f.prepare('original', { permissionScope: { ...f.scope, maxAgents: 1 } });
  f.command(f.ui, 'grant.request_decide', { id: original.id, expectedRevision: 1, requestHash: original.requestHash, decision: 'allow_scope' });
  const corrected = f.prepare('corrected', { permissionScope: f.scope });
  assert.equal(corrected.state, 'awaiting_approval'); assert.equal(corrected.scope.maxAgents, 13);
  assert.equal(corrected.grantSelection.selectedGrantId, null);
  assert.ok(corrected.grantSelection.considered[0].reasons.includes('node_ceiling_below_requested'));
  assert.equal(f.store.get('provision_request', corrected.id, false), null);
  assert.equal(f.store.all('grant_request').length, 2);
});

test('missing dispatch, roots, profiles, expiry and review requirements are not silently swallowed', t => {
  const f = fixture(t), grant = f.grant('standing', { allowDispatch: false });
  const request = f.prepare('needs-dispatch', { permissionScope: { allowDispatch: true } });
  assert.equal(request.state, 'awaiting_approval'); assert.ok(request.grantSelection.considered[0].reasons.includes('allowDispatch_not_permitted'));
  const operation = { id: 'one', nodeId: 'destination', requesterAgentId: 'source-agent', directory: '/work/lab', name: 'One' };
  for (const permissionScope of [{ roots: ['/work'] }, { profiles: ['plan'] }, { reviewPolicy: 'none' }])
    assert.equal(interactiveGrantCovers(grant, { ...operation, permissionScope }), false);
  assert.equal(interactiveGrantCovers({ ...grant, expiresAt: new Date(Date.now() + 10000).toISOString() },
    { ...operation, permissionScope: { expiresAt: new Date(Date.now() + 60000).toISOString() } }), false);
  assert.throws(() => f.prepare('explicit', { grantId: grant.id, permissionScope: { allowDispatch: true } }), { code: 'provisioning_grant_insufficient' });
  assert.equal(f.store.get('provision_request', 'explicit', false), null);
});

test('overlapping grants select a sufficient permission regardless of the first grant in storage order', t => {
  const f = fixture(t); f.grant('a-insufficient', { maxAgents: 1, allowDispatch: false }); f.grant('z-sufficient');
  const request = f.prepare('match', { permissionScope: f.scope });
  assert.equal(request.state, 'requested'); assert.equal(request.grantId, 'z-sufficient');
  assert.equal(request.grantSelection.selectedGrantRevision, 1);
});

test('a new standing grant does not auto-resume requests needing capabilities it lacks', t => {
  const f = fixture(t), request = f.prepare('needs-dispatch', { permissionScope: { allowDispatch: true } });
  f.grant('discussion-only', { allowDispatch: false });
  assert.equal(f.store.get('grant_request', request.id).state, 'awaiting_approval');
  assert.equal(f.store.get('provision_request', request.id, false), null);
});

test('one-off approval can correct the node-wide ceiling without granting a reusable scope', t => {
  const f = fixture(t), request = f.prepare('once', { permissionScope: { maxAgents: 1 } });
  const approval = f.command(f.ui, 'grant.request_decide', { id: request.id, expectedRevision: 1, requestHash: request.requestHash,
    decision: 'approve_once', scope: { maxAgents: 13 } });
  const grant = f.store.get('provision_grant', approval.grantId);
  assert.equal(grant.maxAgents, 13); assert.equal(grant.boundRequestId, request.id);
  assert.equal(f.reserve(f.store.get('provision_request', request.id)).admission.state, 'reserved');
  assert.equal(f.prepare('another').state, 'awaiting_approval');
});

test('competing preparations reserve the final slot once and ordinary enrolment cannot take it', t => {
  const f = fixture(t); f.grant('standing', { roots: ['/work'] });
  const first = f.prepare('first', { directory: '/work/first' }), second = f.prepare('second', { directory: '/work/second' });
  const reserved = f.reserve(first), waiting = f.reserve(second);
  assert.equal(reserved.admission.state, 'reserved'); assert.equal(waiting.state, 'waiting_capacity');
  assert.equal(nodeEnrolmentUsage(f.store, 'destination').used, 13);
  for (const actor of [f.owner, f.operators.destination]) assert.throws(() => f.command(actor, 'agent.enrol', {
    id: `steal-${actor.credentialId}`, nodeId: 'destination', directory: '/work/steal', name: 'Steal' }), { code: 'agent_limit' });
  const agent = f.command(f.nodes.destination, 'interactive.enrol', { id: first.id }, 'enrol-first');
  assert.equal(agent.id, first.agentId); assert.equal(f.store.get('provision_request', first.id).admission.state, 'consumed');
  assert.equal(nodeEnrolmentUsage(f.store, 'destination').used, 13);
  assert.deepEqual(f.command(f.nodes.destination, 'interactive.enrol', { id: first.id }, 'enrol-first'), agent);
  assert.equal(f.store.all('agent').filter(a => a.nodeId === 'destination').length, 13);
});

test('a reservation under a lower grant ceiling is protected from a broader competing grant', t => {
  const f = fixture(t, { ceiling: 25 }); f.grant('low', { maxAgents: 13, roots: ['/work'] }); f.grant('high', { maxAgents: 25, roots: ['/work'] });
  const first = f.prepare('first', { grantId: 'low', directory: '/work/first' }), second = f.prepare('second', { grantId: 'high', directory: '/work/second' });
  f.reserve(first); assert.equal(f.reserve(second).state, 'waiting_capacity');
  f.command(f.nodes.destination, 'interactive.enrol', { id: first.id });
  assert.equal(f.reserve(f.store.get('provision_request', second.id)).admission.state, 'reserved');
});

test('lost reservation replies reconcile the original key rather than reserving another slot', t => {
  const f = fixture(t); f.grant('standing'); const request = f.prepare('reservation');
  const payload = { id: request.id, expectedRevision: request.revision };
  const receipt = f.command(f.nodes.destination, 'interactive.reserve', payload, 'original-reservation');
  assert.deepEqual(f.command(f.nodes.destination, 'interactive.reserve', payload, 'original-reservation'), receipt);
  assert.equal(nodeEnrolmentUsage(f.store, 'destination').reserved, 1);
  assert.throws(() => f.command(f.nodes.destination, 'interactive.reserve', { ...payload, localCeiling: 1 }, 'original-reservation'), { code: 'operation_conflict' });
});

test('uncertain creation retains capacity until node inspection proves a terminal fence and no enrolment', t => {
  const f = fixture(t); f.grant('standing'); const request = f.prepare('uncertain'); f.reserve(request);
  let current = f.store.get('provision_request', request.id);
  current = f.command(f.nodes.destination, 'interactive.progress', { id: current.id, expectedRevision: current.revision, state: 'uncertain', reason: 'native_create_uncertain' });
  current = f.command(f.owner, 'interactive.cancel', { id: current.id, expectedRevision: current.revision, reason: 'Stop' });
  assert.equal(current.admission.state, 'reserved');
  current = f.command(f.nodes.destination, 'interactive.repair_checkpoint', { id: current.id, expectedRevision: current.revision,
    checkpoint: { ...f.checkpoint, safe: false, unresolved: ['native_create_uncertain'] } });
  assert.equal(current.admission.state, 'reserved');
  current = f.command(f.nodes.destination, 'interactive.repair_checkpoint', { id: current.id, expectedRevision: current.revision, checkpoint: f.checkpoint });
  assert.equal(current.admission.state, 'released'); assert.equal(nodeEnrolmentUsage(f.store, 'destination').reserved, 0);
});

test('old drivers are fenced before provisioning and leave a recoverable upgrade wait', t => {
  const f = fixture(t); f.grant('standing'); const request = f.prepare('upgrade');
  assert.throws(() => interactiveAuthority(f.store, f.nodes.destination, request.id), { code: 'interactive_node_upgrade_required' });
  const waiting = f.command(f.nodes.destination, 'interactive.progress', { id: request.id, expectedRevision: request.revision,
    state: 'blocked', reason: 'interactive_node_upgrade_required' });
  assert.equal(waiting.state, 'waiting_node_upgrade');
  assert.equal(interactiveAuthority(f.store, f.nodes.destination, request.id, { driverProtocol: 1 }).request.state, 'waiting_node_upgrade');
  assert.throws(() => f.command(f.nodes.destination, 'interactive.enrol', { id: request.id }), { code: 'interactive_admission_required' });
  assert.equal(f.store.all('agent').filter(a => a.nodeId === 'destination').length, 12);
});

test('linked repair retains the original identity, task, immutable keys and blocked history', t => {
  const f = fixture(t); f.grant('wrong', { maxAgents: 1 }); const original = f.prepare('lab', { grantId: 'wrong' }); f.block(original);
  const task = f.command(f.owner, 'task.create', { id: 'captured', title: 'Existing compatibility task' });
  const repair = f.repair(original, {}, 'repair-key'); f.approve(repair.permission);
  const resumed = f.store.get('provision_request', original.id);
  for (const field of ['id', 'agentId', 'desiredSessionId', 'directory', 'intentHash', 'permissionScopeHash']) assert.deepEqual(resumed[field], original[field]);
  assert.equal(resumed.repairHistory[0].state, 'blocked'); assert.equal(resumed.repairHistory[0].reason, 'agent_limit');
  assert.equal(resumed.repair.requestId, repair.permission.id); assert.equal(resumed.state, 'requested');
  assert.equal(f.store.get('provision_grant', 'wrong').maxAgents, 1);
  assert.equal(f.store.get('provision_grant', resumed.grantId).boundRequestId, original.id);
  assert.deepEqual(f.store.get('task', task.id), task); assert.equal(f.store.all('execution').length, 0);
  assert.deepEqual(f.command(f.ui, 'grant.repair_request', repair.payload, 'repair-key'), repair.permission);
  assert.equal(f.store.all('provision_request').length, 1);
});

test('repair never bypasses unresolved effects, stale previews, pending approval or node workspace policy', t => {
  const f = fixture(t); f.grant('wrong', { maxAgents: 1 }); const original = f.prepare('lab', { grantId: 'wrong' }); f.block(original);
  assert.throws(() => f.repair(original, { roots: ['/outside'] }), { code: 'grant_scope_outside_node' });
  const preview = interactiveRepairPreview(f.store, f.owner, { id: original.id });
  const current = f.store.get('provision_request', original.id);
  f.command(f.nodes.destination, 'interactive.repair_checkpoint', { id: current.id, expectedRevision: current.revision,
    checkpoint: { ...f.checkpoint, safe: false, unresolved: ['workspace_create_uncertain'] } });
  assert.throws(() => f.command(f.ui, 'grant.repair_request', { id: 'stale', preparationId: original.id, expectedRevision: preview.expectedRevision,
    scope: preview.scope, previewHash: preview.previewHash }), { code: 'stale_repair_preview' });
  assert.equal(interactiveRepairPreview(f.store, f.owner, { id: original.id }).reason, 'unresolved_provisioning_effects');
  const latest = f.store.get('provision_request', original.id);
  f.command(f.nodes.destination, 'interactive.repair_checkpoint', { id: latest.id, expectedRevision: latest.revision, checkpoint: f.checkpoint });
  const repair = f.repair(original);
  assert.equal(interactiveRepairPreview(f.store, f.owner, { id: original.id }).reason, 'repair_approval_pending');
  f.command(f.ui, 'grant.revoke', { id: 'wrong', kind: 'interactive', expectedRevision: 1 });
  assert.throws(() => f.approve(repair.permission), { code: 'stale_repair_preview' });
  assert.equal(f.store.all('provision_grant').length, 1, 'Stale approval rolls back the newly minted grant');
});

test('requesters cannot approve their own repair or change another requester preparation', t => {
  const f = fixture(t); f.grant('wrong', { maxAgents: 1 }); const original = f.prepare('lab', { grantId: 'wrong' }); f.block(original);
  const preview = interactiveRepairPreview(f.store, f.nodes.source, { id: original.id, ...f.source });
  const permission = f.command(f.nodes.source, 'interactive.repair_request', { id: 'agent-repair', preparationId: original.id,
    expectedRevision: preview.expectedRevision, scope: preview.scope, previewHash: preview.previewHash, ...f.source });
  for (const actor of [f.nodes.source, f.operators.source]) assert.throws(() => f.command(actor, 'grant.request_decide', {
    id: permission.id, expectedRevision: permission.revision, requestHash: permission.requestHash, decision: 'approve_once' }), { code: 'forbidden' });
  assert.throws(() => interactiveRepairPreview(f.store, f.nodes.destination, { id: original.id, ...f.source }), { code: 'forbidden' });
});

test('cancelling an already-blocked preparation is an explicit no-op and does not erase failure evidence', t => {
  const f = fixture(t); f.grant('wrong', { maxAgents: 1 }); const original = f.prepare('lab', { grantId: 'wrong' }); const blocked = f.block(original);
  const result = f.command(f.nodes.source, 'interactive.cancel', { id: blocked.id, expectedRevision: blocked.revision, reason: 'Replace blocked request', ...f.source });
  assert.equal(result.cancellation.disposition, 'already_terminal'); assert.equal(result.cancellation.applied, false);
  assert.deepEqual(f.store.get('provision_request', blocked.id), blocked);
});

test('Grants links and searches permissions by the lab agent and originating preparation, not just the requester', t => {
  const f = fixture(t); const pending = f.prepare('uwb-lab', { permissionScope: { maxAgents: 1 } });
  const approval = f.command(f.ui, 'grant.request_decide', { id: pending.id, expectedRevision: 1, requestHash: pending.requestHash, decision: 'allow_scope' });
  f.block(f.store.get('provision_request', pending.id));
  const view = buildGrantsView({ requests: f.store.all('grant_request'), decisions: f.store.all('grant_decision'),
    grants: { interactive: f.store.all('provision_grant') }, preparations: f.store.all('provision_request'), agents: f.store.all('agent'), nodes: f.store.all('node'), userId: 'owner' });
  const active = view.active.find(item => item.entityId === approval.grantId);
  assert.match(active.title, /uwb-lab/); assert.match(active.searchText, /uwb-lab/); assert.equal(active.canRevoke, true);
  assert.equal(active.repairTargets[0].id, pending.id); assert.match(active.limits, /Node-wide enrolment ceiling: 1/);
  assert.ok(view.history.some(item => item.kind === 'interactive_preparation' && item.entityId === pending.id));
});

test('new preparation IDs cannot duplicate a blocked or still-pending agent/workspace intent', t => {
  const f = fixture(t), pending = f.prepare('original', { name: 'Lab' });
  assert.throws(() => f.prepare('duplicate-pending', { name: 'Lab' }), { code: 'preparation_approval_pending' });
  f.approve(pending); f.block(f.store.get('provision_request', pending.id));
  assert.throws(() => f.prepare('duplicate-blocked', { name: 'Lab', permissionScope: f.scope }), { code: 'preparation_repair_required' });
  assert.equal(f.store.all('provision_request').length, 1);
});

test('ordinary operator capacity checks and enrolment run in the same backend transaction', t => {
  const f = fixture(t), all = f.store.all.bind(f.store);
  let checked = false;
  f.store.all = kind => {
    if (kind === 'agent') { checked = true; assert.equal(f.store.inTransaction, true); }
    return all(kind);
  };
  f.command(f.operators.destination, 'agent.enrol', { id: 'last', nodeId: 'destination', name: 'Last', directory: '/work/last' });
  assert.equal(checked, true);
});

test('a transaction-refused repair publication retains evidence without becoming uncertain work or retrying', async t => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' }); t.after(() => journal.close());
  const command = { key: 'repair-original', action: 'interactive.repair_request', payload: { id: 'repair', preparationId: 'original', expectedRevision: 3 } };
  journal.queue(command);
  await assert.rejects(journal.flush(async () => { throw Object.assign(Error('Preview changed'), { code: 'stale_repair_preview', status: 409 }); }));
  const item = journal.receipt(command.key);
  assert.equal(item.state, 'refused'); assert.equal(item.applied, false); assert.equal(item.effectsUncertain, false);
  const row = journal.db.prepare('SELECT * FROM outbox WHERE key=?').get(command.key);
  assert.equal(definitivePublicationRefusal(row).applied, false);
  await journal.flush(() => assert.fail('A refused correction must not replay'));
});
