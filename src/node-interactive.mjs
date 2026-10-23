import { connect } from 'node:net';
import { existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeReceivers } from './native-receivers.mjs';
import { nativeConnection } from './native-enrol.mjs';
import { canonicalDirectory, withinRoots, interactiveTerminal } from './interactive-contract.mjs';
import { digest, now, requireValue } from './protocol.mjs';

export function herdrRpc(socketPath, method, params) {
  requireValue(isAbsolute(socketPath), 'invalid_herdr_config', 'Explicit local Herdr socket required');
  return new Promise((resolve, reject) => {
    const id = randomUUID(), socket = connect(socketPath);
    let data = '', finished = false;
    const finish = (error, result) => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(Object.assign(Error('Herdr request outcome is uncertain'), { code: 'herdr_uncertain' })), 40000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('error', error => finish(error)); socket.on('close', () => finish(Object.assign(Error('Herdr disconnected'), { code: 'herdr_uncertain' })));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) { finish(Error('Herdr response too large')); return; }
      const end = data.indexOf('\n'); if (end < 0) return;
      try {
        const response = JSON.parse(data.slice(0, end));
        requireValue(response.id === id && !response.error && response.result, 'herdr_uncertain', 'Herdr outcome was not verified');
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
  });
}

const directoryIdentity = directory => {
  requireValue(realpathSync(directory) === directory && lstatSync(directory).isDirectory(), 'directory_identity_changed', 'Canonical existing workspace directory required');
  const stat = lstatSync(directory);
  return { directory, dev: stat.dev, ino: stat.ino };
};
const exactPlacement = (snapshot, op, ready = false) => {
  const p = op.placement;
  const panes = snapshot.panes.filter(item => item.pane_id === p.paneId || item.terminal_id === p.terminalId);
  requireValue(panes.length === 1 && panes[0].pane_id === p.paneId && panes[0].terminal_id === p.terminalId &&
    panes[0].workspace_id === p.workspaceId && panes[0].tab_id === p.tabId && panes[0].cwd === op.directory,
    'placement_changed', 'Prepared pane identity or workspace changed');
  const agents = snapshot.agents.filter(item => item.pane_id === p.paneId);
  if (!ready) return { pane: panes[0], agent: agents[0] };
  const agent = agents[0];
  if (!agent?.agent_session || agent.launch_pending || !agent.interactive_ready) return null;
  requireValue(agents.length === 1 && agent.agent === 'opencode' && agent.agent_session.kind === 'id' &&
    agent.agent_session.value === op.sessionId && agent.cwd === op.directory && agent.terminal_id === p.terminalId &&
    agent.workspace_id === p.workspaceId && agent.tab_id === p.tabId,
    'native_placement_mismatch', 'Herdr does not contain the exact prepared native session');
  return { pane: panes[0], agent };
};

