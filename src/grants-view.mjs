import { grantKinds } from './grants.mjs';

export const grantDate = value => value && Number.isFinite(Date.parse(value)) ? `${new Date(value).toLocaleString('en-GB', {
  timeZone: 'Africa/Johannesburg', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
})} SAST` : 'No expiry';

export function buildGrantsView({ requests = [], decisions = [], grants = {}, agents = [], nodes = [], preparations = [], userId }) {
  const agent = id => agents.find(a => a.id === id), node = id => nodes.find(n => n.id === id);
  const actorName = who => who?.agentId ? agent(who.agentId)?.name ?? who.agentId : who?.userId === userId ? 'You'
    : who?.type === 'node_operator' ? `Operator on ${node(who.nodeId)?.name ?? who.nodeId}` : who?.userId ?? 'Not recorded';
  const base = (kind, raw) => {
    const requester = agent(raw.requesterAgentId ?? raw.reviewerAgentId);
    const nodeId = raw.nodeId ?? requester?.nodeId ?? raw.principal?.id;
    const machine = node(nodeId);
    const scope = raw.scope ?? raw;
    const folders = scope.roots?.length ? scope.roots : raw.directory ? [raw.directory] : [];
    const actions = kind === 'interactive' ? [
      ...(scope.allowNewEnrolments ? ['Create enrolment and open/attach OpenCode'] : ['Open/attach existing agent']),
      ...(scope.allowCreateDirectories ? ['Create the requested folder'] : []), ...(scope.allowDispatch ? ['Assign work'] : []),
      ...(scope.allowReplacement ? ['Replace an existing receiving chat'] : []),
    ] : kind === 'headless' ? [scope.permissions?.mcp ? 'MCP allowed, including writes and later tools' : 'MCP denied',
      scope.permissions?.shell ? 'Shell allowed: full OS-user access' : 'Shell denied', ...(scope.capabilities?.taskActions ?? []),
      ...(scope.contract ? [`Job contract: ${scope.contract}`] : []),
      ...(scope.capabilities?.sourceNamespaces ? [`Source namespaces: ${scope.capabilities.sourceNamespaces.join(', ')}`] : []),
      ...Object.entries(scope.capabilities?.artifacts ?? {}).map(([kind, path]) => `Artifact ${kind}: ${path}`)] :
      kind === 'headless_contract' ? ['Update this exact instruction revision only. No expansion of existing business scope or capabilities is granted. Review content against the existing job purpose.',
        `Base digest: ${raw.operation.fromDigest}`, `Preview digest: ${raw.requestHash}`,
        ...raw.operation.files.flatMap(f => [`File: ${f.path}`, '--- Approved content', f.before ?? '(new file)', '+++ Proposed content', f.after])] :
      kind === 'reference' ? [`Allocate ${raw.prefix} task references`] : ['Review opted-in direct child results'];
    return { kind, entityId: raw.id, revision: raw.revision, requesterAgentId: requester?.id ?? raw.requesterAgentId,
      requesterName: requester?.name ?? (kind === 'reference' ? 'Node namespace' : 'Not recorded'), nodeId,
      nodeName: machine?.name ?? nodeId ?? 'Not recorded', machineName: machine?.machine?.hostname ?? 'Not advertised',
      folders, actions, profiles: scope.profiles ?? [], expiresAt: raw.expiresAt ?? scope.expiresAt,
      limits: kind === 'interactive' ? `Node-wide enrolment limit: ${scope.maxAgents}. Current: ${agents.filter(a => a.nodeId === nodeId && a.standingGrant).length}.`
        : kind === 'reference' ? `Maximum reference number: ${raw.maxNumber}` : kind === 'review' ? 'Only this parent execution and its opted-in children' : 'Only the recorded job contract and capabilities',
      scope, raw };
  };
  const pending = requests.filter(r => r.state === 'awaiting_approval').map(r => ({ ...base(r.kind ?? 'interactive', r),
    id: `request:${r.id}`, section: 'pending', title: `${r.kind === 'headless_contract' ? 'Instruction revision' : 'Permission requested'} · ${r.name}`, summary: `${agent(r.requesterAgentId)?.name ?? r.requesterAgentId} → ${node(r.nodeId)?.name ?? r.nodeId}`,
    stateLabel: 'Awaiting approval', requestHash: r.requestHash, topic: r.operation.topic, scope: r.scope }));
  const active = [], history = [];
  for (const [kind, records] of Object.entries(grants)) for (const raw of records) {
    const preparation = raw.boundRequestId && preparations.find(r => r.id === raw.boundRequestId);
    const consumed = preparation?.state === 'ready' && (!raw.allowDispatch || preparation.dispatchedExecutionId);
    const expired = raw.expiresAt && Date.parse(raw.expiresAt) <= Date.now();
    const state = raw.state === 'active' ? consumed ? 'consumed' : expired ? 'expired' : 'active' : raw.state;
    const value = { ...base(kind, raw), id: `${kind}:${raw.id}`, section: state === 'active' ? 'active' : 'history', stateLabel: state,
      title: `${kind === 'interactive' ? 'Interactive agents' : kind === 'headless' ? 'Headless job' : kind === 'reference' ? 'Task references' : 'Child review'} · ${raw.name ?? agent(raw.requesterAgentId ?? raw.reviewerAgentId)?.name ?? raw.prefix ?? raw.id}`,
      summary: `${node(raw.nodeId ?? agent(raw.reviewerAgentId)?.nodeId ?? raw.principal?.id)?.name ?? 'Unknown node'} · ${raw.boundRequestId ? 'One saved operation' : 'Standing permission'}`,
      decidedBy: actorName(raw.issuedBy ?? { userId: raw.userId }), at: raw.createdAt, operation: preparation };
    if (state === 'active') active.push(value);
    else if (!decisions.some(d => d.grantKind === kind && d.grantId === raw.id && d.outcome === state)) history.push({ ...value, id: `state:${value.id}`, decidedBy: state === 'revoked' ? actorName(raw.revokedBy) : value.decidedBy,
      at: state === 'expired' ? raw.expiresAt : preparation?.dispatchedExecutionId ? preparation.updatedAt : preparation?.receipt?.readyAt ?? raw.updatedAt });
    if (!decisions.some(d => d.grantKind === kind && d.grantId === raw.id && ['created', 'approved_once', 'allowed_scope'].includes(d.outcome))) {
      history.push({ ...value, section: 'history', id: `created:${value.id}`, stateLabel: 'created', at: raw.createdAt });
    }
  }
  for (const r of requests.filter(r => r.state === 'cancelled')) history.push({ ...base('interactive', r),
    id: `cancelled:${r.id}`, section: 'history', stateLabel: 'cancelled', title: `Cancelled · ${r.name}`, summary: r.reason,
    reason: r.reason, at: r.updatedAt, decidedBy: agent(r.requesterAgentId)?.name ?? 'Requester' });
  for (const d of decisions) {
    const request = requests.find(r => r.id === d.requestId), raw = grants[d.grantKind]?.find(g => g.id === d.grantId) ?? request ?? d;
    history.push({ ...base(d.grantKind, raw), id: `decision:${d.id}`, section: 'history', stateLabel: d.outcome,
      title: `${d.outcome.replaceAll('_', ' ')} · ${agent(raw.requesterAgentId ?? raw.reviewerAgentId)?.name ?? raw.name ?? d.grantId ?? d.requestId}`,
      summary: d.reason || 'Recorded security decision', reason: d.reason, decidedBy: actorName(d.decidedBy), at: d.decidedAt });
  }
  return { pending, active, history: history.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))),
    kinds: Object.keys(grantKinds) };
}
