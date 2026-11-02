import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NodeJournal } from '../src/node-journal.mjs';
import { NativeReceivers } from '../src/native-receivers.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';
import { NativeOpenCodeV2 } from '../packages/opencode-relay/native.mjs';

async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/interactive-errors-');
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  const worker = { agentId: 'initiator', sessionId: 'ses_source', bindingId: 'binding', bindingRevision: 1, token: 'fixture-worker' };
  const identity = { sessionId: worker.sessionId, projectId: 'old-project', directory: root, createdAt: 1 };
  const session = { id: identity.sessionId, projectID: 'new-project', location: { directory: root }, time: { created: 1 },
    model: { id: 'fixture-model', providerID: 'fixture-provider' } };
  const receivers = new NativeReceivers(journal);
  receivers.put(`receiver:${worker.agentId}`, { state: 'active', bindingId: worker.bindingId, generation: worker.bindingRevision });
  const client = { session: { get: async () => structuredClone(session) } };
  const f = { root, journal, worker, identity, session, receivers, backendCalls: [], native: new NativeOpenCodeV2(client, identity) };
  const socketPath = join(root, 'node.sock');
  const service = await startNodeService({ journal, socketPath, workers: [worker], getBackendFeatures: async () => ({ grantsManagement: true }),
    getNativeModel: async () => { if (f.failure) throw f.failure; return (await f.native.verify()).model; },
    api: async (method, path, command) => {
      assert.equal(method, 'POST'); assert.equal(path, '/v1/commands');
      f.backendCalls.push(command); return { id: command.payload.id, state: 'awaiting_approval' };
    } });
  f.input = { key: 'original-key', payload: { id: 'original-preparation', nodeId: 'node', directory: join(root, 'existing-worktree'), name: 'Docs' } };
  f.key = `interactive-source:${worker.agentId}:${f.input.key}`;
  f.prepare = () => call({ socketPath, token: worker.token }, 'POST', '/agent/interactive-prepare', f.input);
  f.confirmAttachment = () => {
    // Simulate a separate, human-confirmed attachment. The failed preparation
    // itself must never change this receiver or the adapter's pinned identity.
    worker.bindingId = 'confirmed-binding'; worker.bindingRevision = 2;
    receivers.put(`receiver:${worker.agentId}`, { state: 'active', bindingId: worker.bindingId, generation: worker.bindingRevision });
    f.native = new NativeOpenCodeV2(client, { ...identity, projectId: session.projectID });
  };
  t.after(async () => { await service.close(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('project-only preparation errors survive the real node/client transport with human reattachment and exact retry guidance', async t => {
  const f = await fixture(t), before = f.receivers.receiver(f.worker.agentId);
  await assert.rejects(f.prepare(), error => {
    assert.equal(error.code, 'native_project_identity_changed'); assert.equal(error.status, 409);
    assert.match(error.message, /\[native_project_identity_changed\]/);
    assert.match(error.message, /human.*\/relay-attach.*existing chat.*same Relay enrolment/);
    assert.match(error.message, /Wait for confirmed attachment/);
    assert.match(error.message, /original ID, key and payload.*existing worktree/);
    assert.match(error.message, /Do not recreate.*backend-admin CLI.*borrow credentials/);
    assert.doesNotMatch(error.message, /old-project|new-project|fixture-worker/);
    return true;
  });
  assert.equal(f.backendCalls.length, 0); assert.equal(f.journal.receipt(f.key), null);
  assert.deepEqual(f.receivers.receiver(f.worker.agentId), before); assert.deepEqual(f.native.identity, f.identity);
});

test('retries remain blocked until explicit attachment recovery, then reuse the same preparation ID, key and payload', async t => {
  const f = await fixture(t), input = structuredClone(f.input);
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(f.prepare(), { code: 'native_project_identity_changed' });
  assert.equal(f.backendCalls.length, 0); assert.equal(f.journal.receipt(f.key), null);
  f.confirmAttachment();
  const result = await f.prepare();
  assert.equal(result.state, 'recorded'); assert.equal(result.receipt.state, 'awaiting_approval');
  assert.equal(f.backendCalls.length, 1); assert.equal(f.backendCalls[0].key, f.key);
  assert.equal(f.backendCalls[0].action, 'interactive.request');
  assert.deepEqual(f.backendCalls[0].payload, { ...input.payload, model: f.session.model, requesterAgentId: f.worker.agentId,
    sourceConversationId: f.worker.sessionId, sourceBindingRevision: 2 });
  assert.deepEqual(f.input, input);
  await f.prepare(); assert.equal(f.backendCalls.length, 1, 'An already recorded request is not duplicated');
});

test('a wider native identity mismatch stops before enqueue and does not recommend the project-only attachment shortcut', async t => {
  const f = await fixture(t); f.session.location.directory = '/different-private-workspace';
  await assert.rejects(f.prepare(), error => {
    assert.equal(error.code, 'native_identity_mismatch'); assert.equal(error.status, 409);
    assert.match(error.message, /human to inspect/); assert.match(error.message, /Do not automatically reattach/);
    assert.doesNotMatch(error.message, /\/relay-attach|different-private-workspace/); return true;
  });
  assert.equal(f.backendCalls.length, 0); assert.equal(f.journal.receipt(f.key), null);
});

test('model-resolution failures have a distinct remedy without leaking the underlying private exception', async t => {
  const f = await fixture(t);
  f.failure = Object.assign(Error('private-provider-response secret-token'), { code: 'native_model_unavailable' });
  await assert.rejects(f.prepare(), error => {
    assert.equal(error.code, 'native_model_unavailable'); assert.equal(error.status, 409);
    assert.match(error.message, /human to select a valid model/); assert.match(error.message, /original preparation ID, key and payload/);
    assert.doesNotMatch(error.message, /private-provider-response|secret-token|\/relay-attach/); return true;
  });
  assert.equal(f.backendCalls.length, 0); assert.equal(f.journal.receipt(f.key), null);
});

test('unknown native failures remain sanitised and never acquire invented recovery guidance', async t => {
  const f = await fixture(t); f.failure = Error('private-provider-response secret-token');
  await assert.rejects(f.prepare(), error => {
    assert.equal(error.code, 'node_error'); assert.equal(error.status, 500); assert.equal(error.message, 'Node request failed'); return true;
  });
  assert.equal(f.backendCalls.length, 0); assert.equal(f.journal.receipt(f.key), null);
});

test('headless workers cannot turn attachment recovery advice into interactive provisioning authority', async t => {
  const f = await fixture(t); f.worker.headlessSetupId = 'headless-fixture';
  await assert.rejects(f.prepare(), error => {
    assert.equal(error.code, 'interactive_human_context_required'); assert.equal(error.status, 403);
    assert.doesNotMatch(error.message, /\/relay-attach/); return true;
  });
  assert.equal(f.backendCalls.length, 0); assert.equal(f.journal.receipt(f.key), null);
});
