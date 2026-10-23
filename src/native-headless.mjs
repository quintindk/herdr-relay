import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { digest, requireValue } from './protocol.mjs';
import { nativeNodeConfig } from './native-enrol.mjs';
import { createPrivateJson, readPrivateJson, writePrivateJson } from './private-files.mjs';
import { previewCron } from './cron-schedule.mjs';
import { serviceLock } from './service-lock.mjs';
import { contextClient } from './native-onboarding.mjs';
import { workerConnection } from '../packages/opencode-relay/worker-context.mjs';
import { call } from './client.mjs';
import { waitHeadlessSetup } from './headless-setup-wait.mjs';

export const headlessHelp = `herdr-relay headless provision --file MANIFEST_JSON [--config NODE_JSON] [--apply] [--schedule-output NEW_JSON]
  Plan by default. --apply saves a dedicated persistent native binding, never starts a runtime or installs a schedule.
  Manifest: {key,name,directory,executable,config:{model,permissions,...},schedule?:{id,instructions,cron,timezone,reviewPolicy}}
  Schedule output is disabled and targets the durable agent, not a human conversation.
herdr-relay headless inspect --file MANIFEST_JSON [--config NODE_JSON]
  Inspect configuration only. Node readiness and schedule acknowledgement must be checked separately.
Also available as herdr-relay native agent provision with the same provisioning options.
herdr-relay headless connections|grants [--config NODE_JSON]  [enrolled coordinator; no secrets]
herdr-relay headless grant|revoke --file PAYLOAD_JSON --key KEY --context ROOT_OWNER_JSON
  Grants require permissions:{mcp:BOOLEAN,shell:false}. MCP is one capability, not a connector/tool allowlist.
herdr-relay headless setup --grant-id ID --key KEY [--config NODE_JSON]  [readiness then activation]
herdr-relay headless status --id SETUP_ID [--config NODE_JSON]`;

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function planHeadless({ manifest, configFile = nativeNodeConfig() }) {
  requireValue(object(manifest) && Object.keys(manifest).every(k => ['key', 'name', 'directory', 'executable', 'config', 'schedule'].includes(k)) &&
    typeof manifest.key === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(manifest.key) && text(manifest.name),
  'invalid_headless', 'Explicit stable key, name and supported headless manifest fields required');
  for (const path of [manifest.directory, manifest.executable]) requireValue(text(path, 4096) && isAbsolute(path),
    'invalid_headless', 'Existing absolute workspace and OpenCode executable paths required');
  const directory = realpathSync(manifest.directory), executable = realpathSync(manifest.executable);
  requireValue(statSync(directory).isDirectory() && statSync(executable).isFile(), 'invalid_headless', 'Workspace directory and executable file required');
  accessSync(executable, constants.X_OK);
  requireValue(object(manifest.config) && text(manifest.config.model) && Array.isArray(manifest.config.permissions) &&
    manifest.config.plugin === undefined && manifest.config.provider === undefined,
  'invalid_headless', 'Explicit V2 model and permission array required; legacy plugin/provider directives are not accepted');
  requireValue(manifest.config.permissions.length > 0 && manifest.config.permissions.every(rule => object(rule) &&
    Object.keys(rule).every(k => ['action', 'resource', 'effect'].includes(k)) && text(rule.action) && text(rule.resource, 4096) &&
    ['allow', 'ask', 'deny'].includes(rule.effect)), 'invalid_headless', 'Explicit V2 action/resource/effect permission rules required');
  requireValue(manifest.config.plugins === undefined || Array.isArray(manifest.config.plugins), 'invalid_headless', 'V2 plugins must be an array');
  configFile = resolve(configFile);
  const source = readFileSync(configFile, 'utf8'), config = readPrivateJson(configFile);
  requireValue(config.identityVersion === 2 && text(config.nodeId) && isAbsolute(config.stateDirectory ?? '') &&
    resolve(config.stateDirectory) === dirname(configFile) && object(config.backend) && text(config.backend.token, 4096) && Array.isArray(config.bindings),
  'configuration_conflict', 'Use an existing joined stable node; headless provisioning never creates nodes or credentials');
  const agentId = `agent_h_${digest([config.nodeId, manifest.key]).slice(0, 48)}`;
  const bindingId = `binding_h_${digest([config.nodeId, manifest.key]).slice(0, 48)}`;
  const binding = { id: bindingId, agentId, name: manifest.name, mode: 'headless', harness: 'opencode-v2-owned',
    reserved: true, directory, executable, config: manifest.config, resume: true };
  const matching = config.bindings.filter(entry => entry.id === bindingId || entry.agentId === agentId);
  requireValue(matching.length <= 1 && (!matching.length || digest(matching[0]) === digest(binding)),
    'configuration_conflict', 'Headless key already has a different binding; do not replace an agent, runtime or policy');
  requireValue(!config.bindings.some(entry => entry.id !== bindingId && entry.name === manifest.name && entry.directory === directory),
    'configuration_conflict', 'Another configured agent already uses this workspace/name; select a distinct role');
  requireValue(matching.length || config.bindings.length < 100, 'agent_limit', 'Node binding limit reached');
  let schedule;
  if (manifest.schedule !== undefined) {
    const s = manifest.schedule;
    requireValue(object(s) && Object.keys(s).every(k => ['id', 'instructions', 'cron', 'timezone', 'reviewPolicy'].includes(k)) &&
      typeof s.id === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(s.id) && text(s.instructions, 32768) &&
      text(s.cron) && text(s.timezone) && ['none', 'human'].includes(s.reviewPolicy),
    'invalid_schedule', 'Explicit schedule ID, instructions, cron, timezone and review policy required');
    previewCron(s.cron, s.timezone);
    schedule = { id: s.id, definition: { nodeId: config.nodeId, targetAgentId: agentId, instructions: s.instructions,
      cron: s.cron, timezone: s.timezone, reviewPolicy: s.reviewPolicy, enabled: false } };
  }
  return { configFile, source, config, binding, schedule, existing: matching.length === 1 };
}

