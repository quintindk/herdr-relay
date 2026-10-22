import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { digest, requireValue } from './protocol.mjs';
import { NativeReceivers } from './native-receivers.mjs';
import { nativeConnection } from './native-enrol.mjs';
import { writePrivateJson } from './private-files.mjs';
import { HeadlessAccess, accessReferences } from '../packages/opencode-relay/headless-access.mjs';
import { setupTerminal, headlessProbeId } from './headless-setup-contract.mjs';

export async function assertHeadlessAccess(api, client, setupId, directory) {
  const authority = await api('GET', `/v1/headless_setups/${encodeURIComponent(setupId)}/authority`);
  const check = await client.rpc(HeadlessAccess).check(accessReferences(authority.grant), { location: { directory } });
  requireValue(check.allowed, check.blocker, 'Existing authorised integration is unavailable or changed');
  return { ...authority, check };
}

export async function tickHeadlessSetups(journal, api, config, load, resolveBinding, dependencies = {}) {
  const records = new NativeReceivers(journal);
  const native = dependencies.native ?? (() => nativeConnection({ serviceRegistration: config.headless?.serviceRegistration }));
  for (const setup of records.list('headless-setup')) {
    if (setupTerminal.includes(setup.state)) continue;
    let op = records.get(`headless-op:${setup.id}`) ?? { phase: 'requested', attempt: setup.attempt ?? 1 };
    if ((setup.attempt ?? 1) > (op.attempt ?? 1)) op = { ...op, attempt: setup.attempt, phase: op.binding ? 'binding' : 'requested' };
    const save = patch => { op = records.put(`headless-op:${setup.id}`, { ...op, ...patch }); };
    const command = async (action, payload = { id: setup.id }) => {
      const key = `headless:${setup.id}:${setup.attempt ?? 1}:${action}`;
      journal.queue({ key, action, payload }); await journal.flush(api);
      const receipt = journal.receipt(key);
      requireValue(receipt?.state === 'recorded', receipt?.error ?? 'headless_publication_pending', 'Headless setup mutation is not confirmed');
      return receipt.receipt;
    };
    try {
      requireValue(config.identityVersion === 2, 'stable_node_required', 'Stable joined node required');
      requireValue(realpathSync(setup.directory) === setup.directory && statSync(setup.directory).isDirectory(), 'headless_directory_changed', 'Workspace must remain canonical');
      const connection = await native();
      const { grant, check } = await assertHeadlessAccess(api, connection.client, setup.id, setup.directory);
      const contract = join(setup.directory, grant.contract);
      requireValue(existsSync(contract) && realpathSync(contract) === contract && statSync(contract).isFile(), 'job_contract_missing', 'Exact workspace job skill must exist without symlink redirection');
      const contractDigest = digest(readFileSync(contract, 'utf8'));
      requireValue(!op.contractDigest || op.contractDigest === contractDigest, 'job_contract_changed', 'Job contract changed during setup; do not activate against stale approval');
      if (op.phase === 'requested') {
        const permissions = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: contract, effect: 'allow' },
          ...['relay_work_read', 'relay_work_submit', 'relay_work_ask', 'relay_task_list', 'relay_task_inspect', 'relay_task_comments', 'relay_task_relations', 'relay_workiq_read', grant.workiq.readTool]
            .map(action => ({ action, resource: '*', effect: 'allow' }))];
        let session;
        try { session = await connection.client.session.get({ sessionID: setup.sessionId }); }
        catch (error) { if (error.status !== 404 && !['NotFoundError', 'SessionNotFoundError'].includes(error._tag ?? error.name)) throw error; }
        if (!session) session = await connection.client.session.create({ id: setup.sessionId, location: { directory: setup.directory }, title: setup.name,
          model: { providerID: grant.model.providerID, id: grant.model.id }, permissions, metadata: { relayHeadlessSetup: setup.id } });
        requireValue(session.metadata?.relayHeadlessSetup === setup.id && session.location.directory === setup.directory && !session.parentID && !session.time.archived,
          'headless_session_conflict', 'Do not adopt or replace an unrelated session');
        const authFile = join(config.stateDirectory, `headless-auth-${digest(setup.id)}.json`);
        writePrivateJson(authFile, { password: connection.password });
        const binding = { id: setup.bindingId, agentId: setup.agentId, name: setup.name, mode: 'headless', harness: 'opencode-v2', reserved: true,
          headlessSetupId: setup.id, url: connection.url, authFile, directory: setup.directory, sessionPermissions: permissions,
          identity: { sessionId: session.id, projectId: session.projectID, directory: setup.directory, createdAt: session.time.created } };
        // Journal the complete binding before registration/hot-loading. No node.json rewrite/restart.
        save({ binding, contractDigest, accessDigest: check.accessDigest, phase: 'binding' });
        continue;
      }
      if (op.phase === 'binding') {
        await command('headless.register'); await load(op.binding); save({ phase: 'probe' }); continue;
      }
      if (op.phase === 'probe') {
        const agent = await api('GET', `/v1/agents/${setup.agentId}`);
        if (agent.availability !== 'available' || agent.conversationId !== setup.sessionId) continue;
        await command('headless.probe'); save({ phase: 'checking', deadline: Date.now() + 60000 }); continue;
      }
      if (op.phase === 'checking') {
        const probe = await api('GET', `/v1/executions/${headlessProbeId(setup)}`);
        if (['failed', 'cancelled', 'rejected'].includes(probe.state)) throw Object.assign(Error('Readiness execution did not succeed'), { code: 'readiness_execution_failed' });
        if (probe.state !== 'completed') {
          requireValue(Date.now() < op.deadline, 'readiness_timeout', 'Bounded readiness probe timed out; schedule remains absent'); continue;
        }
        const binding = await resolveBinding(setup.agentId);
        requireValue(binding, 'headless_binding_unavailable', 'Prepared worker is not loaded');
        const work = journal.work(probe.id), snapshot = await binding.native.snapshot();
        requireValue(work?.invocation && work.observation?.state === 'finished' && work.observation.outcome === 'succeeded', 'readiness_terminal_missing', 'Correlated native terminal evidence required');
        const begin = snapshot.messages.findIndex(m => m.id === work.invocation.messageId);
        const end = snapshot.messages.findIndex(m => m.id === work.observation.messageId);
        requireValue(begin >= 0 && end > begin, 'readiness_terminal_missing', 'Probe transcript bounds must be exact');
        const tools = snapshot.messages.slice(begin + 1, end).filter(m => m.type === 'assistant').flatMap(m => m.content.filter(c => c.type === 'tool'));
        const read = tools.find(t => t.name === 'relay_workiq_read' && t.state.status === 'completed' && digest(t.state.input.arguments) === digest(grant.workiq.probeInput) && t.state.metadata?.headlessWorkiqTool === grant.workiq.readTool);
        requireValue(read && read.state.content?.length && read.state.metadata?.isError !== true, 'workiq_readiness_not_proven', 'An actual successful WorkIQ read with the bounded input is required');
        requireValue(tools.some(t => t.name === 'relay_work_submit' && t.state.status === 'completed'), 'readiness_submission_missing', 'Actual native result submission required');
        await command('headless.activate', { id: setup.id, receipt: { nativeTerminalId: work.observation.messageId, workiqToolCallId: read.id,
          workiqInputDigest: digest(grant.workiq.probeInput), accessDigest: check.accessDigest } });
        save({ phase: 'ready' });
      }
    } catch (error) {
      if (['headless_publication_pending', 'headless_not_ready'].includes(error.code)) continue;
      const blocker = /^[a-z][a-z0-9_]{1,95}$/.test(error.code ?? '') ? error.code : 'native_setup_unavailable';
      // No raw errors, provider bodies, credential material or WorkIQ content is published.
      await command('headless.block', { id: setup.id, reason: blocker });
      save({ phase: 'blocked', blocker });
    }
  }
}
