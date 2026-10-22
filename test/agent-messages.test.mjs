import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickAgentNotices } from '../src/node-notices.mjs';
import { queryMessages, messageParticipant } from '../src/agent-messages.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';
import plugin from '../packages/opencode-relay/server.mjs';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';

function fixture(t, disk = false) {
  const root = mkdtempSync('/tmp/opencode/messages-');
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const cmd = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  const nodes = {}, agents = {};
  for (const name of ['source', 'target', 'foreign']) {
    cmd(owner, `node-${name}`, 'node.enrol', { id: name, name });
    nodes[name] = store.authenticate(store.enrolCredential(owner, name, `token-${name}`).token);
    cmd(owner, `agent-${name}`, 'agent.enrol', { id: name, nodeId: name, name, directory: `/${name}` });
    agents[name] = cmd(owner, `attach-${name}`, 'agent.attach', { id: name, expectedBindingRevision: 0,
      conversationId: `ses_${name}`, directory: `/${name}`, bindingId: `binding-${name}` });
  }
  const f = { root, store, owner, cmd, nodes, agents, sends: [], idle: true, outcome: 'succeeded', observed: true };
  f.journalFile = disk ? join(root, 'node.sqlite') : ':memory:';
  f.open = () => {
    f.journal = new NodeJournal(f.journalFile, { nodeId: 'target', instanceId: store.instance });
    f.journal.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('receiver:target', JSON.stringify({ state: 'active', bindingId: 'binding-target', generation: 1 }));
  };
  f.open();
  f.send = (key = 'one', changes = {}) => cmd(nodes.source, key, 'message.send', { id: `message-${key}`, senderAgentId: 'source',
    sourceConversationId: 'ses_source', sourceBindingRevision: 1, recipientAgentId: 'target', kind: 'status',
    subject: 'Management connectivity recovered', body: 'Bridge running. Workload readiness remains unverified.', ...changes });
  f.api = async (method, path, body) => {
    if (method === 'POST') {
      if (f.beforeCommand) { const hook = f.beforeCommand; f.beforeCommand = null; hook(body); }
      const result = store.command(nodes.target, body);
      if (f.loseBackendReply && body.action === f.loseBackendReply) { f.loseBackendReply = false; throw Error('Lost backend reply'); }
      return result;
    }
    return store.get('message', decodeURIComponent(path.split('/').at(-1)));
  };
  f.resolve = async () => f.offline ? null : ({ id: 'binding-target', agentId: 'target', receiverGeneration: 1, identity: { sessionId: f.conversation ?? 'ses_target' },
    native: { snapshot: async () => ({ idle: f.idle, inbox: [], messages: [] }), send: async invocation => {
      f.sends.push(invocation);
      if (f.lostNativeReply) throw Error('Lost native reply');
    } }, observe: () => f.observed ? { state: 'finished', outcome: f.outcome } : { state: 'uncertain', reason: 'message_not_observed' } });
  f.consume = () => f.journal.reconcileSnapshot(store.snapshot());
  f.tick = () => tickAgentNotices(f.journal, f.api, f.resolve);
  t.after(() => { f.journal.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('agent messages are attributed, task-independent, idempotent and cannot spoof sender, receiver, task or execution authority', t => {
  const f = fixture(t), first = f.send();
  assert.deepEqual(f.send(), first);
  assert.equal(first.state, 'queued'); assert.equal(first.authority, 'context_only');
  assert.equal(first.sender.agentId, 'source'); assert.equal(first.recipient.agentId, 'target');
  assert.equal(f.store.all('task').length, 0); assert.equal(f.store.all('execution').length, 0);
  assert.throws(() => f.send('one', { body: 'Changed' }), { code: 'operation_conflict' });
  for (const changes of [{ sourceConversationId: 'ses_stale' }, { sourceBindingRevision: 2 }, { senderAgentId: 'foreign' },
    { recipientAgentId: 'source' }, { kind: 'task' }, { body: '' }, { body: 'x'.repeat(8001) }, { instructions: 'Execute it' }, { taskId: 'hidden-task' }]) {
    assert.throws(() => f.send(`invalid-${JSON.stringify(changes).length}`, changes));
  }
  assert.equal(f.store.all('message').length, 1);
  assert.throws(() => f.cmd(f.owner, 'root-spoof', 'message.send', { ...first, senderAgentId: 'source' }));
});

test('message inbox/sent pagination binds exact participants and never implies execution or permission', t => {
  const f = fixture(t); f.send('a'); f.send('b');
  const first = queryMessages(f.store, f.nodes.source, { agentId: 'source', direction: 'sent', limit: 1 });
  assert.equal(first.items.length, 1); assert.equal(first.complete, false);
  assert.equal(queryMessages(f.store, f.nodes.source, { agentId: 'source', direction: 'sent', limit: 1, cursor: first.nextCursor }).items[0].id, 'message-b');
  assert.throws(() => queryMessages(f.store, f.nodes.source, { agentId: 'target', limit: 1, cursor: first.nextCursor }), { code: 'forbidden' });
  assert.throws(() => queryMessages(f.store, f.nodes.source, { agentId: 'source', direction: 'inbox', limit: 1, cursor: first.nextCursor }), { code: 'invalid_cursor' });
  assert.equal(queryMessages(f.store, f.nodes.target, { agentId: 'target' }).items.length, 2);
  assert.throws(() => messageParticipant(f.store, f.nodes.foreign, f.store.get('message', 'message-a')), { code: 'forbidden' });
});

test('native HTTP message APIs enforce participant scope, exact pagination fields and node-authored attribution', async t => {
  const backend = await startBackend({ database: ':memory:' });
  t.after(() => backend.close());
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const clients = {};
  for (const id of ['sender', 'recipient', 'unrelated']) {
    await owner('POST', '/v1/commands', { key: `node-${id}`, action: 'node.enrol', payload: { id, name: id } });
    const credential = await owner('POST', '/v1/node-credentials', { nodeId: id, key: `token-${id}` });
    clients[id] = nativeBackendClient({ url: backend.origin, token: credential.token });
    await owner('POST', '/v1/commands', { key: `enrol-${id}`, action: 'agent.enrol', payload: { id, nodeId: id, name: id, directory: `/${id}` } });
    await owner('POST', '/v1/commands', { key: `attach-${id}`, action: 'agent.attach', payload: { id, expectedBindingRevision: 0, conversationId: `ses_${id}`, bindingId: `binding-${id}`, directory: `/${id}` } });
  }
  const body = { key: 'send', action: 'message.send', payload: { id: 'http-message', senderAgentId: 'sender', sourceConversationId: 'ses_sender',
    sourceBindingRevision: 1, recipientAgentId: 'recipient', body: 'Connectivity recovered. No action authorised.' } };
  await clients.sender('POST', '/v1/commands', body);
  assert.equal((await clients.sender('GET', '/v1/messages?agentId=sender&direction=sent')).items.length, 1);
  assert.equal((await clients.recipient('GET', '/v1/messages?agentId=recipient')).items.length, 1);
  await assert.rejects(clients.unrelated('GET', '/v1/messages/http-message'), { code: 'forbidden' });
  await assert.rejects(clients.sender('GET', '/v1/messages?agentId=recipient'), { code: 'forbidden' });
  await assert.rejects(clients.sender('GET', '/v1/messages?agentId=sender&taskId=task'), { code: 'invalid_query' });
  assert.equal((await owner('GET', '/v1/info')).features.agentMessages, true);
  assert.equal((await owner('GET', '/v1/snapshot')).collections.message.length, 1);
});

test('recipient backlog is bounded independently of tasks', t => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) f.send(`queued-${i}`);
  assert.throws(() => f.send('overflow'), { code: 'message_queue_full' });
  assert.equal(f.store.all('task').length, 0);
});

test('offline/busy agent defers a status update then receives one native turn and a delivery receipt, without creating work', async t => {
  const f = fixture(t); f.send(); f.consume();
  f.offline = true; await f.tick(); assert.equal(f.sends.length, 0);
  f.offline = false; f.idle = false; await f.tick(); assert.equal(f.sends.length, 0);
  f.idle = true; await f.tick(); await f.tick(); f.consume(); await f.tick();
  assert.equal(f.sends.length, 1);
  assert.match(f.sends[0].prompt, /not a human instruction or an execution grant/);
  assert.match(f.sends[0].prompt, /Do not automatically acknowledge/);
  assert.match(f.sends[0].prompt, /Workload readiness remains unverified/);
  const message = f.store.get('message', 'message-one');
  assert.equal(message.state, 'delivered'); assert.equal(message.delivery.conversationId, 'ses_target');
  assert.equal(f.store.all('execution').length, 0); assert.equal(f.store.all('task').length, 0);
});

test('lost native response and journal restart observe the same intent without duplicate delivery', async t => {
  const f = fixture(t, true); f.send(); f.consume(); f.lostNativeReply = true; f.observed = false;
  await f.tick(); assert.equal(f.sends.length, 1); assert.equal(f.store.get('message', 'message-one').state, 'uncertain');
  f.journal.close(); f.open(); f.consume(); await f.tick();
  assert.equal(f.sends.length, 1);
  f.observed = true; await f.tick(); assert.equal(f.sends.length, 1);
  assert.equal(f.store.get('message', 'message-one').state, 'delivered');
});

test('lost backend admission response reconciles before the one native send', async t => {
  const f = fixture(t); f.send(); f.consume(); f.loseBackendReply = 'message.admit';
  await assert.rejects(f.tick(), /Lost backend reply/); assert.equal(f.sends.length, 0);
  await f.tick(); await f.tick(); assert.equal(f.sends.length, 1);
  assert.equal(f.store.get('message', 'message-one').state, 'delivered');
});

test('snapshot without the original admitted intent never recreates a native prompt', async t => {
  const f = fixture(t); f.send(); f.consume(); f.observed = false; await f.tick();
  f.journal.close(); f.journalFile = ':memory:'; f.open(); f.consume(); await f.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.journal.db.prepare('SELECT state FROM notices').get().state, 'conflict');
  assert.equal(f.store.get('message', 'message-one').state, 'blocked');
});

