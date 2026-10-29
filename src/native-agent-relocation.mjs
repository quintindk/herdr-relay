import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest, requireValue } from './protocol.mjs';
import { nativeNodeConfig, nativeSession, attachInteractive } from './native-enrol.mjs';
import { NodeJournal, commandWorkId } from './node-journal.mjs';
import { NativeReceivers } from './native-receivers.mjs';
import { createPrivateJson } from './private-files.mjs';
import { definitivePublicationRefusal } from './publication-outcomes.mjs';

export async function relocateInteractive(input, dependencies = {}) {
  requireValue(input.api && input.agentId && input.sessionId && typeof input.previousDirectory === 'string' &&
    Number.isSafeInteger(input.expectedGeneration) && input.expectedGeneration > 0 && input.directory,
  'invalid_relocation', 'Inspect the existing agent, workspace, receiver generation and exact moved root chat first');
  if (input.apply) requireValue(typeof input.key === 'string' && /^[A-Za-z0-9:_.-]{1,128}$/.test(input.key) && /^[a-f0-9]{64}$/.test(input.previewHash ?? ''),
    'invalid_relocation', 'Apply requires an immutable key and the exact preview hash');
  const configFile = resolve(input.configFile ?? nativeNodeConfig()), config = JSON.parse(readFileSync(configFile, 'utf8'));
  requireValue(config.identityVersion === 2 && (!input.backend || input.backend.url === config.backend.url),
    'configuration_conflict', 'Use the existing joined node and matching backend');
  const info = await input.api('GET', '/v1/info');
  requireValue(info.features?.agentWorkspaceRelocation, 'backend_upgrade_required', 'The backend must support explicit agent workspace relocation');
  const journal = new NodeJournal(join(config.stateDirectory, 'node.sqlite'), { nodeId: config.nodeId, instanceId: info.instanceId });
  const receivers = new NativeReceivers(journal);
  try {
    const previous = input.apply && receivers.get(`attachment:${input.key}`);
    if (previous) {
      requireValue(previous.relocation?.previewHash === input.previewHash && previous.relocation.previousDirectory === input.previousDirectory &&
        previous.binding.agentId === input.agentId && previous.binding.identity.sessionId === input.sessionId &&
        previous.binding.identity.directory === resolve(input.directory) && previous.expectedGeneration === input.expectedGeneration,
      'operation_conflict', 'The relocation key belongs to a different confirmed move');
    } else {
      const enrolment = receivers.get(`enrolment:${input.agentId}`), current = receivers.receiver(input.agentId);
      const old = current && receivers.get(`native-binding:${current.bindingId}`);
      requireValue(enrolment?.directory === input.previousDirectory && current?.state === 'active' && current.generation === input.expectedGeneration &&
        old?.identity.sessionId === input.sessionId, 'stale_binding', 'Only this agent\'s current designated chat can relocate', 409);
      const agent = await input.api('GET', `/v1/agents/${encodeURIComponent(input.agentId)}`);
      requireValue(agent.nodeId === config.nodeId && agent.directory === enrolment.directory && agent.bindingId === old.id &&
        agent.bindingRevision === current.generation && agent.conversationId === input.sessionId,
      'stale_binding', 'Local enrolment and backend receiver must agree before relocation', 409);
      const native = await nativeSession({ ...input, requireRoot: true }, dependencies);
      requireValue(native.identity.directory !== enrolment.directory && native.identity.createdAt === old.identity.createdAt,
        'invalid_relocation', 'The existing chat must have moved to a different canonical workspace');
      const works = journal.works().filter(w => w.execution.targetAgentId === input.agentId && w.state !== 'administratively_abandoned');
      requireValue(works.every(w => ['completed', 'cancelled', 'failed', 'rejected'].includes(w.execution.state) && ['settled', 'native_finished'].includes(w.state)),
        'agent_busy', 'Reconcile pinned work before relocating its workspace. No work is moved, cancelled or replayed', 409);
      const ids = new Set(works.map(w => w.id));
      requireValue(!journal.db.prepare("SELECT key,hash,state,data FROM outbox WHERE state IN ('pending','conflict')").all()
        .some(row => ids.has(commandWorkId(JSON.parse(row.data).command)) && !definitivePublicationRefusal(row)) &&
        !journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain','conflict')").all().some(row => JSON.parse(row.data).bindingId === old.id),
      'agent_busy', 'Resolve uncertain publications and notices before relocating', 409);
      const [active, inbox] = await Promise.all([native.client.session.active(), native.client.session.inbox.list({ sessionID: input.sessionId })]);
      requireValue(active && !Array.isArray(active) && !active[input.sessionId] && Array.isArray(inbox) && !inbox.length,
        'native_session_busy', 'Wait for the existing native turn and pending input to settle');
      const operation = { agentId: input.agentId, nodeId: config.nodeId, previousDirectory: enrolment.directory,
        directory: native.identity.directory, expectedGeneration: current.generation, previousBindingId: old.id, identity: native.identity,
        transport: enrolment.transport, standingGrant: agent.standingGrant };
      const previewHash = digest(operation);
      if (!input.apply) return { state: 'relocation_preview', ...operation, previewHash,
        workerIdentityPreserved: true, sessionPreserved: true, schedulesUnchanged: true, permissionsChanged: false, promptReplayed: false };
      requireValue(previewHash === input.previewHash, 'stale_relocation_preview', 'Workspace, native identity or receiver changed after preview');
      const authFile = join(config.stateDirectory, `native-auth-${digest([native.url, native.password])}.json`);
      createPrivateJson(authFile, { password: native.password });
      receivers.prepare({ agentId: input.agentId, identity: native.identity, url: native.url, authFile, expectedGeneration: current.generation,
        key: input.key, relocation: { previousDirectory: enrolment.directory, previousBindingId: old.id, previewHash } });
    }
  } finally { journal.close(); }
  const result = await attachInteractive({ ...input, configFile }, dependencies);
  return { ...result, state: 'relocated', previousDirectory: input.previousDirectory, schedulesUnchanged: true, permissionsChanged: false, promptReplayed: false };
}