export function provisionHeadless(input) {
  let plan = planHeadless(input);
  const result = p => ({ state: input.apply ? (p.existing ? 'existing' : 'configured') : 'headless_plan',
    nodeId: p.config.nodeId, agentId: p.binding.agentId, bindingId: p.binding.id, name: p.binding.name, directory: p.binding.directory,
    config: p.configFile, existing: p.existing, runtimeStarted: false, scheduleInstalled: false,
    ...(p.schedule ? { scheduleId: p.schedule.id, scheduleEnabled: false } : {}),
    restartRequired: input.apply && !p.existing,
    instruction: 'Apply configuration on the destination node, then restart only that Relay node. Install the disabled schedule separately using backend owner authority, verify readiness, then explicitly resume it.' });
  if (!input.apply) return result(plan);
  requireValue(!input.scheduleOutput || plan.schedule, 'invalid_schedule', 'Schedule output requires a schedule in the manifest');
  if (input.scheduleOutput) requireValue(resolve(input.scheduleOutput) !== plan.configFile, 'configuration_conflict', 'Schedule output cannot replace node configuration');
  const lockDirectory = join(plan.config.stateDirectory, 'headless-config-lock');
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const unlock = serviceLock(lockDirectory);
  try {
    plan = planHeadless(input);
    // Validate/write the export before changing the node. An identical retry is safe.
    if (input.scheduleOutput) createPrivateJson(resolve(input.scheduleOutput), plan.schedule);
    if (!plan.existing) {
      const backup = `${plan.configFile}.headless-backup-${digest(plan.source)}`;
      try { writeFileSync(backup, plan.source, { mode: 0o600, flag: 'wx', flush: true }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; requireValue(readFileSync(backup, 'utf8') === plan.source,
        'configuration_conflict', 'Existing configuration backup differs'); }
      requireValue(readFileSync(plan.configFile, 'utf8') === plan.source, 'configuration_conflict', 'Node configuration changed during provisioning');
      writePrivateJson(plan.configFile, { ...plan.config, bindings: [...plan.config.bindings, plan.binding] });
    }
    return result(plan);
  } finally { unlock(); }
}

export function inspectHeadless(input) {
  const plan = planHeadless(input);
  const directory = join(plan.config.stateDirectory, 'managed', digest(plan.binding.id));
  const receipt = existsSync(join(directory, 'provision.json')) ? readPrivateJson(join(directory, 'provision.json')) : null;
  const runtime = existsSync(join(directory, 'runtime/runtime.json')) ? readPrivateJson(join(directory, 'runtime/runtime.json')) : null;
  return { state: plan.existing ? 'configured' : 'not_configured', nodeId: plan.config.nodeId, agentId: plan.binding.agentId,
    bindingId: plan.binding.id, name: plan.binding.name, directory: plan.binding.directory, readOnly: true,
    sessionId: receipt?.identity?.sessionId ?? null, provisioningState: receipt?.state ?? 'not_started',
    recordedRuntimeState: runtime?.state ?? 'not_started', runtimeGeneration: runtime?.generation ?? null,
    liveReadinessVerified: false, scheduleState: 'not_inspected' };
}

export async function headlessCli(args) {
  if (args[0] !== 'headless') return false;
  if (args.includes('--help')) { console.log(headlessHelp); return true; }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    file: { type: 'string' }, config: { type: 'string' }, apply: { type: 'boolean' }, 'schedule-output': { type: 'string' },
    context: { type: 'string' }, key: { type: 'string' }, 'grant-id': { type: 'string' }, id: { type: 'string' }, retry: { type: 'boolean' },
  } });
  if (['grant', 'revoke', 'setup', 'status', 'grants', 'connections'].includes(positionals[1])) {
    const action = positionals[1];
    const permitted = ['grant', 'revoke'].includes(action) ? ['file', 'context', 'key'] : ['config', ...(action === 'setup' ? ['key', 'grant-id', 'retry'] : action === 'status' ? ['id'] : [])];
    requireValue(Object.keys(values).every(k => permitted.includes(k)), 'invalid_request', 'Unsupported setup/grant option');
    requireValue(positionals.length === 2 && !values.apply && !values['schedule-output'], 'invalid_request', 'Setup/grant commands do not accept provisioning options');
    let result;
    if (['grant', 'revoke'].includes(action)) {
      requireValue(values.file && values.context && values.key, 'invalid_request', 'Explicit payload, root context and stable key required');
      const api = contextClient(readPrivateJson(values.context)), payload = readPrivateJson(values.file);
      if (action === 'grant' && payload.permissions) requireValue((await api('GET', '/v1/info')).features?.headlessMcpPermissions,
        'backend_upgrade_required', 'Backend must support general headless MCP permissions');
      if (action === 'grant' && payload.capabilities) requireValue((await api('GET', '/v1/info')).features?.headlessCapabilities,
        'backend_upgrade_required', 'Backend must support approved headless task/artifact capabilities');
      result = await api('POST', '/v1/commands', { key: values.key, action: `headless.${action}`, payload });
    } else {
      const sessionId = process.env.OPENCODE_SESSION_ID;
      requireValue(sessionId, 'human_coordinator_required', 'Use an enrolled coordinator chat; this command does not borrow operator credentials');
      const connection = workerConnection({ workerDirectory: dirname(resolve(values.config ?? nativeNodeConfig())) }, sessionId);
      const body = action === 'setup' ? { key: values.key, grantId: values['grant-id'], ...(values.retry ? { retry: true } : {}) } : action === 'status' ? { id: values.id } : {};
      result = await call(connection, 'POST', `/agent/headless-${action}`, body);
      if (action === 'setup') result = await waitHeadlessSetup(connection, result);
    }
    console.log(JSON.stringify(result, null, 2)); return true;
  }
  requireValue(positionals.length === 2 && ['provision', 'inspect'].includes(positionals[1]) && values.file,
    'invalid_request', 'Use headless provision|inspect --file MANIFEST_JSON [--config NODE_JSON]');
  requireValue(positionals[1] !== 'inspect' || !values.apply && !values['schedule-output'], 'invalid_request', 'Inspection is read-only');
  const input = { manifest: readPrivateJson(resolve(values.file)), configFile: values.config, apply: values.apply === true, scheduleOutput: values['schedule-output'] };
  console.log(JSON.stringify(positionals[1] === 'inspect' ? inspectHeadless(input) : provisionHeadless(input), null, 2));
  return true;
}