test('lost final receipt reconciles without another native send, and failed model execution is not represented as approval', async t => {
  const f = fixture(t); f.send(); f.consume(); f.outcome = 'failed'; f.loseBackendReply = 'message.progress';
  await assert.rejects(f.tick(), /Lost backend reply/);
  await f.tick(); await f.journal.flush(f.api);
  assert.equal(f.sends.length, 1);
  const message = f.store.get('message', 'message-one');
  assert.equal(message.state, 'delivered'); assert.match(message.delivery.evidence, /failed/);
  assert.match(message.delivery.evidence, /not approval/);
});

test('receiving-chat replacement between local intent and backend admission blocks the message without sending', async t => {
  const f = fixture(t); f.send(); f.consume();
  f.beforeCommand = () => f.cmd(f.owner, 'replace-before-admit', 'agent.attach', { id: 'target', expectedBindingRevision: 1,
    conversationId: 'ses_new_target', directory: '/target', bindingId: 'new-target-binding' });
  await f.tick(); assert.equal(f.sends.length, 0);
  assert.equal(f.store.get('message', 'message-one').state, 'blocked');
});

test('replaced conversation after uncertain native delivery blocks rather than retargeting or resending', async t => {
  const f = fixture(t); f.send(); f.consume(); f.lostNativeReply = true; await f.tick();
  f.conversation = 'ses_replacement'; await f.tick();
  assert.equal(f.sends.length, 1); assert.equal(f.store.get('message', 'message-one').state, 'blocked');
});

