import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const packageDirectory = resolve(process.env.RELAY_PACKAGE_DIRECTORY ?? fileURLToPath(new URL('../', import.meta.url)));
const [{ startBackend }, { BackendStore }, { nativeBackendClient }, { bootstrapNode }, { NodeJournal }, { NativeDecisionJournal },
  { startNodeService }, { call }, { nativeBoard }, { headlessSessionPermissions }, { default: plugin }] = await Promise.all([
  'src/backend-service.mjs', 'src/backend-store.mjs', 'src/backend-client.mjs', 'src/node-bootstrap.mjs', 'src/node-journal.mjs',
  'src/native-decision-journal.mjs', 'src/node-service.mjs', 'src/client.mjs', 'src/native-board.mjs', 'src/headless-permissions.mjs',
  'packages/opencode-relay/server.mjs',
].map(path => import(pathToFileURL(join(packageDirectory, path)).href)));

const execute = promisify(execFile);

// The simulated keyboard uses the checkout's Ink/React renderer. Installed
// keyboard coverage runs separately through the real CLI in verify-owner-inbox.
if (!process.env.RELAY_PACKAGE_DIRECTORY) {
  const [{ default: React }, { render }, { TaskBoardInkApp }] = await Promise.all([
    import('react'), import('ink-testing-library'), import('../src/task-board-ink.mjs'),
  ]);
  const frame = instance => stripVTControlCharacters(instance.lastFrame() ?? '');
  const input = async (instance, key) => { instance.stdin.write(key); await delay(45); };
  const waitFor = async (instance, pattern) => {
    const until = Date.now() + 3000;
    while (!pattern.test(frame(instance)) && Date.now() < until) await delay(20);
    assert.match(frame(instance), pattern);
  };
  async function open(t, board, copyToClipboard, writes) {
    const instance = render(React.createElement(TaskBoardInkApp, {
      read: board.read, detailInbox: board.detailInbox, copyToClipboard,
      markInboxRead: async (...args) => writes.push(args), decideInbox: async (...args) => writes.push(args),
      interval: 60000, width: 100, height: 28,
    }));
    t.after(() => instance.unmount());
    await waitFor(instance, /Inbox \(1\)/);
    for (const [key, pattern] of [['\t', /RELAY \/ AGENTS/], ['\t', /RELAY \/ INBOX/], ['\r', /c copy|0\/4000/]]) {
      await input(instance, key);
      await waitFor(instance, pattern);
    }
    return instance;
  }

  for (const result of [{ ok: true, method: 'fixture' }, { ok: false, error: 'Clipboard unavailable in this terminal' }]) {
    test(`Inbox message detail copies the exact body and reports ${result.ok ? 'success' : 'failure'} without marking it read`, async t => {
      const f = await fixture(t), writes = [], copies = [];
      const body = `  First line with trailing space \n\n${Array.from({ length: 28 }, (_, i) => `Retained line ${i}`).join('\n')}\nFinal 📎 line  `;
      const { receipt: message } = await f.send('clipboard', { body });
      const instance = await open(t, f.board, text => { copies.push(text); return result; }, writes);
      assert.match(frame(instance), /c copy/);
      await input(instance, 'c');
      await waitFor(instance, result.ok ? /Copied message to clipboard/ : /Clipboard unavailable in this terminal/);
      assert.deepEqual(copies, [message.body]);
      await input(instance, '\x1b');
      await waitFor(instance, /\[Inbox \(1\)\]/);
      assert.doesNotMatch(frame(instance), /c copy|Copied message to clipboard|Clipboard unavailable/);
      assert.deepEqual(writes, []);
      assert.equal(f.store.get('owner_message', message.id).state, 'unread');
      assert.equal(f.store.get('owner_message', message.id).revision, 1);
    });
  }

  test('Inbox question answer editing treats c as text, not a clipboard shortcut', async t => {
    const item = { id: 'question:one', kind: 'question', title: 'Which option?', summary: 'Choose one option.', stateLabel: 'Open' };
    const board = { read: async () => ({ companies: [], agents: [], projects: [], tasks: [], routines: [], inbox: [item] }), detailInbox: async () => item };
    const writes = [], copies = [];
    const instance = await open(t, board, text => copies.push(text), writes);
    await input(instance, 'c');
    assert.match(frame(instance), /c▏/);
    assert.match(frame(instance), /1\/4000/);
    assert.deepEqual(copies, []);
    assert.deepEqual(writes, []);
  });
}
async function fixture(t, { diskJournal = false } = {}) {
  const root = mkdtempSync('/tmp/opencode/owner-messages-'), backend = await startBackend({ database: ':memory:' });
  const store = backend.store, ownerToken = store.bootstrap().token, owner = store.authenticate(ownerToken);
  let sequence = 0;
  const command = (actor, action, payload) => store.command(actor, { key: `fixture-${++sequence}`, action, payload });
  const bundle = bootstrapNode(store, owner, { key: 'source', id: 'source', name: 'Source node', mode: 'localUser' });
  const node = store.authenticate(bundle.nodeToken), api = nativeBackendClient({ url: backend.origin, token: bundle.nodeToken });
  const ownerApi = nativeBackendClient({ url: backend.origin, token: ownerToken });
  const humanApi = nativeBackendClient({ url: backend.origin, token: bundle.operatorToken });
  command(owner, 'agent.enrol', { id: 'sender', nodeId: 'source', name: 'Armarius fixture', directory: root });
  command(owner, 'agent.attach', { id: 'sender', expectedBindingRevision: 0, conversationId: 'ses_sender', bindingId: 'sender-binding', directory: root });
  const journalFile = diskJournal ? join(root, 'node.sqlite') : ':memory:';
  const journal = new NodeJournal(journalFile, { nodeId: 'source', instanceId: store.instance });
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:sender', JSON.stringify({ state: 'active', bindingId: 'sender-binding', generation: 1 }));
  const socketPath = join(root, 'node.sock'), workers = [{ token: 'sender-token', agentId: 'sender', sessionId: 'ses_sender', bindingId: 'sender-binding', bindingRevision: 1 }];
  const f = { root, backend, store, owner, node, api, ownerApi, humanApi, command, journal, journalFile, workers, supported: true, writes: [] };
  f.serviceOptions = { journal, socketPath, workers,
    getBackendFeatures: async () => ({ ownerInboxMessages: f.supported }),
    api: async (method, path, body) => {
      if (method === 'POST' && path === '/v1/commands') f.writes.push(body);
      const result = await api(method, path, body);
      if (body?.action === 'owner_message.send' && f.loseReply) { f.loseReply = false; throw Error('Lost owner message reply'); }
      if (body?.action === 'owner_message.send' && f.badReply) { f.badReply = false; return { ...result, id: 'wrong-message' }; }
      return result;
    } };
  f.service = await startNodeService(f.serviceOptions);
  f.connection = { socketPath, token: 'sender-token', sessionId: 'ses_sender' };
  f.contextFile = join(root, 'worker.json'); writeFileSync(f.contextFile, JSON.stringify(f.connection), { mode: 0o600 });
  f.send = (key = 'status', changes = {}) => call(f.connection, 'POST', '/agent/owner-message', { key,
    subject: 'Validation complete', body: 'The requested validation passed. Deployment has not started.', ...changes });
  const decisions = new NativeDecisionJournal(); f.board = nativeBoard(humanApi, { decisionJournal: decisions });
  f.headless = () => {
    const setupId = 'headless-setup', agentId = 'headless-sender', sessionId = 'ses_headless', bindingId = 'headless-binding';
    store.save('agent', { id: agentId, ownerId: store.owner, nodeId: 'source', mode: 'headless', name: 'Headless fixture',
      headlessSetupId: setupId, conversationId: sessionId, bindingId, bindingRevision: 1, revision: 1, capabilities: [] });
    store.save('headless_grant', { id: 'headless-grant', nodeId: 'source', requesterAgentId: 'sender', state: 'active', revision: 1,
      directory: root, permissions: { mcp: false, shell: false }, model: { providerID: 'fixture', id: 'fixture', integrationID: 'fixture', connectionId: 'fixture' } });
    store.save('headless_setup', { id: setupId, agentId, sessionId, bindingId, nodeId: 'source', grantId: 'headless-grant',
      grantRevision: 1, state: 'ready', revision: 1, attempt: 1 });
    const execution = store.save('execution', { id: 'business-run', taskId: null, targetAgentId: agentId, targetNodeId: 'source',
      targetConversationId: sessionId, bindingId, state: 'accepted', runId: 'headless-run', revision: 1, contractRevision: 0 });
    const work = journal.save({ id: execution.id, state: 'observing', execution, bindingId, nativeConversationId: sessionId,
      invocation: { messageId: 'headless-input' } });
    workers.push({ token: 'headless-token', agentId, sessionId, headlessSetupId: setupId });
    const connection = { socketPath, token: 'headless-token', sessionId, headlessSetupId: setupId };
    return { connection, work, send: (key = 'headless-status') => call(connection, 'POST', '/work/owner-message', {
      executionId: execution.id, runId: execution.runId, key, payload: { subject: 'Checkpoint', body: 'Reached the requested state.' } }) };
  };
  t.after(async () => { await f.service.close(); decisions.close(); f.journal.close(); await backend.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('a current agent sends an attributed plain owner Inbox message without tasks, questions, notifications or model delivery', async t => {
  const f = await fixture(t), sent = await f.send(), message = sent.receipt;
  assert.equal(sent.state, 'recorded'); assert.equal(message.state, 'unread'); assert.equal(message.userId, f.store.owner);
  assert.equal(message.authority, 'information_only'); assert.equal(message.sender.agentId, 'sender'); assert.equal(message.sender.name, 'Armarius fixture');
  for (const kind of ['task', 'execution', 'question', 'notification', 'message']) assert.equal(f.store.all(kind).length, 0, kind);
  assert.equal(f.journal.db.prepare('SELECT count(*) AS n FROM notices').get().n, 0);
  const board = await f.board.read(), item = board.inbox.find(item => item.kind === 'owner_message');
  assert.equal(item.summary, message.body); assert.equal(item.title, message.subject); assert.equal(item.from, message.sender.name);
  assert.equal(item.action, 'owner_message.read'); assert.equal((await f.board.detailInbox({ id: item.id })).summary, message.body);
  const read = await f.board.markInboxRead({ item, key: 'human-read' });
  assert.equal(read.messageId, message.id); assert.equal(read.notificationId, undefined);
  assert.equal(f.store.get('owner_message', message.id).state, 'read'); assert.equal(f.store.get('owner_message', message.id).revision, 2);
  assert.equal(f.store.get('owner_message', message.id).body, message.body);
  assert.equal((await f.board.read()).inbox.length, 0);
  assert.equal((await f.ownerApi('GET', `/v1/owner_messages/${message.id}`)).state, 'read');
});

test('lost send replies, node journal reopen and subsequent human reads reconcile one exact original message, not a duplicate', async t => {
  const f = await fixture(t, { diskJournal: true }); f.loseReply = true;
  await assert.rejects(f.send());
  const first = f.store.all('owner_message')[0], item = (await f.board.read()).inbox[0];
  await f.board.markInboxRead({ item, key: 'read-before-sender-retry' });
  await f.service.close(); f.journal.close();
  f.journal = new NodeJournal(f.journalFile, { nodeId: 'source', instanceId: f.store.instance });
  f.service = await startNodeService({ ...f.serviceOptions, journal: f.journal });
  const sent = await f.send();
  assert.equal(sent.state, 'recorded'); assert.equal(sent.receipt.id, first.id);
  assert.equal(f.store.all('owner_message').length, 1); assert.equal(f.store.get('owner_message', first.id).state, 'read');
  assert.equal(f.writes[0].key, f.writes[1].key);
  await assert.rejects(f.send('status', { body: 'Different content under the same key' }), { code: 'operation_conflict' });
});

test('malformed send receipts stay uncertain and retry the original key', async t => {
  const f = await fixture(t); f.badReply = true;
  await assert.rejects(f.send(), { code: 'invalid_owner_message_receipt' });
  assert.equal(f.journal.db.prepare("SELECT state FROM outbox WHERE key LIKE 'owner-message:%'").get().state, 'pending');
  const sent = await f.send(); assert.equal(sent.state, 'recorded'); assert.equal(f.store.all('owner_message').length, 1);
});

test('old backends, invalid text, sender/owner overrides and stale receivers fail without queueing messages', async t => {
  const f = await fixture(t); f.supported = false;
  await assert.rejects(f.send(), { code: 'backend_upgrade_required' }); f.supported = true;
  for (const changes of [{ body: '' }, { body: 'x'.repeat(16001) }, { subject: 'two\nlines' }, { subject: 'x'.repeat(257) },
    { senderAgentId: 'spoof' }, { userId: 'another-owner' }, { recipientAgentId: 'recipient' }, { executionId: 'foreign-run' }])
    await assert.rejects(f.send('invalid', changes), { code: 'invalid_owner_message' });
  assert.equal(f.journal.db.prepare('SELECT count(*) AS n FROM outbox').get().n, 0);
  f.journal.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ state: 'active', bindingId: 'replacement', generation: 2 }), 'receiver:sender');
  await assert.rejects(f.send(), { code: 'receiver_replaced' }); assert.equal(f.store.all('owner_message').length, 0);
});

