import { join } from 'node:path';
import { observedAgents } from './herdr-agents.mjs';
import { armBridge, configureBridge, disarmBridge, refreshBridge } from './opencode-bridge.mjs';
import { canonical, digest, requireValue } from './protocol.mjs';

// Call serially after observer reconciliation, sharing the explicit observed-delivery lock.
// Directory validation/canonicalisation belongs to the service, not this reconciler.
export async function reconcileBridgeEnrolment(store, directory, api, { directories = [], companyId, machineId, session, current = () => true }) {
  const results = [];
  const inScope = item => item?.identity?.companyId === companyId && item.identity.machineId === machineId && item.identity.session === session;
  for (const target of new Set(directories)) {
    try {
      const checkDirectory = () => {
        requireValue(!store.db.prepare("SELECT data FROM operations WHERE id LIKE 'herdr-worker:%'").all()
          .map(row => JSON.parse(row.data)).some(item => item.request?.directory === target || item.target?.directory === target),
        'worker_directory_reserved', 'Worker directories require exact worker enrolment, including blocked workers', 409);
        requireValue(current() && directories.includes(target), 'bridge_identity_mismatch', 'Bridge enrolment is no longer current', 409);
        return true;
      };
      checkDirectory();
      const candidates = () => observedAgents(store).filter(item => inScope(item) && item.identity.harness === 'opencode' &&
        item.identity.sessionKind === 'id' && item.placement?.directory === target && item.availability !== 'offline');
      const bridges = () => store.db.prepare("SELECT data FROM operations WHERE id LIKE 'opencode-bridge:%'").all()
        .map(row => JSON.parse(row.data)).filter(item => item.identity.directory === target && inScope(store.operation(item.identity.observedId)));
      const matches = candidates();
      if (matches.length > 1) {
        // Stop idle bridges from accepting new work while directory ownership is ambiguous.
        // Active work is left intact for settlement, never transferred to a candidate.
        for (const bridge of bridges()) {
          if ((bridge.state !== 'configured' || !bridge.backendPaused) &&
            store.runs(bridge.identity.bindingId).every(run => run.nativeState === 'settled')) {
            await disarmBridge(store, api, { bindingId: bridge.identity.bindingId }, checkDirectory);
          }
        }
      }
      requireValue(matches.length <= 1, 'bridge_candidates_ambiguous', 'Multiple live OpenCode chats occupy the allowed directory', 409);
      const observed = matches[0];
      if (!observed) { results.push({ directory: target, state: 'unavailable' }); continue; }
      const bindingId = `observed-${digest(observed.id).slice(0, 24)}`;
      const id = `opencode-bridge:${bindingId}`;
      const check = () => {
        checkDirectory();
        const live = candidates();
        requireValue(live.length === 1, 'bridge_candidates_ambiguous', 'No unique live OpenCode chat in the allowed directory', 409);
        const latest = live[0];
        requireValue(latest.id === observed.id && canonical(latest.identity) === canonical(observed.identity) &&
          latest.agentId === observed.agentId && latest.marker === observed.marker && latest.placement.terminalId === observed.placement.terminalId &&
          latest.availability === 'present' && !latest.error && latest.agentId && Date.now() - Date.parse(latest.updatedAt) < 15000,
        'agent_not_ready', 'Recent unique OpenCode registration required', 409);
        // Include every historical bridge, not just the most recently armed one.
        requireValue(bridges().filter(item => item.id !== id).every(item =>
          store.runs(item.identity.bindingId).every(run => run.nativeState === 'settled')),
        'work_unsettled', 'Prior bridge work in this directory must settle before enrolment', 409);
        return true;
      };
      check();
      for (const old of bridges().filter(item => item.id !== id)) {
        if (old.state !== 'configured' || !old.backendPaused) await disarmBridge(store, api, { bindingId: old.identity.bindingId }, check);
      }
      check();
      let bridge = store.operation(id);
      let configured;
      if (!bridge) configured = await configureBridge(store, directory, api, { observedId: observed.id, reserved: true }, check);
      else if (bridge.identity.terminalId !== observed.placement.terminalId) {
        configured = await refreshBridge(store, directory, api, { observedId: observed.id, reserved: true }, check);
      }
      check();
      bridge = store.operation(id);
      requireValue(bridge.identity.conversationId === observed.identity.conversationId && bridge.identity.directory === target &&
        bridge.identity.terminalId === observed.placement.terminalId, 'bridge_identity_mismatch', 'Bridge does not match current observation', 409);
      if (bridge.ready && bridge.epoch && Date.now() - Date.parse(bridge.lastSeen) < 10000 &&
        store.runs(bindingId).every(run => run.nativeState === 'settled')) {
        await armBridge(store, directory, api, { bindingId }, check);
      }
      const final = store.operation(id);
      const live = Boolean(final.epoch && Date.now() - Date.parse(final.lastSeen) < 10000);
      results.push({ directory: target, bindingId, bridgeConfigFile: join(directory, 'bridges', `${bindingId}.json`),
        state: final.state, ready: live && final.ready === true,
        blocker: !live ? 'plugin_unavailable' : !final.ready ? 'native_busy' : null,
        restartRequired: configured?.restartRequired ?? false });
    } catch (error) {
      results.push({ directory: target, state: 'blocked', error: error.code ?? 'bridge_enrolment_failed' });
    }
  }
  return results;
}
