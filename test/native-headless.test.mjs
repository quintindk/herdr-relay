import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectHeadless, planHeadless, provisionHeadless } from '../src/native-headless.mjs';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { installLocalSchedule, tickLocalSchedules } from '../src/node-schedules.mjs';

function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/headless-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'twd'); mkdirSync(workspace);
  const configFile = join(root, 'node.json');
  const interactive = { id: 'mason-binding', agentId: 'mason', name: 'mason', mode: 'interactive', directory: workspace };
  const config = { identityVersion: 2, nodeId: 'surface', stateDirectory: root,
    backend: { url: 'https://relay.invalid', token: 'private-node-token', cloudflareAccess: { clientId: 'private-id', clientSecret: 'private-secret' } },
    bindings: [interactive], unrelated: { retain: true } };
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const manifest = { key: 'inbox-sweep', name: 'inbox-sweep', directory: workspace, executable: process.execPath,
    config: { model: 'fixture/model', permissions: [{ action: '*', resource: '*', effect: 'deny' }] },
    schedule: { id: 'inbox-sweep-weekdays', instructions: 'Read the fixture inbox and report only.', cron: '0 7-18 * * 1-5',
      timezone: 'Africa/Johannesburg', reviewPolicy: 'none' } };
  return { root, workspace, config, configFile, manifest, input: { configFile, manifest } };
}

test('headless planning has no filesystem/network/process effects and never selects the interactive agent', t => {
  const f = fixture(t), before = readFileSync(f.configFile, 'utf8'), files = readdirSync(f.root);
  const result = provisionHeadless(f.input);
  assert.equal(result.state, 'headless_plan'); assert.notEqual(result.agentId, 'mason');
  assert.equal(result.runtimeStarted, false); assert.equal(result.scheduleInstalled, false);
  assert.equal(result.scheduleEnabled, false);
  assert.equal(readFileSync(f.configFile, 'utf8'), before); assert.deepEqual(readdirSync(f.root), files);
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.equal(inspectHeadless(f.input).state, 'not_configured');
});

test('explicit apply persists one dedicated owned binding and disabled schedule without changing node identity, credentials or human binding', t => {
  const f = fixture(t), before = readFileSync(f.configFile, 'utf8');
  const scheduleOutput = join(f.root, 'schedule.json');
  const result = provisionHeadless({ ...f.input, apply: true, scheduleOutput });
  assert.equal(result.state, 'configured'); assert.equal(result.restartRequired, true);
  const config = JSON.parse(readFileSync(f.configFile, 'utf8'));
  assert.deepEqual({ ...config, bindings: f.config.bindings }, f.config);
  assert.deepEqual(config.bindings[0], f.config.bindings[0]);
  const binding = config.bindings[1];
  assert.equal(binding.harness, 'opencode-v2-owned'); assert.equal(binding.mode, 'headless');
  assert.equal(binding.resume, true); assert.equal(binding.retireOnCompletion, undefined);
  assert.equal(binding.receiverGeneration, undefined);
  const schedule = JSON.parse(readFileSync(scheduleOutput, 'utf8'));
  assert.equal(schedule.definition.targetAgentId, binding.agentId);
  assert.equal(schedule.definition.targetConversationId, undefined);
  assert.equal(schedule.definition.enabled, false);
  assert.equal(schedule.definition.cron, '0 7-18 * * 1-5');
  assert.equal(schedule.definition.timezone, 'Africa/Johannesburg');
  assert.equal(schedule.definition.reviewPolicy, 'none');
  assert.equal(statSync(f.configFile).mode & 0o777, 0o600);
  assert.equal(statSync(scheduleOutput).mode & 0o777, 0o600);
  const backup = readdirSync(f.root).find(n => n.includes('headless-backup'));
  assert.equal(readFileSync(join(f.root, backup), 'utf8'), before);
  const bytes = readFileSync(f.configFile, 'utf8');
  assert.equal(provisionHeadless({ ...f.input, apply: true, scheduleOutput }).state, 'existing');
  assert.equal(readFileSync(f.configFile, 'utf8'), bytes);
  assert.equal(inspectHeadless(f.input).state, 'configured');
});

test('changed keys, policies, workspace/name aliases, legacy config and implicit schedule activation fail closed', t => {
  const f = fixture(t); provisionHeadless({ ...f.input, apply: true });
  const bytes = readFileSync(f.configFile, 'utf8');
  for (const change of [{ name: 'changed' }, { key: 'different' }, { config: { ...f.manifest.config, model: 'other/model' } },
    { config: { ...f.manifest.config, plugin: [] } }, { config: { ...f.manifest.config, permissions: [] } },
    { schedule: { ...f.manifest.schedule, enabled: true } }, { schedule: { ...f.manifest.schedule, cron: 'not a cron' } },
    { retireOnCompletion: true }]) {
    assert.throws(() => provisionHeadless({ ...f.input, manifest: { ...f.manifest, ...change }, apply: true }));
    assert.equal(readFileSync(f.configFile, 'utf8'), bytes);
  }
});

