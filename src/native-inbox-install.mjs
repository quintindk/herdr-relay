import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { requireValue } from './protocol.mjs';
import { nativeNodeConfig } from './native-enrol.mjs';
import { readOpenCodeConfig, replacePluginDirectives, isRelayPlugin } from './opencode-config-file.mjs';
import { readPrivateJson } from './private-files.mjs';

// Configuration only. No prompt, decision, service restart or session-policy edit.
export function installNativeInbox({ contextFile, sessionId, configDirectory, evidenceFile, nodeConfigFile, enrolmentOnly = false, replaceContext = false }) {
  requireValue(contextFile && (sessionId === undefined && enrolmentOnly || typeof sessionId === 'string' && /^ses_[A-Za-z0-9]+$/.test(sessionId)),
    'invalid_request', 'Private operator context required. Inbox notification setup also needs a human session');
  contextFile = resolve(contextFile);
  const context = readPrivateJson(contextFile);
  requireValue(typeof context.token === 'string' && context.token, 'invalid_context', 'Native owner context required');
  const directory = resolve(configDirectory ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode'));
  const packageDirectory = fileURLToPath(new URL('../packages/opencode-relay', import.meta.url));
  const jsonPath = join(directory, 'opencode.json'), jsoncPath = join(directory, 'opencode.jsonc'), cliPath = join(directory, 'cli.json');
  requireValue(!(existsSync(jsonPath) && existsSync(jsoncPath)), 'configuration_conflict', 'Both opencode.json and opencode.jsonc exist. Select the authoritative configuration explicitly');
  requireValue(existsSync(cliPath) || !['tui.json', 'tui.jsonc'].some(p => existsSync(join(directory, p))), 'configuration_conflict',
    'Start OpenCode 2 once to migrate existing terminal preferences before installing Relay');
  const serverPath = existsSync(jsoncPath) ? jsoncPath : jsonPath;
  const read = path => existsSync(path) ? readOpenCodeConfig(path).value : {};
  const server = read(serverPath), cli = read(cliPath);
  requireValue(server.plugin === undefined, 'configuration_conflict', 'Legacy plugin directives need explicit V2 migration before installing Relay. Do not silently replace them');
  for (const config of [server, cli]) requireValue(config && typeof config === 'object' && !Array.isArray(config) &&
    (config.plugins === undefined || Array.isArray(config.plugins)), 'configuration_conflict', 'Object configuration and plugin array required');
  const configure = (config, options) => {
    const plugins = config.plugins ?? [];
    requireValue(!plugins.some(p => typeof p === 'string' && /^[!-]/.test(p) && isRelayPlugin(p.slice(1), directory, packageDirectory)),
      'configuration_conflict', 'Relay is explicitly disabled in this configuration');
    const matches = plugins.filter(p => isRelayPlugin(p, directory, packageDirectory));
    requireValue(matches.length <= 1, 'configuration_conflict', 'Duplicate Relay plugin directives require reconciliation');
    const existing = matches[0];
    if (options && existing?.options?.ownerContextFile && !replaceContext) requireValue(resolve(existing.options.ownerContextFile) === contextFile,
      'configuration_conflict', 'Existing Relay inbox points to another owner context');
    if (options && sessionId && existing?.options?.notificationSessionId && !replaceContext) requireValue(existing.options.notificationSessionId === sessionId,
      'configuration_conflict', 'Existing Relay notification session differs. Reconcile explicitly');
    const entry = { ...(typeof existing === 'object' ? existing : {}), package: packageDirectory,
      ...(options ? { options: { ...(existing?.options ?? {}), ...options } } : {}) };
    if (replaceContext && !sessionId && entry.options) delete entry.options.notificationSessionId;
    return { ...config, plugins: existing ? plugins.map(p => p === existing ? entry : p) : [...plugins, entry] };
  };
  nodeConfigFile = resolve(nodeConfigFile ?? nativeNodeConfig());
  const nextServer = configure(server, { workerDirectory: dirname(nodeConfigFile) });
  const nextCli = configure(cli, { ownerContextFile: contextFile, ...(sessionId ? { notificationSessionId: sessionId } : {}), nativeNodeConfigFile: nodeConfigFile,
    ...(evidenceFile ? { evidenceFile: resolve(evidenceFile) } : {}) });
  // Validate both files before modifying either. Backups retain original bytes.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const changed = [];
  for (const [path, before, after] of [[serverPath, server, nextServer], [cliPath, cli, nextCli]]) {
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    let backup = null;
    if (existsSync(path)) {
      backup = `${path}.relay-backup-${randomUUID()}`;
      writeFileSync(backup, readFileSync(path), { mode: 0o600, flag: 'wx' });
    }
    const temporary = `${path}.relay-${randomUUID()}`;
    const source = existsSync(path) ? readFileSync(path, 'utf8') : '{}\n';
    writeFileSync(temporary, replacePluginDirectives(source, after.plugins), { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, path);
    changed.push({ path, backup });
  }
  return { state: changed.length ? 'installed' : 'existing', changed, notificationSessionId: sessionId,
    serverRestarted: false, permissionsChanged: false,
    instruction: 'OpenCode reloads valid configuration edits. Verify /relay-questions and /relay-reviews in the human TUI before starting work.' };
}

export function uninstallNativePlugin({ configDirectory } = {}) {
  const directory = resolve(configDirectory ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode'));
  const packageDirectory = fileURLToPath(new URL('../packages/opencode-relay', import.meta.url));
  const files = ['opencode.json', 'opencode.jsonc', 'cli.json'].map(p => join(directory, p)).filter(existsSync);
  const updates = files.map(path => {
    const { source, value } = readOpenCodeConfig(path);
    requireValue(value.plugins === undefined || Array.isArray(value.plugins), 'configuration_conflict', 'Plugin directives must be an array');
    const plugins = value.plugins?.filter(p => !isRelayPlugin(p, directory, packageDirectory));
    return { path, source, plugins, changed: plugins && plugins.length !== value.plugins.length };
  });
  const changed = [];
  for (const item of updates.filter(i => i.changed)) {
    const backup = `${item.path}.relay-backup-${randomUUID()}`;
    writeFileSync(backup, item.source, { mode: 0o600, flag: 'wx', flush: true });
    const temporary = `${item.path}.relay-${randomUUID()}`;
    writeFileSync(temporary, replacePluginDirectives(item.source, item.plugins), { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, item.path); changed.push({ path: item.path, backup });
  }
  return { state: changed.length ? 'uninstalled' : 'absent', changed, credentialsRemoved: false, nativePermissionsChanged: false };
}
