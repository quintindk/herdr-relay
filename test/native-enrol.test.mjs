import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { enrolInteractive, attachInteractive, listEnrolments, launchInteractive } from '../src/native-enrol.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { NativeReceivers } from '../src/native-receivers.mjs';

async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/native-enrol-');
  const backend = await startBackend({ database: ':memory:' });
  t.after(async () => { await backend.close(); rmSync(root, { recursive: true, force: true }); });
  const context = { url: backend.origin, token: backend.store.bootstrap().token };
  const api = nativeBackendClient(context);
  const session = { id: 'ses_exact', projectID: 'project', location: { directory: root }, time: { created: 1 } };
  const client = { server: { info: async () => ({ version: '2.5.0' }) }, session: { get: async () => session } };
  const dependencies = { discover: async () => ({ url: 'http://127.0.0.1:4096', auth: { type: 'basic', username: 'opencode', password: 'native-password' } }), makeClient: () => client };
  const input = { configFile: join(root, 'node.json'), directory: root, sessionId: session.id, reserved: true, transport: 'cli', backend: { url: backend.origin }, api };
  return { root, backend, api, session, client, dependencies, input, token: context.token };
}

test('native enrolment writes private scoped config and retries without changing native policy or duplicating records', async t => {
  const f = await fixture(t);
  const result = await enrolInteractive(f.input, f.dependencies);
  assert.equal(result.state, 'enrolled'); assert.equal(result.nativeServiceRestarted, false); assert.equal(result.permissionsChanged, false);
  const before = readFileSync(f.input.configFile, 'utf8');
  const config = JSON.parse(before);
  const journal = new NodeJournal(join(f.root, 'node.sqlite'), { nodeId: config.nodeId, instanceId: f.backend.store.instance });
  const binding = new NativeReceivers(journal).resolve(result.agentId);
  journal.close();
  assert.equal(statSync(f.input.configFile).mode & 0o777, 0o600);
  assert.equal(statSync(binding.authFile).mode & 0o777, 0o600);
  assert.notEqual(config.backend.token, f.token);
  assert.equal(binding.workerTransport, 'cli');
  assert.equal(JSON.stringify(result).includes('native-password'), false);
  assert.equal((await enrolInteractive(f.input, f.dependencies)).state, 'existing');
  assert.equal(readFileSync(f.input.configFile, 'utf8'), before);
  assert.equal((await f.api('GET', '/v1/nodes')).items.length, 1);
  assert.equal((await f.api('GET', '/v1/agents')).items.length, 1);
  await assert.rejects(enrolInteractive({ ...f.input, transport: 'tools' }, f.dependencies), { code: 'configuration_conflict' });
  assert.equal(readFileSync(f.input.configFile, 'utf8'), before);
});

test('native enrolment checks explicit reservation and exact identity before backend writes', async t => {
  const f = await fixture(t);
  await assert.rejects(enrolInteractive({ ...f.input, reserved: false }, f.dependencies), { code: 'invalid_enrolment' });
  f.session.location.directory = '/elsewhere';
  await assert.rejects(enrolInteractive(f.input, f.dependencies), { code: 'native_identity_mismatch' });
  assert.equal((await f.api('GET', '/v1/nodes')).items.length, 0);
  await assert.rejects(enrolInteractive(f.input, { ...f.dependencies, discover: async () => ({ url: 'https://remote.invalid', auth: { type: 'basic', username: 'opencode', password: 'secret' } }) }), { code: 'invalid_binding' });
});

test('native enrolment recovers a lost node-credential reply using the same backend operation identity', async t => {
  const f = await fixture(t);
  let lost = false;
  const api = async (...args) => {
    const result = await f.api(...args);
    if (args[1] === '/v1/node-credentials' && !lost) { lost = true; throw Error('Lost credential reply'); }
    return result;
  };
  await assert.rejects(enrolInteractive({ ...f.input, api }, f.dependencies), /Lost credential reply/);
  const enrolled = await enrolInteractive({ ...f.input, api }, f.dependencies);
  assert.equal(enrolled.state, 'enrolled');
  assert.equal((await f.api('GET', '/v1/nodes')).items.length, 1);
  assert.equal((await f.api('GET', '/v1/agents')).items.length, 1);
});

