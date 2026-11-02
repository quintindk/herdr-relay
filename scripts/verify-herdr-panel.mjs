// Real Herdr server and native board, isolated from the human's HOME/session.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { createNodeBundle, joinNode } from '../src/native-onboarding.mjs';

const root = mkdtempSync('/tmp/opencode/relay-herdr-panel-'), home = join(root, 'home'), state = join(home, '.local/state');
const workspace = join(root, 'workspace'), name = `rc4-panel-${process.pid}`;
const packageDirectory = resolve(process.env.RELAY_PACKAGE_DIRECTORY || '.');
for (const path of [home, state, workspace, join(home, '.config/herdr')]) mkdirSync(path, { recursive: true });
const env = { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', SHELL: '/bin/sh',
  XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: state, XDG_DATA_HOME: join(home, '.local/share'),
  XDG_CACHE_HOME: join(home, '.cache'), HERDR_CONFIG_PATH: join(home, '.config/herdr/config.toml') };
writeFileSync(env.HERDR_CONFIG_PATH, 'onboarding = false\n');
const exec = promisify(execFile);
const herdr = async (...args) => {
  const json = ['plugin list', 'session list'].includes(args.slice(0, 2).join(' ')) ? ['--json'] : [];
  const { stdout } = await exec('herdr', ['--session', name, ...args, ...json], { env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  if (!stdout.trim()) return {};
  const value = JSON.parse(stdout); assert.equal(value.error, undefined, JSON.stringify(value.error)); return value.result;
};
const installPanel = async () => {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
    import { installHerdrPanel } from ${JSON.stringify(pathToFileURL(join(packageDirectory, 'src/herdr-install.mjs')).href)};
    console.log(JSON.stringify(await installHerdrPanel({ sourceDirectory: ${JSON.stringify(packageDirectory)} })));
  `], { env, timeout: 60000 });
  const result = JSON.parse(stdout); assert.equal(result.complete, true, JSON.stringify(result)); return result;
};
async function wait(label, inspect) {
  const until = Date.now() + 20000; let last;
  while (Date.now() < until) { try { const result = await inspect(); if (result) return result; } catch (error) { last = error; } await delay(100); }
  throw Error(`${label}: ${last?.message || 'condition not observed'}`);
}
let server, backend, serverLog = '';
try {
  backend = await startBackend({ database: ':memory:' });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const bundleFile = join(root, 'fixture-bundle.json');
  await createNodeBundle({ api: owner, output: bundleFile, key: 'fixture-node', name: 'Isolated node', url: backend.origin, mode: 'localUser' });
  await joinNode({ bundleFile, configFile: join(state, 'herdr-relay-native/node.json') });
  await owner('POST', '/v1/commands', { key: 'task', action: 'task.create', payload: { id: 'fixture-task', title: 'NATIVE_PANEL_FIXTURE' } });
  const oldPlugin = join(root, 'old-plugin'); mkdirSync(oldPlugin);
  writeFileSync(join(oldPlugin, 'herdr-plugin.toml'), 'id="quintindk.herdr-relay"\nname="Old Relay fixture"\nversion="0.1.0"\nmin_herdr_version="0.9.3"\nplatforms=["linux"]\n');
  await herdr('plugin', 'link', oldPlugin);
  const offlineSetup = await installPanel();
  assert.equal(offlineSetup.configReload.state, 'not_running');
  assert.equal(offlineSetup.shortcut.state, 'installed');
  assert.match(readFileSync(env.HERDR_CONFIG_PATH, 'utf8'), /quintindk\.herdr-relay\.toggle/);
  server = spawn('herdr', ['--session', name, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { serverLog += data; }); server.stderr.on('data', data => { serverLog += data; });
  await wait('isolated Herdr server ready', async () => { const result = await herdr('pane', 'list'); return result && result.panes; });
  const runningSetup = await installPanel();
  assert.equal(runningSetup.shortcut.state, 'existing');
  assert.deepEqual(runningSetup.configReload, { state: 'reloaded', sessions: [name] });
  const plugins = (await herdr('plugin', 'list')).plugins;
  assert.equal(plugins.find(plugin => plugin.plugin_id === 'quintindk.herdr-relay').plugin_root, packageDirectory);
  const created = await herdr('workspace', 'create', '--cwd', workspace, '--label', 'RC4 panel fixture', '--focus');
  const anchor = created.root_pane;
  assert.ok(anchor?.pane_id);
  const panes = () => herdr('pane', 'list').then(result => result.panes);
  const open = async () => {
    await herdr('plugin', 'action', 'invoke', 'toggle', '--plugin', 'quintindk.herdr-relay');
    const board = await wait('native panel focused', async () => (await panes()).find(p => p.tab_id === anchor.tab_id && p.pane_id !== anchor.pane_id && p.focused));
    await herdr('pane', 'wait-output', board.pane_id, '--match', 'NATIVE_PANEL_FIXTURE', '--timeout', '15000');
    return board;
  };
  const board = await open();
  await herdr('plugin', 'action', 'invoke', 'toggle', '--plugin', 'quintindk.herdr-relay');
  await wait('toggle closes only its panel and restores origin', async () => {
    const items = await panes(); return !items.some(p => p.pane_id === board.pane_id) && items.some(p => p.pane_id === anchor.pane_id && p.focused);
  });
  const second = await open();
  await herdr('pane', 'send-keys', second.pane_id, 'q');
  await wait('q closes panel and restores original focus', async () => {
    const items = await panes(); return !items.some(p => p.pane_id === second.pane_id) && items.some(p => p.pane_id === anchor.pane_id && p.focused);
  });
  const third = await open();
  const other = (await herdr('pane', 'split', '--pane', anchor.pane_id, '--direction', 'down', '--cwd', workspace, '--focus')).pane;
  await herdr('pane', 'send-keys', third.pane_id, 'q');
  await wait('quitting an unfocused panel does not steal focus', async () => {
    const items = await panes(); return !items.some(p => p.pane_id === third.pane_id) && items.some(p => p.pane_id === other.pane_id && p.focused);
  });
  console.log(JSON.stringify({ passed: true, realHerdrServer: true, scopedNodeOnlyBoard: true, nativeTaskDisplayed: true,
    automaticPanelSetup: true, stalePluginRelinked: true, shortcutInstalled: true, offlineSetupStartsNoServer: true, runningConfigReloaded: true,
    immediateKeyboardFocus: true, toggleRestoresOrigin: true, quitRestoresOrigin: true, quitDoesNotStealFocus: true,
    userServicesTouched: false, fixture: root }, null, 2));
} catch (error) { console.error(serverLog); throw error; }
finally {
  if (server) { try { await herdr('server', 'stop'); } catch { server.kill('SIGTERM'); } }
  await backend?.close();
}
