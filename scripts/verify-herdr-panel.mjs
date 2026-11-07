// Real Herdr server and native board, isolated from the human's HOME/session.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { createNodeBundle, joinNode } from '../src/native-onboarding.mjs';
import { hashBytes } from '../src/release-install.mjs';

const scratch = resolve(process.env.RELAY_TEST_SCRATCH ?? '/tmp/opencode'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(scratch, 'herdr-panel-')), home = join(root, 'home'), state = join(home, '.local/state');
const workspace = join(root, 'workspace'), name = `p-${process.pid}`;
const packageDirectory = resolve(process.env.RELAY_PACKAGE_DIRECTORY || '.');
const artifact = process.env.RELAY_PACKAGE_ARTIFACT ? resolve(process.env.RELAY_PACKAGE_ARTIFACT) : null;
const herdrBinary = process.env.HERDR_BINARY || 'herdr';
for (const path of [home, state, workspace, join(home, '.config/herdr')]) mkdirSync(path, { recursive: true });
const env = { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', SHELL: '/bin/sh',
  XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: state, XDG_DATA_HOME: join(home, '.local/share'),
  XDG_CACHE_HOME: join(home, '.cache'), HERDR_CONFIG_PATH: join(home, '.config/herdr/config.toml'), HERDR_BIN_PATH: herdrBinary };
