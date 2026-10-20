import { digest, now, requireValue } from './protocol.mjs';

// A bounded node tick. Native bindings are injected by the local runtime host.
// Persist admission and prompt intent before crossing either external boundary.
export async function tickNode(journal, api, resolveBinding) {
  let connected = true;
  try { await journal.flush(api); await journal.poll(api); }
  catch (error) {
    if (error.status && error.status < 500) throw error;
    connected = false;
  }
  for (let work of journal.works()) {
    let execution = work.execution;
    if (execution.localOccurrence) continue;
    if (execution.monitor && Date.now() >= Date.parse(execution.monitor.endsAt) && !execution.cancellationRequested &&
      !['completed', 'cancelled', 'failed', 'rejected'].includes(execution.state)) {
      if (!work.monitorExpiryCommand) {
        const command = { key: `monitor-end:${execution.id}`, action: 'execution.monitor_end', payload: { id: execution.id, expectedRevision: execution.revision } };
        journal.queue(command);
        work = journal.save({ ...work, monitorExpiryCommand: command.key, monitorExpiredLocally: true });
      }
      if (connected) {
        await journal.flush(api);
        const receipt = journal.receipt(work.monitorExpiryCommand);
        if (receipt?.state === 'recorded') execution = receipt.receipt;
      } else execution = { ...execution, cancellationRequested: true, cancellationReason: 'Local standing-monitor window expired' };
      work = journal.save({ ...work, execution });
    }
    if (execution.monitor && Date.now() < Date.parse(execution.monitor.startsAt)) continue;
    if (execution.state === 'waiting_time' && connected && work.state === 'settled_waiting' && !execution.cancellationRequested) {
      if (Date.now() >= Date.parse(execution.nextCheckAt) && !execution.cancellationRequested) {
        journal.queue({ key: `time-ready:${digest([execution.id, execution.revision])}`, action: 'execution.check_time',
          payload: { id: execution.id, expectedRevision: execution.revision } });
        await journal.flush(api);
      }
      continue;
    }
    if (execution.state === 'waiting_children' && connected && work.state === 'settled_waiting' && !execution.cancellationRequested) {
      const children = await Promise.all(execution.childExecutionIds.map(id => api('GET', `/v1/executions/${encodeURIComponent(id)}`)));
      if (children.every(child => child.state === 'completed' && child.result)) {
        journal.queue({ key: `children-ready:${digest([execution.id, execution.revision])}`, action: 'execution.check_children',
          payload: { id: execution.id, expectedRevision: execution.revision } });
        await journal.flush(api);
      } else {
        const ready = children.filter(child => child.state === 'in_review' && child.reviewPolicy === 'agent');
        const fingerprint = ready.length ? digest(ready.map(child => [child.id, child.revision, child.result.digest])) : null;
        if (fingerprint && fingerprint !== execution.reviewWakeFingerprint) {
          journal.queue({ key: `children-review:${digest([execution.id, fingerprint])}`, action: 'execution.review_children',
            payload: { id: execution.id, expectedRevision: execution.revision } });
          await journal.flush(api);
        }
      }
      continue;
    }
    const recoveringAdmission = work.state === 'admitting' && work.attempt && journal.receipt(`admit:${work.attempt}`);
    if (recoveringAdmission?.state === 'recorded') {
      execution = execution.revision > recoveringAdmission.receipt.revision ? execution : recoveringAdmission.receipt;
      const answer = execution.answerQuestionId ? (await api('GET', `/v1/questions/${encodeURIComponent(execution.answerQuestionId)}`)).answer : null;
      const children = execution.childContinuationId ? await Promise.all(execution.childExecutionIds.map(id => api('GET', `/v1/executions/${encodeURIComponent(id)}`))) : [];
      work = journal.save({ ...work, execution, answer, children, state: 'admitted', invocation: null, observation: null, interruption: null, staged: null });
    }
    if (['completed', 'cancelled', 'failed', 'rejected', 'in_review'].includes(execution.state) || work.state === 'settled') continue;
    const binding = await resolveBinding(execution.targetAgentId);
    if (!binding) continue;
    const exactConversation = binding.identity?.sessionId ?? binding.conversationId ?? null;
    if (work.nativeConversationId && work.nativeConversationId !== exactConversation) {
      journal.save({ ...work, state: 'conflict', error: 'native_conversation_replaced' }); continue;
    }
    if (execution.targetConversationId && execution.targetConversationId !== binding.identity?.sessionId &&
      execution.targetConversationId !== binding.conversationId) {
      journal.save({ ...work, state: 'conflict', error: 'target_conversation_replaced' }); continue;
    }
    if (execution.cancellationRequested && (!work.invocation || work.state === 'settled_waiting')) {
      if (connected) {
        journal.queue({ key: `cancel-unstarted:${digest([execution.id, execution.revision])}`, action: 'execution.settle',
          payload: { id: execution.id, expectedRevision: execution.revision, outcome: 'cancelled',
            evidence: work.invocation ? 'Previous native turn settled before cancellation; no continuation admitted' : 'No native prompt intent exists for this execution' } });
        await journal.flush(api);
      }
      continue;
    }
    const attempt = digest([execution.id, execution.continuationId ?? 'initial']);
    const admissionKey = `admit:${attempt}`;
    if (['requested', 'continuation_ready'].includes(execution.state)) {
      if (!connected) continue;
      if (journal.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state IN ('pending','conflict')").get().n >= journal.maxPending) continue;
      if (work.invocation && work.attempt !== attempt && work.state !== 'settled_waiting') {
        if (work.state === 'conflict') continue;
        const observation = binding.observe(await binding.native.snapshot(), work.invocation);
        journal.save({ ...work, observation, state: observation.state === 'finished' && observation.outcome === 'succeeded' ? 'settled_waiting' :
          observation.state === 'conflict' || observation.state === 'finished' ? 'conflict' : work.state });
        continue;
      }
      if (execution.cancellationRequested) continue;
      if (work.bindingId && work.bindingId !== binding.id) {
        journal.save({ ...work, state: 'conflict', error: 'binding_replaced' });
        continue;
      }
      const snapshot = await binding.native.snapshot();
      if (journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain','conflict')").all()
        .some(row => JSON.parse(row.data).bindingId === binding.id)) continue;
      if (!snapshot.idle || snapshot.inbox?.length || journal.works().some(other =>
        other.id !== work.id && other.bindingId === binding.id &&
        !['completed', 'cancelled', 'rejected', 'failed', 'in_review'].includes(other.execution.state) &&
        ['intent', 'observing', 'uncertain', 'conflict', 'admitted', 'native_finished'].includes(other.state))) continue;
      const runId = `run_${attempt}`;
      journal.archive(work);
      work = journal.save({ ...work, state: 'admitting', bindingId: binding.id, nativeConversationId: exactConversation, attempt });
      journal.queue({ key: admissionKey, action: execution.state === 'requested' ? 'execution.admit' : 'execution.continue',
        payload: { id: execution.id, expectedRevision: execution.revision, runId,
          ...(execution.state === 'requested' ? { bindingId: binding.id } : {}) } });
      await journal.flush(api);
      const receipt = journal.receipt(admissionKey);
      if (receipt?.state !== 'recorded') continue;
      execution = receipt.receipt;
      const answer = execution.answerQuestionId ? (await api('GET', `/v1/questions/${encodeURIComponent(execution.answerQuestionId)}`)).answer : null;
      const children = execution.childContinuationId ? await Promise.all(execution.childExecutionIds.map(id => api('GET', `/v1/executions/${encodeURIComponent(id)}`))) : [];
      work = journal.save({ ...work, execution, answer, children, state: 'admitted', invocation: null, observation: null, interruption: null, staged: null });
    }
    if (!['accepted', 'waiting', 'waiting_children', 'waiting_time', 'monitor_review', 'monitor_blocked'].includes(execution.state) || work.state === 'conflict') continue;
    if (work.bindingId !== binding.id) continue;
    if (!work.invocation) {
      if (!connected || execution.cancellationRequested || execution.state !== 'accepted') continue;
      const fresh = await api('GET', `/v1/executions/${encodeURIComponent(execution.id)}`);
      requireValue(fresh.targetNodeId === journal.nodeId && fresh.targetAgentId === execution.targetAgentId &&
        fresh.runId === execution.runId && fresh.bindingId === binding.id, 'execution_identity_changed', 'Backend admission identity changed');
      work = journal.save({ ...work, execution: fresh });
      execution = fresh;
      if (execution.cancellationRequested || execution.state !== 'accepted') continue;
      const task = await api('GET', `/v1/tasks/${encodeURIComponent(execution.taskId)}`);
      if (['done', 'cancelled'].includes(task.status)) continue;
      const snapshot = await binding.native.snapshot();
      if (!snapshot.idle || snapshot.inbox?.length) continue;
      const invocation = { runId: execution.runId, messageId: `msg_${digest([execution.id, execution.runId])}`, priorMessageIds: snapshot.messages.map(message => message.id),
        ...(binding.prepareInvocation?.(snapshot) ?? {}),
        prompt: `Relay execution ${execution.id}, run ${execution.runId}.\n${execution.instructions}\n` +
          (work.answer ? `Clarification answer: ${work.answer.body}\n` : '') +
          (work.children?.length ? `Child result receipts for inspection: ${JSON.stringify(work.children.map(child => ({ id: child.id, revision: child.revision,
            reviewPolicy: child.reviewPolicy, reviewGrantId: child.reviewGrantId, state: child.state, result: child.result })))}\n` : '') +
          (execution.monitor ? `This is a bounded standing monitor through ${execution.monitor.endsAt}. Submit one check result; Relay retains this task and schedules the next interval. Do not run a continuous polling model turn.\n` : '') +
          (binding.workerInstructions?.(execution) ?? ''), createdAt: now() };
      work = journal.save({ ...work, state: 'intent', invocation });
      try { await binding.native.send(invocation); }
      catch (error) { journal.save({ ...work, state: 'uncertain', error: error.code ?? 'native_delivery_uncertain' }); continue; }
      work = journal.save({ ...journal.work(work.id), state: 'observing' });
    }
    if (execution.cancellationRequested && work.invocation && binding.interrupt && !work.interruption && work.state !== 'conflict') {
      // Only explicit owned bindings expose interruption. Persist before request,
      // and never equate an interrupt response with native terminal settlement.
      work = journal.save({ ...work, interruption: { state: 'uncertain', at: now() } });
      try { await binding.interrupt(); }
      catch (error) { journal.save({ ...journal.work(work.id), interruption: { ...work.interruption, error: error.code ?? 'interrupt_uncertain' } }); }
    }
    const observation = ['native_finished', 'settled_waiting'].includes(work.state) && work.observation?.state === 'finished' ?
      work.observation : binding.observe(await binding.native.snapshot(), work.invocation);
    if (observation.state !== 'finished') {
      journal.save({ ...journal.work(work.id), observation, state: observation.state === 'conflict' ? 'conflict' : work.state });
      continue;
    }
    // Native completion alone is not a submitted result. Persist its evidence and
    // await scoped worker submission/question protocol before backend completion.
    work = journal.save({ ...journal.work(work.id), observation, state: ['waiting', 'waiting_children', 'waiting_time', 'monitor_review', 'monitor_blocked'].includes(execution.state) ? 'settled_waiting' : 'native_finished' });
    if (execution.cancellationRequested || observation.outcome !== 'succeeded') {
      if (work.monitorExpiredLocally && !connected) continue;
      journal.queue({ key: `settle:${digest([execution.id, execution.runId])}`, action: 'execution.settle', payload: {
        id: execution.id, expectedRevision: execution.revision, outcome: execution.cancellationRequested ? 'cancelled' : 'failed',
        evidence: `Exact native terminal ${observation.messageId}, outcome ${observation.outcome}`,
      } });
      continue;
    }
    if (work.staged && observation.outcome === 'succeeded' && execution.state === 'accepted') {
      if (work.staged.kind === 'result') submitNodeResult(journal, execution.id, work.staged.payload);
      else if (work.staged.kind === 'monitor_result') {
        journal.queue({ key: `monitor-result:${digest([execution.id, execution.runId])}`, action: 'execution.monitor_result', payload: {
          id: execution.id, expectedRevision: execution.revision, ...work.staged.payload,
          evidence: `Native terminal ${observation.messageId}, run ${execution.runId}`,
        } });
        journal.save({ ...work, state: 'settled_waiting' });
      }
      else if (work.staged.kind === 'children') {
        journal.queue({ key: `children-wait:${digest([execution.id, execution.runId, work.staged])}`, action: 'execution.wait_children',
          payload: { id: execution.id, expectedRevision: execution.revision, childExecutionIds: work.staged.payload.childExecutionIds } });
        journal.save({ ...work, state: 'settled_waiting' });
      } else if (work.staged.kind === 'delay') {
        journal.queue({ key: `delay:${digest([execution.id, execution.runId, work.staged])}`, action: 'execution.delay',
          payload: { id: execution.id, expectedRevision: execution.revision, until: work.staged.payload.until, reason: work.staged.payload.reason } });
        journal.save({ ...work, state: 'settled_waiting' });
      } else {
        journal.queue({ key: `question:${digest([execution.id, execution.runId, work.staged])}`, action: 'question.ask', payload: {
          id: `question_${digest([execution.id, execution.runId, work.staged.key])}`, executionId: execution.id,
          expectedRevision: execution.revision, prompt: work.staged.payload.prompt, blocking: true,
          humanRequired: work.staged.payload.humanRequired ?? false,
        } });
        journal.save({ ...work, state: 'settled_waiting' });
      }
    }
  }
}

export function submitNodeResult(journal, executionId, result) {
  const work = journal.work(executionId);
  requireValue(work?.state === 'native_finished' && work.observation?.outcome === 'succeeded',
    'native_unsettled', 'Successful exact native settlement required before result publication');
  const e = work.execution;
  journal.queue({ key: `submit:${digest([e.id, e.runId, result])}`, action: 'execution.submit', payload: {
    id: e.id, expectedRevision: e.revision, candidate: result.candidate, summary: result.summary,
    evidence: `Native terminal ${work.observation.messageId}, run ${e.runId}`,
  } });
}
