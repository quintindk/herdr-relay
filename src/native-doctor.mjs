import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeConnection } from './native-enrol.mjs';
import { contextClient, defaultNodeConfig, defaultOperatorContext, boardContext } from './native-onboarding.mjs';
import { readOpenCodeConfig, isRelayPlugin } from './opencode-config-file.mjs';
import { homedir } from 'node:os';

export async function nativeDoctor({ configFile = defaultNodeConfig(), contextFile, backendOnly = false }, dependencies = {}) {
  const checks = [], check = (name, status, details = {}) => checks.push({ name, status, ...details });
  const run = dependencies.run ?? ((command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  const packageFile = fileURLToPath(new URL('../package.json', import.meta.url));
  check('relay_release', 'passed', { version: JSON.parse(readFileSync(packageFile, 'utf8')).version, installation: dirname(packageFile) });
  check('node_runtime', Number(process.versions.node.split('.')[0]) >= 24 ? 'passed' : 'failed', { version: process.versions.node });
  check('platform', process.platform === 'linux' ? 'passed' : 'failed', { platform: process.platform,
    wsl: existsSync('/proc/sys/kernel/osrelease') && /microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8')) });
  if (!backendOnly) {
    try { run('systemctl', ['--user', 'show-environment']); check('systemd_user_manager', 'passed'); }
    catch { check('systemd_user_manager', 'failed', { action: 'Enable systemd in WSL2, then verify the user manager. Do not run Relay as root.' }); }
  }
  let config, context, api, info;
  try {
    if (existsSync(configFile)) config = JSON.parse(readFileSync(configFile, 'utf8'));
    const path = contextFile ?? (existsSync(defaultOperatorContext(configFile)) ? defaultOperatorContext(configFile) : boardContext());
    context = JSON.parse(readFileSync(path, 'utf8')); api = contextClient(context);
    info = await api('GET', '/v1/info');
    if (!info.features?.scopedNodeBootstrap) { const error = new Error('Backend does not support scoped onboarding'); error.code = 'backend_upgrade_required'; throw error; }
    const identity = await api('GET', '/v1/identity');
    const pinned = context.instanceId ?? (config && existsSync(join(config.stateDirectory, 'backend-instance.json')) ? JSON.parse(readFileSync(join(config.stateDirectory, 'backend-instance.json'), 'utf8')).instanceId : null);
    const matches = info.protocol === 'relay/0.2' && (!pinned || info.instanceId === pinned);
    check('backend', matches ? 'passed' : 'failed', { instanceId: info.instanceId, protocol: info.protocol, role: identity.scope?.kind ?? identity.type,
      ...(!matches ? { action: 'Wrong backend instance. Archive old state explicitly, never delete a journal to bypass its identity pin.' } : {}) });
    if (!backendOnly) {
      if (!config) check('node_joined', 'failed', { action: 'Join an Evo-issued private node bootstrap bundle first.' });
      else {
        const node = await contextClient(config.backend)('GET', '/v1/identity');
        check('node_identity', node.type === 'node' && node.id === config.nodeId && (!pinned || node.instanceId === pinned) ? 'passed' : 'failed', { nodeId: config.nodeId, name: config.name ?? null });
        try { check('node_service', run('systemctl', ['--user', 'is-active', `herdr-relay-node-${config.nodeId}.service`]) === 'active' ? 'passed' : 'failed'); }
        catch { check('node_service', 'failed', { action: 'Install/start this node service after joining.' }); }
      }
    }
  } catch (error) { check('backend', 'failed', { code: error.code ?? 'backend_or_context_unavailable', action: 'Check the private context, endpoint, ingress credentials and backend service.' }); }
  if (!backendOnly) {
    try { const native = await (dependencies.native ?? (() => nativeConnection({})))(); const version = (await native.client.server.info()).version;
      check('opencode', 'passed', { version, releaseCertified: ['2.1.0', '2.1.2'].includes(version), ...( !['2.1.0', '2.1.2'].includes(version) ? { warning: 'Supported major version, not a certified patch release.' } : {}) }); }
    catch (error) { check('opencode', 'failed', { code: error.code ?? 'native_service_unavailable', action: 'Install/authenticate OpenCode 2 and start it once. Doctor never starts or upgrades it.' }); }
    try { check('herdr', 'passed', { version: run('herdr', ['--version']) }); } catch { check('herdr', 'failed', { action: 'Install Herdr inside the same WSL distribution and user account.' }); }
    const directory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode');
    const plugin = fileURLToPath(new URL('../packages/opencode-relay', import.meta.url));
    for (const [name, paths] of [['server_plugin', ['opencode.json', 'opencode.jsonc']], ['tui_plugin', ['cli.json']]]) {
      try {
        const files = paths.map(p => join(directory, p)).filter(existsSync);
        const good = files.length === 1 && readOpenCodeConfig(files[0]).value.plugins?.some(p => isRelayPlugin(p, directory, plugin));
        check(name, good ? 'passed' : 'failed', { ...(!good ? { action: 'Run native plugin install. Resolve conflicting or legacy configuration explicitly.' } : {}) });
      } catch { check(name, 'failed', { action: 'Fix malformed OpenCode JSON/JSONC before installing the plugin.' }); }
    }
  }
  return { ready: checks.every(c => c.status === 'passed'), checks, readOnly: true, servicesStarted: false, destructiveChanges: false,
    verificationLimits: ['Does not certify Cloudflare Access policy. Run backend ingress-check separately.',
      'Does not prove model-provider authentication or successful model/tool execution.',
      'Does not certify a physical second node or complete business-source coverage. Verify each enrolled host separately.'] };
}
