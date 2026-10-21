import { connect } from 'node:net';
import { isAbsolute, basename } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { digest, requireValue } from './protocol.mjs';
import { hostname } from 'node:os';

// A hostname is a node-reported display label, never a machine identity or grant.
export function nodeHeartbeatPayload(nodeId, info, machine = { hostname: hostname(), platform: process.platform }) {
  return { id: nodeId, ...(info.features?.nodeMachineAdvertisement === true ? { machine } : {}) };
}

export function herdrInventory(socketPath) {
  requireValue(isAbsolute(socketPath), 'invalid_herdr_config', 'Absolute Herdr socket required');
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = '', done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Herdr inventory timed out')), 5000);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ id: 'relay-native-snapshot', method: 'session.snapshot', params: {} })}\n`));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) return finish(new Error('Herdr inventory too large'));
      const end = data.indexOf('\n'); if (end < 0) return;
      try {
        const response = JSON.parse(data.slice(0, end));
        requireValue(response.id === 'relay-native-snapshot' && Array.isArray(response.result?.snapshot?.agents), 'invalid_herdr_snapshot', 'Complete snapshot required');
        finish(null, response.result.snapshot);
      } catch (error) { finish(error); }
    });
    socket.on('error', error => finish(error)); socket.on('close', () => finish(new Error('Herdr inventory disconnected')));
  });
}

export async function publishHerdrInventory(api, { nodeId, socketPath, excludedWorkspaces = [] }, snapshot) {
  const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 240);
  const seen = new Map();
  for (const item of snapshot.agents) {
    const ref = item.agent_session;
    if (excludedWorkspaces.includes(item.workspace_id) || !ref || ref.agent !== item.agent ||
      !['id', 'path'].includes(ref.kind) || typeof ref.value !== 'string' || !ref.value || ref.kind === 'path' && !isAbsolute(ref.value)) continue;
    const id = `observed_${digest([nodeId, socketPath, item.agent, ref.kind, ref.value])}`;
    seen.set(id, [...(seen.get(id) ?? []), item]);
  }
  const published = [];
  for (const [id, matches] of seen) {
    const item = matches[0];
    let agent;
    try { agent = await api('GET', `/v1/agents/${id}`); }
    catch (error) {
      if (error.status !== 404) throw error;
      agent = await api('POST', '/v1/commands', { key: `observe-register:${id}`, action: 'agent.register', payload: {
        id, nodeId, name: clean(item.name || basename(item.cwd ?? '') || `${item.agent} conversation`),
        mode: 'interactive', capabilities: ['observation_only'],
      } });
    }
    requireValue(agent.nodeId === nodeId && agent.capabilities.includes('observation_only'), 'agent_identity_changed', 'Observation record changed ownership');
    agent = await api('POST', '/v1/commands', { key: `observe:${id}:${agent.revision}`, action: 'agent.advertise', payload: {
      id, expectedRevision: agent.revision, availability: 'unknown', conversationId: item.agent_session.value,
    } });
    published.push(agent);
  }
  // Last-seen freshness, not a fabricated offline/dead-process claim, fences lost
  // observations. Directory presence never creates native delivery bindings.
  return published;
}
