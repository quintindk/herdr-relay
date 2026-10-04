import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../src/service.mjs';
import { execute } from '../src/adapter.mjs';

async function fixture(t, { cancel = false, conflict = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-adapter-'));
  const service = await startService({ directory, paperclipUrl: 'http://paperclip.test', api: async () => ({}) });
  service.store.register({ id: 'driver', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'session' });
  const payload = { bindingId: 'driver', bindingRevision: 1, companyId: 'company', agentId: 'agent', runId: 'backend', taskId: 'task' };
  if (conflict) service.store.dispatch({ ...payload, taskId: 'another-task' });
  const attempts = [];
  const controller = new AbortController();
  let lost = false;
  let attaches = 0;
  const proxy = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/runs' && req.method === 'POST') attempts.push(JSON.parse(body));
    if (req.url.endsWith('/attach')) {
      attaches++;
      if (cancel) assert.equal(service.store.runs()[0].cancellationRequested, true, 'Attach must follow cancellation');
    }
    const upstream = request({ socketPath: service.socketPath, path: req.url, method: req.method, headers: req.headers }, response => {
      let responseBody = '';
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => {
        if (!conflict && req.url === '/runs' && req.method === 'POST' && !lost) {
          lost = true;
          if (cancel) controller.abort();
          else {
            // The worker can finish even though its adapter missed the receipt.
            const run = service.store.runs()[0];
            service.store.acknowledge(run.id);
            service.store.submit(run.id, { key: 'one', summary: 'Done', candidate: 'fixture' });
            service.store.publication(run.id, { state: 'recorded', commentId: 'existing' });
            service.store.settle(run.id, { outcome: 'completed', evidence: 'Fixture native completion' });
          }
          req.socket.destroy();
          return;
        }
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      });
    });
    upstream.on('error', () => res.destroy());
    upstream.end(body);
  });
  const socketPath = join(directory, 'proxy.sock');
  await new Promise(resolve => proxy.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise(resolve => proxy.close(resolve));
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const contextPath = join(directory, 'operator.json');
  writeFileSync(contextPath, JSON.stringify({ socketPath, token: service.token }), { mode: 0o600 });
  const logs = [];
  const run = () => execute({ agent: { companyId: 'company', id: 'agent' }, runId: 'backend', authToken: 'backend-token',
    config: { relayContextFile: contextPath, bindingId: 'driver' }, context: { taskId: 'task' },
    signal: controller.signal, onLog: async (stream, message) => logs.push({ stream, message }) });
  return { service, run, attempts, logs, attaches: () => attaches };
}

test('adapter replays immutable dispatch after a lost committed response', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).exitCode, 0);
  assert.equal(f.attempts.length, 2);
  assert.deepEqual(f.attempts[0], f.attempts[1]);
  assert.equal(f.service.store.runs().length, 1);
  assert.ok(f.logs.some(log => log.message.includes('reconciliationPending')));
  assert.ok(!JSON.stringify(f.logs).includes('backend-token'));
});

test('cancellation during lost initial receipt is recovered before attaching credentials', async t => {
  const f = await fixture(t, { cancel: true });
  assert.equal((await f.run()).exitCode, 1);
  assert.equal(f.attempts.length, 2);
  assert.equal(f.attaches(), 1);
  assert.equal(f.service.store.runs()[0].settlement.outcome, 'cancelled');
});

test('definitive initial dispatch conflicts fail rather than retry forever', async t => {
  const f = await fixture(t, { conflict: true });
  await assert.rejects(f.run(), error => error.code === 'dispatch_conflict');
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attaches(), 0);
});