test('schedule export conflicts cannot overwrite files or partially configure an agent', t => {
  const f = fixture(t), before = readFileSync(f.configFile, 'utf8'), path = join(f.root, 'schedule.json');
  writeFileSync(path, '{"unrelated":true}');
  assert.throws(() => provisionHeadless({ ...f.input, apply: true, scheduleOutput: path }), { code: 'configuration_conflict' });
  assert.equal(readFileSync(f.configFile, 'utf8'), before);
  assert.equal(readFileSync(path, 'utf8'), '{"unrelated":true}');
  assert.throws(() => provisionHeadless({ ...f.input, apply: true, scheduleOutput: f.configFile }), { code: 'configuration_conflict' });
});

test('public and native provisioning entrypoints stay native and plan without applying', t => {
  const f = fixture(t), file = join(f.root, 'manifest.json'); writeFileSync(file, JSON.stringify(f.manifest));
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const commands = [['headless', 'provision'], ['native', 'headless', 'provision'], ['native', 'agent', 'provision']];
  for (const command of commands) {
    const output = JSON.parse(execFileSync(process.execPath, [cli, ...command, '--file', file, '--config', f.configFile], { encoding: 'utf8' }));
    assert.equal(output.state, 'headless_plan'); assert.equal(output.scheduleInstalled, false);
  }
  assert.equal(JSON.parse(readFileSync(f.configFile, 'utf8')).bindings.length, 1);
});

test('the same durable headless agent and schedule survive backend and node journal reopen across days', t => {
  const f = fixture(t), plan = planHeadless(f.input);
  provisionHeadless({ ...f.input, apply: true });
  const database = join(f.root, 'backend.sqlite');
  let store = new BackendStore(database);
  const owner = store.authenticate(store.bootstrap().token);
  store.command(owner, { key: 'node', action: 'node.enrol', payload: { id: 'surface', name: 'Surface' } });
  const credential = store.issueCredential({ type: 'node', id: 'surface' });
  const node = store.authenticate(credential.token);
  store.command(node, { key: 'agent', action: 'agent.register', payload: { id: plan.binding.agentId, nodeId: 'surface',
    name: plan.binding.name, mode: 'headless', directory: f.workspace } });
  store.command(owner, { key: 'schedule', action: 'schedule.install', payload: plan.schedule });
  let schedule = store.get('schedule', plan.schedule.id);
  assert.equal(schedule.definition.enabled, false);
  schedule = store.command(owner, { key: 'resume', action: 'schedule.resume', payload: { id: schedule.id, expectedRevision: schedule.revision } });
  const instanceId = store.instance, agentId = plan.binding.agentId, revision = schedule.revision;
  store.close(); store = new BackendStore(database);
  t.after(() => store.close());
  assert.equal(store.instance, instanceId); assert.equal(store.get('agent', agentId).mode, 'headless');
  assert.equal(store.get('schedule', schedule.id).revision, revision);
  const db = join(f.root, 'node.sqlite');
  let journal = new NodeJournal(db, { nodeId: 'surface', instanceId });
  const day1 = Date.parse('2026-10-22T04:59:00Z');
  installLocalSchedule(journal, { id: schedule.id, revision, ...schedule.definition }, day1);
  const first = tickLocalSchedules(journal, Date.parse('2026-10-22T05:00:00Z'));
  assert.equal(first.length, 1); assert.equal(first[0].definition.targetAgentId, agentId);
  journal.db.prepare("UPDATE occurrences SET state='completed'").run(); journal.close();
  journal = new NodeJournal(db, { nodeId: 'surface', instanceId });
  try {
    assert.equal(tickLocalSchedules(journal, Date.parse('2026-10-23T04:59:00Z')).length, 0);
    const second = tickLocalSchedules(journal, Date.parse('2026-10-23T05:00:00Z'));
    assert.equal(second.length, 1); assert.equal(second[0].definition.targetAgentId, agentId);
    assert.notEqual(first[0].id, second[0].id);
    assert.equal(provisionHeadless({ ...f.input, apply: true }).agentId, agentId);
    assert.equal(store.get('schedule', schedule.id).revision, revision);
  } finally { journal.close(); }
});
