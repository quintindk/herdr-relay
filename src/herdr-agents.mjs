import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { canonical, digest, requireValue, text } from './protocol.mjs';

export function herdrConfig(input) {
  const config = { socketPath: text(input.socketPath, 'socketPath'),
    machineId: text(input.machineId, 'machineId'), session: text(input.session, 'session'),
    companyId: text(input.companyId, 'companyId'), excludedWorkspaces: input.excludedWorkspaces ?? [],
    ...(input.bridgeDirectories === undefined ? {} : { bridgeDirectories: input.bridgeDirectories }) };
  requireValue(isAbsolute(config.socketPath), 'invalid_herdr_config', 'Herdr socket path must be absolute');
  requireValue(Array.isArray(config.excludedWorkspaces) && config.excludedWorkspaces.every(id => typeof id === 'string' && id.length),
    'invalid_herdr_config', 'excludedWorkspaces must contain workspace IDs');
  requireValue(config.bridgeDirectories === undefined || (Array.isArray(config.bridgeDirectories) &&
    config.bridgeDirectories.every(path => typeof path === 'string' && isAbsolute(path))),
  'invalid_herdr_config', 'bridgeDirectories must contain absolute directory paths');
  return config;
}

export function observedAgents(store) {
  return store.db.prepare("SELECT data FROM operations WHERE id LIKE 'herdr-agent:%' ORDER BY id").all().map(row => JSON.parse(row.data));
}

