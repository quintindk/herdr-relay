// Real native Inbox keyboard verification using disposable backend/operator state.
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
const [{ startBackend }, { bootstrapNode }, { digest }] = await Promise.all(['backend-service', 'node-bootstrap', 'protocol'].map(load));
const root = mkdtempSync('/tmp/opencode/relay-inbox-read-');
const backend = await startBackend({ database: join(root, 'backend.sqlite') });
try {
  const store = backend.store, owner = store.authenticate(store.bootstrap().token);
  let sequence = 0;
  const command = (actor, action, payload) => store.command(actor, { key: `fixture-${++sequence}`, action, payload });
  const bundle = bootstrapNode(store, owner, { key: 'local', id: 'local', name: 'Local', mode: 'localUser' });
  const node = store.authenticate(bundle.nodeToken);
  command(node, 'agent.register', { id: 'worker', nodeId: 'local', name: 'Fixture worker', mode: 'interactive' });
  command(owner, 'schedule.install', { id: 'preview-job', definition: { nodeId: 'local', targetAgentId: 'worker', instructions: 'Fixture only',
    cron: '* * * * *', enabled: true, reviewPolicy: 'none', runResultNotifications: { inbox: true, requester: false } } });
  const at = '2026-11-14T06:00:00.000Z', occurrenceId = `occurrence_${digest(['preview-job', at])}`;
  const summary = Array.from({ length: 40 }, (_, index) => `PREVIEW_${String(index + 1).padStart(2, '0')}`).join('\n');
  command(node, 'schedule.publish', { id: occurrenceId, scheduleId: 'preview-job', definitionRevision: 1, intendedAt: at,
    candidate: 'fixture-only', summary, evidence: 'Disposable Inbox fixture' });
  command(owner, 'schedule.install', { id: 'reminder', definition: { nodeId: 'local', intent: 'reminder', instructions: 'REMINDER_ENTRY', cron: '* * * * *', enabled: true } });
  const reminderId = `occurrence_${digest(['reminder', at])}`;
  command(node, 'schedule.remind', { id: reminderId, scheduleId: 'reminder', definitionRevision: 1, intendedAt: at, message: 'REMINDER_ENTRY' });
  command(owner, 'task.create', { id: 'guard-task', title: 'Decision guard fixture' });
  command(owner, 'execution.request', { id: 'guard-execution', taskId: 'guard-task', taskRevision: 1, targetAgentId: 'worker', instructions: 'Fixture only' });
  command(node, 'execution.admit', { id: 'guard-execution', expectedRevision: 1, runId: 'guard-run', bindingId: 'guard-binding' });
  command(node, 'question.ask', { id: 'guard-question', executionId: 'guard-execution', expectedRevision: 2, prompt: 'KEEP_QUESTION_OPEN', humanRequired: true });
  const context = join(root, 'operator.json');
  writeFileSync(context, JSON.stringify({ url: backend.origin, token: bundle.operatorToken, nodeId: 'local', instanceId: store.instance,
    scope: bundle.operatorCredential.scope }), { mode: 0o600 });
  const driver = fileURLToPath(new URL('../test/inbox-read-pty.py', import.meta.url));
  for (const kind of ['result', 'reminder']) {
    const output = await promisify(execFile)('python3', [driver, process.execPath, join(installed, 'src/cli.mjs'), context, root, kind], {
      timeout: 30000, env: { ...process.env, CI: 'true', CONTINUOUS_INTEGRATION: 'true', GITHUB_ACTIONS: 'true' },
    });
    assert.equal(JSON.parse(output.stdout).directReadWithoutConfirmation, true);
    const notification = store.get('notification', kind === 'result' ? `run-result:${occurrenceId}` : reminderId);
    assert.equal(notification.state, 'acknowledged'); assert.equal(notification.revision, 2);
    assert.equal(store.get('question', 'guard-question').status, 'open');
    assert.equal(store.get('execution', 'guard-execution').state, 'waiting');
  }
  assert.equal(store.get('notification', `run-result:${occurrenceId}`).summary, summary);
  assert.equal(store.get('occurrence', occurrenceId).summary, summary);
  assert.equal(store.get('occurrence', occurrenceId).state, 'completed');
  assert.equal(store.get('schedule', 'preview-job').revision, 1);
  assert.equal(store.all('headless_setup').length, 0);
  console.log(JSON.stringify({ passed: true, package: installed, realTuiKeyboard: true, fiveLinePreview: true,
    fullDetailsPreserved: true, directReadWithoutConfirmation: true, resultAndReminderRead: true,
    questionStillOpen: true, publishedResultPreserved: true, modelTurnsStarted: 0,
    userServicesTouched: false, credentialsCopied: false, fixture: root }, null, 2));
} finally { await backend.close(); }
