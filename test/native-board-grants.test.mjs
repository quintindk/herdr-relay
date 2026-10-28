import assert from 'node:assert/strict';
import test from 'node:test';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { bootstrapNode } from '../src/node-bootstrap.mjs';
import { nativeBoard } from '../src/native-board.mjs';
import { NativeDecisionJournal } from '../src/native-decision-journal.mjs';

async function fixture(t) {
  const backend = await startBackend({ database: ':memory:' }), store = backend.store;
  const owner = store.authenticate(store.bootstrap().token);
  const bundle = bootstrapNode(store, owner, { key: 'join', id: 'node', name: 'Surface', mode: 'roots', roots: ['/work'], maxAgents: 25 });
  const operator = store.authenticate(bundle.operatorToken), node = store.authenticate(bundle.nodeToken);
  const api = nativeBackendClient({ url: backend.origin, token: bundle.operatorToken });
  let sequence = 0;
  const command = (actor, action, payload) => store.command(actor, { key: `seed:${++sequence}`, action, payload });
  command(operator, 'agent.enrol', { id: 'mason', nodeId: 'node', directory: '/work/project', name: 'Mason' });
  command(operator, 'agent.attach', { id: 'mason', expectedBindingRevision: 0, conversationId: 'ses_source', directory: '/work/project', bindingId: 'source' });
  const request = command(node, 'interactive.request', { id: 'discussion', nodeId: 'node', requesterAgentId: 'mason', sourceConversationId: 'ses_source',
    sourceBindingRevision: 1, directory: '/work/discussion', name: 'Discussion', createDirectory: true });
  const journal = new NativeDecisionJournal(), board = nativeBoard(api, { decisionJournal: journal });
  t.after(async () => { journal.close(); await backend.close(); });
  return { backend, store, owner, operator, node, api, bundle, request, journal, board, command };
}

test('human Grants transport approves and resumes without an owner file, separately from Inbox', async t => {
  const f = await fixture(t), snapshot = await f.board.read();
  assert.equal(snapshot.grantsAvailable, true); assert.deepEqual(snapshot.inbox, []);
  assert.equal(snapshot.grants.pending.length, 1);
  const item = await f.board.detailGrant({ id: snapshot.grants.pending[0].id });
  assert.equal(item.requesterName, 'Mason'); assert.equal(item.nodeName, 'Surface');
  const result = await f.board.decideGrant({ item, key: 'approve', decision: 'approve_once' });
  assert.equal(result.state, 'recorded'); assert.equal(f.store.get('provision_request', f.request.id).state, 'requested');
  const after = await f.board.read();
  assert.equal(after.grants.pending.length, 0); assert.equal(after.grants.active.length, 1); assert.deepEqual(after.inbox, []);
  assert.ok(after.grants.history.some(item => item.stateLabel === 'approved_once' && item.decidedBy === 'You'));
  await f.board.decideGrant({ item: await f.board.detailGrant({ id: after.grants.active[0].id }), key: 'revoke', reason: 'Finished' });
  assert.equal((await f.board.read()).grants.active.length, 0);
});

test('approval credentials are restricted by transport, command, expiry and parent revocation', async t => {
  const f = await fixture(t), session = await f.api('POST', '/v1/grants/ui-session', { terminalId: 'terminal' });
  const ui = f.api.withToken(session.token), node = f.api.withToken(f.bundle.nodeToken);
  assert.ok(Date.parse(session.credential.scope.expiresAt) <= Date.now() + 3600000);
  for (const [method, path, body] of [['GET', '/v1/tasks'], ['GET', '/v1/identity'], ['POST', '/v1/grants/ui-session', { terminalId: 'nested' }],
    ['POST', '/v1/node-credentials', { nodeId: 'node', key: 'credential' }]]) {
    await assert.rejects(ui(method, path, body), { status: 403 });
  }
  for (const action of ['grant.create', 'grant.revoke', 'grant.request_decide']) {
    for (const caller of [f.api, node]) await assert.rejects(caller('POST', '/v1/commands', { key: action, action, payload: {} }), { status: 403 });
  }
  await assert.rejects(node('POST', '/v1/grants/ui-session', { terminalId: 'agent' }), { status: 403 });
  await assert.rejects(ui('POST', '/v1/commands', { key: 'task', action: 'task.create', payload: { id: 'bad', title: 'No' } }), { status: 403 });
  const row = f.store.db.prepare('SELECT data FROM credentials WHERE id=?').get(session.credential.id), credential = JSON.parse(row.data);
  f.store.db.prepare('UPDATE credentials SET data=? WHERE id=?').run(JSON.stringify({ ...credential,
    scope: { ...credential.scope, expiresAt: '2000-01-01T00:00:00Z' } }), credential.id);
  await assert.rejects(ui('GET', '/v1/info'), { status: 401 });
  const next = await f.api('POST', '/v1/grants/ui-session', { terminalId: 'second' });
  f.command(f.owner, 'credential.revoke', { id: f.operator.credentialId });
  await assert.rejects(f.api.withToken(next.token)('GET', '/v1/info'), { status: 401 });
});

