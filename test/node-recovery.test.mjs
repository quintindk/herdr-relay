import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NodeJournal } from '../src/node-journal.mjs';
import { nodeRecovery } from '../src/node-recovery.mjs';
import { tickNode } from '../src/node-execution.mjs';
import { digest } from '../src/protocol.mjs';
import { BackendStore } from '../src/backend-store.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tickAutomation } from '../src/node-automation.mjs';

function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/node-recovery-'), database = join(root, 'node.sqlite');
  const configFile = join(root, 'node.json'), identity = { nodeId: 'node', instanceId: 'instance' };
  writeFileSync(configFile, JSON.stringify({ identityVersion: 2, nodeId: 'node', stateDirectory: root, backend: { url: 'http://fixture', token: 'fixture-only' } }), { mode: 0o600 });
  const f = { root, database, configFile, identity, directory: join(root, 'maintenance'), journal: new NodeJournal(database, identity) };
  f.execution = { id: 'execution', revision: 4, targetNodeId: 'node', targetAgentId: 'agent', state: 'cancelled', cancellationRequested: true, bindingId: 'binding', runId: 'run' };
  f.api = async (_method, path) => path === '/v1/info' ? { instanceId: 'instance', protocol: 'relay/0.2' } : f.execution;
  f.input = { configFile, directory: f.directory, kind: 'work', id: 'execution', key: 'withdraw', reason: 'Owner explicitly withdrew the assignment' };
  f.seedWork = () => f.journal.save({ id: 'execution', state: 'conflict', bindingId: 'binding', nativeConversationId: 'session',
    execution: { ...f.execution, state: 'accepted', revision: 2, cancellationRequested: false },
    invocation: { messageId: 'original', runId: 'run', prompt: 'Original immutable task', priorMessageIds: [] },
    observation: { state: 'conflict', reason: 'concurrent_native_input', inputId: 'human' } });
  f.recover = extra => nodeRecovery({ ...f.input, ...extra }, { api: f.api });
  t.after(() => { f.journal.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('cancelled backend projection is terminal-unresolved, then explicit audited abandonment preserves native evidence and cannot replay', async t => {
  const f = fixture(t), original = f.seedWork();
  f.journal.save({ ...original, execution: f.execution });
  await tickNode(f.journal, async method => { if (method === 'GET') return { items: [], cursor: 'one', hasMore: false }; assert.fail('No terminal command may be posted'); },
    async () => assert.fail('A terminal backend assignment must not resolve or dispatch its native binding'));
  const unresolved = f.journal.work('execution');
  assert.equal(unresolved.state, 'terminal_unresolved'); assert.deepEqual(unresolved.invocation, original.invocation);
  assert.deepEqual(unresolved.observation, original.observation); assert.equal(unresolved.terminalProjection.nativeSettlementClaimed, false);
  const preview = await f.recover();
  assert.equal(preview.nativeProcessTerminationClaimed, false); assert.equal(existsSync(f.directory), false);
  await assert.rejects(f.recover({ apply: true, previewHash: 'wrong' }), { code: 'stale_recovery_preview' });
  const applied = await f.recover({ apply: true, previewHash: preview.previewHash });
  assert.equal(applied.state, 'administratively_abandoned'); assert.ok(existsSync(applied.backup));
  const abandoned = f.journal.work('execution');
  assert.deepEqual(abandoned.invocation, original.invocation); assert.deepEqual(abandoned.observation, original.observation);
  assert.equal(abandoned.administrativeDisposition.nativeSettlementClaimed, false);
  assert.equal(abandoned.administrativeDisposition.promptReplayAllowed, false);
  assert.equal((await f.recover({ apply: true, previewHash: preview.previewHash })).replayed, true);
  f.journal.save({ ...original, state: 'observing' }); assert.equal(f.journal.work('execution').state, 'administratively_abandoned');
  assert.throws(() => f.journal.queue({ key: 'late-submit', action: 'execution.submit', payload: { id: 'execution' } }), { code: 'work_abandoned' });
  f.journal.close(); f.journal = new NodeJournal(f.database, f.identity);
  await tickNode(f.journal, async method => { if (method === 'GET') return { items: [], cursor: 'two', hasMore: false }; assert.fail('No replay'); },
    async () => assert.fail('Abandoned work must never redispatch after restart'));
  assert.equal(f.journal.work('execution').state, 'administratively_abandoned');
});

function rejected(f, error = 'invalid_headless_request', status = 'conflict') {
  const command = { key: 'comment-original', action: 'headless.task', payload: { executionId: 'execution', runId: 'run', operation: 'comment.create', key: 'logical-comment',
    source: { namespace: 'mail', externalId: 'message' }, payload: { taskId: 'task', expectedRevision: 2, body: 'Preserve this content', reason: 'Unsupported legacy field' } } };
  f.journal.queue(command);
  const item = { ...f.journal.receipt(command.key), state: status, error };
  f.journal.db.prepare('UPDATE outbox SET state=?,data=? WHERE key=?').run(status, JSON.stringify(item), command.key);
  return command;
}

test('legacy definitive validation refusal can be abandoned without replay, preserving exact command, error and hash', async t => {
  const f = fixture(t), command = rejected(f), original = f.journal.db.prepare('SELECT * FROM outbox').get();
  const input = { kind: 'publication', id: command.key };
  const preview = await f.recover(input), applied = await f.recover({ ...input, apply: true, previewHash: preview.previewHash });
  assert.equal(applied.applied, false);
  const after = f.journal.db.prepare('SELECT * FROM outbox').get(), item = JSON.parse(after.data);
  assert.equal(after.hash, original.hash); assert.deepEqual(item.command, command); assert.equal(item.error, 'invalid_headless_request');
  assert.equal(item.state, 'administratively_abandoned'); assert.equal(item.effectsUncertain, false);
  await f.journal.flush(() => assert.fail('Abandonment must not replay publication'));
  assert.equal((await f.recover({ ...input, apply: true, previewHash: preview.previewHash })).replayed, true);
});

test('uncertainty, unknown 4xx, revision/key conflicts and changed hashes cannot masquerade as validation refusals', async t => {
  for (const [error, state] of [['transport_uncertain', 'pending'], ['forbidden', 'conflict'], ['stale_revision', 'conflict'], ['operation_conflict', 'conflict']]) {
    const f = fixture(t), command = rejected(f, error, state), before = f.journal.db.prepare('SELECT * FROM outbox').get();
    await assert.rejects(f.recover({ kind: 'publication', id: command.key }), { code: 'publication_ineligible' });
    assert.deepEqual(f.journal.db.prepare('SELECT * FROM outbox').get(), before);
  }
  const f = fixture(t), command = rejected(f);
  f.journal.db.prepare('UPDATE outbox SET hash=?').run('changed');
  await assert.rejects(f.recover({ kind: 'publication', id: command.key }), { code: 'publication_ineligible' });
});

test('active backend work requires human withdrawal, changed previews refuse edits and native scope cannot be substituted', async t => {
  const f = fixture(t); f.seedWork(); f.execution.state = 'accepted';
  await assert.rejects(f.recover(), { code: 'recovery_ineligible' });
  f.execution.state = 'cancelled';
  const preview = await f.recover();
  f.journal.save({ ...f.journal.work('execution'), observation: { state: 'conflict', reason: 'changed' } });
  await assert.rejects(f.recover({ apply: true, previewHash: preview.previewHash }), { code: 'stale_recovery_preview' });
  f.execution.targetNodeId = 'another-node';
  await assert.rejects(f.recover(), { code: 'recovery_ineligible' });
});

test('new native transactional refusals are typed, revision conflicts require inspection and transport uncertainty stays recoverable', async t => {
  for (const [code, status, expected] of [['invalid_headless_request', 400, 'refused'], ['stale_revision', 409, 'conflict'], ['proxy_unknown', 400, 'conflict'], ['ECONNRESET', undefined, 'pending']]) {
    const f = fixture(t), command = { key: 'operation', action: 'headless.task', payload: { operation: 'comment.create' } };
    f.journal.queue(command);
    await assert.rejects(f.journal.flush(async () => { throw Object.assign(Error('Unsupported field: payload.reason'), { code, status }); }));
    const item = f.journal.receipt(command.key); assert.equal(item.state, expected);
    if (expected === 'refused') { assert.equal(item.applied, false); assert.equal(item.effectsUncertain, false); assert.match(item.refusal.details, /payload.reason/); }
    else if (code === 'stale_revision') { assert.equal(item.inspectionRequired, true); assert.equal(item.effectsUncertain, false); }
    else assert.equal(item.effectsUncertain, true);
    assert.equal(f.journal.db.prepare('SELECT hash FROM outbox').get().hash, digest(command));
  }
});

test('human handback withdraws an accepted assignment and open question without claiming native settlement', () => {
  const store = new BackendStore(':memory:');
  try {
    const owner = store.authenticate(store.bootstrap().token), c = (key, action, payload, actor = owner) => store.command(actor, { key, action, payload });
    c('node', 'node.enrol', { id: 'node', name: 'Node' });
    const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
    c('agent', 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'interactive' }, node);
    c('task', 'task.create', { id: 'task', title: 'Human task' });
    c('execution', 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1, targetAgentId: 'agent', instructions: 'Original work' });
    const accepted = c('admit', 'execution.admit', { id: 'execution', expectedRevision: 1, bindingId: 'binding', runId: 'run' }, node);
    c('question', 'question.ask', { id: 'question', executionId: accepted.id, expectedRevision: accepted.revision, prompt: 'Original unanswered question' }, node);
    const payload = { id: accepted.id, expectedRevision: store.get('execution', accepted.id).revision, reason: 'Owner takes over' };
    assert.throws(() => c('not-owner', 'execution.handback', payload, node), { code: 'forbidden' });
    const withdrawn = c('handback', 'execution.handback', payload);
    assert.equal(withdrawn.state, 'cancelled'); assert.equal(withdrawn.administrativeDisposition.nativeSettlementClaimed, false);
    assert.equal(withdrawn.result, undefined); assert.equal(withdrawn.settlement, undefined);
    assert.equal(store.get('task', 'task').status, 'todo'); assert.equal(store.get('question', 'question').status, 'superseded');
    assert.equal(store.get('question', 'question').answer, undefined);
    assert.deepEqual(c('handback', 'execution.handback', payload), withdrawn);
    assert.throws(() => c('another', 'execution.handback', { ...payload, expectedRevision: withdrawn.revision }), { code: 'execution_terminal' });
  } finally { store.close(); }
});