writeFileSync(env.HERDR_CONFIG_PATH, 'onboarding = false\n');
const bin = join(root, 'bin'); mkdirSync(bin);
symlinkSync(join(packageDirectory, 'src/cli.mjs'), join(bin, 'herdr-relay'));
const exec = promisify(execFile);
const herdr = async (...args) => {
  const json = ['plugin list', 'session list'].includes(args.slice(0, 2).join(' ')) ? ['--json'] : [];
  const { stdout } = await exec(herdrBinary, ['--session', name, ...args, ...json], { env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  if (!stdout.trim()) return {};
  const value = JSON.parse(stdout); assert.equal(value.error, undefined, JSON.stringify(value.error)); return value.result;
};
const installPanel = async () => {
  if (artifact) {
    const { stdout } = await exec(process.execPath, [join(packageDirectory, 'src/cli.mjs'), 'release', 'install',
      '--artifact', artifact, '--sha256', hashBytes(readFileSync(artifact)), '--bin-dir', bin,
      '--upgrade-dir', join(root, 'upgrades'), '--releases-dir', join(root, 'releases')], { env, timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    assert.equal(result.complete, true, JSON.stringify(result)); assert.equal(result.servicesChanged, false);
    assert.equal(result.installer.mode, 'candidate'); assert.equal(result.installer.version, result.version);
    return result.herdr;
  }
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
let server, backend, activeBoard, serverLog = '';
try {
  backend = await startBackend({ database: ':memory:' });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const bundleFile = join(root, 'fixture-bundle.json');
  await createNodeBundle({ api: owner, output: bundleFile, key: 'fixture-node', name: 'Isolated node', url: backend.origin, mode: 'localUser' });
  const joined = await joinNode({ bundleFile, configFile: join(state, 'herdr-relay-native/node.json') });
  await owner('POST', '/v1/commands', { key: 'task', action: 'task.create', payload: { id: 'fixture-task', title: 'NATIVE_PANEL_FIXTURE' } });
  const nodeConfig = JSON.parse(readFileSync(join(state, 'herdr-relay-native/node.json'), 'utf8'));
  const node = nativeBackendClient(nodeConfig.backend);
  await owner('POST', '/v1/commands', { key: 'source', action: 'agent.enrol', payload: { id: 'source', name: 'Panel fixture source', nodeId: joined.nodeId, directory: workspace } });
  await owner('POST', '/v1/commands', { key: 'attach', action: 'agent.attach', payload: { id: 'source', expectedBindingRevision: 0,
    conversationId: 'ses_panel_source', bindingId: 'panel-source', directory: workspace } });
  const approval = await owner('POST', '/v1/grants/ui-session', { terminalId: 'fixture-seed' }), ui = owner.withToken(approval.token);
  await ui('POST', '/v1/commands', { key: 'wrong-scope', action: 'grant.create', payload: { id: 'bad-lab-permission', requesterAgentId: 'source', nodeId: joined.nodeId,
    scope: { mode: 'roots', roots: [join(root, 'lab')], profiles: ['build'], maxAgents: 1,
      allowNewEnrolments: true, allowCreateDirectories: true, allowReplacement: false, allowDispatch: true, reviewPolicy: 'human' } } });
  let preparation = await node('POST', '/v1/commands', { key: 'prepare-lab', action: 'interactive.request', payload: { id: 'panel-lab', grantId: 'bad-lab-permission',
    requesterAgentId: 'source', sourceConversationId: 'ses_panel_source', sourceBindingRevision: 1, nodeId: joined.nodeId,
    directory: join(root, 'lab'), name: 'LAB_REPAIR_FIXTURE', createDirectory: true } });
  preparation = await node('POST', '/v1/commands', { key: 'legacy-block', action: 'interactive.progress', payload: {
    id: preparation.id, expectedRevision: preparation.revision, state: 'blocked', reason: 'agent_limit' } });
  await node('POST', '/v1/commands', { key: 'inspect-block', action: 'interactive.repair_checkpoint', payload: { id: preparation.id, expectedRevision: preparation.revision,
    checkpoint: { protocol: 1, safe: true, phase: 'initial', unresolved: [] } } });
  const oldPlugin = join(root, 'old-plugin'); mkdirSync(oldPlugin);
  writeFileSync(join(oldPlugin, 'herdr-plugin.toml'), 'id="quintindk.herdr-relay"\nname="Old Relay fixture"\nversion="0.1.0"\nmin_herdr_version="0.9.3"\nplatforms=["linux"]\n');
  await herdr('plugin', 'link', oldPlugin);
  const offlineSetup = await installPanel();
  assert.equal(offlineSetup.configReload.state, 'not_running');
  assert.equal(offlineSetup.shortcut.state, 'installed');
  assert.match(readFileSync(env.HERDR_CONFIG_PATH, 'utf8'), /quintindk\.herdr-relay\.toggle/);
  server = spawn(herdrBinary, ['--session', name, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { serverLog += data; }); server.stderr.on('data', data => { serverLog += data; });
  await wait('isolated Herdr server ready', async () => { const result = await herdr('pane', 'list'); return result && result.panes; });
  const runningSetup = await installPanel();
  assert.equal(runningSetup.shortcut.state, 'existing');
  assert.deepEqual(runningSetup.configReload, { state: 'reloaded', sessions: [name] });
  const plugins = (await herdr('plugin', 'list')).plugins;
  assert.equal(plugins.find(plugin => plugin.plugin_id === 'quintindk.herdr-relay').plugin_root, offlineSetup.installation);
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
  activeBoard = board;
  const keys = async (...keys) => {
    // Separate terminal input events. Sending a whole navigation sequence as one
    // PTY write is paste input, not a series of keyboard presses in Ink.
    for (const key of keys) { await herdr('pane', 'send-keys', board.pane_id, key); await delay(45); }
  };
  const output = text => herdr('pane', 'wait-output', board.pane_id, '--match', text, '--timeout', '15000');
  await keys('tab', 'tab', 'tab'); await output('RELAY / GRANTS');
  await keys('2'); await output('LAB_REPAIR_FIXTURE');
  await keys('p'); await output('Repair interactive preparation');
  await keys('enter'); await output('Confirm: Request repair approval');
  assert.equal(backend.store.all('grant_request').length, 0, 'Repair preview must not request approval yet');
  await keys('enter'); await output('Repair permission requested.');
  await wait('linked repair approval requested through keyboard', async () => backend.store.all('grant_request').find(r => r.kind === 'interactive_repair'));
  await keys('1'); await keys('enter'); await output('Approve repair once');
  await keys('enter'); await output('Confirm: Approve repair once');
  await keys('enter'); await output('Permission recorded.');
  await wait('keyboard repair approval retains the original preparation', async () => {
    const request = backend.store.get('provision_request', preparation.id);
    return request.state === 'requested' && request.repair?.attempt === 1 && request.agentId === preparation.agentId;
  });
  await keys('2', '/', ...'bad-lab-permission', 'enter');
  await keys('v'); await output('Confirm: Revoke');
  assert.equal(backend.store.get('provision_grant', 'bad-lab-permission').state, 'active');
  await keys('enter');
  await wait('keyboard revocation applies to the selected original grant', async () => backend.store.get('provision_grant', 'bad-lab-permission').state === 'revoked');
  assert.equal(backend.store.all('provision_request').length, 1); assert.equal(backend.store.all('agent').length, 1);
  assert.equal(backend.store.get('task', 'fixture-task').revision, 1); assert.equal(backend.store.all('execution').length, 0);
  assert.equal(existsSync(join(root, 'lab')), false, 'Human approval alone must not create resources');
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
    automaticPanelSetup: true, candidateInstallerHandover: Boolean(artifact), stagedPackageAuditVerified: Boolean(artifact),
    stalePluginRelinked: true, shortcutInstalled: true, offlineSetupStartsNoServer: true, runningConfigReloaded: true,
    immediateKeyboardFocus: true, toggleRestoresOrigin: true, quitRestoresOrigin: true, quitDoesNotStealFocus: true,
    keyboardLinkedRepairRequested: true, keyboardRepairApproved: true, keyboardGrantRevocationVerified: true, originalPreparationAndTaskPreserved: true,
    userServicesTouched: false, fixture: root }, null, 2));
} catch (error) {
  console.error(serverLog);
  if (activeBoard) try {
    const { stdout } = await exec(herdrBinary, ['--session', name, 'pane', 'read', activeBoard.pane_id, '--source', 'visible', '--lines', '100', '--raw'], { env, timeout: 10000 });
    console.error(stdout);
  } catch {}
  throw error;
}
finally {
  if (server) { try { await herdr('server', 'stop'); } catch { server.kill('SIGTERM'); } }
  await backend?.close();
}