export async function reconcileHerdrAgents(store, api, config, snapshot, current = () => true) {
  requireValue(Array.isArray(snapshot.agents) && snapshot.agents.every(agent =>
    typeof agent.pane_id === 'string' && typeof agent.terminal_id === 'string' && typeof agent.workspace_id === 'string'),
  'invalid_herdr_snapshot', 'Expected complete Herdr agent inventory');
  const scope = { machineId: config.machineId, session: config.session, companyId: config.companyId };
  const agents = snapshot.agents.filter(agent => agent.agent && !config.excludedWorkspaces.includes(agent.workspace_id));
  const candidates = new Map();
  for (const agent of agents) {
    const ref = agent.agent_session;
    if (!ref || ref.agent !== agent.agent || !['id', 'path'].includes(ref.kind) || typeof ref.value !== 'string' || !ref.value) continue;
    if (ref.kind === 'path' && !isAbsolute(ref.value)) continue;
    const identity = { ...scope, harness: agent.agent, sessionKind: ref.kind, conversationId: ref.value };
    const id = `herdr-agent:${digest(identity)}`;
    candidates.set(id, [...(candidates.get(id) ?? []), { agent, identity }]);
  }
  const companiesAgents = await api('GET', `/api/companies/${encodeURIComponent(config.companyId)}/agents`);
  requireValue(Array.isArray(companiesAgents), 'invalid_backend_response', 'Expected Paperclip agents array', 502);
  if (!current()) return;
  for (const [id, matches] of candidates) {
    const { identity } = matches[0];
    if (!store.operation(id)) store.saveOperation({ id, runId: '', identity, marker: randomUUID(), state: 'intent' });
  }
  for (let operation of observedAgents(store).filter(item => canonical({ machineId: item.identity.machineId,
    session: item.identity.session, companyId: item.identity.companyId }) === canonical(scope))) {
    try {
      if (!current()) return;
      const matches = candidates.get(operation.id) ?? [];
      const agent = matches.length === 1 ? matches[0].agent : null;
      const pendingIdentity = agents.some(item => item.terminal_id === operation.placement?.terminalId && !item.agent_session);
      const availability = agent ? 'present' : matches.length > 1 || pendingIdentity ? 'unknown' : 'offline';
      const clean = value => typeof value === 'string'
        ? stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) : '';
      const workspace = agent && snapshot.workspaces?.find(item => item.workspace_id === agent.workspace_id);
      const tab = agent && snapshot.tabs?.find(item => item.tab_id === agent.tab_id && item.workspace_id === agent.workspace_id);
      const pane = agent && snapshot.panes?.find(item => item.pane_id === agent.pane_id && item.terminal_id === agent.terminal_id);
      let display = operation.observation?.display ?? null;
      if (agent) {
        const name = clean(agent.name);
        const workspaceLabel = clean(workspace?.label);
        const tabLabel = clean(tab?.label);
        const paneLabel = clean(pane?.label);
        const terminalTitle = clean(agent.title) || clean(agent.terminal_title_stripped) || clean(agent.terminal_title);
        const context = workspaceLabel || clean(basename(agent.cwd || ''));
        const fallback = context || paneLabel || `${agent.agent} ${agent.pane_id}`;
        display = { name: (name || fallback).slice(0, 240),
          title: [clean(agent.display_agent) || clean(agent.agent), workspaceLabel, tabLabel && `tab ${tabLabel}`].filter(Boolean).join(' | ').slice(0, 240),
          agentName: name || null, workspaceLabel: workspaceLabel || null, tabLabel: tabLabel || null,
          paneLabel: paneLabel || null, terminalTitle: terminalTitle || null };
      }
      const placement = agent ? { paneId: agent.pane_id, terminalId: agent.terminal_id,
        workspaceId: agent.workspace_id, tabId: agent.tab_id ?? null, directory: agent.cwd ?? null,
        foregroundDirectory: agent.foreground_cwd ?? null } : operation.placement ?? null;
      const observation = { identity: operation.identity, availability, placement, display,
        state: agent?.agent_status ?? 'unknown', dispatch: 'unavailable', lifecycleAuthority: 'observe_only' };
      const bindingId = `observed-${digest(operation.id).slice(0, 24)}`;
      const permit = store.operation(`observed-pull:${bindingId}`);
      const bridge = store.operation(`opencode-bridge:${bindingId}`);
      const reserved = permit?.state === 'active' && permit.request.observedId === operation.id &&
        (Date.parse(permit.expiresAt) > Date.now() || store.runs(bindingId).some(run => run.nativeState !== 'settled'));
      if (reserved) observation.dispatch = 'operator_reserved_pull';
      const bridged = bridge?.state === 'armed';
      if (bridge) observation.dispatch = bridged && Date.now() - Date.parse(bridge.lastSeen) < 10000 ? 'opencode_bridge' : 'bridge_unavailable';
      operation = store.saveOperation({ ...operation, availability, placement, observation, error: null });
      const backendMatches = companiesAgents.filter(item => item.adapterConfig?.relayObservationMarker === operation.marker);
      requireValue(backendMatches.length <= 1, 'agent_identity_ambiguous', 'Multiple agents match observed identity', 409);
      let backend = operation.agentId ? companiesAgents.find(item => item.id === operation.agentId) : backendMatches[0];
      if (!backend) {
        requireValue(!operation.agentId, 'observed_agent_missing', 'Previously registered Paperclip agent is missing; refusing replacement', 409);
        if (!agent) continue;
        requireValue(operation.state !== 'uncertain', 'agent_creation_uncertain', 'Creation was attempted; absence does not authorise another create', 409);
        operation = store.saveOperation({ ...operation, state: 'uncertain' });
        backend = await api('POST', `/api/companies/${encodeURIComponent(config.companyId)}/agents`, {
          name: display.name, title: display.title,
          adapterType: 'herdr_relay', adapterConfig: { observationOnly: true, relayObservationMarker: operation.marker },
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
          metadata: { relayObservation: observation },
        });
      }
      requireValue(typeof backend.id === 'string' && backend.companyId === config.companyId &&
        backend.adapterType === 'herdr_relay' && backend.adapterConfig?.relayObservationMarker === operation.marker &&
        (backend.adapterConfig?.observationOnly === true || ((permit || bridge) && backend.adapterConfig?.bindingId === bindingId)),
      'observed_agent_conflict', 'Paperclip agent ownership or delivery configuration changed', 409);
      operation = store.saveOperation({ ...operation, agentId: backend.id, state: 'recorded' });
      if (!current()) return;
      // Observation does not confer dispatch or process ownership. Never turn a
      // detected terminal's idle/done status into Paperclip task completion.
      const previousObservation = backend.metadata?.relayObservation;
      const { observedAt, ...previousFields } = previousObservation ?? {};
      // Paperclip may allocate a unique suffix. Do not repeatedly restore a taken name.
      const nameChanged = agent && previousObservation?.display?.name !== display.name && backend.name !== display.name;
      const titleChanged = agent && backend.title !== display.title;
      const displayChanged = nameChanged || titleChanged;
      if (displayChanged || (!reserved && !bridged && backend.status !== 'paused') || canonical(previousFields) !== canonical(observation) ||
        !observedAt || Date.now() - Date.parse(observedAt) > 60000) {
        await api('PATCH', `/api/agents/${encodeURIComponent(backend.id)}`, {
          ...(nameChanged ? { name: display.name } : {}), ...(titleChanged ? { title: display.title } : {}),
          ...(!reserved && !bridged ? { status: 'paused' } : {}), metadata: { ...backend.metadata, relayObservation: { ...observation, observedAt: new Date().toISOString() } },
        });
      }
    } catch (error) {
      store.saveOperation({ ...operation, error: error.code ?? 'backend_unavailable' });
    }
  }
}