test('lost grant acknowledgement stays in Grants and replays the exact key rather than approving twice', async t => {
  const f = await fixture(t);
  let lose = true;
  const flaky = async (...args) => f.api(...args);
  flaky.withToken = token => {
    const api = f.api.withToken(token);
    return async (method, path, body) => {
      const result = await api(method, path, body);
      if (method === 'POST' && body.action === 'grant.request_decide' && lose) { lose = false; throw Error('Lost acknowledgement'); }
      return result;
    };
  };
  const board = nativeBoard(flaky, { decisionJournal: f.journal });
  const item = await board.detailGrant({ id: `request:${f.request.id}` });
  await assert.rejects(board.decideGrant({ item, key: 'original', decision: 'approve_once' }), /Lost acknowledgement/);
  const snapshot = await board.read();
  assert.deepEqual(snapshot.inbox, []); assert.equal(snapshot.grants.pending[0].kind, 'publication');
  assert.equal(board.pendingDecisions().length, 0); assert.equal(board.pendingGrantDecisions().length, 1);
  await board.decideGrant({ item: await board.detailGrant({ id: snapshot.grants.pending[0].id }), key: 'unused' });
  assert.equal(f.store.all('provision_grant').length, 1); assert.equal(f.store.all('provision_request').length, 1);
  assert.equal(board.pendingGrantDecisions().length, 0);
});

test('new standing permission is journalled through the human transport and covers the pending request', async t => {
  const f = await fixture(t);
  await f.board.createGrant({ key: 'new-standing', payload: { id: 'standing', requesterAgentId: 'mason', nodeId: 'node',
    scope: { ...f.request.scope, roots: ['/work'] } } });
  assert.equal(f.store.get('grant_request', f.request.id).state, 'approved');
  assert.equal(f.store.get('provision_request', f.request.id).grantId, 'standing');
  assert.equal(f.journal.pending().length, 0);
});

test('all four existing grant families are visible and revocable through Grants without changing work responsibility', async t => {
  const f = await fixture(t);
  f.command(f.owner, 'interactive.grant', { id: 'interactive', requesterAgentId: 'mason', nodeId: 'node', mode: 'roots', roots: ['/work'] });
  f.command(f.operator, 'headless.grant', { id: 'sweep', requesterAgentId: 'mason', nodeId: 'node', directory: '/work/project', name: 'Existing sweep',
    model: { providerID: 'fixture', id: 'model', integrationID: 'existing', connectionId: 'connection' }, permissions: { mcp: true, shell: false },
    contract: '.opencode/skills/job/SKILL.md', schedule: { id: 'job', cron: '0 7 * * *', timezone: 'Africa/Johannesburg', reviewPolicy: 'none' } });
  f.command(f.owner, 'task.reference_namespace.grant', { principal: { type: 'node', id: 'node' }, prefix: 'SFC', maxNumber: 9999 });
  f.command(f.owner, 'task.create', { id: 'parent-task', title: 'Coordinate' });
  f.command(f.owner, 'execution.request', { id: 'parent', taskId: 'parent-task', taskRevision: 1, targetAgentId: 'mason', instructions: 'Coordinate', allowDelegation: true, reviewPolicy: 'human' });
  f.command(f.owner, 'review.grant', { id: 'review', parentExecutionId: 'parent', reviewerAgentId: 'mason' });
  const snapshot = await f.board.read();
  assert.deepEqual(snapshot.grants.active.map(item => item.kind).sort(), ['headless', 'interactive', 'reference', 'review']);
  const sweep = snapshot.grants.active.find(item => item.kind === 'headless');
  assert.ok(sweep.actions.some(action => action.includes('MCP allowed'))); assert.ok(sweep.actions.includes('Shell denied'));
  for (const item of snapshot.grants.active) {
    const result = await f.board.decideGrant({ item: await f.board.detailGrant({ id: item.id }), key: `revoke-${item.kind}` });
    assert.equal(result.state, 'recorded');
  }
  const after = await f.board.read();
  assert.equal(after.grants.active.length, 0); assert.equal(after.grants.history.filter(item => item.stateLabel === 'revoked').length, 4);
  assert.equal(f.store.get('task', 'parent-task').responsibleUserId, 'owner');
  assert.equal(after.inbox.length, 0);
});
