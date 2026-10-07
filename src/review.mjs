import { canonical, digest, requireValue, text } from './protocol.mjs';
import { resultPolicy, taskPolicy } from './task-policy.mjs';
import { coordinatorReviewGrant } from './coordinator-review.mjs';
import { taskOrigins } from './task-origin.mjs';

// Recovery removes agent authority, but still requires the original exact creation scope.
function revokedReviewGrant(store, target) {
  const { companyId, taskId, agentId } = target.request;
  const records = store.db.prepare('SELECT id, run_id, data FROM operations').all().flatMap(row => {
    const op = JSON.parse(row.data);
    return op.id === row.id && op.runId === row.run_id && op.state === 'recorded' && op.receipt?.id === taskId &&
      op.receipt.companyId === companyId && ((op.id.startsWith('operator-task:') && op.request?.companyId === companyId) ||
        (op.request?.kind === 'task.create' && op.request.method === 'POST' &&
          op.request.path === `/api/companies/${encodeURIComponent(companyId)}/issues`)) ? [op] : [];
  });
  const child = records[0];
  const grant = child?.request?.relayReviewGrantId && store.operation(child.request.relayReviewGrantId);
  const request = grant?.request;
  if (!grant || grant.id !== child.request.relayReviewGrantId || grant.state !== 'revoked' || grant.runId !== '' || request?.companyId !== companyId ||
    grant.id !== `coordinator-review-grant:${digest([request.origin, request.parentTaskId, request.key])}` ||
    records.some(op => op.request.relayReviewPolicy !== 'coordinator' || op.request.relayReviewGrantId !== grant.id ||
      canonical(op.request.body) !== canonical(child.request.body) ||
      op.request.body?.parentId !== request.parentTaskId || op.receipt.parentId !== request.parentTaskId ||
      op.request.body?.assigneeAgentId !== agentId || op.receipt.assigneeAgentId !== agentId ||
      op.request.body?.assigneeUserId || op.receipt.assigneeUserId) ||
    taskId === request.parentTaskId || agentId === request.reviewerAgentId) return null;
  const parent = taskOrigins(store).find(op => op.request.companyId === companyId && op.receipt.id === request.parentTaskId);
  if (!parent?.id.startsWith('operator-task:') || parent.request.body?.parentId || parent.receipt.parentId ||
    parent.receipt.companyId !== companyId || taskPolicy(store, companyId, request.parentTaskId) !== 'human' ||
    parent.request.body?.assigneeAgentId !== request.reviewerAgentId || parent.receipt.assigneeAgentId !== request.reviewerAgentId ||
    !['sourceMessageId', 'sourceDigest'].every(field => typeof parent.request.origin?.[field] === 'string' && parent.request.origin[field].trim()) ||
    !['bindingId', 'conversationId', 'sessionCreatedAt'].every(field => request.origin?.[field] === parent.request.origin[field]) ||
    !['key', 'reviewerBindingId', 'reviewerAgentId', 'reviewerConversationId'].every(field => typeof request[field] === 'string' && request[field].trim()) ||
    !Number.isSafeInteger(request.reviewerBindingRevision) || request.reviewerBindingRevision <= 0 ||
    !Number.isSafeInteger(request.reviewerSessionCreatedAt) || request.reviewerSessionCreatedAt <= 0 ||
    request.reviewerBindingId === request.origin.bindingId) return null;
  return grant;
}

function resolverMatches(interaction, decision) {
  return typeof decision?.caller?.backendRunId === 'string' && decision.caller.backendRunId.trim() &&
    interaction.resolvedByAgentId === decision.caller.request.agentId &&
    interaction.resolvedByRunId === decision.caller.backendRunId && interaction.resolvedByUserId == null;
}

