import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installHerdrPanel } from '../src/herdr-install.mjs';

const execute = promisify(execFile);
const pluginId = 'quintindk.herdr-relay';

function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/herdr-install-'), sourceDirectory = join(root, 'verified release');
  const herdrConfig = join(root, 'custom herdr/config.toml');
  mkdirSync(join(sourceDirectory, 'scripts'), { recursive: true });
  copyFileSync(new URL('../scripts/install-herdr-shortcut.py', import.meta.url), join(sourceDirectory, 'scripts/install-herdr-shortcut.py'));
  mkdirSync(join(root, 'custom herdr'));
  const source = '# Preserve preferences\n[theme]\nname = "one-dark"\n\n[[keys.command]]\nkey="prefix+e"\ntype="plugin_action"\ncommand="other.open"\n';
  writeFileSync(herdrConfig, source);
  const f = { root, sourceDirectory, herdrConfig, source, calls: [], plugins: [],
    sessions: [{ name: 'default', running: true }, { name: 'work', running: true }, { name: 'stopped', running: false }] };
  f.input = { sourceDirectory, herdrConfig };
  f.run = async (command, args, options) => {
    f.calls.push({ command, args });
    assert.equal(options.env.HERDR_CONFIG_PATH, herdrConfig);
    if (command === 'python3') {
      assert.equal(args[0], join(sourceDirectory, 'scripts/install-herdr-shortcut.py'));
      if (f.pythonMissing) throw Object.assign(Error('Python was not found'), { code: 'ENOENT' });
      return execute(command, args, options);
    }
    assert.equal(command, process.env.HERDR_BIN_PATH || 'herdr');
    const action = args.at(-1) === '--json' ? args.slice(0, -1) : args;
    const json = result => ({ stdout: JSON.stringify({ result }) });
    if (action.join(' ') === 'plugin list') {
      assert.equal(args.at(-1), '--json');
      if (f.herdrMissing) throw Object.assign(Error('Herdr was not found'), { code: 'ENOENT' });
      return json({ plugins: f.plugins });
    }
    if (action.slice(0, 2).join(' ') === 'plugin link') {
      assert.deepEqual(action, ['plugin', 'link', sourceDirectory]);
      if (f.linkError) return { stdout: JSON.stringify({ error: { code: 'link_refused', message: 'Fixture link refused' } }) };
      if (f.linkExitError) throw Object.assign(Error('Command failed'), { code: 1,
        stdout: JSON.stringify({ error: { code: 'unsupported_version', message: 'Fixture Herdr is too old' } }) });
      if (f.onLink) f.onLink();
      if (!f.staleLink) f.plugins = [...f.plugins.filter(plugin => plugin.plugin_id !== pluginId), { plugin_id: pluginId, plugin_root: sourceDirectory, enabled: true }];
      return json({ plugin: f.plugins.at(-1) });
    }
    if (action.join(' ') === 'session list') {
      assert.equal(args.at(-1), '--json');
      return { stdout: JSON.stringify({ sessions: f.sessions }) };
    }
    assert.deepEqual(action.slice(2), ['server', 'reload-config']);
    assert.equal(action[0], '--session');
    assert.ok(f.sessions.some(session => session.running && session.name === action[1]));
    if (f.reloadError) throw Object.assign(Error('Fixture reload failed'), { code: 'reload_failed' });
    return json({ reloaded: true });
  };
  f.install = extra => installHerdrPanel({ ...f.input, ...extra }, { run: f.run });
  f.links = () => f.calls.filter(call => call.args.slice(0, 2).join(' ') === 'plugin link');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return f;
}

test('release setup links the verified package, preserves preferences and reloads every running Herdr session', async t => {
  const f = fixture(t), result = await f.install();
  assert.equal(result.state, 'herdr_installed'); assert.equal(result.complete, true);
  assert.equal(result.installation, f.sourceDirectory); assert.equal(result.shortcut.state, 'installed');
  assert.deepEqual(result.configReload, { state: 'reloaded', sessions: ['default', 'work'] });
  assert.equal(f.plugins[0].plugin_root, f.sourceDirectory);
  const after = readFileSync(f.herdrConfig, 'utf8');
  assert.ok(after.startsWith(f.source)); assert.match(after, /command = "quintindk\.herdr-relay\.toggle"/);
  assert.equal(readFileSync(result.shortcut.backup, 'utf8'), f.source);
  const files = readdirSync(join(f.root, 'custom herdr'));
  const retry = await f.install();
  assert.equal(retry.complete, true); assert.equal(retry.shortcut.state, 'existing');
  assert.deepEqual(readdirSync(join(f.root, 'custom herdr')), files);
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), after);
});

test('an old Relay link is replaced even when its prefix+t action already matches', async t => {
  const f = fixture(t), oldRoot = join(f.root, 'old release');
  f.plugins = [{ plugin_id: pluginId, plugin_root: oldRoot, enabled: true }];
  const source = f.source + '\n[[keys.command]]\nkey="prefix+t"\ntype="plugin_action"\ncommand="quintindk.herdr-relay.toggle"\n';
  writeFileSync(f.herdrConfig, source);
  const result = await f.install();
  assert.equal(result.complete, true); assert.equal(result.shortcut.state, 'existing');
  assert.equal(f.links().length, 1); assert.equal(f.plugins[0].plugin_root, f.sourceDirectory);
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), source);
  assert.equal(readdirSync(join(f.root, 'custom herdr')).length, 1);
});

