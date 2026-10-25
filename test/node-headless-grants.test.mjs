import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { bootstrapNode } from '../src/node-bootstrap.mjs';

function fixture(t) {
  const store = new BackendStore(':memory:'); t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token), nodes = {}, operators = {};
  const command = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  for (const id of ['evo', 'surface']) {
    const bundle = bootstrapNode(store, owner, { key: id, id, name: id, mode: 'roots', roots: [`/work/${id}`] });
    nodes[id] = store.authenticate(bundle.nodeToken); operators[id] = store.authenticate(bundle.operatorToken);
    command(owner, `agent-${id}`, 'agent.enrol', { id: `agent-${id}`, nodeId: id, name: id, directory: `/work/${id}/job` });
    command(owner, `attach-${id}`, 'agent.attach', { id: `agent-${id}`, expectedBindingRevision: 0, conversationId: `ses_${id}`, directory: `/work/${id}/job`, bindingId: `binding-${id}` });
  }
  const grant = id => ({ id: `grant-${id}`, name: 'sweep', model: { providerID: 'provider', id: 'model', integrationID: 'auth', connectionId: 'existing-connection' },
    permissions: { mcp: true, shell: true }, contract: '.opencode/skills/job/SKILL.md',
    schedule: { id: `schedule-${id}`, cron: '0 7-18 * * 1-5', timezone: 'Africa/Johannesburg', reviewPolicy: 'none' } });
  const envelope = (id, payload = grant(id)) => ({ agentId: `agent-${id}`, conversationId: `ses_${id}`, bindingRevision: 1, payload });
  return { store, owner, nodes, operators, command, grant, envelope };
}

test('coordinators on independent nodes create their own grants without a backend-owner credential', t => {
  const f = fixture(t);
  for (const id of ['evo', 'surface']) {
    const input = f.envelope(id);
    const result = f.command(f.nodes[id], `self-${id}`, 'agent.headless_grant', input);
    assert.equal(result.state, 'active'); assert.equal(result.requesterAgentId, `agent-${id}`); assert.equal(result.nodeId, id);
    assert.equal(result.directory, `/work/${id}/job`); assert.equal(result.userId, 'owner'); assert.equal(result.issuedBy.type, 'agent');
    assert.equal(result.issuedBy.agentId, `agent-${id}`); assert.deepEqual(result.permissions, { mcp: true, shell: true });
    assert.deepEqual(f.command(f.nodes[id], `self-${id}`, 'agent.headless_grant', input), result);
  }
  assert.equal(f.store.all('headless_grant').length, 2);
  for (const kind of ['headless_setup', 'schedule', 'execution', 'task']) assert.equal(f.store.all(kind).length, 0);
  assert.equal(f.store.all('agent').length, 2, 'Creating a grant does not create its worker');
});

test('agent grant creation rejects different nodes, requesters, workspaces and stale bindings', t => {
  const f = fixture(t), base = f.envelope('evo');
  for (const [index, change] of [{ requesterAgentId: 'agent-surface' }, { nodeId: 'surface' }, { directory: '/work/surface/job' }].entries()) {
    assert.throws(() => f.command(f.nodes.evo, `override-${index}`, 'agent.headless_grant', { ...base, payload: { ...base.payload, ...change } }), { code: 'headless_requester_scope' });
  }
  assert.throws(() => f.command(f.nodes.surface, 'wrong-node', 'agent.headless_grant', base), { code: 'forbidden' });
  assert.throws(() => f.command(f.nodes.evo, 'stale', 'agent.headless_grant', { ...base, bindingRevision: 2 }), { code: 'headless_requester_scope' });
  assert.throws(() => f.command(f.nodes.evo, 'wrong-chat', 'agent.headless_grant', { ...base, conversationId: 'ses_elsewhere' }), { code: 'headless_requester_scope' });
  assert.equal(f.store.all('headless_grant').length, 0);
});

test('headless agents and unattributed node commands cannot issue grants', t => {
  const f = fixture(t);
  f.command(f.nodes.evo, 'worker', 'agent.register', { id: 'worker', nodeId: 'evo', name: 'Worker', mode: 'headless', directory: '/work/evo/job' });
  assert.throws(() => f.command(f.nodes.evo, 'worker-self', 'agent.headless_grant', { agentId: 'worker', conversationId: 'ses_worker', bindingRevision: 1, payload: f.grant('evo') }), { code: 'headless_requester_scope' });
  assert.throws(() => f.command(f.nodes.evo, 'raw-node', 'headless.grant', { ...f.grant('evo'), requesterAgentId: 'agent-evo', nodeId: 'evo', directory: '/work/evo/job' }), { code: 'forbidden' });
});

test('node operators can use the same grant command locally, but not for another node or outside roots', t => {
  const f = fixture(t);
  const input = { ...f.grant('evo'), requesterAgentId: 'agent-evo', nodeId: 'evo', directory: '/work/evo/job' };
  const grant = f.command(f.operators.evo, 'local-grant', 'headless.grant', input);
  assert.equal(grant.issuedBy.type, 'node_operator'); assert.equal(grant.issuedBy.nodeId, 'evo');
  assert.throws(() => f.command(f.operators.surface, 'local-grant', 'headless.grant', input), { code: 'operator_scope_mismatch' });
  assert.throws(() => f.command(f.operators.surface, 'foreign-grant', 'headless.grant', { ...input, id: 'foreign' }), { code: 'operator_scope_mismatch' });
  assert.throws(() => f.command(f.operators.evo, 'outside-roots', 'headless.grant', { ...input, id: 'outside', directory: '/other' }), { code: 'operator_scope_mismatch' });
  assert.throws(() => f.command(f.operators.surface, 'foreign-revoke', 'headless.revoke', { id: grant.id, expectedRevision: 1 }), { code: 'operator_scope_mismatch' });
  const revoked = f.command(f.operators.evo, 'local-revoke', 'headless.revoke', { id: grant.id, expectedRevision: 1 });
  assert.equal(revoked.state, 'revoked');
});

test('coordinator revocation pauses only its grant schedule, including grants originally issued by the owner', t => {
  const f = fixture(t);
  const grant = f.command(f.owner, 'root-grant', 'headless.grant', { ...f.grant('evo'), requesterAgentId: 'agent-evo', nodeId: 'evo', directory: '/work/evo/job' });
  const foreign = f.command(f.nodes.surface, 'foreign', 'agent.headless_grant', f.envelope('surface'));
  assert.throws(() => f.command(f.nodes.evo, 'foreign-revoke', 'agent.headless_revoke', f.envelope('evo', { id: foreign.id, expectedRevision: 1 })), { code: 'headless_requester_scope' });
  f.command(f.nodes.evo, 'job-agent', 'agent.register', { id: 'job-agent', nodeId: 'evo', name: 'Job', mode: 'headless', directory: grant.directory });
  f.command(f.owner, 'job-schedule', 'schedule.install', { id: grant.schedule.id, definition: { nodeId: 'evo', targetAgentId: 'job-agent', instructions: 'Job', cron: grant.schedule.cron, enabled: true } });
  f.store.save('headless_setup', { id: 'setup', revision: 1, grantId: grant.id, nodeId: 'evo', agentId: 'job-agent', scheduleId: grant.schedule.id });
  const revoked = f.command(f.nodes.evo, 'self-revoke', 'agent.headless_revoke', f.envelope('evo', { id: grant.id, expectedRevision: 1 }));
  assert.equal(revoked.state, 'revoked'); assert.equal(f.store.get('schedule', grant.schedule.id).definition.enabled, false);
  assert.equal(f.store.get('headless_grant', foreign.id).state, 'active');
});
