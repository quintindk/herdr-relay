import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOpenCodeConfig, replacePluginDirectives, isRelayPlugin } from './opencode-config-file.mjs';
import { requireValue } from './protocol.mjs';

// Change package paths only. Never replace enrolments, contexts, preferences,
// source permissions, pending decisions or an unrelated plugin directive.
export function pluginUpgradeFiles(configDirectory, packageDirectory) {
  const packagePath = join(packageDirectory, 'packages/opencode-relay');
  const server = ['opencode.json', 'opencode.jsonc'].map(name => join(configDirectory, name)).filter(existsSync);
  requireValue(server.length <= 1, 'configuration_conflict', 'Both OpenCode JSON and JSONC configurations exist');
  return [...server, join(configDirectory, 'cli.json')].filter(existsSync).flatMap(path => {
    const { source, value } = readOpenCodeConfig(path);
    requireValue(value.plugins === undefined || Array.isArray(value.plugins), 'configuration_conflict', 'Plugin directives must be an array');
    const matches = (value.plugins ?? []).filter(p => isRelayPlugin(p, configDirectory, packagePath));
    requireValue(matches.length <= 1, 'configuration_conflict', 'Duplicate Relay plugin directives need explicit reconciliation');
    if (!matches.length) return [];
    const plugins = value.plugins.map(p => p === matches[0] ? typeof p === 'string' ? packagePath : { ...p, package: packagePath } : p);
    const after = replacePluginDirectives(source, plugins);
    return after === source ? [] : [{ path, before: readFileSync(path), after: Buffer.from(after), kind: 'plugin' }];
  });
}