test('public CLI previews and abandons a legacy refusal using isolated local state, then returns its original receipt on retry', async t => {
  const f = fixture(t), command = rejected(f), cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const args = ['node', 'recover', 'publication', command.key, '--config', f.configFile, '--reason', 'Owner discards malformed rejected comment', '--key', 'cli-recovery'];
  const run = async extra => JSON.parse((await promisify(execFile)(process.execPath, [cli, ...args, ...extra], {
    cwd: f.root, env: { ...process.env, XDG_STATE_HOME: join(f.root, 'isolated-state'), RELAY_NATIVE_CONTEXT: '', RELAY_CONTEXT: '', RELAY_CLI_EXECUTION_ID: '', RELAY_CLI_READ_ONLY: '' },
  })).stdout);
  const preview = await run([]); assert.equal(preview.state, 'recovery_preview');
  const applied = await run(['--preview-hash', preview.previewHash, '--apply']);
  assert.equal(applied.state, 'administratively_abandoned'); assert.equal(applied.applied, false);
  assert.ok(applied.backup.startsWith(f.root));
  assert.equal((await run(['--preview-hash', preview.previewHash, '--apply'])).replayed, true);
});

test('a stale admission can be retired only after actual absent-receipt and revision-fence inspection, then its unstarted work can be abandoned', async t => {
  const f = fixture(t);
  f.execution = { ...f.execution, revision: 2, bindingId: undefined, runId: undefined };
  f.journal.save({ id: 'execution', state: 'admitting', execution: { ...f.execution, state: 'requested', revision: 1, cancellationRequested: false } });
  const command = { key: 'admit-original', action: 'execution.admit', payload: { id: 'execution', expectedRevision: 1, bindingId: 'binding', runId: 'run' } };
  f.journal.queue(command);
  await assert.rejects(f.journal.flush(async () => { throw Object.assign(Error('Changed revision'), { status: 409, code: 'stale_revision' }); }));
  f.api = async (_method, path) => path === '/v1/info' ? { instanceId: 'instance', protocol: 'relay/0.2' } : path.startsWith('/v1/command-receipts/') ?
    { state: 'absent', execution: f.execution } : f.execution;
  const input = { kind: 'publication', id: command.key, key: 'retire-admission' };
  const preview = await f.recover(input); assert.equal(preview.proof.kind, 'backend_revision_fence');
  await f.recover({ ...input, apply: true, previewHash: preview.previewHash });
  const work = await f.recover({ key: 'retire-unstarted-work' });
  await f.recover({ key: 'retire-unstarted-work', apply: true, previewHash: work.previewHash });
  assert.equal(f.journal.work('execution').state, 'administratively_abandoned');
  assert.equal(f.journal.work('execution').invocation, undefined);
});

