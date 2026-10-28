import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { installNativeInbox, uninstallNativePlugin } from '../src/native-inbox-install.mjs';
import { readOpenCodeConfig } from '../src/opencode-config-file.mjs';
import { pluginUpgradeFiles } from '../src/upgrade-plugin.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'relay-inbox-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contextFile = join(root, 'owner.json');
  writeFileSync(contextFile, JSON.stringify({ url: 'http://127.0.0.1:3210', token: 'owner-secret' }), { mode: 0o600 });
  return { root, input: { contextFile, configDirectory: root, sessionId: 'ses_human123', evidenceFile: join(root, 'evidence.jsonl') } };
}

test('bundled product detection and exact disable preferences survive a package and plugin-ID rename', t => {
  const f = fixture(t), release = join(f.root, 'previous-release'), old = join(release, 'packages/opencode-relay');
  mkdirSync(old, { recursive: true });
  writeFileSync(join(release, 'package.json'), JSON.stringify({ name: 'herdr-relay' }));
  writeFileSync(join(old, 'package.json'), JSON.stringify({ name: '@herdr/previous-brand' }));
  writeFileSync(join(old, 'server.mjs'), "export default {id:'herdr.relay.previous.server'};");
  writeFileSync(join(old, 'tui.mjs'), "export default {id:'herdr.relay.previous.tui'};");
  writeFileSync(join(f.root, 'opencode.json'), JSON.stringify({ plugins: [{ package: old, options: { workerDirectory: '/unchanged' } }] }));
  writeFileSync(join(f.root, 'cli.json'), '{"theme":{"name":"unchanged"},"plugins":["-herdr.relay.previous.tui","-other.tui"]}');
  const changes = pluginUpgradeFiles(f.root, '/candidate');
  assert.equal(changes.length, 2);
  assert.deepEqual(JSON.parse(changes.find(file => file.path.endsWith('cli.json')).after),
    { theme: { name: 'unchanged' }, plugins: ['-herdr.relay.tui', '-other.tui'] });
  assert.deepEqual(JSON.parse(changes.find(file => file.path.endsWith('opencode.json')).after).plugins,
    [{ package: '/candidate/packages/opencode-relay', options: { workerDirectory: '/unchanged' } }]);
  writeFileSync(join(f.root, 'opencode.json'), JSON.stringify({ plugins: [{ package: old, options: { humanProposals: true } }] }));
  assert.throws(() => pluginUpgradeFiles(f.root, '/candidate'), { code: 'upgrade_plugin_state_migration_required' });
});

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
  writeFileSync(join(f.root, 'opencode.json'), '{}');
  assert.throws(() => installNativeInbox(f.input), { code: 'configuration_conflict' });
});

test('plugin installation supports JSONC without losing unrelated comments/settings and can start before any human session exists', t => {
  const f = fixture(t), path = join(f.root, 'opencode.jsonc');
  const source = '{\n  // Keep my model and this comment.\n  "model": "chosen/model",\n  "plugins": [\n    // This is not Relay.\n    {"package":"other-plugin", "options": {"untouched":true}},\n  ],\n}\n';
  writeFileSync(path, source);
  const input = { ...f.input, sessionId: undefined, enrolmentOnly: true, nodeConfigFile: join(f.root, 'node/node.json') };
  const result = installNativeInbox(input);
  const after = readFileSync(path, 'utf8');
  assert.match(after, /Keep my model/); assert.match(after, /This is not Relay/);
  assert.equal(readOpenCodeConfig(path).value.model, 'chosen/model');
  assert.equal(readOpenCodeConfig(path).value.plugins.length, 2);
  assert.equal(existsSync(join(f.root, 'opencode.json')), false);
  assert.equal(readFileSync(result.changed.find(c => c.path === path).backup, 'utf8'), source);
  assert.equal(installNativeInbox(input).state, 'existing');
  const cli = readOpenCodeConfig(join(f.root, 'cli.json')).value;
  assert.equal(cli.plugins[0].options.notificationSessionId, undefined);
  assert.equal(cli.plugins[0].options.nativeNodeConfigFile, input.nodeConfigFile);
  assert.equal(uninstallNativePlugin({ configDirectory: f.root }).state, 'uninstalled');
  assert.match(readFileSync(path, 'utf8'), /This is not Relay/);
  assert.equal(readOpenCodeConfig(path).value.plugins.length, 1);
  assert.equal(uninstallNativePlugin({ configDirectory: f.root }).state, 'absent');
});

test('plugin upgrades replace a recognised old release path rather than installing a duplicate', t => {
  const f = fixture(t), old = join(f.root, 'old-release'); mkdirSync(old);
  writeFileSync(join(old, 'package.json'), JSON.stringify({ name: '@herdr/relay-opencode' }));
  writeFileSync(join(f.root, 'opencode.json'), JSON.stringify({ plugins: [{ package: old, options: { retained: true } }] }));
  installNativeInbox(f.input);
  const plugins = readOpenCodeConfig(join(f.root, 'opencode.json')).value.plugins;
  assert.equal(plugins.length, 1); assert.notEqual(plugins[0].package, old); assert.equal(plugins[0].options.retained, true);
});

test('plugin installation does not suppress first-run V1 terminal migration or bypass a disabled Relay directive', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'tui.json'), '{"theme":"existing"}');
  assert.throws(() => installNativeInbox(f.input), { code: 'configuration_conflict' });
  assert.equal(existsSync(join(f.root, 'cli.json')), false);
  rmSync(join(f.root, 'tui.json'));
  const old = join(f.root, 'disabled-release'); mkdirSync(old);
  writeFileSync(join(old, 'package.json'), JSON.stringify({ name: '@herdr/relay-opencode' }));
  writeFileSync(join(f.root, 'opencode.json'), JSON.stringify({ plugins: [`-${old}`] }));
  assert.throws(() => installNativeInbox(f.input), { code: 'configuration_conflict' });
});

test('inbox installer refuses malformed plugin configuration without partially installing', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'cli.json'), '{"plugins":{}}');
  assert.throws(() => installNativeInbox(f.input), { code: 'configuration_conflict' });
  assert.equal(readdirSync(f.root).includes('opencode.json'), false);
});
