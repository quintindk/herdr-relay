import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOpenCodeConfig, replacePluginDirectives, isRelayPlugin } from './opencode-config-file.mjs';
import { requireValue } from './protocol.mjs';

// Change package paths and exact renamed IDs only. Never replace enrolments, contexts, preferences,
// source permissions, pending decisions or an unrelated plugin directive.
export function pluginUpgradeFiles(configDirectory, packageDirectory) {
  const packagePath = join(packageDirectory, 'packages/opencode-relay');
  const server = ['opencode.json', 'opencode.jsonc'].map(name => join(configDirectory, name)).filter(existsSync);
  requireValue(server.length <= 1, 'configuration_conflict', 'Both OpenCode JSON and JSONC configurations exist');
  const paths = [...server, join(configDirectory, 'cli.json')].filter(existsSync), ids = new Map();
  // Preserve explicit enabled/disabled preferences across a plugin-ID rename.
  // Inspect only recognised installed product files, never arbitrary directives.
  for (const path of paths) {
    const { plugins } = readOpenCodeConfig(path).value;
    requireValue(plugins === undefined || Array.isArray(plugins), 'configuration_conflict', 'Plugin directives must be an array');
    for (const directive of plugins ?? []) {
      if (!isRelayPlugin(directive, configDirectory, packagePath)) continue;
      const name = typeof directive === 'string' ? directive : directive.package;
      if (!name.startsWith('/') && !name.startsWith('.') && !name.startsWith('file:')) continue;
      const directory = name.startsWith('file:') ? fileURLToPath(name) : resolve(configDirectory, name);
      for (const role of ['server', 'tui']) {
        const file = join(directory, `${role}.mjs`);
        if (!existsSync(file)) continue;
        const id = readFileSync(file, 'utf8').match(/\bid:\s*['"](herdr\.relay\.[\w.-]+)['"]/)?.[1];
        requireValue(role !== 'server' || !id || id === 'herdr.relay.server' || typeof directive === 'string' || directive.options?.humanProposals !== true,
          'upgrade_plugin_state_migration_required', 'An enabled server proposal store uses an earlier plugin namespace. Explicitly migrate or reconcile that store before renaming the plugin. No proposal was discarded');
        if (id) ids.set(id, `herdr.relay.${role}`);
      }
    }
  }
  return paths.flatMap(path => {
    const { source, value } = readOpenCodeConfig(path);
    requireValue(value.plugins === undefined || Array.isArray(value.plugins), 'configuration_conflict', 'Plugin directives must be an array');
    const matches = (value.plugins ?? []).filter(p => isRelayPlugin(p, configDirectory, packagePath));
    requireValue(matches.length <= 1, 'configuration_conflict', 'Duplicate Relay plugin directives need explicit reconciliation');
    const plugins = (value.plugins ?? []).map(p => {
      if (matches.length && p === matches[0]) return typeof p === 'string' ? packagePath : { ...p, package: packagePath };
      if (typeof p === 'string' && /^[!-]/.test(p) && ids.has(p.slice(1))) return p[0] + ids.get(p.slice(1));
      return p;
    });
    const after = replacePluginDirectives(source, plugins);
    return after === source ? [] : [{ path, before: readFileSync(path), after: Buffer.from(after), kind: 'plugin' }];
  });
}