test('owner Inbox APIs and read acknowledgement require the human, and sending cannot impersonate another node or chat', async t => {
  const f = await fixture(t), message = (await f.send()).receipt;
  await assert.rejects(f.api('GET', '/v1/owner_messages'), { code: 'forbidden' });
  await assert.rejects(f.api('GET', `/v1/owner_messages/${message.id}`), { code: 'forbidden' });
  await assert.rejects(f.api('POST', '/v1/commands', { key: 'agent-read', action: 'owner_message.read', payload: { id: message.id, expectedRevision: 1 } }), { code: 'forbidden' });
  const p = { id: 'forged', senderAgentId: 'sender', sourceConversationId: 'ses_sender', sourceBindingRevision: 1, body: 'Not authorised' };
  await assert.rejects(f.ownerApi('POST', '/v1/commands', { key: 'root-spoof', action: 'owner_message.send', payload: p }), { code: 'forbidden' });
  const foreign = f.store.issueCredential({ type: 'node', id: 'different-node' });
  const foreignApi = nativeBackendClient({ url: f.backend.origin, token: foreign.token });
  await assert.rejects(foreignApi('POST', '/v1/commands', { key: 'node-spoof', action: 'owner_message.send', payload: p }), { code: 'forbidden' });
  await assert.rejects(f.api('POST', '/v1/commands', { key: 'chat-spoof', action: 'owner_message.send', payload: { ...p, sourceConversationId: 'stale-chat' } }), { code: 'stale_binding' });
  assert.equal(f.store.all('owner_message').length, 1);
});