// A backend status alone cannot prove that an agent used the granted authority.
export function reviewAuthority(store, target) {
  const current = store.run(target.id);
  requireValue(canonical([current.request, current.result, current.conversationId, current.backendRunId]) ===
    canonical([target.request, target.result, target.conversationId, target.backendRunId]), 'stale_candidate', 'Review target changed', 409);
  requireValue(current.nativeState === 'settled' && current.settlement?.outcome === 'completed' && current.publication.state === 'recorded',
    'result_not_ready', 'Result publication and native completion must settle before review', 409);
  const latest = store.runs().find(run => run.request.companyId === target.request.companyId && run.request.taskId === target.request.taskId && run.result);
  requireValue(latest?.id === target.id, 'stale_candidate', 'A newer candidate has been submitted', 409);
  const policy = resultPolicy(store, current, current.result);
  const decision = store.operation(`review-decision:${digest([target.request.companyId, target.request.taskId])}`);
  const disposition = store.operation(`review-disposition:${target.id}`);
  const expected = disposition?.coordinatorReviewGrant;
  const humanDecision = disposition?.interactionId && store.operation(`harness-review:${digest([target.request.companyId, disposition.interactionId])}`);
  const humanRecorded = policy === 'coordinator' && disposition?.runId === target.id && disposition.candidate === target.result.candidate &&
    humanDecision?.id === `harness-review:${digest([target.request.companyId, disposition.interactionId])}` &&
    humanDecision.state === 'recorded' && humanDecision.runId === target.id &&
    humanDecision.request?.companyId === target.request.companyId && humanDecision.request.taskId === target.request.taskId &&
    humanDecision.request.candidate === target.result.candidate && humanDecision.request.interactionId === disposition.interactionId &&
    humanDecision.request.decision === 'accept' && ['sourceMessageId', 'sourceDigest'].every(field =>
      typeof humanDecision.request[field] === 'string' && humanDecision.request[field].trim().length > 0) &&
    humanDecision.receipt?.interactionId === disposition.interactionId && humanDecision.receipt.status === 'accepted';
  const recorded = policy === 'coordinator' && decision?.state === 'recorded' && decision.confirmed === true &&
    decision.resolver && resolverMatches(decision.resolver, decision) &&
    decision.targetRunId === target.id && decision.companyId === target.request.companyId && decision.taskId === target.request.taskId &&
    decision.candidate === target.result.candidate && decision.resultDigest === digest(target.result) && decision.policy === policy &&
    disposition?.runId === target.id && disposition.candidate === target.result.candidate &&
    ['accept', 'reject'].includes(decision.action) && typeof decision.reason === 'string' && decision.reason.trim() && decision.reason.length <= 4000 &&
    decision.interactionId === disposition?.interactionId && canonical(decision.grant) === canonical(expected) && expected &&
    decision.caller?.request?.taskId === expected.request.parentTaskId && decision.caller.request.companyId === target.request.companyId &&
    decision.caller.request.bindingId === expected.request.reviewerBindingId &&
    decision.caller.request.bindingRevision === expected.request.reviewerBindingRevision &&
    decision.caller.request.agentId === expected.request.reviewerAgentId &&
    decision.caller.conversationId === expected.request.reviewerConversationId && decision.runId === decision.caller.id;
  const grant = policy === 'coordinator' ? coordinatorReviewGrant(store, target.request.companyId, target.request.taskId) : null;
  const recoveryGrant = policy === 'coordinator' && !grant && (!disposition?.interactionId || disposition.reviewerMode === 'human_recovery')
    ? revokedReviewGrant(store, target) : null;
  const humanOnlyRecovery = Boolean(recoveryGrant);
  if (disposition?.reviewerMode === 'human_recovery') requireValue(humanOnlyRecovery &&
    canonical(expected) === canonical({ id: recoveryGrant.id, request: recoveryGrant.request }),
  'review_scope_changed', 'Human recovery scope changed', 409);
  requireValue(policy !== 'coordinator' || grant || recorded || humanRecorded || humanOnlyRecovery,
    'coordinator_grant_inactive', 'An exact coordinator grant or recorded decision is required', 403);
  if (grant && expected && !humanRecorded) requireValue(canonical(expected) === canonical({ id: grant.id, request: grant.request }),
    'review_scope_changed', 'Disposition grant changed', 409);
  return { policy, grant, decision, recorded: Boolean(recorded), humanDecision, humanRecorded: Boolean(humanRecorded),
    humanOnlyRecovery, expectedGrant: expected ?? (recoveryGrant && { id: recoveryGrant.id, request: recoveryGrant.request }) };
}