test('fresh conversations attach to one stable node/agent while retaining historical exact bindings and schedules', async t => {
  const f = await fixture(t);
  const first = await enrolInteractive(f.input, f.dependencies);
  await f.api('POST', '/v1/commands', { key: 'schedule', action: 'schedule.install', payload: { id: 'persistent', definition: {
    nodeId: first.nodeId, targetAgentId: first.agentId, instructions: 'Bounded check', cron: '* * * * *', enabled: true,
  } } });
  f.session.id = 'ses_replacement'; f.session.time.created = 2;
  const second = await attachInteractive({ ...f.input, sessionId: f.session.id, agentId: first.agentId,
    expectedGeneration: 1, key: 'replace' }, f.dependencies);
  assert.equal(second.agentId, first.agentId); assert.equal(second.nodeId, first.nodeId);
  assert.equal(second.generation, 2); assert.notEqual(second.bindingId, first.bindingId);
  assert.equal((await f.api('GET', '/v1/nodes')).items.length, 1);
  assert.equal((await f.api('GET', '/v1/agents')).items.length, 1);
  const schedule = await f.api('GET', '/v1/schedules/persistent');
  assert.equal(schedule.definition.targetAgentId, first.agentId); assert.equal(schedule.revision, 1);
  const journal = new NodeJournal(join(f.root, 'node.sqlite'), { nodeId: first.nodeId, instanceId: f.backend.store.instance });
  const receivers = new NativeReceivers(journal);
  assert.equal(receivers.resolve(first.agentId).identity.sessionId, f.session.id);
  assert.equal(receivers.resolve(first.agentId, { bindingId: first.bindingId }).identity.sessionId, 'ses_exact');
  journal.close();
  assert.equal((await attachInteractive({ ...f.input, sessionId: f.session.id, agentId: first.agentId, expectedGeneration: 2, key: 'same' }, f.dependencies)).state, 'existing');
  await assert.rejects(attachInteractive({ ...f.input, sessionId: f.session.id, agentId: first.agentId, expectedGeneration: 1, key: 'stale' }, f.dependencies), { code: 'stale_binding' });
});

test('lost attachment reply fences new admission until original-key reconciliation and cannot reclaim a superseded receiver', async t => {
  const f = await fixture(t);
  const first = await enrolInteractive(f.input, f.dependencies);
  f.session.id = 'ses_new'; f.session.time.created = 2;
  let lost = false;
  const api = async (...args) => {
    const result = await f.api(...args);
    if (args[2]?.action === 'agent.attach' && !lost) { lost = true; throw Error('lost attachment reply'); }
    return result;
  };
  const input = { ...f.input, sessionId: f.session.id, api, agentId: first.agentId, expectedGeneration: 1, key: 'lost' };
  await assert.rejects(attachInteractive(input, f.dependencies), /lost attachment reply/);
  const journal = new NodeJournal(join(f.root, 'node.sqlite'), { nodeId: first.nodeId, instanceId: f.backend.store.instance });
  const receivers = new NativeReceivers(journal);
  assert.equal(receivers.resolve(first.agentId), null);
  assert.throws(() => journal.assertReceiver({ ...receivers.resolve(first.agentId, { bindingId: first.bindingId }), receiverGeneration: 1 }), { code: 'receiver_replaced' });
  journal.close();
  f.session.time.archived = 3;
  assert.equal((await attachInteractive(input, f.dependencies)).generation, 2);
  delete f.session.time.archived;
  assert.equal((await f.api('GET', `/v1/agents/${first.agentId}`)).bindingRevision, 2);
  const oldSession = structuredClone(f.session);
  f.session.id = 'ses_third'; f.session.time.created = 3;
  await attachInteractive({ ...input, sessionId: f.session.id, expectedGeneration: 2, key: 'third' }, f.dependencies);
  Object.assign(f.session, oldSession);
  await assert.rejects(attachInteractive(input, f.dependencies), { code: 'attachment_superseded' });
  assert.equal((await f.api('GET', `/v1/agents/${first.agentId}`)).bindingRevision, 3);
});

