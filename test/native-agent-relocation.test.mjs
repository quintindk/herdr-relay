import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { enrolInteractive, listEnrolments } from '../src/native-enrol.mjs';
import { relocateInteractive } from '../src/native-agent-relocation.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { NativeReceivers } from '../src/native-receivers.mjs';
import { installLocalSchedule } from '../src/node-schedules.mjs';
import { tickAutomation } from '../src/node-automation.mjs';

async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/agent-relocation-'), old = join(root, 'shared'), target = join(root, 'dedicated');
  mkdirSync(old); mkdirSync(target);
  const backend = await startBackend({ database: ':memory:' });
  const token = backend.store.bootstrap().token, owner = backend.store.authenticate(token);
  const api = nativeBackendClient({ url: backend.origin, token });
  const session = { id: 'existing-chat', projectID: 'old-project', location: { directory: old }, time: { created: 1 },
    model: { providerID: 'provider', id: 'model' }, permissions: [{ action: '*', resource: '*', effect: 'ask' }] };
  const f = { root, old, target, backend, owner, api, session, busy: false };
  const client = { server: { info: async () => ({ version: '2.1.0' }) }, session: { get: async () => structuredClone(session),
    active: async () => f.busy ? { [session.id]: {} } : {}, inbox: { list: async () => [] },
    update: () => assert.fail('Do not change native policy or model'), create: () => assert.fail('Do not create a replacement chat') } };
  const dependencies = { discover: async () => ({ url: 'http://127.0.0.1:4096', auth: { type: 'basic', username: 'opencode', password: 'fixture-native-password' } }), makeClient: () => client };
  const input = { configFile: join(root, 'node.json'), directory: old, sessionId: session.id, name: 'Blender', reserved: true,
    transport: 'tools', backend: { url: backend.origin }, api };
  const first = await enrolInteractive(input, dependencies);
  const journal = new NodeJournal(join(root, 'node.sqlite'), { nodeId: first.nodeId, instanceId: backend.store.instance });
  const receivers = new NativeReceivers(journal);
  const command = (key, action, payload, actor = owner) => backend.store.command(actor, { key, action, payload });
  command('schedule', 'schedule.install', { id: 'durable', definition: { nodeId: first.nodeId, targetAgentId: first.agentId,
    instructions: 'Keep this exact schedule', cron: '* * * * *', timezone: 'Africa/Johannesburg', enabled: true } });
  session.location.directory = target; session.projectID = 'new-project';
  const move = { ...input, agentId: first.agentId, previousDirectory: old, directory: target, expectedGeneration: 1 };
  Object.assign(f, { first, journal, receivers, command, dependencies, move,
    preview: () => relocateInteractive(move, dependencies), apply: (preview, extra = {}) => relocateInteractive({ ...move,
      apply: true, key: 'move-once', previewHash: preview.previewHash, ...extra }, dependencies) });
  t.after(async () => { journal.close(); await backend.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('explicit relocation preserves agent/chat/policy/schedule and retains the original binding as history', async t => {
  const f = await fixture(t), beforeConfig = readFileSync(f.move.configFile), beforeAgent = f.backend.store.get('agent', f.first.agentId);
  const beforeBinding = f.receivers.resolve(f.first.agentId), beforeSession = structuredClone(f.session), schedule = f.backend.store.get('schedule', 'durable');
  const preview = await f.preview();
  assert.equal(preview.previousDirectory, f.old); assert.equal(preview.directory, f.target);
  assert.equal(f.receivers.resolve(f.first.agentId).id, beforeBinding.id, 'Preview cannot fence the old receiver');
  assert.equal(f.backend.store.get('agent', f.first.agentId).directory, f.old);
  await assert.rejects(enrolInteractive({ ...f.move, name: 'Another name' }, f.dependencies), { code: 'workspace_relocation_required' });
  assert.equal(f.backend.store.all('agent').length, 1, 'Re-enrolment cannot leave an orphan agent after a workspace move');
  const moved = await f.apply(preview);
  assert.equal(moved.state, 'relocated'); assert.equal(moved.agentId, f.first.agentId); assert.equal(moved.sessionId, f.first.sessionId);
  assert.equal(moved.generation, 2); assert.equal(moved.permissionsChanged, false); assert.equal(moved.promptReplayed, false);
  assert.deepEqual(readFileSync(f.move.configFile), beforeConfig); assert.deepEqual(f.session, beforeSession);
  assert.deepEqual(f.backend.store.get('schedule', 'durable'), schedule);
  const agent = f.backend.store.get('agent', f.first.agentId);
  assert.equal(agent.directory, f.target); assert.deepEqual(agent.standingGrant, beforeAgent.standingGrant);
  assert.equal(f.backend.store.all('agent').length, 1);
  assert.equal((await listEnrolments({ ...f.move, directory: f.target }))[0].id, f.first.agentId);
  assert.equal((await listEnrolments({ ...f.move, directory: f.old })).length, 0);
  assert.deepEqual(f.receivers.resolve(f.first.agentId, { bindingId: beforeBinding.id }), beforeBinding);
  assert.throws(() => f.journal.assertReceiver(beforeBinding), { code: 'receiver_replaced' });
  assert.equal((await f.apply(preview)).generation, 2, 'The same move key cannot advance the generation twice');
});

test('lost committed relocation replies retain the local fence and reconcile the same move after restart', async t => {
  const f = await fixture(t), preview = await f.preview(); let lost = false;
  const api = async (...args) => {
    const result = await f.api(...args);
    if (args[2]?.action === 'agent.relocate' && !lost) { lost = true; throw Error('Lost committed reply'); }
    return result;
  };
  await assert.rejects(f.apply(preview, { api }), /Lost committed reply/);
  assert.equal(f.receivers.receiver(f.first.agentId).state, 'pending');
  assert.equal(f.receivers.get(`enrolment:${f.first.agentId}`).directory, f.old);
  assert.equal(f.backend.store.get('agent', f.first.agentId).directory, f.target);
  assert.equal((await f.apply(preview, { api })).generation, 2);
  assert.equal(f.receivers.get(`enrolment:${f.first.agentId}`).directory, f.target);
  await assert.rejects(f.apply(preview, { previewHash: 'a'.repeat(64) }), { code: 'operation_conflict' });
});

test('the unchanged agent-targeted cron resolves the relocated workspace on its next local tick', async t => {
  const f = await fixture(t), preview = await f.preview(); await f.apply(preview);
  const schedule = f.backend.store.get('schedule', 'durable'), clock = Date.parse('2026-10-29T10:00:00Z');
  const installed = installLocalSchedule(f.journal, { ...schedule.definition, id: schedule.id, revision: schedule.revision }, clock);
  let sends = 0;
  await tickAutomation(f.journal, async agentId => {
    assert.equal(agentId, f.first.agentId);
    const binding = f.receivers.resolve(agentId);
    assert.equal(binding.identity.directory, f.target); assert.equal(binding.receiverGeneration, 2);
    return { ...binding, agentInstructions: () => '', workerInstructions: () => '', native: {
      snapshot: async () => ({ idle: true, inbox: [], messages: [] }), send: async () => { sends++; },
    }, observe: () => ({ state: 'observed' }) };
  }, Date.parse(installed.nextAt));
  assert.equal(sends, 1);
  assert.equal(f.journal.works()[0].bindingId, f.receivers.resolve(f.first.agentId).id);
  assert.equal(f.backend.store.get('schedule', 'durable').revision, 1);
});

test('forks, native activity, changed previews and unresolved local evidence cannot authorise relocation', async t => {
  const f = await fixture(t), preview = await f.preview();
  f.session.parentID = 'another-root'; await assert.rejects(f.preview(), { code: 'root_session_required' }); delete f.session.parentID;
  f.busy = true; await assert.rejects(f.preview(), { code: 'native_session_busy' }); f.busy = false;
  f.session.projectID = 'changed-after-preview'; await assert.rejects(f.apply(preview), { code: 'stale_relocation_preview' }); f.session.projectID = 'new-project';
  f.journal.save({ id: 'old-work', state: 'uncertain', execution: { id: 'old-work', state: 'failed', targetAgentId: f.first.agentId } });
  await assert.rejects(f.preview(), { code: 'agent_busy' });
  assert.equal(f.backend.store.get('agent', f.first.agentId).directory, f.old);
  assert.equal(f.receivers.receiver(f.first.agentId).generation, 1);
});

test('racing backend work refuses the move atomically and restores the original local receiver', async t => {
  const f = await fixture(t), preview = await f.preview(), before = f.receivers.receiver(f.first.agentId);
  f.command('task', 'task.create', { id: 'task', title: 'Pinned work' });
  f.command('execution', 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1, targetAgentId: f.first.agentId, instructions: 'Do not move this execution' });
  await assert.rejects(f.apply(preview), { code: 'attachment_refused' });
  assert.deepEqual(f.receivers.receiver(f.first.agentId), before);
  assert.equal(f.receivers.get(`enrolment:${f.first.agentId}`).directory, f.old);
  assert.equal(f.backend.store.get('agent', f.first.agentId).directory, f.old);
});

test('a same-name destination enrolment and an operator outside either workspace cannot take over an agent', async t => {
  const f = await fixture(t), preview = await f.preview();
  f.command('other', 'agent.enrol', { id: 'other', nodeId: f.first.nodeId, directory: f.target, name: 'Blender' });
  await assert.rejects(f.apply(preview), { code: 'attachment_refused' });
  const operation = f.receivers.get('attachment:move-once').command;
  const actor = { ...f.owner, scope: { kind: 'node_operator', nodeId: f.first.nodeId, mode: 'roots', roots: [f.target], maxAgents: 10 } };
  assert.throws(() => f.command('outside-source', operation.action, operation.payload, actor), { code: 'operator_scope_mismatch' });
  actor.scope.roots = [f.old];
  assert.throws(() => f.command('outside-destination', operation.action, operation.payload, actor), { code: 'operator_scope_mismatch' });
});
