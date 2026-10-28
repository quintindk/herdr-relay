import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { requireValue } from './protocol.mjs';
import { readPrivateJson } from './private-files.mjs';
import { createNodeBundle, joinNode, revokeNodeBundle, contextClient, defaultNodeConfig, defaultOperatorContext, defaultOwnerContext, cloudflareTransportFromFile } from './native-onboarding.mjs';
import { installNativeInbox, uninstallNativePlugin } from './native-inbox-install.mjs';
import { nativeDoctor } from './native-doctor.mjs';
import { installSkills, skillStatus } from './skill-install.mjs';

export const adminHelp = `Installed-release administration (no checkout scripts required):
  backend install [--state-dir DIR] [--port PORT] [--dry-run]
  backend init|run --state-dir DIR [--port PORT]
  backend backup --output NEW_FILE [--state-dir DIR]
  backend status|inventory --context ROOT_OWNER_JSON
  backend ingress-check --url HTTPS_ORIGIN --context ROOT_OWNER_JSON --access PRIVATE_ACCESS_ENV
  node bootstrap --context ROOT_OWNER_JSON --key KEY --name Evo|Surface --url NODE_BACKEND_URL --output PRIVATE_BUNDLE
    --local-user | --root ABSOLUTE_NODE_ROOT [--root ...] [--max-agents N] [--access PRIVATE_ACCESS_ENV] [--transport PRIVATE_TRANSPORT_JSON]
  node join --bundle PRIVATE_BUNDLE [--config LOCAL_NODE_JSON]
  node revoke --bundle PRIVATE_BUNDLE --key KEY --context ROOT_OWNER_JSON
  plugin install [--config NODE_JSON] [--context OPERATOR_JSON] [--config-dir DIR] [--here|--session ID] [--replace-context]
  plugin uninstall [--config-dir DIR]
  plugin shortcut [--herdr-config TOML] [--dry-run]  [explicit prefix+t binding; preserves other Herdr keys]
  skills status [--config-dir DIR]
  skills install [--config-dir DIR] [--dry-run] [--replace-modified]
  doctor [--config NODE_JSON] [--context OPERATOR_JSON] [--backend-only]
No command here clears backend state, upgrades OpenCode or imports tasks implicitly.
Join bundles contain separate scoped daemon/human credentials, never Evo's root owner token.`;

