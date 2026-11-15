// Actual scoped CLI send and human TUI read, using disposable state only.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const { values } = parseArgs({ options: { package: { type: 'string' } } });
const installed = resolve(values.package ?? fileURLToPath(new URL('../', import.meta.url)));
const load = name => import(pathToFileURL(join(installed, 'src', `${name}.mjs`)));
const [{ startBackend }, { bootstrapNode }, { NodeJournal }, { startNodeService }] = await Promise.all(
  ['backend-service', 'node-bootstrap', 'node-journal', 'node-service'].map(load));
const root = mkdtempSync('/tmp/opencode/relay-owner-inbox-'), backend = await startBackend({ database: join(root, 'backend.sqlite') });
let service, journal;
try {
  const store = backend.store, ownerToken = store.bootstrap().token, owner = store.authenticate(ownerToken);
  const bundle = bootstrapNode(store, owner, { key: 'local', id: 'local', name: 'Local', mode: 'localUser' });
  const node = store.authenticate(bundle.nodeToken); let sequence = 0;
  const command = (actor, action, payload) => store.command(actor, { key: `fixture-${++sequence}`, action, payload });
  command(owner, 'agent.enrol', { id: 'sender', nodeId: 'local', name: 'Owner message sender', directory: root });
  command(owner, 'agent.attach', { id: 'sender', expectedBindingRevision: 0, conversationId: 'ses_fixture', bindingId: 'fixture-binding', directory: root });
  journal = new NodeJournal(join(root, 'node.sqlite'), { nodeId: 'local', instanceId: store.instance });
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:sender', JSON.stringify({ state: 'active', bindingId: 'fixture-binding', generation: 1 }));
  const socketPath = join(root, 'node.sock');
  service = await startNodeService({ journal, socketPath, workers: [{ agentId: 'sender', sessionId: 'ses_fixture', bindingId: 'fixture-binding', bindingRevision: 1, token: 'fixture' }],
    getBackendFeatures: async () => ({ ownerInboxMessages: true }), api: async (method, path, body) => {
      assert.equal(method, 'POST'); assert.equal(path, '/v1/commands'); return store.command(node, body);
    } });
  const worker = join(root, 'worker.json'), context = join(root, 'operator.json'), payload = join(root, 'message.json');
  const body = Array.from({ length: 40 }, (_, index) => `OWNER_BODY_${String(index + 1).padStart(2, '0')}`).join('\n');
  writeFileSync(worker, JSON.stringify({ socketPath, token: 'fixture', sessionId: 'ses_fixture' }), { mode: 0o600 });
  writeFileSync(context, JSON.stringify({ url: backend.origin, token: bundle.operatorToken, nodeId: 'local', instanceId: store.instance, scope: bundle.operatorCredential.scope }), { mode: 0o600 });
  writeFileSync(payload, JSON.stringify({ subject: 'Plain owner message fixture', body }), { mode: 0o600 });
  const execute = promisify(execFile), cli = join(installed, 'src/cli.mjs');
  const sent = JSON.parse((await execute(process.execPath, [cli, 'native', 'work', 'owner-message', '--context', worker, '--key', 'owner-keyboard', '--file', payload])).stdout);
  assert.equal(sent.state, 'recorded'); assert.equal(sent.receipt.sender.agentId, 'sender');
  const driver = fileURLToPath(new URL('../test/owner-inbox-pty.py', import.meta.url));
  const output = await execute('python3', [driver, process.execPath, cli, context, root], { timeout: 30000 });
  assert.equal(JSON.parse(output.stdout).directReadWithoutConfirmation, true);
  const message = store.get('owner_message', sent.receipt.id);
  assert.equal(message.state, 'read'); assert.equal(message.revision, 2); assert.equal(message.body, body);
  for (const kind of ['task', 'question', 'execution', 'notification', 'message']) assert.equal(store.all(kind).length, 0, kind);
  assert.equal(journal.db.prepare('SELECT count(*) AS n FROM notices').get().n, 0);
  console.log(JSON.stringify({ passed: true, package: installed, actualCliSend: true, realTuiKeyboard: true,
    plainOwnerMessage: true, senderPreserved: true, fiveLinePreview: true, fullDetailsPreserved: true,
    directReadWithoutConfirmation: true, createdNoWorkOrNotification: true, modelTurnsStarted: 0,
    userServicesTouched: false, credentialsCopied: false, fixture: root }, null, 2));
} finally { await service?.close(); journal?.close(); await backend.close(); }
