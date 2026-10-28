import { parseArgs } from 'node:util';
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { requireValue } from './protocol.mjs';
import { readPrivateJson } from './private-files.mjs';
import { serviceUpgrade, installationStatus, upgradeDirectory, installCliRelease } from './service-upgrade.mjs';
import { installSkills } from './skill-install.mjs';

export const upgradeHelp = `Relay service maintenance (node means Relay node, not nodejs):
  release install --version VERSION [--config-dir DIR]  [verified CLI and safe skill sync; no service changes]
  node status [--config PRIVATE_NODE_JSON]
  backend status
  node upgrade --version VERSION [--apply] [--key KEY]
  backend upgrade --version VERSION [--apply] [--key KEY]
  upgrade --services both|node|backend --version VERSION [--apply] [--key KEY]
    Or use --artifact VERIFIED_TGZ --sha256 TRUSTED_DIGEST instead of --version.
  upgrade status [OPERATION_ID]
  upgrade resume OPERATION_ID --apply
  upgrade rollback OPERATION_ID [--apply]
Without --apply, upgrade stages/audits the release and shows a plan only.
Schema-compatible code upgrades preserve active/conflicted work and pending publications.
RC4 (0.2.1-rc4) is the minimum upgrade source. Database schemas must match; migrations are unsupported.
Identity/integrity/provenance checks remain mandatory.
Pending UI decisions defer plugin reload; upgrade resume OPERATION_ID --apply finishes it without restarting services.
Local recovery: node recover list|work|publication ... (node recover --help).
Upgrades preserve state and enrolments. Rollback switches compatible code/configuration,
never silently restores a database. No SSH, nodejs upgrade, reset or OpenCode restart.`;

export async function maintenanceCli(args) {
  const [group, action] = args;
  if (!(group === 'upgrade' || group === 'release' && action === 'install' || ['node', 'backend'].includes(group) && ['upgrade', 'status'].includes(action))) return false;
  if (args.includes('--help')) { console.log(upgradeHelp); return true; }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    ...Object.fromEntries(['version', 'artifact', 'sha256', 'key', 'services', 'config', 'upgrade-dir', 'releases-dir', 'config-dir', 'bin-dir'].map(name => [name, { type: 'string' }])),
    apply: { type: 'boolean' },
  } });
  const operation = group === 'upgrade' ? action : 'service';
  const permitted = group === 'release' ? ['version', 'artifact', 'sha256', 'upgrade-dir', 'releases-dir', 'bin-dir', 'config-dir'] : group !== 'upgrade' && action === 'status' ? ['config'] :
    ['status', 'resume', 'rollback'].includes(operation) ? ['upgrade-dir', ...(operation !== 'status' ? ['apply'] : [])] :
    ['version', 'artifact', 'sha256', 'key', 'services', 'config', 'upgrade-dir', 'releases-dir', 'config-dir', 'bin-dir', 'apply'];
  for (const key of Object.keys(values)) requireValue(permitted.includes(key), 'invalid_request', `--${key} is not supported here`);
  const output = value => console.log(JSON.stringify(value, null, 2));
  if (group === 'release') {
    requireValue(positionals.length === 2 && (values.artifact ? values.sha256 && !values.version : values.version && !values.sha256),
      'invalid_request', 'Choose exact --version or --artifact plus --sha256');
    const result = await installCliRelease({ version: values.version, artifact: values.artifact, sha256: values.sha256,
      directory: values['upgrade-dir'], releasesDirectory: values['releases-dir'], binDirectory: values['bin-dir'] });
    output({ ...result, skills: installSkills({ sourceDirectory: result.installation, configDirectory: values['config-dir'] }) }); return true;
  }
  if (group !== 'upgrade' && action === 'status') {
    requireValue(positionals.length === 2 && (group === 'node' || !values.config), 'invalid_request', 'Unexpected service status arguments');
    const result = await installationStatus({ services: [group], nodeConfig: values.config });
    output(result); if (result.services.some(service => service.installed === false)) process.exitCode = 1;
    return true;
  }
  if (operation === 'status') {
    requireValue(positionals.length <= 3, 'invalid_request', 'Exact optional operation ID required');
    const directory = resolve(values['upgrade-dir'] ?? upgradeDirectory()), id = positionals[2];
    if (id) requireValue(/^[A-Za-z0-9_-]{1,100}$/.test(id), 'invalid_request', 'Invalid operation ID');
    const root = join(directory, 'operations');
    const names = id ? [id] : existsSync(root) ? readdirSync(root).filter(name => /^[A-Za-z0-9_-]+$/.test(name) && existsSync(join(root, name, 'operation.json'))) : [];
    output({ operations: names.map(name => { const record = readPrivateJson(join(root, name, 'operation.json'));
      return { id: record.id, phase: record.phase, version: record.version, services: record.services.map(s => s.role),
        maintenancePolicy: record.maintenancePolicy ?? 'legacy', pluginReloadDeferred: record.deferredPluginReload ?? null,
        failureCode: record.failureCode, rollbackFailureCode: record.rollbackFailureCode, recoveryAction: record.recoveryAction, updatedAt: record.updatedAt }; }) });
    return true;
  }
  if (operation === 'resume' || operation === 'rollback') {
    requireValue(positionals.length === 3, 'invalid_request', 'Exact operation ID required');
    output(await serviceUpgrade({ [operation]: positionals[2], apply: values.apply, directory: values['upgrade-dir'] })); return true;
  }
  requireValue(positionals.length === (group === 'upgrade' ? 1 : 2) &&
    (values.artifact ? values.sha256 && !values.version : values.version && !values.sha256), 'invalid_request', 'Choose exact --version or --artifact plus --sha256');
  requireValue(group === 'upgrade' || !values.services, 'invalid_request', 'Service-specific upgrade cannot override its service role');
  const selected = group === 'upgrade' ? values.services ?? 'node' : group;
  requireValue(['both', 'backend', 'node'].includes(selected), 'invalid_request', 'Use both, backend or node');
  output(await serviceUpgrade({ services: selected === 'both' ? ['backend', 'node'] : [selected], version: values.version,
    artifact: values.artifact, sha256: values.sha256, key: values.key, apply: values.apply, nodeConfig: values.config,
    directory: values['upgrade-dir'], releasesDirectory: values['releases-dir'], configDirectory: values['config-dir'], binDirectory: values['bin-dir'] }));
  return true;
}