// The same addressed-request driver runs locally and remotely. It never uses
// owner credentials or sends native work. Filesystem, pane and process effects
// have their own durable intent; absent observations never permit replay.
export async function tickInteractive(journal, api, config, resolveBinding, dependencies = {}) {
  const records = new NativeReceivers(journal);
  const rpc = dependencies.rpc ?? ((method, params) => herdrRpc(config.interactive?.herdrSocketPath, method, params));
  const native = dependencies.native ?? (() => nativeConnection({ serviceRegistration: config.interactive?.serviceRegistration }));
  const snapshot = async () => {
    const value = (await rpc('session.snapshot', {})).snapshot;
    requireValue(value?.protocol === 22 && ['agents', 'panes', 'tabs', 'workspaces'].every(k => Array.isArray(value[k])),
      'invalid_herdr_snapshot', 'A complete supported Herdr snapshot is required');
    return value;
  };
  for (const request of records.list('interactive-request')) {
    // Receipt reconciliation is not a fresh permission to mutate. Finish a
    // proved local attachment (or restore after a definitive refusal) even if
    // cancellation/revocation arrived while its reply was lost.
    const attachment = records.get(`attachment:interactive-${digest(request.id)}`);
    if (attachment?.state === 'pending') {
      const publication = journal.receipt(`interactive:${request.id}:attach`);
      if (publication?.state === 'recorded') records.confirm(attachment, publication.receipt);
      else if (publication?.state === 'conflict') {
        try { records.reject(attachment, { code: publication.error }, await api('GET', `/v1/agents/${encodeURIComponent(request.agentId)}`)); } catch {}
      }
    }
    if (interactiveTerminal.includes(request.state)) continue;
    let op = records.get(`interactive-op:${request.id}`) ?? { id: request.id, directory: request.directory, phase: 'initial' };
    const save = patch => { op = records.put(`interactive-op:${request.id}`, { ...op, ...patch }); return op; };
    const authority = () => api('GET', `/v1/provision_requests/${encodeURIComponent(request.id)}/authority`);
    const command = async (key, action, payload) => {
      const fullKey = `interactive:${request.id}:${key}`;
      journal.queue({ key: fullKey, action, payload }); await journal.flush(api);
      const receipt = journal.receipt(fullKey);
      requireValue(receipt?.state === 'recorded', 'publication_pending', 'Provisioning mutation awaits a receipt');
      return receipt.receipt;
    };
    const progress = async (state, extra = {}) => {
      const current = await api('GET', `/v1/provision_requests/${encodeURIComponent(request.id)}`);
      if (current.state === state) return current;
      return command(`progress-${state}-${current.revision}`, 'interactive.progress', { id: request.id, expectedRevision: current.revision, state, ...extra });
    };
    try {
      const { grant } = await authority();
      const policy = config.interactive;
      requireValue(policy && ['roots', 'localUser'].includes(policy.mode) && isAbsolute(policy.herdrSocketPath ?? ''),
        'interactive_not_configured', 'Destination node has no interactive provisioning policy');
      requireValue(canonicalDirectory(request.directory) && (policy.mode === 'localUser' || Array.isArray(policy.roots) && withinRoots(request.directory, policy.roots.map(p => realpathSync(p)))) &&
        (grant.mode === 'localUser' || withinRoots(request.directory, grant.roots)), 'provisioning_directory_forbidden', 'Destination policy refuses this workspace');
      requireValue((policy.profiles ?? ['build']).includes(request.profile), 'profile_forbidden', 'Native profile is not allowed by this node');
      const guard = async () => {
        await authority();
        if (op.directoryIdentity) requireValue(digest(directoryIdentity(op.directory)) === digest(op.directoryIdentity), 'directory_identity_changed', 'Workspace directory was replaced');
        const receiver = records.receiver(request.agentId);
        if (op.bindingId) requireValue(receiver?.state === 'active' && receiver.bindingId === op.bindingId, 'stale_binding', 'The prepared receiver was replaced');
        else requireValue((receiver?.generation ?? 0) === request.expectedBindingRevision && receiver?.state !== 'pending' ||
          receiver?.key === `interactive-${digest(request.id)}`, 'stale_binding', 'Receiving chat changed during preparation');
      };
      if (op.phase === 'initial') {
        await progress('accepted'); await guard();
        if (!existsSync(op.directory)) {
          requireValue(request.createDirectory && policy.allowCreateDirectories && grant.allowCreateDirectories, 'directory_creation_forbidden', 'Directory does not exist and creation is not authorised');
          const parent = realpathSync(dirname(op.directory));
          requireValue(join(parent, basename(op.directory)) === op.directory, 'provisioning_directory_forbidden', 'New directory escaped its canonical parent');
          save({ directoryIntent: true });
          mkdirSync(op.directory, { mode: 0o700 });
          writeFileSync(join(op.directory, '.relay-workspace-owner'), request.id, { mode: 0o600, flag: 'wx', flush: true });
        } else if (op.directoryIntent) {
          requireValue(readFileSync(join(op.directory, '.relay-workspace-owner'), 'utf8') === request.id,
            'directory_creation_uncertain', 'Existing directory was not proved to be created by this request');
        }
        save({ directoryIdentity: directoryIdentity(op.directory), phase: 'directory' });
        continue;
      }
      await guard();
      if (op.phase === 'directory') {
        if (request.newEnrolment) {
          requireValue(policy.allowNewEnrolments && records.list('enrolment').length < Math.min(policy.maxAgents ?? 10, grant.maxAgents) ||
            records.get(`enrolment:${request.agentId}`), 'agent_limit', 'New enrolment is disabled or the local agent limit was reached');
          const enrolment = records.enrol({ id: request.agentId, directory: op.directory, name: request.name, transport: 'tools' });
          await command('enrol', 'interactive.enrol', { id: request.id });
          requireValue(enrolment.id === request.agentId, 'agent_identity_changed', 'Prepared enrolment identity differs');
        } else requireValue(records.get(`enrolment:${request.agentId}`)?.directory === op.directory, 'enrolment_missing', 'Destination has no matching local enrolment');
        const connection = await native();
        let existing;
        if (request.instance === 'ensure' && request.previousConversationId) {
          try { existing = await connection.client.session.get({ sessionID: request.previousConversationId }); }
          catch (error) { if (error.status !== 404 && !['NotFoundError', 'SessionNotFoundError'].includes(error.name)) throw error; }
          if (existing?.time.archived) existing = null;
          if (existing) requireValue(existing.location?.directory === op.directory && !existing.parentID && !existing.revert, 'native_identity_mismatch', 'Existing receiving session changed scope');
        }
        requireValue(existing || !request.previousConversationId || grant.allowReplacement && policy.allowReplacement,
          'replacement_forbidden', 'Opening a replacement requires an explicit grant and local policy');
        let model = existing?.model ?? policy.model ?? request.model;
        if (!model) {
          const profile = await connection.client.agent.get({ agentID: request.profile, location: { directory: op.directory } });
          const fallback = profile.data.model ?? (await connection.client.model.default({ location: { directory: op.directory } })).data;
          requireValue(fallback?.id && fallback.providerID, 'native_model_unavailable', 'No explicit or resolvable model for the new native session');
          model = { id: fallback.id, providerID: fallback.providerID,
            ...(fallback.variant && fallback.variant !== 'default' ? { variant: fallback.variant } : {}) };
        }
        save({ sessionId: existing?.id ?? request.desiredSessionId, model, phase: 'selected' });
        continue;
      }
      const connection = await native();
      const session = async () => {
        let value;
        try { value = await connection.client.session.get({ sessionID: op.sessionId }); }
        catch (error) { if (error.status !== 404 && !['NotFoundError', 'SessionNotFoundError'].includes(error.name)) throw error; }
        if (!value && op.sessionId === request.desiredSessionId && op.phase === 'selected') {
          await guard();
          value = await connection.client.session.create({ id: op.sessionId, location: { directory: op.directory }, agent: request.profile, model: op.model,
            title: request.name, metadata: { relayProvisionRequest: request.id, relayDiscussionTopic: request.topic ?? '' } });
        }
        requireValue(value?.id === op.sessionId && value.location?.directory === op.directory && !value.time.archived && !value.parentID && !value.revert &&
          (op.sessionId !== request.desiredSessionId || value.metadata?.relayProvisionRequest === request.id), 'native_identity_mismatch', 'Exact prepared native session unavailable');
        if (op.model) requireValue(value.model?.id === op.model.id && value.model.providerID === op.model.providerID &&
          (!op.model.variant || op.model.variant === 'default' || value.model.variant === op.model.variant),
          'native_model_changed', 'Native model differs from the explicitly resolved model');
        return value;
      };
      const currentSession = await session();
      if (op.phase === 'selected') {
        const view = await snapshot();
        const matches = view.agents.filter(a => a.agent_session?.kind === 'id' && a.agent_session.value === op.sessionId);
        requireValue(matches.length <= 1, 'ambiguous_placement', 'The native session appears in multiple Herdr panes');
        if (matches.length) {
          const a = matches[0];
          requireValue(a.cwd === op.directory && a.agent === 'opencode', 'native_placement_mismatch', 'Existing pane belongs to another workspace or harness');
          save({ reused: true, placement: { workspaceId: a.workspace_id, tabId: a.tab_id, paneId: a.pane_id, terminalId: a.terminal_id }, phase: 'opening' });
          continue;
        }
        await progress('preparing_workspace');
        const label = `relay-${digest(request.id).slice(0, 20)}`;
        if (!op.workspaceIntent) {
          await guard();
          save({ workspaceIntent: { label, beforeIds: view.workspaces.map(w => w.workspace_id) } });
          const result = await rpc('workspace.create', { cwd: op.directory, label, focus: false,
            ...(policy.environment ? { env: policy.environment } : {}) });
          const pane = result.root_pane;
          requireValue(result.type === 'workspace_created' && pane?.cwd === op.directory && pane.workspace_id === result.workspace?.workspace_id &&
            pane.tab_id === result.tab?.tab_id && pane.pane_id && pane.terminal_id, 'herdr_uncertain', 'Workspace create receipt did not prove its placement');
          save({ placement: { workspaceId: pane.workspace_id, tabId: pane.tab_id, paneId: pane.pane_id, terminalId: pane.terminal_id }, reused: false, phase: 'workspace' });
        } else {
          const candidates = view.workspaces.filter(w => w.label === label && !op.workspaceIntent.beforeIds.includes(w.workspace_id));
          requireValue(candidates.length <= 1, 'ambiguous_placement', 'Multiple possible workspace create outcomes');
          const panes = view.panes.filter(p => p.workspace_id === candidates[0]?.workspace_id && p.cwd === op.directory);
          if (!candidates.length || panes.length !== 1) { save({ blocker: 'workspace_create_uncertain' }); await progress('uncertain', { reason: 'Workspace create outcome is uncertain. No resend is permitted.' }); continue; }
          const p = panes[0];
          save({ placement: { workspaceId: p.workspace_id, tabId: p.tab_id, paneId: p.pane_id, terminalId: p.terminal_id }, reused: false, phase: 'workspace' });
        }
        continue;
      }
      if (op.phase === 'workspace') {
        const view = await snapshot(), { pane } = exactPlacement(view, op);
        if (!op.startIntent) {
          requireValue(!pane.agent && !view.agents.some(a => a.pane_id === pane.pane_id && a.agent), 'pane_occupied', 'Prepared shell is no longer empty');
          await progress('opening_chat'); await guard();
          save({ startIntent: true });
          await rpc('agent.start', { pane_id: pane.pane_id, name: `relay-${digest(request.id).slice(0, 20)}`, kind: 'opencode', args: ['--session', op.sessionId], timeout_ms: 30000 });
          save({ phase: 'opening' });
        } else {
          if (!exactPlacement(view, op, true)) { save({ blocker: 'native_start_uncertain' }); await progress('uncertain', { reason: 'Interactive launch is unproved. No resend is permitted.' }); continue; }
          save({ phase: 'opening' });
        }
        continue;
      }
      if (op.phase === 'opening') {
        if (!exactPlacement(await snapshot(), op, true)) continue;
        save({ phase: 'attaching' }); continue;
      }
      if (op.phase === 'attaching') {
        await progress('attaching'); await guard();
        const authFile = join(config.stateDirectory, `native-auth-${digest([connection.url, connection.password])}.json`);
        if (!existsSync(authFile)) writeFileSync(authFile, JSON.stringify({ password: connection.password }), { mode: 0o600, flag: 'wx', flush: true });
        const operation = records.prepare({ agentId: request.agentId, identity: { sessionId: currentSession.id, projectId: currentSession.projectID,
          directory: op.directory, createdAt: currentSession.time.created }, url: connection.url, authFile,
          expectedGeneration: request.expectedBindingRevision, key: `interactive-${digest(request.id)}` });
        if (operation.state === 'pending') {
          let agent;
          try { agent = await command('attach', 'interactive.attach', { id: request.id, attachment: operation.command.payload }); }
          catch (error) {
            if ([400, 403, 404, 409].includes(error.status)) records.reject(operation, error, await api('GET', `/v1/agents/${encodeURIComponent(request.agentId)}`));
            throw error;
          }
          records.confirm(operation, agent);
        }
        const receiver = records.receiver(request.agentId);
        requireValue(receiver.state === 'active' && receiver.bindingId === operation.binding.id, 'stale_binding', 'Attachment was superseded');
        records.put(`interactive-context:${receiver.bindingId}`, { requestId: request.id, requesterAgentId: request.requesterAgentId,
          topic: request.topic ?? '', authority: 'discussion_context_only', at: now() });
        save({ bindingId: receiver.bindingId, generation: receiver.generation, phase: 'verifying' }); continue;
      }
      if (op.phase === 'verifying') {
        const binding = await resolveBinding(request.agentId);
        if (binding?.id !== op.bindingId) continue;
        await binding.native.snapshot();
        if (!exactPlacement(await snapshot(), op, true)) continue;
        await guard();
        // Keep the recovery marker until placement and attachment are proven.
        // Naming is presentation only and must never replay an attachment.
        let workspaceNameState = 'unconfirmed';
        try {
          requireValue(typeof request.name === 'string' && request.name.trim() && request.name.length <= 256 &&
            !/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(request.name), 'invalid_workspace_label', 'Safe agent label required');
          await rpc('workspace.rename', { workspace_id: op.placement.workspaceId, label: request.name });
          workspaceNameState = 'renamed';
        } catch {}
        save({ workspaceNameState });
        const receipt = { ...op.placement, agentId: request.agentId, conversationId: op.sessionId, bindingId: op.bindingId,
          generation: op.generation, directory: op.directory, reused: op.reused, readyAt: now(), ...(currentSession.model ? { model: currentSession.model } : {}) };
        await progress('ready', { receipt }); save({ phase: 'ready', receipt });
      }
    } catch (error) {
      // Do not expose native auth, environment, raw CLI errors or arbitrary
      // transport messages through backend progress records.
      const reason = typeof error.code === 'string' ? error.code : 'provisioning_transport_unavailable';
      save({ blocker: reason });
      if (error.code === 'herdr_uncertain' || op.workspaceIntent && !op.placement || op.startIntent && op.phase === 'workspace') {
        try { await progress('uncertain', { reason }); } catch {}
      } else if (error.status && error.status < 500 || ['interactive_not_configured', 'profile_forbidden', 'agent_limit', 'directory_creation_forbidden',
        'provisioning_directory_forbidden', 'directory_identity_changed', 'directory_creation_uncertain', 'ambiguous_placement', 'placement_changed',
        'native_placement_mismatch', 'pane_occupied', 'enrolment_missing', 'enrolment_exists', 'native_identity_mismatch', 'native_model_unavailable', 'native_model_changed'].includes(error.code)) {
        try { await progress('blocked', { reason }); save({ phase: 'blocked' }); } catch {}
      }
    }
  }
}