export function watchHerdrAgents(store, api, config, { intervalMs = 5000, reconnectMs = 1000, afterReconcile = async () => {} } = {}) {
  let socket, timer, retry, pending, buffer = '', sequence = 0, closed = false, subscribed = false, busy, dirty = false, lastStarted = 0;
  const sourceId = `herdr-source:${digest([config.machineId, config.session, config.companyId])}`;
  const status = (state, error = null) => store.saveOperation({ id: sourceId, runId: '',
    state, error, machineId: config.machineId, session: config.session, companyId: config.companyId, socketPath: config.socketPath });
  const unknown = () => {
    for (const record of observedAgents(store)) {
      if (record.identity.machineId === config.machineId && record.identity.session === config.session && record.identity.companyId === config.companyId) {
        store.saveOperation({ ...record, availability: 'unknown', error: 'herdr_unavailable' });
      }
    }
  };
  const request = () => new Promise((resolve, reject) => {
    const id = `snapshot-${++sequence}`;
    // Subscription connections switch to an event stream. RPCs need their own socket.
    const rpc = connect(config.socketPath);
    let data = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); pending = null; rpc.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error('snapshot_timeout')), 5000);
    pending = { cancel: () => finish(new Error('herdr_disconnected')) };
    rpc.setEncoding('utf8');
    rpc.on('connect', () => rpc.write(`${JSON.stringify({ id, method: 'session.snapshot', params: {} })}\n`));
    rpc.on('data', chunk => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) return finish(new Error('snapshot_too_large'));
      const end = data.indexOf('\n');
      if (end < 0) return;
      try {
        const message = JSON.parse(data.slice(0, end));
        if (message.id !== id || !message.result?.snapshot) return finish(new Error('invalid_snapshot'));
        finish(null, message.result.snapshot);
      } catch { finish(new Error('invalid_snapshot')); }
    });
    rpc.on('error', error => finish(error));
    rpc.on('close', () => finish(new Error('snapshot_disconnected')));
  });
  const reconcile = () => {
    if (closed || !subscribed) return;
    if (busy) return;
    if (Date.now() - lastStarted < Math.min(intervalMs, 1000)) return;
    lastStarted = Date.now();
    busy = (async () => {
      dirty = false;
      try {
        const snapshot = await request();
          await reconcileHerdrAgents(store, api, config, snapshot, () => subscribed && !closed && !dirty);
          if (subscribed && !closed && !dirty) await afterReconcile(() => subscribed && !closed && !dirty);
        if (subscribed) status('connected');
      } catch (error) { status(subscribed ? 'error' : 'disconnected', error.code ?? 'reconciliation_failed'); }
      if (!subscribed) unknown();
    })().finally(() => { busy = null; });
  };
  const open = () => {
    if (closed) return;
    buffer = ''; subscribed = false;
    status('connecting');
    socket = connect(config.socketPath);
    socket.setEncoding('utf8');
    const handshake = setTimeout(() => socket.destroy(), 5000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'subscribe', method: 'events.subscribe', params: {
      subscriptions: ['pane.agent_detected', 'pane.updated', 'pane.moved', 'pane.exited', 'pane.closed',
        'workspace.renamed', 'tab.renamed', 'tab.moved'].map(type => ({ type })),
    } })}\n`));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) { socket.destroy(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        let message;
        try { message = JSON.parse(buffer.slice(0, end)); } catch { socket.destroy(); return; }
        buffer = buffer.slice(end + 1);
        if (message.id === 'subscribe') {
          if (message.result?.type !== 'subscription_started') { socket.destroy(); return; }
          clearTimeout(handshake); subscribed = true; reconcile();
        } else if (message.event) { dirty = true; }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(handshake); subscribed = false;
      pending?.cancel();
      unknown(); status('disconnected', 'herdr_unavailable');
      if (!closed) retry = setTimeout(open, reconnectMs);
    });
  };
  unknown(); open();
  timer = setInterval(reconcile, intervalMs);
  // Coalesce bursts without postponing periodic inventory repair.
  const events = setInterval(() => { if (dirty) reconcile(); }, 200);
  return { status: () => store.operation(sourceId), close: async () => {
    closed = true; clearInterval(timer); clearInterval(events); clearTimeout(retry);
    await new Promise(resolve => { if (socket.destroyed) resolve(); else { socket.once('close', resolve); socket.destroy(); } });
    await busy;
  } };
}