export async function review(store, caller, token, api, input) {
  input = structuredClone(input);
  caller = structuredClone(caller);
  requireValue(['request', 'inspect', 'accept', 'reject'].includes(input.action), 'invalid_review_action', 'Unknown review action');
  const target = structuredClone(store.run(text(input.runId, 'runId')));
  requireValue(target.request.companyId === caller.request.companyId, 'forbidden', 'Result belongs to another company', 403);
  requireValue(target.result?.candidate === input.candidate, 'stale_candidate', 'Exact submitted candidate required', 409);
  const deciding = ['accept', 'reject'].includes(input.action);
  if (deciding) requireValue(caller.request.agentId !== target.request.agentId,
    'self_review_forbidden', 'Result author cannot accept or reject its own candidate', 403);
  const initial = reviewAuthority(store, target);
  if (deciding) requireValue(!initial.humanOnlyRecovery, 'human_review_required', 'Revoked coordinator authority requires human review', 403);
  if (deciding) requireValue(initial.policy === 'coordinator', 'human_review_required', 'Agents cannot decide human or ungranted reviews', 403);
  const grant = initial.grant && { id: initial.grant.id, request: initial.grant.request };
  const expectedGrant = initial.expectedGrant ?? grant ?? initial.decision?.grant;
  const reason = deciding ? text(input.reason, 'reason') : null;
  requireValue(!reason || reason.length <= 4000, 'invalid_request', 'Review reason exceeds 4000 characters');
  const path = `/api/issues/${encodeURIComponent(target.request.taskId)}/interactions`;
  const identity = `relay-review:${target.id}:${digest(target.result)}`;
  const expectedTarget = { type: 'custom', key: 'herdr-relay-candidate', revisionId: target.result.candidate, label: target.id };
  let interaction;
  const check = () => {
    const authority = reviewAuthority(store, target);
    requireValue(authority.policy === initial.policy, 'review_scope_changed', 'Review policy changed', 409);
    if (input.action === 'request' && initial.policy === 'coordinator') {
      requireValue(caller.id === target.id && canonical(caller.request) === canonical(target.request) &&
        caller.conversationId === target.conversationId && (caller.backendRunId ?? caller.request.runId) === (target.backendRunId ?? target.request.runId),
      'review_author_mismatch', 'Only the exact candidate author run may request coordinator review', 403);
      requireValue(initial.humanOnlyRecovery ? authority.humanOnlyRecovery && canonical(authority.expectedGrant) === canonical(expectedGrant) :
        authority.grant && canonical({ id: authority.grant.id, request: authority.grant.request }) === canonical(grant),
      'coordinator_grant_inactive', 'Coordinator grant changed or was revoked', 403);
    }
    if (deciding) {
      requireValue(authority.policy === 'coordinator', 'human_review_required', 'Agents cannot decide human or ungranted reviews', 403);
      requireValue(authority.grant && canonical({ id: authority.grant.id, request: authority.grant.request }) === canonical(grant),
        'coordinator_grant_inactive', 'Coordinator grant changed or was revoked', 403);
      const live = store.run(caller.id);
      const scope = grant.request;
      requireValue(canonical(live.request) === canonical(caller.request) && live.conversationId === caller.conversationId &&
        (live.backendRunId ?? live.request.runId) === (caller.backendRunId ?? caller.request.runId) &&
        live.nativeState === 'claimed' && live.deliveryState === 'acknowledged' && !live.cancellationRequested && !live.result &&
        caller.request.taskId === scope.parentTaskId && caller.request.bindingId === scope.reviewerBindingId &&
        caller.request.bindingRevision === scope.reviewerBindingRevision && caller.request.agentId === scope.reviewerAgentId &&
        caller.conversationId === scope.reviewerConversationId,
      'coordinator_reviewer_mismatch', 'Only the current acknowledged parent reviewer conversation may decide this child', 403);
      requireValue(!store.runs().some(run => run.request.companyId === target.request.companyId &&
        run.request.taskId === target.request.taskId && run.nativeState !== 'settled'),
      'candidate_busy', 'Another task invocation remains unsettled', 409);
      requireValue(!interaction || !store.operation(`harness-review:${digest([target.request.companyId, interaction.id])}`),
      'review_conflict', 'A human review intent owns this interaction', 409);
    }
    return authority;
  };
  check();
  requireValue((initial.policy !== 'human' && !initial.humanOnlyRecovery) || input.reviewerAgentId === undefined,
    'human_review_required', 'Human reviews cannot be addressed to agents', 403);
  requireValue(initial.policy !== 'coordinator' || ((!input.reviewerAgentId || input.reviewerAgentId === expectedGrant?.request?.reviewerAgentId) && !input.reviewerUserId),
    'review_scope_changed', 'Coordinator review audience must match the grant', 409);
  let interactions = await api(caller, token, 'GET', path);
  check();
  requireValue(Array.isArray(interactions), 'invalid_backend_response', 'Expected interaction array', 502);
  interaction = interactions.find(item => item.idempotencyKey === identity);
  const validateInteraction = () => {
    const resolverPolicy = interaction?.effectiveResolverPolicy ?? interaction?.resolverPolicy;
    requireValue(interaction?.kind === 'request_confirmation' && interaction.idempotencyKey === identity &&
      canonical(interaction.payload?.target) === canonical(expectedTarget), 'review_not_found', 'Matching candidate review is required', 409);
    if (initial.policy === 'human') {
      const human = store.operation(`harness-review:${digest([target.request.companyId, interaction.id])}`);
      // Legacy pending `anyone` reviews wait for a recorded human decision. New requests must enforce human_only.
      const legacyProof = input.action === 'inspect' && human?.state === 'recorded' && human.runId === target.id &&
        human.request?.candidate === target.result.candidate && human.request.interactionId === interaction.id &&
        (human.request.companyId === undefined || human.request.companyId === target.request.companyId) &&
        (human.request.taskId === undefined || human.request.taskId === target.request.taskId) &&
        ['accept', 'reject'].includes(human.request.decision) &&
        ['sourceMessageId', 'sourceDigest'].every(field => typeof human.request[field] === 'string' && human.request[field].trim().length > 0) &&
        human.receipt?.interactionId === interaction.id &&
        human.receipt.status === interaction.status && interaction.status === (human.request.decision === 'accept' ? 'accepted' : 'rejected');
      requireValue(!interaction.addresseeAgentId && (resolverPolicy === 'human_only' || legacyProof),
        'human_review_required', 'Backend review must enforce human resolution', 403);
    } else if (initial.policy === 'coordinator') {
      requireValue(interaction.sourceRunId === (target.backendRunId ?? target.request.runId) &&
        interaction.createdByAgentId === target.request.agentId && interaction.createdByUserId == null,
      'review_author_mismatch', 'Backend review must be created by the exact candidate author', 409);
      requireValue(resolverPolicy === (initial.humanOnlyRecovery ? 'human_only' : 'not_creator') && !interaction.addresseeUserId &&
        (!interaction.addresseeAgentId || (!initial.humanOnlyRecovery && interaction.addresseeAgentId === expectedGrant?.request?.reviewerAgentId)),
      'review_scope_changed', 'Backend coordinator audience differs from the grant', 409);
      const authority = check();
      if (!deciding && ['accepted', 'rejected'].includes(interaction.status)) requireValue((!initial.humanOnlyRecovery && authority.recorded &&
        resolverMatches(interaction, authority.decision) &&
        authority.decision.interactionId === interaction.id && interaction.status === (authority.decision.action === 'accept' ? 'accepted' : 'rejected')) ||
        (authority.humanRecorded && authority.humanDecision.receipt.interactionId === interaction.id && interaction.status === 'accepted'),
      'review_decision_uncertain', 'Review decision requires an exact verified local receipt', 409);
    }
  };
  if (initial.policy === 'coordinator' && (deciding || input.action === 'request')) {
    const scope = initial.humanOnlyRecovery ? expectedGrant : grant;
    requireValue(scope, 'coordinator_grant_inactive', 'An exact grant is required before sending a review', 403);
    const child = await api(caller, token, 'GET', path.slice(0, -'/interactions'.length));
    check();
    requireValue(child.id === target.request.taskId && child.companyId === target.request.companyId && child.parentId === scope.request.parentTaskId &&
      child.assigneeAgentId === target.request.agentId && !child.assigneeUserId &&
      ['backlog', 'todo', 'in_progress', 'blocked', 'in_review'].includes(child.status) &&
      (!child.executionRunId || child.executionRunId === (target.backendRunId ?? target.request.runId)),
    'review_scope_changed', 'Child assignment or parent changed', 409);
    const parent = await api(caller, token, 'GET', `/api/issues/${encodeURIComponent(scope.request.parentTaskId)}`);
    check();
    requireValue(parent.id === scope.request.parentTaskId && parent.companyId === target.request.companyId && !parent.parentId &&
      parent.assigneeAgentId === scope.request.reviewerAgentId && !parent.assigneeUserId &&
      ['backlog', 'todo', 'in_progress', 'blocked', 'in_review'].includes(parent.status) &&
      (!deciding || !parent.executionRunId || parent.executionRunId === (caller.backendRunId ?? caller.request.runId)),
    'review_scope_changed', 'Parent must remain nonterminal and assigned to this reviewer', 409);
  }
  if (input.action === 'request' && !interaction) {
    requireValue(['human', 'coordinator'].includes(initial.policy), 'review_policy_locked', 'Task does not request review', 403);
    check();
    if (initial.humanOnlyRecovery) {
      const id = `review-disposition:${target.id}`;
      store.saveOperation({ ...store.operation(id), id, runId: target.id, candidate: target.result.candidate, state: 'waiting',
        policy: initial.policy, reviewerMode: 'human_recovery', coordinatorReviewGrant: expectedGrant });
    }
    interaction = await api(caller, token, 'POST', path, {
      kind: 'request_confirmation', idempotencyKey: identity,
      sourceRunId: caller.backendRunId ?? caller.request.runId, continuationPolicy: 'none',
      resolverPolicy: initial.policy === 'human' || initial.humanOnlyRecovery ? 'human_only' : 'not_creator',
      ...(input.reviewerUserId ? { addresseeUserId: input.reviewerUserId } : {}),
      payload: { version: 1, prompt: `Accept candidate ${target.result.candidate}?`,
        acceptLabel: 'Accept candidate', rejectLabel: 'Request changes', rejectRequiresReason: true,
        detailsMarkdown: target.result.summary, target: expectedTarget },
    });
    check();
  }
  validateInteraction();
  if (initial.policy === 'coordinator' && input.action === 'request') {
    const id = `review-disposition:${target.id}`;
    store.saveOperation({ ...store.operation(id), id, runId: target.id, candidate: target.result.candidate,
      state: 'waiting', policy: initial.policy, interactionId: interaction.id, coordinatorReviewGrant: expectedGrant });
  }
  if (deciding) {
    const status = input.action === 'accept' ? 'accepted' : 'rejected';
    const disposition = store.operation(`review-disposition:${target.id}`);
    requireValue(disposition?.runId === target.id && disposition.candidate === target.result.candidate &&
      disposition.interactionId === interaction.id && canonical(disposition.coordinatorReviewGrant) === canonical(grant),
    'review_scope_changed', 'Coordinator decision requires the exact locally requested disposition', 409);
    const decisionId = `review-decision:${digest([target.request.companyId, target.request.taskId])}`;
    const evidence = { id: decisionId, runId: caller.id, targetRunId: target.id, companyId: target.request.companyId,
      taskId: target.request.taskId, candidate: target.result.candidate, resultDigest: digest(target.result),
      interactionId: interaction.id, action: input.action, policy: initial.policy, grant, reason,
      caller: { id: caller.id, request: caller.request, conversationId: caller.conversationId,
        backendRunId: caller.backendRunId ?? caller.request.runId } };
    const decision = store.transaction(() => {
      check();
      const harness = store.operation(`harness-review:${digest([target.request.companyId, interaction.id])}`);
      requireValue(!harness, 'review_conflict', 'A human review intent already owns this interaction', 409);
      const pendingHuman = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'harness-review:%'").all()
        .map(row => JSON.parse(row.data)).some(operation => {
          if (operation.state === 'recorded') return false;
          const scope = operation.request?.companyId && operation.request?.taskId ? operation.request : store.run(operation.runId).request;
          return scope.companyId === target.request.companyId && scope.taskId === target.request.taskId;
        });
      requireValue(!pendingHuman, 'review_decision_uncertain', 'Task has an unresolved human review intent', 409);
      const previous = store.operation(decisionId);
      if (previous && (previous.targetRunId === target.id || previous.state !== 'recorded')) {
        requireValue(Object.entries(evidence).every(([key, value]) => canonical(previous[key]) === canonical(value)),
          'review_conflict', 'Review intent changed', 409);
        requireValue(interaction.status === status, 'review_decision_uncertain', 'Prior decision is unconfirmed; no replay authorised', 409);
        return previous;
      }
      requireValue(interaction.status === 'pending', 'review_conflict', 'No local intent authorises this backend decision', 409);
      return store.saveOperation({ ...evidence, state: 'uncertain' });
    });
    if (interaction.status === 'pending') {
      await api(caller, token, 'POST', `${path}/${encodeURIComponent(interaction.id)}/${input.action}`, { reason });
      check();
      interactions = await api(caller, token, 'GET', path);
      check();
      requireValue(Array.isArray(interactions), 'invalid_backend_response', 'Expected interaction array', 502);
      interaction = interactions.find(item => item.id === decision.interactionId);
      validateInteraction();
    }
    requireValue(interaction.status === status, 'review_decision_uncertain', 'Backend did not confirm the requested disposition', 409);
    requireValue(resolverMatches(interaction, decision), 'review_resolver_mismatch',
      'Backend decision must belong to the exact coordinator agent and run, not a user or another actor', 409);
    check();
    store.saveOperation({ ...decision, state: 'recorded', confirmed: true, resolver: {
      resolvedByAgentId: interaction.resolvedByAgentId, resolvedByRunId: interaction.resolvedByRunId, resolvedByUserId: null,
    } });
  }
  check();
  const authority = reviewAuthority(store, target);
  return store.recordReview(target.id, { interactionId: interaction.id, candidate: target.result.candidate,
    status: interaction.status, observedAt: new Date().toISOString(), ...(deciding ? {
      caller: authority.decision.caller, reason, grantId: grant.id, policy: initial.policy,
    } : {}) });
}
