// Real human TUI against the selected package, with private disposable state.
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
const [{ startBackend }, { bootstrapNode }, { nativeBackendClient }, { NodeJournal }, { reconcileScheduleDefinitions }] = await Promise.all(
  ['backend-service', 'node-bootstrap', 'backend-client', 'node-journal', 'node-automation'].map(load));
const root = mkdtempSync('/tmp/opencode/relay-native-lifecycle-');
let backend, journal, timer, pending = Promise.resolve(), busy = false, closed = false, failure;
try {
  backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const store = backend.store, owner = store.authenticate(store.bootstrap().token);
  const bundle = bootstrapNode(store, owner, { key: 'local', id: 'local', name: 'Local', mode: 'roots', roots: [root] });
  const directory = join(root, 'workspace');
  store.command(owner, { key: 'enrol', action: 'agent.enrol', payload: { id: 'agent', nodeId: 'local', name: 'Archive me', directory } });
  store.command(owner, { key: 'attach', action: 'agent.attach', payload: { id: 'agent', directory, conversationId: 'disposable-session',
    bindingId: 'disposable-binding', expectedBindingRevision: 0 } });
  const context = join(root, 'operator.json');
  writeFileSync(context, JSON.stringify({ url: backend.origin, token: bundle.operatorToken, nodeId: 'local',
    instanceId: store.instance, scope: bundle.operatorCredential.scope }), { mode: 0o600 });
  journal = new NodeJournal(join(root, 'node.sqlite'), { nodeId: 'local', instanceId: store.instance });
  const api = nativeBackendClient({ url: backend.origin, token: bundle.nodeToken });
  const tick = () => {
    if (busy || closed) return;
    busy = true;
    pending = (async () => { await journal.poll(api); reconcileScheduleDefinitions(journal); await journal.flush(api); })()
      .catch(error => { failure = error; }).finally(() => { busy = false; });
  };
  tick(); timer = setInterval(tick, 20); timer.unref();
  const driver = fileURLToPath(new URL('../test/tui-lifecycle-pty.py', import.meta.url));
  const result = await promisify(execFile)('python3', [driver, process.execPath, join(installed, 'src/cli.mjs'), context, root], {
    timeout: 25000, env: { ...process.env, CI: 'true', CONTINUOUS_INTEGRATION: 'true', GITHUB_ACTIONS: 'true' },
  });
  assert.equal(JSON.parse(result.stdout).realTuiKeyboard, true);
  closed = true; clearInterval(timer); await pending; if (failure) throw failure;
  await journal.poll(api);
  const schedule = store.get('schedule', 'pty-job'), agent = store.get('agent', 'agent', true, true);
  assert.equal(schedule.cancelled, true); assert.equal(schedule.definition.enabled, false);
  assert.equal(schedule.appliedRevision, schedule.revision); assert.equal(schedule.definition.targetAgentId, agent.id);
  assert.ok(agent.deletedAt); assert.equal(agent.deletion.nativeProcessTerminationClaimed, false);
  assert.equal(store.query('agent').items.length, 0); assert.equal(store.all('execution').length, 0);
  assert.equal(store.all('headless_setup').length, 0); assert.equal(journal.works().length, 0);
  assert.ok(journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`agent-deleted:${agent.id}`));
  assert.equal(store.snapshot().collections.agent[0].id, agent.id);
  console.log(JSON.stringify({ passed: true, package: installed, realTuiKeyboard: true, humanScheduleCreate: true,
    humanScheduleDelete: true, inactiveAgentDelete: true, nodeCancellationAcknowledged: true,
    deletionFencedOnNode: true, historyRetained: true, modelTurnsStarted: 0,
    userServicesTouched: false, credentialsCopied: false, fixture: root }, null, 2));
} finally {
  closed = true; clearInterval(timer); await pending; journal?.close(); await backend?.close();
}
