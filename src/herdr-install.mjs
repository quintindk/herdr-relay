import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { requireValue } from './protocol.mjs';

const execute = promisify(execFile);
const pluginId = 'quintindk.herdr-relay';

function response(stdout) {
  const value = JSON.parse(stdout);
  requireValue(!value.error, value.error?.code ?? 'herdr_setup_failed', value.error?.message ?? 'Herdr command failed');
  return value.result ?? value;
}

// Registration works without a running server. Only existing sessions are
// reloaded, never started, restarted or closed. OpenCode and Relay services
// remain independent of the local Herdr panel.
export async function installHerdrPanel({ sourceDirectory, herdrConfig, skip = false } = {}, dependencies = {}) {
  if (skip) return { state: 'herdr_skipped', reason: 'disabled_by_option', complete: true };
  const run = dependencies.run ?? execute, binary = process.env.HERDR_BIN_PATH || 'herdr';
  const configPath = resolve(herdrConfig ?? process.env.HERDR_CONFIG_PATH ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'herdr/config.toml'));
  const env = { ...process.env, HERDR_CONFIG_PATH: configPath };
  const options = { env, timeout: 20000, maxBuffer: 1024 * 1024 };
  const command = async args => response((await run(binary, args, options)).stdout);
  let phase = 'discovery', shortcut = null, linked = false;
  const reloaded = [];
  try {
    let listed;
    try { listed = await command(['plugin', 'list', '--json']); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { state: 'herdr_skipped', reason: 'not_installed', complete: true,
        instruction: 'Herdr was not found. Use herdr-relay tui, or rerun release install after installing Herdr.' };
    }
    requireValue(Array.isArray(listed.plugins), 'invalid_herdr_response', 'Herdr did not return its installed plugins');
    const existing = listed.plugins.find(plugin => plugin.plugin_id === pluginId);
    if (existing?.enabled === false) return { state: 'herdr_skipped', reason: 'plugin_disabled', complete: true,
      instruction: 'The Relay Herdr plugin is disabled. Its registration and shortcut were preserved. Enable it explicitly, then rerun release install.' };

    sourceDirectory = resolve(sourceDirectory);
    const script = join(sourceDirectory, 'scripts/install-herdr-shortcut.py');
    const shortcutArgs = [script, '--herdr-config', configPath];
    const installShortcut = async dryRun => {
      const result = response((await run('python3', [...shortcutArgs, ...(dryRun ? ['--dry-run'] : [])], options)).stdout);
      delete result.instruction; // The surrounding installer handles registration and reload.
      return result;
    };
    phase = 'shortcut_preflight';
    shortcut = await installShortcut(true);
    requireValue(['shortcut_preview', 'existing'].includes(shortcut.state), 'invalid_herdr_response', 'Relay shortcut preview was not confirmed');

    phase = 'plugin_link';
    await command(['plugin', 'link', sourceDirectory]);
    linked = true;
    const registered = (await command(['plugin', 'list', '--json'])).plugins?.find(plugin => plugin.plugin_id === pluginId);
    requireValue(registered?.enabled === true && typeof registered.plugin_root === 'string' &&
      realpathSync(registered.plugin_root) === realpathSync(sourceDirectory), 'herdr_link_not_applied', 'Herdr did not register the enabled Relay plugin at the verified release path');
    phase = 'shortcut_install';
    shortcut = await installShortcut(false);
    requireValue(['installed', 'existing'].includes(shortcut.state), 'invalid_herdr_response', 'Relay shortcut installation was not confirmed');

    phase = 'config_reload';
    const listedSessions = await command(['session', 'list', '--json']);
    requireValue(Array.isArray(listedSessions.sessions), 'invalid_herdr_response', 'Herdr did not return its sessions');
    for (const session of listedSessions.sessions.filter(session => session.running)) {
      requireValue(typeof session.name === 'string' && session.name.length > 0, 'invalid_herdr_response', 'Herdr session has no name');
      await command(['--session', session.name, 'server', 'reload-config']);
      reloaded.push(session.name);
    }
    return { state: 'herdr_installed', complete: true, pluginId, installation: sourceDirectory, configPath, shortcut,
      configReload: { state: reloaded.length ? 'reloaded' : 'not_running', sessions: reloaded },
      instruction: reloaded.length ? 'Herdr prefix+t now opens the installed native Relay TUI. Existing panels were not restarted.'
        : 'Herdr prefix+t is configured for the installed native Relay TUI. No Herdr server was started.' };
  } catch (error) {
    let refusal;
    for (const output of [error.stderr, error.stdout]) {
      try { refusal = JSON.parse(output).error; if (refusal) break; } catch {}
    }
    return { state: 'herdr_setup_failed', complete: false, phase, pluginId, configPath, linked, shortcut, reloadedSessions: reloaded,
      code: refusal?.code ?? (typeof error.code === 'string' ? error.code : 'herdr_setup_failed'),
      message: typeof refusal === 'string' ? refusal : refusal?.message ?? error.message,
      instruction: phase.startsWith('shortcut')
        ? `Herdr setup is incomplete. Check Python 3.11+ and ${configPath}. Resolve any prefix+t conflict, then rerun release install. Unrelated bindings are never overwritten.`
        : 'Herdr setup is incomplete. Resolve the reported error, then rerun release install. No services or existing panels were restarted.' };
  }
}
