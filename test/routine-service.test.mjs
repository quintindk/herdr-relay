import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { digest } from '../src/protocol.mjs';

test('routine preview/list use Relay routes and preserve credential boundaries', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-routine-service-'));
  const service = await startService({ directory: root, paperclipUrl: 'http://127.0.0.1:1' });
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const worker = service.store.register({ id: 'worker', companyId: 'company', agentId: 'agent',
    harness: 'opencode', instanceId: 'instance', conversationId: 'conversation', delivery: 'pull' });
  const identity = { bindingId: 'worker', observedId: 'herdr-agent:worker', conversationId: 'conversation', terminalId: 'terminal', directory: '/work' };
  service.store.saveOperation({ id: identity.observedId, runId: '', availability: 'present',
    identity: { conversationId: 'conversation' }, placement: { terminalId: 'terminal', directory: '/work' } });
  service.store.saveOperation({ id: 'opencode-bridge:worker', runId: '', identity, state: 'configured', tokenHash: digest('bridge') });
  const preview = await call(service, 'POST', '/routines/preview', { cron: '0 8 * * 1-5' });
  assert.equal(preview.timezone, 'Africa/Johannesburg');
  assert.equal(preview.nextRuns.length, 3);
  const native = { socketPath: service.socketPath, token: 'bridge' };
  const snapshot = { epoch: 'epoch', conversationId: 'conversation', terminalId: 'terminal', sessionCreatedAt: 123, idle: false };
  assert.equal((await call(native, 'POST', '/bridge/routine-preview', { ...snapshot, cron: '0 8 * * 1-5' })).nextRuns.length, 3);
  assert.deepEqual(await call(native, 'POST', '/bridge/routine-list', snapshot), { routines: [] });
  await assert.rejects(call(native, 'POST', '/routines/manage', { action: 'list', companyId: 'company' }), { code: 'forbidden' });
  await assert.rejects(call({ ...native, token: worker.token }, 'POST', '/routines/preview', { cron: '* * * * *' }), { code: 'forbidden' });
  await assert.rejects(call(native, 'POST', '/bridge/routine-create', { ...snapshot, targetBindingId: 'worker' }), { code: 'invalid_routine_source' });
  assert.deepEqual(service.store.runs(), []);
  assert.equal(service.store.db.prepare("SELECT count(*) AS n FROM operations WHERE id LIKE 'routine:%'").get().n, 0);

  const context = join(root, 'context.json'), input = join(root, 'preview.json');
  writeFileSync(context, JSON.stringify({ socketPath: service.socketPath, token: service.token }), { mode: 0o600 });
  writeFileSync(input, JSON.stringify({ cron: '0 9 * * 1-5', timezone: 'UTC' }));
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, '--context', context, 'routine', 'preview', '--file', input], { timeout: 15000 });
  assert.equal(JSON.parse(stdout).timezone, 'UTC');
});