test('workspace roles share an installation but never silently share a receiver or select an ambiguous enrolment', async t => {
  const f = await fixture(t);
  const first = await enrolInteractive({ ...f.input, name: 'Wright' }, f.dependencies);
  f.session.id = 'ses_other'; f.session.time.created = 2;
  const second = await enrolInteractive({ ...f.input, sessionId: f.session.id, name: 'Reviewer' }, f.dependencies);
  assert.equal(second.nodeId, first.nodeId); assert.notEqual(second.agentId, first.agentId);
  const enrolments = await listEnrolments({ ...f.input });
  assert.equal(enrolments.length, 2);
  await assert.rejects(launchInteractive({ ...f.input, key: 'ambiguous' }, f.dependencies), { code: 'enrolment_ambiguous' });
  await assert.rejects(attachInteractive({ ...f.input, sessionId: f.session.id, agentId: first.agentId, key: 'alias', expectedGeneration: 1 }, f.dependencies), { code: 'attachment_refused' });
  assert.equal((await listEnrolments(f.input)).find(e => e.id === first.agentId).receiver.conversationId, 'ses_exact');
  f.session.id = 'ses_valid_after_refusal'; f.session.time.created = 3;
  assert.equal((await attachInteractive({ ...f.input, sessionId: f.session.id, agentId: first.agentId,
    key: 'after-refusal', expectedGeneration: 1 }, f.dependencies)).generation, 2);
});

test('explicit launches attach fresh root chats before display, retry native create by stable ID and refuse stale launch reclamation', async t => {
  const f = await fixture(t);
  const first = await enrolInteractive(f.input, f.dependencies);
  const sessions = new Map([[f.session.id, structuredClone(f.session)]]);
  let creates = 0, lose = true;
  f.client.session.get = async ({ sessionID }) => {
    const session = sessions.get(sessionID);
    if (!session) throw Object.assign(Error('not found'), { status: 404 });
    return session;
  };
  f.client.session.create = async input => {
    creates++;
    const session = { ...input, projectID: 'project', time: { created: 2 } };
    sessions.set(input.id, session);
    if (lose) { lose = false; throw Error('lost native create reply'); }
    return session;
  };
  const input = { ...f.input, agentId: first.agentId, key: 'fresh-launch' };
  await assert.rejects(launchInteractive(input, f.dependencies), /lost native create reply/);
  const launched = await launchInteractive(input, f.dependencies);
  assert.equal(creates, 1); assert.equal(launched.generation, 2);
  assert.notEqual(launched.sessionId, first.sessionId);
  assert.equal((await launchInteractive(input, f.dependencies)).generation, 2);
  await launchInteractive({ ...input, key: 'another-launch' }, f.dependencies);
  await assert.rejects(launchInteractive(input, f.dependencies), { code: 'attachment_superseded' });
});

test('competing attachment claims preserve one receiver and a rejected contender cannot silently retry with a new generation', async t => {
  const f = await fixture(t);
  const first = await enrolInteractive(f.input, f.dependencies);
  const session = id => ({ id, projectID: 'project', location: { directory: f.root }, time: { created: 2 } });
  const attempts = ['ses_a', 'ses_b'].map(id => attachInteractive({ ...f.input, sessionId: id, agentId: first.agentId,
    expectedGeneration: 1, key: id }, { ...f.dependencies, makeClient: () => ({ server: f.client.server, session: { get: async () => session(id) } }) }));
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'stale_binding');
  const current = (await listEnrolments(f.input))[0].receiver;
  assert.equal(current.generation, 2);
  assert.equal((await f.api('GET', `/v1/agents/${first.agentId}`)).conversationId, current.conversationId);
});