const defaultBackendState = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-relay-backend');
export function inventoryProjection(snapshot) {
  return { instanceId: snapshot.instanceId, counts: Object.fromEntries(Object.entries(snapshot.collections).map(([k, rows]) => [k, rows.length])),
    outstandingExecutions: snapshot.collections.execution.filter(e => !['completed', 'cancelled', 'failed', 'rejected'].includes(e.state)).map(e => ({ id: e.id, state: e.state })),
    openQuestions: snapshot.collections.question.filter(q => q.status === 'open').map(q => ({ id: q.id, executionId: q.executionId })),
    schedules: snapshot.collections.schedule.map(s => ({ id: s.id, enabled: s.definition.enabled, revision: s.revision, appliedRevision: s.appliedRevision })),
    headlessSetups: (snapshot.collections.headless_setup ?? []).map(s => ({ id: s.id, state: s.state,
      contractRevision: s.contract?.revision ?? 0, appliedContractRevision: s.appliedContractRevision ?? 0 })),
    note: 'Backend projection only. This does not prove native process settlement or business-job completeness.' };
}
export async function nativeAdmin(args) {
  const [group, action] = args;
  const selected = ['backend', 'plugin', 'doctor', 'skills'].includes(group) || group === 'node' && ['bootstrap', 'join', 'revoke'].includes(action);
  if (!selected) return false;
  if (args.includes('--help')) { console.log(adminHelp); return true; }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    ...Object.fromEntries(['context', 'state-dir', 'port', 'output', 'key', 'name', 'url', 'bundle', 'config', 'transport', 'max-agents', 'config-dir',
      'session', 'evidence-file', 'access', 'herdr-config'].map(k => [k, { type: 'string' }])),
    root: { type: 'string', multiple: true },
    ...Object.fromEntries(['dry-run', 'local-user', 'here', 'replace-context', 'replace-modified', 'backend-only'].map(k => [k, { type: 'boolean' }])),
  } });
  requireValue(positionals.length === (group === 'doctor' ? 1 : 2), 'invalid_request', 'Unexpected administrative positional arguments');
  const permitted = group === 'doctor' ? ['config', 'context', 'backend-only'] : {
    'backend:install': ['state-dir', 'port', 'dry-run'], 'backend:init': ['state-dir'], 'backend:run': ['state-dir', 'port'],
    'backend:backup': ['state-dir', 'output'], 'backend:status': ['context'], 'backend:inventory': ['context'],
    'backend:ingress-check': ['url', 'context', 'access'],
    'node:bootstrap': ['context', 'key', 'name', 'url', 'output', 'local-user', 'root', 'max-agents', 'transport', 'access'],
    'node:join': ['bundle', 'config'], 'node:revoke': ['bundle', 'key', 'context'],
    'plugin:install': ['config', 'context', 'config-dir', 'here', 'session', 'replace-context', 'evidence-file'], 'plugin:uninstall': ['config-dir'],
    'plugin:shortcut': ['herdr-config', 'dry-run'],
    'skills:status': ['config-dir'], 'skills:install': ['config-dir', 'dry-run', 'replace-modified'],
  }[`${group}:${action}`];
  requireValue(permitted, 'invalid_request', 'Unknown administrative command. Use native --help');
  for (const key of Object.keys(values)) requireValue(permitted.includes(key), 'invalid_request', `--${key} is not supported for this command`);
  const output = value => console.log(JSON.stringify(value, null, 2));
  const script = (name, options = {}, more = []) => {
    const parts = [...Object.entries(options).flatMap(([key, value]) => value === undefined ? [] : value === true ? [`--${key}`] : [`--${key}`, String(value)]), ...more];
    execFileSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url)), ...parts], { stdio: 'inherit' });
  };
  const ownerApi = () => { requireValue(values.context, 'invalid_request', 'Explicit --context required'); return contextClient(readPrivateJson(values.context)); };
  if (group === 'skills') {
    const result = action === 'status' ? skillStatus({ configDirectory: values['config-dir'] })
      : installSkills({ configDirectory: values['config-dir'], dryRun: values['dry-run'], replaceModified: values['replace-modified'] });
    output(result);
    if (result.state === 'skill_conflict') process.exitCode = 1;
  } else if (group === 'backend') {
    if (action === 'install') script('../scripts/install-native-backend.mjs', values);
    else if (action === 'init' || action === 'run') {
      requireValue(values['state-dir'], 'invalid_request', 'Explicit --state-dir required');
      execFileSync(process.execPath, [fileURLToPath(new URL('./backend-cli.mjs', import.meta.url)), action === 'run' ? 'serve' : 'init',
        ...Object.entries(values).flatMap(([k, v]) => [`--${k}`, String(v)])], { stdio: 'inherit' });
    } else if (action === 'backup') {
      requireValue(values.output, 'invalid_request', 'Explicit new --output backup path required');
      script('./backend-backup.mjs', { database: join(values['state-dir'] ?? defaultBackendState(), 'backend.sqlite'), output: values.output });
    } else if (action === 'status') { const report = await nativeDoctor({ contextFile: values.context, backendOnly: true }); output(report); if (!report.ready) process.exitCode = 1; }
    else if (action === 'inventory') {
      const snapshot = await ownerApi()('GET', '/v1/snapshot');
      output(inventoryProjection(snapshot));
    } else {
      requireValue(values.url && values.context && values.access, 'invalid_request', 'Ingress verification requires explicit HTTPS origin, actor context and private Access file');
      script('../scripts/verify-backend-ingress.mjs', { url: values.url, owner: values.context, access: values.access });
    }
  } else if (group === 'node') {
    if (action === 'bootstrap') {
      requireValue(Boolean(values['local-user']) !== Boolean(values.root?.length), 'invalid_request', 'Choose --local-user or one or more explicit --root paths');
      const transport = values.transport ? readPrivateJson(values.transport) : {};
      if (values.access) { requireValue(!transport.cloudflareAccess, 'invalid_transport', 'Choose one private Access credential source'); Object.assign(transport, cloudflareTransportFromFile(values.access)); }
      output(await createNodeBundle({ api: ownerApi(), output: values.output, key: values.key, name: values.name, url: values.url,
        mode: values['local-user'] ? 'localUser' : 'roots', roots: values.root, maxAgents: values['max-agents'] === undefined ? 100 : Number(values['max-agents']), transport }));
    } else if (action === 'join') output(await joinNode({ bundleFile: values.bundle, configFile: values.config }));
    else output(await revokeNodeBundle({ api: ownerApi(), bundleFile: values.bundle, key: values.key }));
  } else if (group === 'plugin') {
    if (action === 'shortcut') execFileSync('python3', [fileURLToPath(new URL('../scripts/install-herdr-shortcut.py', import.meta.url)),
      ...(values['herdr-config'] ? ['--herdr-config', values['herdr-config']] : []), ...(values['dry-run'] ? ['--dry-run'] : [])], { stdio: 'inherit' });
    else if (action === 'uninstall') output(uninstallNativePlugin({ configDirectory: values['config-dir'] }));
    else {
      requireValue(!(values.here && values.session), 'invalid_request', 'Choose --here or --session, not both');
      const config = values.config ?? defaultNodeConfig();
      const context = values.context ?? (existsSync(defaultOperatorContext(config)) ? defaultOperatorContext(config) : defaultOwnerContext());
      const sessionId = values.here ? process.env.OPENCODE_SESSION_ID : values.session;
      if (values.here) requireValue(sessionId, 'invalid_request', '--here requires an actual OpenCode session');
      output(installNativeInbox({ contextFile: context, nodeConfigFile: config, sessionId, enrolmentOnly: !sessionId,
        configDirectory: values['config-dir'], evidenceFile: values['evidence-file'], replaceContext: values['replace-context'] }));
    }
  } else if (group === 'doctor') {
    const result = await nativeDoctor({ configFile: values.config, contextFile: values.context, backendOnly: values['backend-only'] });
    output(result); if (!result.ready) process.exitCode = 1;
  }
  return true;
}