test('peer notices cannot automatically forward a message into the human Inbox', async t => {
  const f = await fixture(t);
  f.journal.db.prepare('INSERT INTO notices VALUES (?,?,?)').run('incoming', 'observing', JSON.stringify({ kind: 'message', bindingId: 'sender-binding' }));
  await assert.rejects(f.send(), { code: 'message_reply_not_authorised' });
  assert.equal(f.store.all('owner_message').length, 0);
});

test('full messages survive sender deletion and backend reopen without recreating work', async t => {
  const root = mkdtempSync('/tmp/opencode/owner-message-reopen-'), path = join(root, 'backend.sqlite');
  let store = new BackendStore(path);
  try {
    const owner = store.authenticate(store.bootstrap().token);
    store.command(owner, { key: 'node', action: 'node.enrol', payload: { id: 'node', name: 'Node' } });
    const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
    store.command(owner, { key: 'agent', action: 'agent.enrol', payload: { id: 'sender', nodeId: 'node', name: 'Historical sender', directory: root } });
    store.command(owner, { key: 'attach', action: 'agent.attach', payload: { id: 'sender', expectedBindingRevision: 0, conversationId: 'ses_fixture', bindingId: 'binding', directory: root } });
    const command = { key: 'message', action: 'owner_message.send', payload: { id: 'message', senderAgentId: 'sender', sourceConversationId: 'ses_fixture', sourceBindingRevision: 1, body: 'Full\nmessage\nretained' } };
    const sent = store.command(node, command);
    store.command(owner, { key: 'delete-sender', action: 'agent.delete', payload: { id: 'sender', expectedRevision: store.get('agent','sender').revision, reason: 'Remove fixture sender' } });
    store.close(); store = new BackendStore(path);
    assert.deepEqual(store.command(node, command), sent); assert.deepEqual(store.get('owner_message','message'), sent);
    assert.equal(store.get('owner_message','message').sender.name, 'Historical sender'); assert.equal(store.all('execution').length, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('the plugin and actual CLI expose the same task-independent owner message primitive', async t => {
  const f = await fixture(t), tools = [];
  const close = await plugin.setup({ options: { workerContextFile: f.contextFile },
    tool: { transform: async fn => { fn({ add: tool => tools.push(tool) }); return { dispose() {} }; } },
    rpc: { register: async () => ({ dispose() {} }) } }); t.after(close);
  const tool = tools.find(tool => tool.name === 'relay_owner_message'); assert.ok(tool); assert.equal(tool.options.codemode, false);
  const input = { key: 'plugin-update', subject: 'Plugin checkpoint', body: 'Reached the requested state. No action needed.' };
  assert.equal(JSON.parse((await tool.execute(input, { sessionID: 'ses_sender' })).content).state, 'recorded');
  await assert.rejects(tool.execute(input, { sessionID: 'different-session' }));
  const file = join(f.root, 'message.json'); writeFileSync(file, JSON.stringify({ subject: 'CLI checkpoint', body: 'Plain CLI message' }));
  const result = await execute(process.execPath, [join(packageDirectory,'src/cli.mjs'),'native','work','owner-message','--context',f.contextFile,'--key','cli-update','--file',file]);
  assert.equal(JSON.parse(result.stdout).state, 'recorded'); assert.equal(f.store.all('owner_message').length, 2);
  const wrongContext = join(f.root,'not-a-worker.json');
  writeFileSync(wrongContext,JSON.stringify({url:'http://127.0.0.1:1',token:'must-not-leave-context'}),{mode:0o600});
  await assert.rejects(execute(process.execPath,[join(packageDirectory,'src/cli.mjs'),'native','work','owner-message','--context',wrongContext,'--key','wrong-context','--file',file]), error => {
    assert.match(error.stderr,/invalid_worker_context/); assert.doesNotMatch(error.stderr,/must-not-leave-context/); return true;
  });
  assert.equal(f.store.all('question').length, 0); assert.equal(f.store.all('notification').length, 0);
});

test('accepted headless runs can message their owner without MCP/shell grants, but readiness, cancellation, staged outcomes and revocation cannot', async t => {
  const f = await fixture(t), headless = f.headless();
  assert.equal((await headless.send()).state, 'recorded');
  assert.ok(headlessSessionPermissions({ directory: f.root, contract: 'SKILL.md', permissions: { mcp: false, shell: false } })
    .some(rule => rule.action === 'relay_owner_message' && rule.effect === 'allow'));
  headless.work.staged = { kind: 'submit' }; f.journal.save(headless.work);
  await assert.rejects(headless.send('staged'), { code: 'headless_execution_inactive' });
  delete headless.work.staged; f.journal.save(headless.work);
  const execution = f.store.get('execution','business-run'); f.store.save('execution',{ ...execution, cancellationRequested: true });
  await assert.rejects(headless.send('cancelled'), { code: 'headless_execution_inactive' });
  f.store.save('execution',execution);
  const grant = f.store.get('headless_grant','headless-grant'); f.store.save('headless_grant',{ ...grant, state: 'revoked' });
  await assert.rejects(headless.send('revoked'), { code: 'headless_grant_inactive' });
  f.store.save('headless_grant',grant);
  const probe = { ...execution, id: 'probe_headless-setup_1', runId: 'probe-run' };
  f.store.save('execution',probe); f.journal.save({ ...headless.work, id: probe.id, execution: probe });
  await assert.rejects(call(headless.connection,'POST','/work/owner-message',{ executionId: probe.id, runId: probe.runId, key: 'probe', payload: { body: 'Must not reach the owner' } }), { code: 'headless_probe_forbidden' });
  assert.equal(f.store.all('owner_message').length, 1);
});

test('owner read acknowledgements survive a lost reply and decision-journal reopen under the original key', async t => {
  const f = await fixture(t); await f.send(); const item = (await f.board.read()).inbox[0];
  const path = join(f.root,'decisions.sqlite'); let journal = new NativeDecisionJournal(path), lose = true; const keys = [];
  const api = async (...args) => {
    const result = await f.humanApi(...args);
    if (args[0] === 'POST' && args[2].action === 'owner_message.read') {
      keys.push(args[2].key); if (lose) { lose = false; throw Error('Lost read reply'); }
    }
    return result;
  };
  try {
    await assert.rejects(nativeBoard(api,{decisionJournal:journal}).markInboxRead({ item,key:'original-read' }), /Lost read reply/);
    journal.close(); journal = new NativeDecisionJournal(path);
    await nativeBoard(api,{decisionJournal:journal}).markInboxRead({item,key:'must-not-create-another-read'});
    assert.deepEqual(keys,['original-read','original-read']); assert.equal(f.store.get('owner_message',item.entityId).revision,2);
  } finally { journal.close(); }
});

test('owner message pagination is complete and its cursors bind unread/read scope', async t => {
  const f = await fixture(t); await f.send('one'); await f.send('two');
  const first = await f.ownerApi('GET','/v1/owner_messages?limit=1&status=unread');
  assert.equal(first.items.length,1); assert.ok(first.nextCursor);
  const next = await f.ownerApi('GET',`/v1/owner_messages?${new URLSearchParams({limit:'1',status:'unread',cursor:first.nextCursor})}`);
  assert.equal(next.items.length,1); assert.notEqual(first.items[0].id,next.items[0].id); assert.equal(next.nextCursor,null);
  await assert.rejects(f.ownerApi('GET',`/v1/owner_messages?${new URLSearchParams({limit:'1',status:'read',cursor:first.nextCursor})}`), {code:'invalid_cursor'});
});

test('the same plugin and CLI message API accepts only the exact active headless run', async t => {
  const f = await fixture(t), headless = f.headless(), file = join(f.root,'headless-worker.json'), tools=[];
  writeFileSync(file,JSON.stringify(headless.connection),{mode:0o600});
  const close = await plugin.setup({options:{workerContextFile:file},tool:{transform:async fn=>{fn({add:tool=>tools.push(tool)});return{dispose(){}};}},rpc:{register:async()=>({dispose(){}})}}); t.after(close);
  const tool = tools.find(tool=>tool.name==='relay_owner_message');
  assert.equal(JSON.parse((await tool.execute({key:'headless-plugin',body:'Headless plugin checkpoint'},{sessionID:'ses_headless'})).content).state,'recorded');
  const payload = join(f.root,'headless-message.json'); writeFileSync(payload,JSON.stringify({body:'Headless CLI checkpoint'}));
  const args=[join(packageDirectory,'src/cli.mjs'),'native','work','owner-message','--context',file,'--key','headless-cli','--file',payload];
  await assert.rejects(execute(process.execPath,args));
  assert.equal(JSON.parse((await execute(process.execPath,[...args,'--execution','business-run','--run','headless-run'])).stdout).state,'recorded');
  assert.equal(f.store.all('owner_message').length,2);
});