test('a cancelled local-only schedule has an explicit administrative disposition without native success or future replay', async t => {
  const f = fixture(t), original = f.seedWork();
  f.journal.save({ ...original, execution: { ...original.execution, localOccurrence: true } });
  f.journal.db.prepare('INSERT INTO occurrences VALUES (?,?,?,?)').run('execution', 'schedule', 'admitted', JSON.stringify({ id: 'execution', state: 'admitted', scheduleId: 'schedule' }));
  f.api = async (_method, path) => {
    if (path === '/v1/info') return { instanceId: 'instance', protocol: 'relay/0.2' };
    if (path.startsWith('/v1/executions/')) throw Object.assign(Error('Unknown execution'), { status: 404 });
    return { id: 'schedule', revision: 2, cancelled: true, definition: { nodeId: 'node', targetAgentId: 'agent', enabled: false } };
  };
  const preview = await f.recover(); assert.equal(preview.proof.cancelledLocalSchedule, true);
  await f.recover({ apply: true, previewHash: preview.previewHash });
  assert.equal(f.journal.work('execution').execution.state, 'cancelled', 'Withdraw the local assignment without claiming a backend or native result');
  assert.equal(f.journal.work('execution').execution.result, undefined);
  assert.equal(f.journal.work('execution').execution.administrativeDisposition.nativeSettlementClaimed, false);
  assert.equal(f.journal.work('execution').state, 'administratively_abandoned');
  await tickAutomation(f.journal, () => assert.fail('Abandoned occurrence cannot dispatch'));
  assert.equal(f.journal.db.prepare('SELECT state FROM occurrences').get().state, 'administratively_abandoned');
});

test('a late transport callback cannot resurrect a publication abandoned after a proven backend revision fence', async t => {
  const f = fixture(t), command = { key: 'late-admit', action: 'execution.admit', payload: { id: 'execution', expectedRevision: 1, bindingId: 'binding', runId: 'run' } };
  f.journal.queue(command);
  let started, reject;
  const began = new Promise(resolve => { started = resolve; });
  const pending = f.journal.flush(() => { started(); return new Promise((_resolve, fail) => { reject = fail; }); });
  pending.catch(() => {}); await began;
  f.api = async (_method, path) => path === '/v1/info' ? { instanceId: 'instance', protocol: 'relay/0.2' } : { state: 'absent', execution: f.execution };
  const input = { kind: 'publication', id: command.key };
  const preview = await f.recover(input); await f.recover({ ...input, apply: true, previewHash: preview.previewHash });
  reject(Object.assign(Error('Lost reply'), { code: 'ECONNRESET' })); await assert.rejects(pending);
  assert.equal(f.journal.receipt(command.key).state, 'administratively_abandoned');
  await f.journal.flush(() => assert.fail('Abandoned command cannot replay'));
});
