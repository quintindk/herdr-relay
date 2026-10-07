import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execute } from '../src/adapter.mjs';

async function fixture(t, { failures = 1, code = 'review_decision_uncertain', status = 409 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-review-wait-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const attempts = [];
  const runs = [];
  const paths = [];
  const controller = new AbortController();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    paths.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/runs') {
      res.end(JSON.stringify(runs));
      return;
    }
    if (req.method === 'POST' && req.url === '/runs') {
      const request = JSON.parse(body);
      attempts.push(request);
      if (attempts.length <= failures) {
        res.writeHead(status);
        res.end(JSON.stringify({ code, message: 'Dispatch rejected' }));
        return;
      }
      runs.push({ id: 'relay-run', request, backendRunId: request.runId, nativeState: 'settled',
        conversationId: 'conversation', settlement: { outcome: 'completed', evidence: 'Finished' } });
    }
    res.end(JSON.stringify(runs[0] ?? {}));
  });
  const socketPath = join(directory, 'relay.sock');
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const contextPath = join(directory, 'operator.json');
  writeFileSync(contextPath, JSON.stringify({ socketPath, token: 'operator-token' }), { mode: 0o600 });
  const logs = [];
  const ctx = { agent: { companyId: 'company', id: 'agent' }, runId: 'original-backend-run', authToken: 'backend-token',
    config: { relayContextFile: contextPath, bindingId: 'driver', bindingRevision: 7, timeoutSec: 2 },
    context: { taskId: 'task', relayScheduleId: 'schedule' }, signal: controller.signal,
    onLog: async (stream, message) => logs.push({ stream, message }) };
  return { ctx, attempts, runs, paths, controller, logs };
}

test('uncertain review retries the exact original dispatch and creates one run after resolution', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const expected = { bindingId: 'driver', bindingRevision: 7, companyId: 'company', agentId: 'agent',
    runId: 'original-backend-run', taskId: 'task', scheduleId: 'schedule' };
  const result = await execute(f.ctx);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.deepEqual(f.attempts, [expected, expected]);
  assert.equal(f.runs.length, 1);
  assert.deepEqual(f.runs[0].request, expected);
  assert.equal(f.paths.filter(path => path.endsWith('/attach')).length, 1);
  assert.ok(f.logs.some(log => log.message.includes('review_decision_uncertain')));
  assert.ok(!JSON.stringify(f.logs).includes('backend-token'));
});

test('uncertain review timeout stops before a retry can create a run', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  f.ctx.config.timeoutSec = 0.1;
  const result = await execute(f.ctx);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, true);
  assert.match(result.errorMessage, /timed out/);
  assert.deepEqual(f.paths, ['/runs']);
  assert.equal(f.runs.length, 0);
});

test('persistent uncertain review retries are bounded by the invocation timeout', { timeout: 3000 }, async t => {
  const f = await fixture(t, { failures: Infinity });
  f.ctx.config.timeoutSec = 0.6;
  const result = await execute(f.ctx);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, true);
  assert.ok(f.attempts.length >= 2 && f.attempts.length <= 3);
  assert.ok(f.attempts.every(attempt => JSON.stringify(attempt) === JSON.stringify(f.attempts[0])));
  assert.equal(f.runs.length, 0);
});

test('cancellation during the review retry wait stops without a run', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  f.ctx.onLog = async () => { setImmediate(() => f.controller.abort()); };
  const result = await execute(f.ctx);
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.match(result.errorMessage, /cancelled/);
  assert.deepEqual(f.paths, ['/runs']);
  assert.equal(f.runs.length, 0);
});

for (const stop of ['cancellation', 'timeout']) {
  test(`${stop} before initial dispatch only looks up existing work`, { timeout: 2000 }, async t => {
    const f = await fixture(t, { failures: 0 });
    if (stop === 'cancellation') f.controller.abort();
    else {
      f.ctx.config.timeoutSec = 0.01;
      f.ctx.onCancellationReady = () => delay(20);
    }
    const result = await execute(f.ctx);
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, stop === 'timeout');
    assert.deepEqual(f.paths, ['/runs']);
    assert.equal(f.attempts.length, 0);
    assert.equal(f.runs.length, 0);
  });
}

for (const [code, status] of [['dispatch_conflict', 409], ['forbidden', 403], ['stale_backend_run', 409], ['invalid_request', 400]]) {
  test(`initial ${code} remains definitive without retries`, { timeout: 2000 }, async t => {
    const f = await fixture(t, { code, status });
    await assert.rejects(execute(f.ctx), { code, status, message: 'Dispatch rejected' });
    assert.deepEqual(f.paths, ['/runs']);
    assert.equal(f.runs.length, 0);
  });
}