test('an offline Herdr installation is configured without starting a server', async t => {
  const f = fixture(t); f.sessions = [{ name: 'default', running: false }];
  const result = await f.install();
  assert.equal(result.complete, true); assert.equal(result.configReload.state, 'not_running');
  assert.ok(f.calls.every(call => !call.args.includes('server')));
});

test('missing Herdr, --no-herdr and an explicitly disabled Relay plugin leave registration and keys untouched', async t => {
  const f = fixture(t); f.herdrMissing = true;
  const missing = await f.install();
  assert.equal(missing.state, 'herdr_skipped'); assert.equal(missing.reason, 'not_installed'); assert.equal(missing.complete, true);
  f.calls.length = 0;
  assert.equal((await f.install({ skip: true })).reason, 'disabled_by_option'); assert.equal(f.calls.length, 0);
  f.herdrMissing = false; f.plugins = [{ plugin_id: pluginId, enabled: false }];
  assert.equal((await f.install()).reason, 'plugin_disabled');
  assert.equal(f.links().length, 0); assert.ok(f.calls.every(call => call.command !== 'python3'));
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), f.source);
});

test('a conflicting shortcut fails preflight before linking or reloading and never overwrites the binding', async t => {
  const f = fixture(t), source = f.source + '\n[[keys.command]]\nkey="prefix+t"\ntype="plugin_action"\ncommand="other.toggle"\n';
  writeFileSync(f.herdrConfig, source);
  const result = await f.install();
  assert.equal(result.state, 'herdr_setup_failed'); assert.equal(result.complete, false);
  assert.equal(result.phase, 'shortcut_preflight'); assert.match(result.message, /already has another binding/);
  assert.equal(result.linked, false); assert.equal(f.links().length, 0);
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), source); assert.equal(readdirSync(join(f.root, 'custom herdr')).length, 1);
});

test('a missing Python runtime is a setup failure, not a silently skipped Herdr installation', async t => {
  const f = fixture(t); f.pythonMissing = true;
  const result = await f.install();
  assert.equal(result.complete, false); assert.equal(result.phase, 'shortcut_preflight');
  assert.match(result.instruction, /Python 3\.11/); assert.equal(f.links().length, 0);
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), f.source);
});

test('a refused plugin link leaves keys unchanged, including errors returned in a successful process envelope', async t => {
  const f = fixture(t); f.linkError = true;
  const result = await f.install();
  assert.equal(result.complete, false); assert.equal(result.phase, 'plugin_link'); assert.equal(result.code, 'link_refused');
  assert.equal(result.linked, false); assert.equal(readFileSync(f.herdrConfig, 'utf8'), f.source);
});

test('a successful link command is not sufficient without the enabled plugin at the verified release path', async t => {
  const f = fixture(t); f.staleLink = true;
  const result = await f.install();
  assert.equal(result.complete, false); assert.equal(result.phase, 'plugin_link'); assert.equal(result.code, 'herdr_link_not_applied');
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), f.source);
});

test('a failed Herdr process retains its native error instead of hiding the reason behind an exit code', async t => {
  const f = fixture(t); f.linkExitError = true;
  const result = await f.install();
  assert.equal(result.complete, false); assert.equal(result.phase, 'plugin_link');
  assert.equal(result.code, 'unsupported_version'); assert.equal(result.message, 'Fixture Herdr is too old');
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), f.source);
});

test('a shortcut edited after preflight remains untouched and reports the already-applied plugin link', async t => {
  const f = fixture(t), changed = f.source + '\n[[keys.command]]\nkey="prefix+t"\ntype="plugin_action"\ncommand="another.toggle"\n';
  f.onLink = () => writeFileSync(f.herdrConfig, changed);
  const result = await f.install();
  assert.equal(result.complete, false); assert.equal(result.phase, 'shortcut_install'); assert.equal(result.linked, true);
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), changed);
});

test('failed reloads report partial setup and a retry finishes without replacing keys or restarting existing panels', async t => {
  const f = fixture(t); f.reloadError = true;
  const result = await f.install();
  assert.equal(result.complete, false); assert.equal(result.phase, 'config_reload'); assert.equal(result.linked, true);
  assert.equal(result.shortcut.state, 'installed'); assert.deepEqual(result.reloadedSessions, []);
  const source = readFileSync(f.herdrConfig, 'utf8'), files = readdirSync(join(f.root, 'custom herdr'));
  f.reloadError = false;
  assert.equal((await f.install()).complete, true);
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), source); assert.deepEqual(readdirSync(join(f.root, 'custom herdr')), files);
  assert.ok(f.calls.every(call => !call.args.includes('stop') && !call.args.includes('restart') && !call.args.includes('pane')));
});

test('malformed Herdr responses fail visibly instead of claiming complete setup', async t => {
  const f = fixture(t);
  const result = await installHerdrPanel(f.input, { run: async () => ({ stdout: '{"result":{}}' }) });
  assert.equal(result.complete, false); assert.equal(result.phase, 'discovery'); assert.equal(result.code, 'invalid_herdr_response');
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), f.source);
  assert.equal(readdirSync(join(f.root, 'custom herdr')).length, 1);
});
