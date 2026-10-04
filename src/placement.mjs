import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireValue, text } from './protocol.mjs';

export async function herdrPane(paneId) {
  requireValue(process.env.HERDR_ENV === '1', 'herdr_context_required', 'Placement operations require a herdr-managed service context');
  const { stdout } = await promisify(execFile)('herdr', ['pane', 'get', paneId], { maxBuffer: 1024 * 1024 });
  const response = JSON.parse(stdout);
  requireValue(response.result?.pane, 'invalid_placement', 'Herdr did not return the requested pane');
  return response.result.pane;
}

export async function bindPlacement(store, input, inspect = herdrPane) {
  const binding = store.binding(text(input.bindingId, 'bindingId'));
  const paneId = text(input.paneId, 'paneId');
  const pane = await inspect(paneId);
  requireValue(pane.pane_id === paneId && pane.agent === binding.config.harness &&
    pane.agent_session?.value === binding.config.conversationId,
  'placement_identity_mismatch', 'Herdr pane does not report the bound native conversation', 409);
  const placement = { paneId, terminalId: pane.terminal_id, workspaceId: pane.workspace_id,
    tabId: pane.tab_id, nativeSessionId: pane.agent_session.value, state: 'verified' };
  requireValue(typeof placement.terminalId === 'string', 'placement_identity_mismatch', 'Herdr terminal identity required');
  return store.saveOperation({ id: `placement:${binding.id}`, runId: '', bindingId: binding.id, ...placement });
}

export async function reconcilePlacement(store, bindingId, inspect = herdrPane) {
  const placement = store.operation(`placement:${bindingId}`);
  requireValue(placement, 'placement_not_found', 'No placement is registered for this binding', 404);
  try {
    const pane = await inspect(placement.paneId);
    const binding = store.binding(bindingId);
    requireValue(pane.terminal_id === placement.terminalId && pane.agent === binding.config.harness &&
      pane.agent_session?.value === binding.config.conversationId,
    'placement_identity_mismatch', 'Pane occupant changed. Do not restore or stop it under the old binding.', 409);
    return store.saveOperation({ ...placement, state: 'verified', reason: null });
  } catch (error) {
    return store.saveOperation({ ...placement, state: 'unresolved', reason: error.code ?? 'herdr_unavailable' });
  }
}
