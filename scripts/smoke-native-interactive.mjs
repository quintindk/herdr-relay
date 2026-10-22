// Opt-in live Herdr/model test. Uses the same scoped source-node service and
// backend-addressed destination driver as a remote request. No SSH or local
// bypass. Creates only its explicitly supplied disposable root's workspaces.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { workerConnection } from '../packages/opencode-relay/worker-context.mjs';
import { call } from '../src/client.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['context', 'config', 'requester-agent', 'root'].map(k => [k, { type: 'string' }])) });
for (const key of ['context', 'config', 'requester-agent', 'root']) assert.ok(values[key], `Explicit --${key} required`);
assert.equal(process.env.HERDR_ENV, '1', 'Run live Herdr tests from an authorised Herdr pane');
const root = resolve(values.root); mkdirSync(root, { recursive: true, mode: 0o700 });
const stateFile = join(root, 'smoke.json');
const owner = JSON.parse(readFileSync(values.context));
const api = nativeBackendClient({ ...owner, url: owner.url ?? 'http://127.0.0.1:3210' });
const config = JSON.parse(readFileSync(values.config));
const requester = await api('GET', `/v1/agents/${values['requester-agent']}`);
assert.equal(requester.nodeId, config.nodeId, 'This probe deliberately targets its own node through the backend');
const source = workerConnection({ workerDirectory: config.stateDirectory }, requester.conversationId);
let state;
if (existsSync(stateFile)) state = JSON.parse(readFileSync(stateFile));
else {
  const id = `local-interactive-${randomUUID().slice(0, 8)}`;
  state = { id, nodeId: config.nodeId, requesterAgentId: requester.id, directory: join(root, 'discussion'),
    grant: { id: `${id}-grant`, requesterAgentId: requester.id, nodeId: config.nodeId, mode: 'roots', roots: [root],
      allowNewEnrolments: true, allowCreateDirectories: true, allowReplacement: true, allowDispatch: true,
      reviewPolicy: 'none', maxAgents: 100, expiresAt: new Date(Date.now() + 3600000).toISOString() } };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600, flush: true });
}
const command = (key, action, payload) => api('POST', '/v1/commands', { key, action, payload });
await command(`${state.id}-grant`, 'interactive.grant', state.grant);
const wait = async (id, expected = 'ready') => {
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const request = await call(source, 'POST', '/agent/interactive-status', { id });
    assert.notEqual(request.state, 'blocked', JSON.stringify(request));
    assert.notEqual(request.state, 'cancelled', JSON.stringify(request));
    if (request.state === expected) return request;
    await delay(500);
  }
  throw Error(`Timed out waiting for ${id}. Inspect native interactive status and retained local journal; do not resend mutations.`);
};
await call(source, 'POST', '/agent/interactive-prepare', { key: `${state.id}-prepare`, payload: { id: state.id, grantId: state.grant.id,
  nodeId: config.nodeId, directory: state.directory, name: 'Relay interactive smoke', createDirectory: true,
  topic: 'This is a disposable interactive discussion opened through Relay. Discuss only this test when Quintin talks to you. Provisioning does not assign work.' } });
const first = await wait(state.id);
assert.equal(first.receipt.directory, state.directory);
console.error(`PASS: visible interactive workspace prepared: ${first.receipt.workspaceId}, ${first.receipt.paneId}`);
const ensureId = `${state.id}-ensure`;
await call(source, 'POST', '/agent/interactive-prepare', { key: ensureId, payload: { id: ensureId, grantId: state.grant.id,
  nodeId: config.nodeId, agentId: first.agentId, instance: 'ensure' } });
const ensured = await wait(ensureId);
assert.equal(ensured.receipt.bindingId, first.receipt.bindingId); assert.equal(ensured.receipt.paneId, first.receipt.paneId);
assert.equal(ensured.receipt.reused, true);
const replacementId = `${state.id}-replacement`;
await call(source, 'POST', '/agent/interactive-prepare', { key: replacementId, payload: { id: replacementId, grantId: state.grant.id,
  nodeId: config.nodeId, agentId: first.agentId, instance: 'replace', topic: 'Replacement interactive smoke conversation. No work is implied by opening this chat.' } });
const replacement = await wait(replacementId);
assert.equal(replacement.agentId, first.agentId); assert.equal(replacement.receipt.generation, first.receipt.generation + 1);
assert.notEqual(replacement.receipt.conversationId, first.receipt.conversationId);
const taskId = `${state.id}-task`, executionId = `${state.id}-run`;
await call(source, 'POST', '/agent/interactive-dispatch', { key: `${state.id}-dispatch`, payload: { id: replacementId, taskId, executionId,
  title: 'Bounded interactive provisioning check', instructions: 'Perform only this bounded Relay smoke. Read your exact current execution and check cancellation with relay_work_read. You may read relay_interactive_context for the attributed briefing. Submit candidate equal to your execution ID and summary exactly "Interactive provisioning check passed." using relay_work_submit, then finish immediately. Do not inspect or modify files, use shell commands, create schedules, delegate, provision other agents or perform unrelated work.' } });
let execution;
const deadline = Date.now() + 150000;
while (Date.now() < deadline) {
  execution = await api('GET', `/v1/executions/${executionId}`);
  assert.ok(!['failed', 'cancelled', 'rejected'].includes(execution.state), JSON.stringify(execution));
  if (execution.state === 'completed') break;
  await delay(500);
}
assert.equal(execution.state, 'completed');
assert.equal(execution.targetConversationId, replacement.receipt.conversationId);
assert.equal(execution.result.summary, 'Interactive provisioning check passed.');
await command(`${state.id}-revoke`, 'interactive.revoke', { id: state.grant.id, expectedRevision: 1 });
const result = { verifiedOn: new Date().toISOString(), passed: true, samePhysicalNodeThroughBackend: true, realHerdr: true, realNativeModel: true,
  newEnrolmentPreparedWithoutWork: true, existingInstanceReused: true, explicitReplacementAttached: true, separateScopedDispatchCompleted: true,
  sourceAgentId: requester.id, destinationNodeId: config.nodeId, original: first.receipt, replacement: replacement.receipt,
  execution: { id: execution.id, state: execution.state, result: execution.result }, grantRevokedAfterTest: true,
  retainedDisposableWorkspaces: [first.receipt.workspaceId, replacement.receipt.workspaceId], limitations: ['One physical machine, not remote-node certification.'] };
writeFileSync(join(root, 'evidence.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
