import { posix } from 'node:path';
import { digest, requireValue } from './protocol.mjs';
import { headlessAuthority } from './headless-setup-contract.mjs';

export const contractManifest = files => files.map(file => ({ path: file.path, digest: digest(file.after) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
export const contractDigest = files => digest(contractManifest(files));
export function validateContractFiles(files, contract) {
  const root = posix.dirname(contract);
  requireValue(Array.isArray(files) && files.length > 0 && files.length <= 16 && files.every(f => f && typeof f === 'object') && new Set(files.map(f => f.path)).size === files.length &&
    files.some(f => f.path === contract) && files.every(f => f && Object.keys(f).every(k => ['path', 'before', 'after'].includes(k)) &&
      typeof f.path === 'string' && f.path.startsWith(`${root}/`) && posix.normalize(f.path) === f.path && !f.path.includes('\\') &&
      !/[\x00-\x1f]/.test(f.path) && f.path.endsWith('.md') && (f.before === null || typeof f.before === 'string') && typeof f.after === 'string') &&
    Buffer.byteLength(JSON.stringify(files)) <= 80000,
  'invalid_contract_update', 'Bounded Markdown contract bundle inside the original skill directory required');
  return files;
}

export function requestContractUpdate(store, actor, p, { created }) {
  requireValue(p && Object.keys(p).every(k => ['id', 'setupId', 'expectedRevision', 'grantRevision', 'fromDigest', 'files', 'previewHash', 'requesterAgentId', 'sourceConversationId', 'sourceBindingRevision'].includes(k)), 'invalid_contract_update', 'No scope changes are accepted through instruction updates');
  const { setup, grant } = headlessAuthority(store, actor, p.setupId);
  store.revision(setup, p.expectedRevision); store.revision(grant, p.grantRevision);
  const requester = store.agent(actor, p.requesterAgentId);
  requireValue(requester.id === setup.requesterAgentId && requester.mode === 'interactive' && requester.standingGrant &&
    requester.conversationId === p.sourceConversationId && requester.bindingRevision === p.sourceBindingRevision && requester.nodeId === setup.nodeId,
  'headless_requester_scope', 'Exact current original coordinator required', 403);
  requireValue(setup.state === 'ready' && (!setup.contract || setup.appliedContractRevision === setup.contract.revision), 'contract_activation_pending', 'Finish the previous instruction activation first');
  validateContractFiles(p.files, grant.contract);
  const root = p.files.find(f => f.path === grant.contract);
  requireValue(typeof root.before === 'string' && /^[a-f0-9]{64}$/.test(p.fromDigest) &&
    (setup.contract ? p.fromDigest === setup.contract.digest && setup.contract.files.every(f => p.files.some(n => n.path === f.path && digest(n.before) === f.digest)) : p.fromDigest === digest(root.before)),
  'stale_contract_preview', 'Preview must start from the exact active contract, including all pinned resources');
  const operation = { setupId: setup.id, expectedRevision: setup.revision, grantRevision: grant.revision,
    fromDigest: p.fromDigest, files: p.files, scopeDigest: digest(grant) };
  requireValue(p.previewHash === digest(operation), 'stale_contract_preview', 'Exact preview digest required');
  return created('grant_request', { id: p.id, permissionRequest: true, kind: 'headless_contract', requesterAgentId: requester.id,
    nodeId: setup.nodeId, requesterNodeId: setup.nodeId, directory: setup.directory, name: setup.name, operation,
    requestHash: p.previewHash, state: 'awaiting_approval', responsibleUserId: store.owner });
}

export function approveContractUpdate(store, actor, request, changed, decision) {
  const p = request.operation, { setup, grant } = headlessAuthority(store, actor, p.setupId);
  store.revision(setup, p.expectedRevision); store.revision(grant, p.grantRevision);
  requireValue(digest(grant) === p.scopeDigest, 'stale_contract_preview', 'Grant scope changed since instruction preview');
  const contract = { revision: (setup.contract?.revision ?? 0) + 1, digest: contractDigest(p.files), files: contractManifest(p.files), requestId: request.id };
  const next = changed('headless_setup', setup, { contract, appliedContractRevision: setup.appliedContractRevision ?? 0,
    contractActivation: { state: 'approved', requestId: request.id, previousDigest: p.fromDigest } });
  store.event('headless.contract_approved', next, actor, request.id);
  return changed('grant_request', request, { state: 'approved', decision, contractRevision: contract.revision });
}

export function acknowledgeContractUpdate(store, actor, p, changed) {
  requireValue(Object.keys(p).every(k => ['id', 'expectedRevision', 'requestId', 'digest'].includes(k)), 'invalid_contract_update', 'Exact activation acknowledgement required');
  const { setup } = headlessAuthority(store, actor, p.id); store.nodeOnly(actor, setup.nodeId); store.revision(setup, p.expectedRevision);
  requireValue(setup.contract?.requestId === p.requestId && setup.contract.digest === p.digest,
    'stale_contract_preview', 'Exact approved bundle required');
  if (setup.appliedContractRevision === setup.contract.revision) return setup;
  requireValue(!store.all('execution').some(e => e.targetAgentId === setup.agentId && !['completed', 'cancelled', 'failed', 'rejected'].includes(e.state)),
    'contract_activation_busy', 'Fully settled worker required');
  return changed('headless_setup', setup, { appliedContractRevision: setup.contract.revision,
    contractActivation: { ...setup.contractActivation, state: 'applied' } });
}