test('admission/receipts are recipient-node-only and do not accept stale bindings or unadmitted delivery claims', t => {
  const f = fixture(t); f.send();
  const payload = { id: 'message-one', expectedRevision: 1, bindingId: 'binding-target', conversationId: 'ses_target', bindingRevision: 1, nativeMessageId: 'msg_exact' };
  assert.throws(() => f.cmd(f.nodes.source, 'admit', 'message.admit', payload), { code: 'forbidden' });
  assert.throws(() => f.cmd(f.nodes.target, 'wrong-binding', 'message.admit', { ...payload, bindingId: 'binding-wrong' }), { code: 'stale_binding' });
  assert.throws(() => f.cmd(f.nodes.target, 'fake-delivered', 'message.progress', { id: 'message-one', expectedRevision: 1, nativeMessageId: 'msg_exact', state: 'delivered', evidence: 'Trust me' }), { code: 'message_delivery_ineligible' });
});

test('enrolled tools send messages after execution completion, read only their own inbox/sent records and forbid automatic reply loops', async t => {
  const f = fixture(t), sourceJournal = new NodeJournal(':memory:', { nodeId: 'source', instanceId: f.store.instance });
  t.after(() => sourceJournal.close());
  sourceJournal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:source', JSON.stringify({ state: 'active', bindingId: 'binding-source', generation: 1 }));
  const socketPath = join(f.root, 'source.sock');
  const api = async (method, path, body) => {
    if (method === 'POST') return f.store.command(f.nodes.source, body);
    const url = new URL(path, 'http://backend');
    if (url.pathname === '/v1/messages') return queryMessages(f.store, f.nodes.source, { ...Object.fromEntries(url.searchParams),
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}) });
    return messageParticipant(f.store, f.nodes.source, f.store.get('message', url.pathname.split('/').at(-1)));
  };
  const service = await startNodeService({ journal: sourceJournal, socketPath, api,
    workers: [{ agentId: 'source', sessionId: 'ses_source', bindingId: 'binding-source', bindingRevision: 1, token: 'fixture' }] });
  t.after(() => service.close());
  const contextFile = join(f.root, 'worker.json');
  writeFileSync(contextFile, JSON.stringify({ socketPath, token: 'fixture', sessionId: 'ses_source' }), { mode: 0o600 });
  const tools = [];
  const close = await plugin.setup({ options: { workerContextFile: contextFile },
    tool: { transform: async fn => { fn({ add: definition => tools.push(definition) }); return { dispose() {} }; } },
    rpc: { register: async () => ({ dispose() {} }) } });
  t.after(close);
  const invoke = async (name, input) => JSON.parse((await tools.find(tool => tool.name === name).execute(input, { sessionID: 'ses_source' })).content);
  const sent = await invoke('relay_message_send', { key: 'update', recipientAgentId: 'target', kind: 'status', body: 'Bridge running; workload readiness unknown' });
  assert.equal(sent.state, 'recorded'); assert.equal(sent.receipt.sender.agentId, 'source');
  assert.equal((await invoke('relay_messages', { direction: 'sent' })).items.length, 1);
  assert.equal((await invoke('relay_message_inspect', { id: sent.receipt.id })).state, 'queued');
  const connection = { socketPath, token: 'fixture' };
  await assert.rejects(call(connection, 'POST', '/agent/message-send', { key: 'spoof', recipientAgentId: 'target', body: 'Hi', senderAgentId: 'target' }), { code: 'invalid_request' });
  sourceJournal.db.prepare('INSERT INTO notices VALUES (?,?,?)').run('incoming', 'observing', JSON.stringify({ kind: 'message', bindingId: 'binding-source' }));
  await assert.rejects(invoke('relay_message_send', { key: 'auto-reply', recipientAgentId: 'target', body: 'Acknowledged' }), { code: 'message_reply_not_authorised' });
  sourceJournal.db.prepare('DELETE FROM notices WHERE id=?').run('incoming');
  sourceJournal.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ state: 'active', bindingId: 'new-binding', generation: 2 }), 'receiver:source');
  await assert.rejects(invoke('relay_message_send', { key: 'old-chat', recipientAgentId: 'target', body: 'Hi' }), { code: 'receiver_replaced' });
  assert.equal(f.store.all('task').length, 0); assert.equal(f.store.all('execution').length, 0);
});
