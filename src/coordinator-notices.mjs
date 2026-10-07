import { canonical, digest, requireValue, RelayError } from './protocol.mjs';
import { coordinatorReviewGrant } from './coordinator-review.mjs';
import { resultPolicy } from './task-policy.mjs';

// Candidate-ready only. Rejection follow-up needs a separate continuation protocol.
export async function reconcileCoordinatorNotices(store, operatorApi, locks = new Map()) {
  const notices = new Map(store.db.prepare("SELECT data FROM operations WHERE id LIKE 'coordinator-review-notice:%'").all()
    .map(row => JSON.parse(row.data)).filter(item => ['uncertain', 'recorded'].includes(item.state)).map(item => [item.id, item]));
  const dispositions = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'review-disposition:%'").all();
  for (const row of dispositions) {
    const disposition = JSON.parse(row.data);
    const grant = disposition.coordinatorReviewGrant;
    if (disposition.policy !== 'coordinator' || !grant?.id || !grant.request ||
      disposition.id !== `review-disposition:${disposition.runId}` || disposition.state !== 'waiting') continue;
    let run;
    try { run = store.run(disposition.runId); }
    catch (error) { if (error.code === 'run_not_found') continue; throw error; }
    if (!run.result?.candidate || run.review?.status !== 'pending' || !disposition.interactionId) continue;
    const { companyId, taskId: childTaskId } = run.request;
    const { parentTaskId } = grant.request;
    const candidate = run.result.candidate;
    const interactionId = disposition.interactionId;
    const key = digest([grant.id, parentTaskId, childTaskId, run.id, candidate, interactionId]);
    const id = `coordinator-review-notice:${key}`;
    const previous = store.operation(id);
    if (previous?.state === 'recorded' || notices.has(id)) continue;
    const clientRequestId = `relay-coordinator-review:${key}`;
    const body = 'Relay coordinator review notice (machine-generated informational data, not a human instruction or authorisation).\n' +
      JSON.stringify({ kind: 'candidate_ready', companyId, parentTaskId, childTaskId, runId: run.id,
        candidate, interactionId, grantId: grant.id }) + '\n' +
      'The child candidate is awaiting review. This notice does not complete any dependency or approve any result.';
    notices.set(id, { id, runId: run.id, state: 'pending', request: { companyId, parentTaskId, childTaskId,
      candidate, interactionId, grant, resultDigest: digest(run.result),
      runIdentity: digest([run.request, run.conversationId, run.backendRunId]), clientRequestId, body } });
  }
  for (const notice of notices.values()) {
    const lock = `review:${notice.runId}`;
    if (locks.has(lock)) continue;
    const pending = Promise.resolve().then(async () => {
      let operation = store.operation(notice.id);
      if (operation?.state === 'recorded') {
        // Local runs (even later native invocations) do not prove this comment's wake
        // was admitted. Preserve the comment receipt without inferring continuation.
        if (operation.continuationState === undefined) store.saveOperation({ ...operation,
          continuationState: 'awaiting_admission', reason: 'continuation_unconfirmed' });
        return;
      }
      const request = notice.request;
      const path = `/api/issues/${encodeURIComponent(request.parentTaskId)}/comments`;
      const codes = new Set(['coordinator_notice_conflict', 'coordinator_grant_inactive', 'stale_candidate',
        'candidate_busy', 'coordinator_busy', 'coordinator_unavailable', 'worker_grant_inactive',
        'coordinator_not_waiting', 'review_scope_changed',
        'review_not_pending', 'coordinator_notice_uncertain', 'invalid_backend_response']);
      try {
        requireValue(!operation || (operation.runId === notice.runId && canonical(operation.request) === canonical(request)),
          'coordinator_notice_conflict', 'Notice identity changed', 409);
        const receipt = async () => {
          const comments = await operatorApi('GET', path);
          requireValue(Array.isArray(comments), 'invalid_backend_response', 'Expected comments array', 502);
          const matches = comments.filter(comment => comment?.clientRequestId === request.clientRequestId);
          const comment = matches[0];
          // Board user identity is deployment-specific. The exact request key and body
          // prove this receipt, not an invented local-board author or worker run ID.
          requireValue(matches.length === 1 && typeof comment.id === 'string' && comment.id.trim() &&
            comment.body === request.body && (comment.companyId === undefined || comment.companyId === request.companyId) &&
            (comment.issueId === undefined || comment.issueId === request.parentTaskId) &&
            (!operation.commentId || operation.commentId === comment.id),
          'coordinator_notice_uncertain', 'Exact comment receipt not confirmed', 409);
          store.saveOperation({ ...operation, state: 'recorded', commentId: comment.id,
            continuationState: 'awaiting_admission', reason: 'continuation_unconfirmed' });
        };
        // Receipt recovery is read-only, including after revocation or a later decision.
        if (operation?.state === 'uncertain') { await receipt(); return; }
        const check = () => {
          const grant = coordinatorReviewGrant(store, request.companyId, request.childTaskId);
          requireValue(grant && canonical({ id: grant.id, request: grant.request }) === canonical(request.grant),
            'coordinator_grant_inactive', 'The exact active coordinator grant is required', 409);
          const run = store.run(notice.runId);
          const runs = store.runs();
          const children = runs.filter(item => item.request.companyId === request.companyId && item.request.taskId === request.childTaskId);
          requireValue(children[0]?.id === run.id && run.request.companyId === request.companyId &&
            run.request.taskId === request.childTaskId && run.result?.candidate === request.candidate &&
            digest([run.request, run.conversationId, run.backendRunId]) === request.runIdentity &&
            digest(run.result) === request.resultDigest && run.nativeState === 'settled' &&
            run.settlement?.outcome === 'completed' && run.publication?.state === 'recorded' && !run.cancellationRequested &&
            resultPolicy(store, run, run.result) === 'coordinator',
          'stale_candidate', 'The latest settled published coordinator candidate is required', 409);
          requireValue(children.every(item => item.nativeState === 'settled'), 'candidate_busy', 'Child work remains unsettled', 409);
          const disposition = store.operation(`review-disposition:${run.id}`);
          requireValue(run.review?.status === 'pending' && run.review.candidate === request.candidate &&
            run.review.interactionId === request.interactionId && disposition?.runId === run.id &&
            disposition.state === 'waiting' && disposition.policy === 'coordinator' && disposition.candidate === request.candidate &&
            disposition.interactionId === request.interactionId && canonical(disposition.coordinatorReviewGrant) === canonical(request.grant) &&
            !store.operation(`harness-review:${digest([request.companyId, request.interactionId])}`),
          'review_not_pending', 'Exact pending review disposition is required', 409);
          const decision = store.operation(`review-decision:${digest([request.companyId, request.childTaskId])}`);
          requireValue((!decision || (decision.state === 'recorded' && decision.targetRunId !== run.id)) &&
            !['completion:', 'no-review-completion:'].some(prefix => store.operation(`${prefix}${run.id}`)),
          'review_not_pending', 'A review decision or completion already owns the candidate', 409);
          const scope = grant.request;
          const parents = runs.filter(item => item.request.companyId === request.companyId && item.request.taskId === request.parentTaskId);
          requireValue(store.runs(scope.reviewerBindingId).every(item => item.nativeState === 'settled') &&
            parents.every(item => item.nativeState === 'settled'), 'coordinator_busy', 'Coordinator work remains unsettled', 409);
          const binding = store.binding(scope.reviewerBindingId, false);
          const bridge = store.operation(`opencode-bridge:${scope.reviewerBindingId}`);
          const identity = bridge?.identity;
          const fresh = (value, limit) => {
            const age = Date.now() - Date.parse(value);
            return age >= 0 && age < limit;
          };
          requireValue(binding && !binding.lifecycleState && binding.revision === scope.reviewerBindingRevision &&
            binding.config.companyId === request.companyId && binding.config.agentId === scope.reviewerAgentId &&
            binding.config.harness === 'opencode' && binding.config.delivery === 'pull' &&
            binding.config.conversationId === scope.reviewerConversationId &&
            bridge?.state === 'armed' && bridge.ready === true && fresh(bridge.lastSeen, 10000) &&
            typeof bridge.epoch === 'string' && bridge.epoch.trim() &&
            bridge.sessionCreatedAt === scope.reviewerSessionCreatedAt &&
            identity?.bindingId === binding.id && identity.conversationId === binding.config.conversationId &&
            typeof identity.observedId === 'string' && identity.observedId.startsWith('herdr-agent:') &&
            typeof identity.directory === 'string' && identity.directory.trim() &&
            typeof identity.terminalId === 'string' && identity.terminalId.trim(),
          'coordinator_unavailable', 'Coordinator requires a ready, fresh native bridge', 409);
          const observed = store.operation(identity.observedId);
          requireValue(observed?.id === identity.observedId && observed.id === `herdr-agent:${digest(observed.identity)}` &&
            observed.state === 'recorded' && observed.availability === 'present' && !observed.error && fresh(observed.updatedAt, 15000) &&
            observed.identity?.companyId === request.companyId && observed.identity.harness === binding.config.harness &&
            observed.identity.sessionKind === 'id' && observed.identity.conversationId === identity.conversationId &&
            observed.agentId === binding.config.agentId &&
            binding.config.instanceId === digest([observed.identity.machineId, observed.identity.session]) &&
            observed.placement?.directory === identity.directory && observed.placement.terminalId === identity.terminalId,
          'coordinator_unavailable', 'Exact fresh Herdr observation and native placement required', 409);
          store.assertWorkerAdmission(binding.id);
          const parent = parents[0];
          requireValue(parent && parent.request.bindingId === scope.reviewerBindingId &&
            parent.request.bindingRevision === scope.reviewerBindingRevision && parent.request.agentId === scope.reviewerAgentId &&
            parent.conversationId === scope.reviewerConversationId && parent.settlement?.outcome === 'waiting' &&
            !parent.cancellationRequested && !parent.waiting && parent.dependency?.state === 'recorded' &&
            (parent.dependency.taskIds ?? [parent.dependency.childId]).includes(request.childTaskId) &&
            parents.every(item => !item.result && item.review?.status !== 'pending'),
          'coordinator_not_waiting', 'Latest coordinator turn must be waiting for this child without a final result', 409);
          return run;
        };
        const read = async path => {
          check();
          const response = await operatorApi('GET', path);
          check();
          return response;
        };
        const run = check();
        const childPath = `/api/issues/${encodeURIComponent(request.childTaskId)}`;
        const parentPath = `/api/issues/${encodeURIComponent(request.parentTaskId)}`;
        const child = await read(childPath);
        requireValue(child?.id === request.childTaskId && child.companyId === request.companyId &&
          child.parentId === request.parentTaskId && child.status === 'in_review' &&
          child.assigneeAgentId === run.request.agentId && !child.assigneeUserId &&
          (!child.executionRunId || child.executionRunId === (run.backendRunId ?? run.request.runId)),
        'review_scope_changed', 'Child assignment, parent or review status changed', 409);
        const parent = await read(parentPath);
        requireValue(parent?.id === request.parentTaskId && parent.companyId === request.companyId && !parent.parentId &&
          parent.assigneeAgentId === request.grant.request.reviewerAgentId && !parent.assigneeUserId &&
          ['backlog', 'todo', 'in_progress', 'blocked'].includes(parent.status),
        'review_scope_changed', 'Parent must remain nonterminal and assigned to the coordinator', 409);
        const parentInteractions = await read(`${parentPath}/interactions`);
        requireValue(Array.isArray(parentInteractions), 'invalid_backend_response', 'Expected parent interactions', 502);
        requireValue(!parentInteractions.some(item => item.status === 'pending'),
          'review_not_pending', 'Parent has a pending interaction', 409);
        const interactions = await read(`${childPath}/interactions`);
        requireValue(Array.isArray(interactions), 'invalid_backend_response', 'Expected child interactions', 502);
        const identity = `relay-review:${run.id}:${request.resultDigest}`;
        const matches = interactions.filter(item => item.id === request.interactionId || item.idempotencyKey === identity);
        const interaction = matches[0];
        requireValue(matches.length === 1 && interaction.id === request.interactionId && interaction.status === 'pending' &&
          interaction.kind === 'request_confirmation' && interaction.idempotencyKey === identity &&
          interaction.resolverPolicy === 'not_creator' && !interaction.addresseeUserId &&
          (!interaction.addresseeAgentId || interaction.addresseeAgentId === request.grant.request.reviewerAgentId) &&
          (interaction.companyId === undefined || interaction.companyId === request.companyId) &&
          (interaction.issueId === undefined || interaction.issueId === request.childTaskId) &&
          canonical(interaction.payload?.target) === canonical({ type: 'custom', key: 'herdr-relay-candidate',
            revisionId: request.candidate, label: run.id }),
        'review_not_pending', 'Exact backend candidate review must remain pending', 409);
        const freshChild = await read(childPath);
        const freshParent = await read(parentPath);
        requireValue(canonical(freshChild) === canonical(child) && canonical(freshParent) === canonical(parent),
          'review_scope_changed', 'Task scope changed during notice validation', 409);
        const dispatch = store.transaction(() => {
          check();
          const current = store.operation(notice.id);
          if (current && ['uncertain', 'recorded'].includes(current.state)) return false;
          requireValue(!current || canonical(current.request) === canonical(request),
            'coordinator_notice_conflict', 'Notice identity changed', 409);
          operation = store.saveOperation({ ...notice, state: 'uncertain' });
          return true;
        });
        if (!dispatch) return;
        const posted = await operatorApi('POST', path, { body: request.body, clientRequestId: request.clientRequestId });
        if (typeof posted?.id === 'string' && posted.id.trim()) {
          operation = store.saveOperation({ ...operation, commentId: posted.id });
        }
        await receipt();
      } catch (error) {
        const current = store.operation(notice.id);
        if (current?.state === 'recorded') return;
        store.saveOperation({ ...(current ?? notice), state: current?.state === 'uncertain' ? 'uncertain' : 'blocked',
          reason: error instanceof RelayError && codes.has(error.code) ? error.code : 'backend_unavailable' });
      }
    });
    locks.set(lock, pending);
    try { await pending; } finally { if (locks.get(lock) === pending) locks.delete(lock); }
  }
}
