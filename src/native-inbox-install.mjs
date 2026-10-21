import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { requireValue } from './protocol.mjs';
import { nativeNodeConfig } from './native-enrol.mjs';

// Configuration only. No prompt, decision, service restart or session-policy edit.
export function installNativeInbox({ contextFile, sessionId, configDirectory, evidenceFile }) {
  requireValue(contextFile && typeof sessionId === 'string' && /^ses_[A-Za-z0-9]+$/.test(sessionId),
    'invalid_request', 'Existing human session and private owner context required');
  contextFile = resolve(contextFile);
  const context = JSON.parse(readFileSync(contextFile, 'utf8'));
  requireValue(typeof context.token === 'string' && context.token, 'invalid_context', 'Native owner context required');
  const directory = resolve(configDirectory ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode'));
  const packageDirectory = fileURLToPath(new URL('../packages/opencode-relay', import.meta.url));
  const serverPath = join(directory, 'opencode.json'), cliPath = join(directory, 'cli.json');
  // Do not silently shadow JSONC or try a lossy conversion of somebody's config.
  requireValue(!existsSync(join(directory, 'opencode.jsonc')), 'configuration_conflict',
    'opencode.jsonc exists. Reconcile its plugin configuration explicitly before installing');
  const read = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const server = read(serverPath), cli = read(cliPath);
  for (const config of [server, cli]) requireValue(config && typeof config === 'object' && !Array.isArray(config) &&
    (config.plugins === undefined || Array.isArray(config.plugins)), 'configuration_conflict', 'Object configuration and plugin array required');
  const configure = (config, options) => {
    const plugins = config.plugins ?? [];
    requireValue(!plugins.includes(`!${packageDirectory}`), 'configuration_conflict', 'Relay is explicitly disabled in this configuration');
    const matches = plugins.filter(p => p === packageDirectory || p?.package === packageDirectory);
    requireValue(matches.length <= 1, 'configuration_conflict', 'Duplicate Relay plugin directives require reconciliation');
    const existing = matches[0];
    if (options && existing?.options?.ownerContextFile) requireValue(resolve(existing.options.ownerContextFile) === contextFile,
      'configuration_conflict', 'Existing Relay inbox points to another owner context');
    if (options && existing?.options?.notificationSessionId) requireValue(existing.options.notificationSessionId === sessionId,
      'configuration_conflict', 'Existing Relay notification session differs. Reconcile explicitly');
    const entry = { ...(typeof existing === 'object' ? existing : {}), package: packageDirectory,
      ...(options ? { options: { ...(existing?.options ?? {}), ...options } } : {}) };
    return { ...config, plugins: existing ? plugins.map(p => p === existing ? entry : p) : [...plugins, entry] };
  };
  const nodeConfigFile = nativeNodeConfig();
  const nextServer = configure(server, { workerDirectory: dirname(nodeConfigFile) });
  const nextCli = configure(cli, { ownerContextFile: contextFile, notificationSessionId: sessionId, nativeNodeConfigFile: nodeConfigFile,
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
    writeFileSync(temporary, `${JSON.stringify(after, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    changed.push({ path, backup });
  }
  return { state: changed.length ? 'installed' : 'existing', changed, notificationSessionId: sessionId,
    serverRestarted: false, permissionsChanged: false,
    instruction: 'OpenCode reloads valid configuration edits. Verify /relay-questions and /relay-reviews in the human TUI before starting work.' };
}
