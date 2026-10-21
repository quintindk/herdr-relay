import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { installNativeInbox } from '../src/native-inbox-install.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'relay-inbox-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contextFile = join(root, 'owner.json');
  writeFileSync(contextFile, JSON.stringify({ url: 'http://127.0.0.1:3210', token: 'owner-secret' }), { mode: 0o600 });
  return { root, input: { contextFile, configDirectory: root, sessionId: 'ses_human123', evidenceFile: join(root, 'evidence.jsonl') } };
}

test('inbox installer preserves unrelated configuration, makes private backups and is repeat-safe', t => {
  const f = fixture(t), serverFile = join(f.root, 'opencode.json'), cliFile = join(f.root, 'cli.json');
  const server = { model: 'unchanged/model', plugins: ['other-plugin'], permissions: [{ action: '*', effect: 'ask', resource: '*' }] };
  const cli = { theme: { name: 'one-dark' }, plugins: [{ package: 'other-cli', options: { untouched: true } }] };
  writeFileSync(serverFile, JSON.stringify(server)); writeFileSync(cliFile, JSON.stringify(cli));
  const result = installNativeInbox(f.input);
  assert.equal(result.state, 'installed'); assert.equal(result.serverRestarted, false); assert.equal(result.permissionsChanged, false);
  const nextServer = JSON.parse(readFileSync(serverFile, 'utf8')), nextCli = JSON.parse(readFileSync(cliFile, 'utf8'));
  assert.equal(nextServer.model, server.model); assert.deepEqual(nextServer.permissions, server.permissions);
  assert.equal(nextServer.plugins[0], server.plugins[0]);
  assert.equal(nextServer.plugins[1].options.workerDirectory, dirname(nextCli.plugins[1].options.nativeNodeConfigFile));
  assert.equal(nextServer.plugins[1].options.ownerContextFile, undefined);
  assert.deepEqual(nextCli.theme, cli.theme); assert.deepEqual(nextCli.plugins[0], cli.plugins[0]);
  assert.equal(nextCli.plugins[1].options.notificationSessionId, f.input.sessionId);
  assert.equal(nextCli.plugins[1].options.ownerContextFile, f.input.contextFile);
  assert.equal(JSON.stringify(nextCli).includes('owner-secret'), false);
  assert.equal(statSync(cliFile).mode & 0o777, 0o600);
  for (const item of result.changed) { assert.equal(statSync(item.backup).mode & 0o777, 0o600); }
  const before = readdirSync(f.root);
  assert.equal(installNativeInbox(f.input).state, 'existing'); assert.deepEqual(readdirSync(f.root), before);
  assert.equal(readFileSync(result.changed[0].backup, 'utf8'), JSON.stringify(server));
});

test('inbox installer refuses conflicting scope before editing either file', t => {
  const f = fixture(t);
  installNativeInbox(f.input);
  const server = readFileSync(join(f.root, 'opencode.json'), 'utf8');
  const cli = readFileSync(join(f.root, 'cli.json'), 'utf8');
  assert.throws(() => installNativeInbox({ ...f.input, sessionId: 'ses_other' }), { code: 'configuration_conflict' });
  assert.equal(readFileSync(join(f.root, 'opencode.json'), 'utf8'), server);
  assert.equal(readFileSync(join(f.root, 'cli.json'), 'utf8'), cli);
});

test('inbox installer refuses JSONC shadowing and missing identity', t => {
  const f = fixture(t);
  assert.throws(() => installNativeInbox({ ...f.input, sessionId: undefined }), { code: 'invalid_request' });
  writeFileSync(join(f.root, 'opencode.jsonc'), '{}');
  assert.throws(() => installNativeInbox(f.input), { code: 'configuration_conflict' });
});

test('inbox installer refuses malformed plugin configuration without partially installing', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'cli.json'), '{"plugins":{}}');
  assert.throws(() => installNativeInbox(f.input), { code: 'configuration_conflict' });
  assert.equal(readdirSync(f.root).includes('opencode.json'), false);
});
