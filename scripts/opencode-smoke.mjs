// Opt-in live-model test. Starts its own isolated OpenCode server and removes
// copied credentials on exit. The Paperclip boundary is deterministic here.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { execute } from '../src/adapter.mjs';

assert.equal(execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim(), '1.18.34', 'Revalidate the native contract before changing the pinned version');
const root = mkdtempSync(join(process.env.OPENCODE_SMOKE_TMP ?? tmpdir(), 'relay-opencode-smoke-'));
const home = join(root, 'home');
const workspace = join(root, 'workspace');
mkdirSync(workspace);
mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
mkdirSync(join(home, '.config/opencode'), { recursive: true });
const auth = join(home, '.local/share/opencode/auth.json');
let child;
let service;
let adapter;
let shuttingDown = false;
let serverLog = '';
const polling = new AbortController();
const controller = new AbortController();
const cleanup = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  controller.abort();
  polling.abort();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    process.kill(-child.pid, 'SIGTERM');
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
    await exited;
    clearTimeout(timer);
  }
  await service?.close();
  rmSync(root, { recursive: true, force: true });
};
process.once('SIGINT', () => { cleanup().finally(() => process.exit(130)); });
process.once('SIGTERM', () => { cleanup().finally(() => process.exit(143)); });

try {
  copyFileSync(process.env.OPENCODE_SMOKE_AUTH ?? join(homedir(), '.local/share/opencode/auth.json'), auth);
  chmodSync(auth, 0o600);
  const model = process.env.OPENCODE_SMOKE_MODEL ?? 'github-copilot/gpt-6-astra';
  const [providerID, ...modelParts] = model.split('/');
  const modelID = modelParts.join('/');
  writeFileSync(join(home, '.config/opencode/opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json', model, autoupdate: false, share: 'disabled', plugin: [],
    permission: { bash: 'allow', edit: 'allow', task: 'deny', question: 'deny', external_directory: 'allow' },
    compaction: { auto: false },
  }));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'en_GB.UTF-8', HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'),
    OPENCODE_PURE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' };
  child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure'], {
    cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { serverLog = (serverLog + chunk).slice(-8000); });
  const origin = `http://127.0.0.1:${port}`;
  const http = async (method, path, body) => {
    const url = new URL(path, origin);
    url.searchParams.set('directory', workspace);
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, `Native HTTP ${response.status}`);
    return response.json();
  };
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Isolated OpenCode exited: ${serverLog}`);
    try { await http('GET', '/global/health'); healthy = true; break; } catch { await delay(200); }
  }
  assert.ok(healthy, 'Isolated OpenCode did not become ready');
  const session = await http('POST', '/session', { title: 'Relay native delivery smoke' });
  const word = `continuity-${randomUUID()}`;
  await http('POST', `/session/${session.id}/message`, {
    noReply: true, model: { providerID, modelID }, parts: [{ type: 'text', text: `Remember this exact continuity word for later work: ${word}` }],
  });
  const comments = [];
  service = await startService({ directory: join(root, 'relay'), paperclipUrl: 'http://paperclip.test',
    api: async (run, token, method, path, body) => {
      assert.equal(token, 'fixture-backend-token');
      if (path.endsWith('/comments')) {
        if (method === 'GET') return comments;
        const receipt = { id: randomUUID(), ...body, authorAgentId: run.request.agentId, createdByRunId: run.request.runId };
        comments.push(receipt);
        return receipt;
      }
      return { companyId: 'fixture-company', title: 'Recall existing context and submit',
        description: 'Write the exact continuity word from the earlier conversation into result.md in your working directory. Submit it through the supplied Relay CLI with candidate sha256:smoke-fixture. Then reply REPORTED. This is a protocol fixture, so that candidate value is intentional.' };
    } });
  const operator = { socketPath: service.socketPath, token: service.token };
  const operatorPath = join(root, 'operator.json');
  writeFileSync(operatorPath, JSON.stringify(operator), { mode: 0o600 });
  await call(operator, 'POST', '/bindings', {
    id: 'smoke', companyId: 'fixture-company', agentId: 'fixture-agent', harness: 'opencode',
    instanceId: origin, conversationId: session.id, delivery: 'opencode', opencode: {
      url: origin, directory: workspace, projectID: session.projectID, sessionCreatedAt: session.time.created,
      exclusive: true, model: { providerID, modelID },
    },
  });
  adapter = execute({ agent: { id: 'fixture-agent', companyId: 'fixture-company' }, runId: 'fixture-run',
    authToken: 'fixture-backend-token', config: { relayContextFile: operatorPath, bindingId: 'smoke', timeoutSec: 180 },
    context: { taskId: 'fixture-task' }, signal: controller.signal, onLog: async () => {} });
  const timeout = setTimeout(() => controller.abort(), 180000);
  let finished;
  try {
    finished = await Promise.race([adapter, delay(190000, undefined, { signal: polling.signal }).then(() => { throw new Error('Native smoke deadline exceeded'); })]);
  } finally { clearTimeout(timeout); }
  assert.equal(finished.exitCode, 0);
  const run = service.store.runs()[0];
  assert.ok(run.result.summary.includes(word), 'Existing conversation context was not recalled');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].authorAgentId, 'fixture-agent');
  assert.equal(comments[0].createdByRunId, 'fixture-run');
  const messages = await http('GET', `/session/${session.id}/message`);
  assert.equal(messages.filter(message => message.info.id === run.invocation.messageId).length, 1);
  assert.equal((await http('GET', `/session/${session.id}`)).id, session.id);
  console.log(JSON.stringify({ opencodeVersion: '1.18.34', backend: 'deterministic fixture',
    realModel: model, existingContextRecalled: true, nativePromptCount: 1, comments: comments.length,
    attributed: true, conversationPreserved: true, settlement: run.settlement, native: run.native }, null, 2));
} catch (error) {
  // A disconnected adapter intentionally keeps supervising. Bound this test's
  // lifecycle after cleanup, rather than letting its retry loop hang the probe.
  console.error(JSON.stringify({ error: error.message, native: service?.store.runs()[0]?.native }));
  await cleanup();
  process.exit(1);
} finally {
  // On a failed smoke, ending our isolated server is cleanup, never Relay evidence.
  await cleanup();
  process.exitCode ??= 0;
}
