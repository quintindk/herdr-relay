import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { enrolInteractive } from '../src/native-enrol.mjs';

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
  assert.equal(statSync(f.input.configFile).mode & 0o777, 0o600);
  assert.equal(statSync(config.bindings[0].authFile).mode & 0o777, 0o600);
  assert.notEqual(config.backend.token, f.token);
  assert.equal(config.bindings[0].workerTransport, 'cli');
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
