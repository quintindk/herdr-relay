import { canonicalDirectory, withinRoots } from './interactive-contract.mjs';
import { digest, requireValue } from './protocol.mjs';

// A human credential is separate from both the backend-root credential and the
// node daemon credential. It may manage this node's enrolments and the same
// human's task/inbox decisions and local headless grants, but cannot bootstrap nodes.
export const nodeOperatorActions = Object.freeze(['agent.enrol', 'agent.attach', 'task.create', 'task.update', 'comment.create', 'reference.attach',
  'execution.request', 'execution.cancel', 'execution.review', 'execution.monitor_review', 'question.answer', 'question.forward', 'question.close',
  'occurrence.review', 'notification.acknowledge', 'review.grant', 'review.revoke', 'headless.grant', 'headless.revoke']);

export function authoriseOperator(store, actor, action, payload) {
  if (!actor.scope) return;
  const scope = actor.scope;
  if (scope.kind === 'grant_approval') {
    requireValue(actor.type === 'user' && actor.id === store.owner && ['grant.request_decide', 'grant.create', 'grant.revoke'].includes(action),
      'forbidden', 'Human Grants sessions cannot perform unrelated administration', 403);
    return;
  }
  requireValue(actor.type === 'user' && actor.id === store.owner && scope.kind === 'node_operator' && nodeOperatorActions.includes(action),
    'forbidden', 'This node operator credential cannot perform backend administration', 403);
  if (action === 'headless.grant' || action === 'headless.revoke') {
    const grant = action === 'headless.grant' ? payload : store.get('headless_grant', payload.id);
    requireValue(grant.nodeId === scope.nodeId && canonicalDirectory(grant.directory) &&
      (scope.mode === 'localUser' || withinRoots(grant.directory, scope.roots)),
    'operator_scope_mismatch', 'Grant must stay within this node operator workspace scope', 403);
  }
  if (action === 'agent.enrol' || action === 'agent.attach') {
    const nodeId = action === 'agent.enrol' ? payload.nodeId : store.get('agent', payload.id).nodeId;
    requireValue(nodeId === scope.nodeId && canonicalDirectory(payload.directory) &&
      (scope.mode === 'localUser' || withinRoots(payload.directory, scope.roots)), 'operator_scope_mismatch', 'Enrolment is outside this operator\'s node/workspace scope', 403);
    if (action === 'agent.enrol' && !store.get('agent', payload.id, false)) requireValue(store.all('agent').filter(a => a.nodeId === nodeId && a.standingGrant).length < scope.maxAgents,
      'agent_limit', 'Node enrolment limit reached');
  }
}

export function bootstrapNode(store, actor, input) {
  store.rootOwnerOnly(actor);
  requireValue(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(k =>
    ['key', 'id', 'name', 'mode', 'roots', 'maxAgents'].includes(k)) && typeof input.key === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(input.key) &&
    typeof input.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.id) && typeof input.name === 'string' && input.name.trim() && input.name.length <= 256,
    'invalid_bootstrap', 'Stable bootstrap key, node ID and display name required');
  requireValue(['roots', 'localUser'].includes(input.mode) && (input.mode === 'localUser' ? input.roots === undefined || Array.isArray(input.roots) && !input.roots.length :
    Array.isArray(input.roots) && input.roots.length > 0 && input.roots.length <= 32 && input.roots.every(canonicalDirectory)),
    'invalid_bootstrap', 'Explicit node-operator filesystem scope required');
  requireValue(Number.isSafeInteger(input.maxAgents ?? 100) && (input.maxAgents ?? 100) > 0 && (input.maxAgents ?? 100) <= 100,
    'invalid_bootstrap', 'A node enrolment limit of 1..100 is required');
  return store.transaction(() => {
    const identity = `bootstrap-owner:${actor.id}`, key = `bootstrap:${input.key}`, hash = digest(input);
    const previous = store.db.prepare('SELECT hash,data FROM receipts WHERE actor=? AND key=?').get(identity, key);
    if (previous) {
      requireValue(previous.hash === hash, 'operation_conflict', 'Bootstrap key belongs to a different request', 409);
      const result = JSON.parse(previous.data);
      for (const credential of [result.nodeCredential, result.operatorCredential]) {
        const current = store.db.prepare('SELECT data FROM credentials WHERE id=?').get(credential.id);
        requireValue(current && !JSON.parse(current.data).revoked, 'credential_superseded', 'Bootstrap credentials were revoked. Issue a new bootstrap explicitly', 409);
      }
      return result;
    }
    requireValue(!store.get('node', input.id, false), 'identity_conflict', 'Bootstrap requires a fresh node identity', 409);
    store.command(actor, { key: `bootstrap-node:${input.key}`, action: 'node.enrol', payload: { id: input.id, name: input.name } });
    const node = store.issueCredential({ type: 'node', id: input.id });
    const scope = { kind: 'node_operator', nodeId: input.id, mode: input.mode, roots: input.roots ?? [], maxAgents: input.maxAgents ?? 100 };
    const operator = store.issueCredential({ type: 'user', id: store.owner, scope });
    const result = { protocol: 'relay/0.2', instanceId: store.instance, nodeId: input.id, name: input.name, userId: store.owner,
      nodeToken: node.token, operatorToken: operator.token, nodeCredential: node.credential, operatorCredential: operator.credential };
    store.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(identity, key, hash, JSON.stringify(result));
    return result;
  });
}
