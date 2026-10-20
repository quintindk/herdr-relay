import { digest, now } from './protocol.mjs';
import { installLocalSchedule, tickLocalSchedules } from './node-schedules.mjs';

export function reconcileScheduleDefinitions(journal, clock = Date.now()) {
  for (const row of journal.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'schedule-pending:%'").all()) {
    const schedule = JSON.parse(row.value);
    journal.transaction(() => {
      installLocalSchedule(journal, { ...schedule.definition, id: schedule.id, revision: schedule.revision }, clock);
      if (schedule.cancelled) {
        const local = JSON.parse(journal.db.prepare('SELECT data FROM schedules WHERE id=?').get(schedule.id).data);
        journal.db.prepare('UPDATE schedules SET data=? WHERE id=?').run(JSON.stringify({ ...local, state: 'cancelled' }), schedule.id);
        for (const occurrenceRow of journal.db.prepare("SELECT id,data FROM occurrences WHERE schedule_id=? AND state='pending'").all(schedule.id)) {
          if (journal.work(occurrenceRow.id)?.invocation) continue;
          journal.db.prepare('UPDATE occurrences SET state=?,data=? WHERE id=?').run('cancelled',
            JSON.stringify({ ...JSON.parse(occurrenceRow.data), state: 'cancelled' }), occurrenceRow.id);
        }
      }
      journal.queue({ key: `schedule-ack:${schedule.id}:${schedule.revision}`, action: 'schedule.acknowledge',
        payload: { id: schedule.id, expectedRevision: schedule.revision } });
      journal.db.prepare('DELETE FROM settings WHERE key=?').run(row.key);
    });
  }
  for (const row of journal.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'schedule-transfer:%'").all()) {
    const schedule = JSON.parse(row.value);
    journal.transaction(() => {
      // Fence future ticks first. Already admitted occurrence evidence survives.
      const local = journal.db.prepare('SELECT data FROM schedules WHERE id=?').get(schedule.id);
      if (local) {
        const value = { ...JSON.parse(local.data), state: 'transferring' };
        journal.db.prepare('UPDATE schedules SET data=? WHERE id=?').run(JSON.stringify(value), schedule.id);
      }
      const outstanding = journal.db.prepare("SELECT 1 FROM occurrences WHERE schedule_id=? AND state IN ('pending','admitted','uncertain','waiting_question') LIMIT 1").get(schedule.id);
      if (!outstanding) {
        journal.queue({ key: `transfer-fenced:${schedule.id}:${schedule.revision}`, action: 'schedule.transfer_fenced',
          payload: { id: schedule.id, expectedRevision: schedule.revision } });
        journal.db.prepare('DELETE FROM settings WHERE key=?').run(row.key);
      }
    });
  }
}

// Installed automation executes without backend access. The optional client is
// used only for answered asynchronous clarification continuation.
export async function tickAutomation(journal, resolveBinding, clock = Date.now(), api) {
  reconcileScheduleDefinitions(journal, clock);
  tickLocalSchedules(journal, clock);
  for (const row of journal.db.prepare("SELECT data FROM occurrences WHERE state IN ('pending','admitted','uncertain','waiting_question') ORDER BY id").all()) {
    let occurrence = JSON.parse(row.data);
    let work = journal.work(occurrence.id);
    if (occurrence.definition.intent === 'reminder') {
      journal.transaction(() => {
        const notification = { id: occurrence.id, scheduleId: occurrence.scheduleId, intendedAt: occurrence.intendedAt,
          message: occurrence.definition.instructions, state: 'pending', kind: 'human_reminder' };
        journal.db.prepare('INSERT OR IGNORE INTO local_notifications VALUES (?,?)').run(notification.id, JSON.stringify(notification));
        journal.queue({ key: `reminder:${occurrence.id}`, action: 'schedule.remind', payload: { id: occurrence.id,
          scheduleId: occurrence.scheduleId, definitionRevision: occurrence.definition.revision,
          intendedAt: occurrence.intendedAt, message: occurrence.definition.instructions } });
        journal.db.prepare('UPDATE occurrences SET state=?,data=? WHERE id=?').run('completed', JSON.stringify({ ...occurrence, state: 'completed', notificationId: notification.id }), occurrence.id);
      });
      continue;
    }
    const saveOccurrence = (state, extra = {}) => {
      occurrence = { ...occurrence, ...extra, state };
      journal.db.prepare('UPDATE occurrences SET state=?,data=? WHERE id=?').run(state, JSON.stringify(occurrence), occurrence.id);
    };
    if (!work) {
      if (occurrence.definition.expiresAt && clock >= Date.parse(occurrence.definition.expiresAt)) {
        saveOccurrence('expired', { reason: 'Admission deadline elapsed before native intent' }); continue;
      }
      const local = journal.db.prepare('SELECT data FROM schedules WHERE id=?').get(occurrence.scheduleId);
      if (!local || JSON.parse(local.data).state === 'paused') continue;
      if (['cancelled', 'transferring', 'transferred', 'expired'].includes(JSON.parse(local.data).state)) {
        saveOccurrence('cancelled', { reason: 'Installed schedule no longer admits pending work' }); continue;
      }
    }
    const binding = work ? await resolveBinding(work.execution.targetAgentId) : occurrence.definition.targetFolder ?
      await resolveBinding.folder?.(occurrence.definition.targetFolder) : await resolveBinding(occurrence.definition.targetAgentId);
    if (!binding) {
      if (!work) saveOccurrence('pending', { admission: { state: 'deferred', reason: 'target_unavailable_or_ambiguous' } });
      continue;
    }
    const exactConversation = binding.identity?.sessionId ?? binding.conversationId ?? null;
    if (!work && occurrence.definition.targetConversationId && occurrence.definition.targetConversationId !== exactConversation) {
      saveOccurrence('pending', { admission: { state: 'blocked', reason: 'target_conversation_replaced' } }); continue;
    }
    if (work?.state === 'conflict') continue;
    if (work?.bindingId && work.bindingId !== binding.id) {
      journal.save({ ...work, state: 'conflict', error: 'binding_replaced' }); continue;
    }
    if (work?.nativeConversationId && work.nativeConversationId !== exactConversation) {
      journal.save({ ...work, state: 'conflict', error: 'native_conversation_replaced' }); continue;
    }
    const capacityAvailable = () => !journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain','conflict')").all()
      .some(item => JSON.parse(item.data).bindingId === binding.id) && !journal.works().some(other => other.id !== work?.id &&
        other.bindingId === binding.id && other.state !== 'settled' &&
        !['completed', 'cancelled', 'failed', 'rejected', 'in_review'].includes(other.execution.state) &&
        ['intent', 'observing', 'uncertain', 'conflict', 'admitted', 'native_finished'].includes(other.state));
    if (work?.execution.cancellationRequested) {
      // A backend cancellation request is not native settlement. Reuse durable
      // terminal evidence or observe the exact invocation before releasing work.
      let observation = work.observation?.state === 'finished' ? work.observation : null;
      if (!observation && work.invocation) {
        if (binding.interrupt && !work.interruption && work.state !== 'conflict') {
          work = journal.save({ ...work, interruption: { state: 'uncertain', at: now() } });
          try { await binding.interrupt(); }
          catch (error) { work = journal.save({ ...work, interruption: { ...work.interruption, error: error.code ?? 'interrupt_uncertain' } }); }
        }
        observation = binding.observe(await binding.native.snapshot(), work.invocation);
        work = journal.save({ ...work, observation,
          state: observation.state === 'conflict' ? 'conflict' : work.state });
        if (observation.state !== 'finished') continue;
      }
      journal.transaction(() => {
        if (work.execution.state !== 'cancelled') journal.queue({
          key: `schedule-cancel:${digest([work.id, work.execution.revision])}`, action: 'execution.settle', payload: {
            id: work.id, expectedRevision: work.execution.revision, outcome: 'cancelled',
            evidence: observation ? `Exact native terminal ${observation.messageId}, run ${work.execution.runId}` :
              'No native prompt intent exists for scheduled continuation',
          },
        });
        journal.save({ ...work, observation, state: 'settled' });
        saveOccurrence('cancelled', { observation, cancellationPublicationPending: work.execution.state !== 'cancelled' });
      });
      continue;
    }
    if (occurrence.state === 'waiting_question') {
      if (!api || work.execution.cancellationRequested) continue;
      let execution = work.execution;
      let receipt = work.continuationCommandKey && journal.receipt(work.continuationCommandKey);
      if (!receipt) {
        if (execution.state !== 'continuation_ready') continue;
        const command = { key: `schedule-continue:${execution.id}:${execution.continuationId}`, action: 'execution.continue',
          payload: { id: execution.id, expectedRevision: execution.revision, runId: `run_${digest([execution.id, execution.continuationId])}` } };
        journal.queue(command);
        work = journal.save({ ...work, continuationCommandKey: command.key });
        try { await journal.flush(api); } catch { continue; }
        receipt = journal.receipt(command.key);
      }
      if (receipt?.state === 'pending') {
        try { await journal.flush(api); } catch { continue; }
        receipt = journal.receipt(work.continuationCommandKey);
      }
      if (receipt?.state !== 'recorded') continue;
      execution = receipt.receipt;
      const question = await api('GET', `/v1/questions/${encodeURIComponent(execution.answerQuestionId)}`);
      journal.archive(work);
      work = journal.save({ ...work, execution, answer: question.answer, invocation: null, observation: null, interruption: null,
        staged: null, state: 'pending', continuationCommandKey: null });
      saveOccurrence('pending');
    }
    if (work && !work.invocation) {
      // Continuation has a fresh run identity but retains its pinned binding.
      if (work.bindingId !== binding.id) continue;
      if (!api) continue;
      const fresh = await api('GET', `/v1/executions/${encodeURIComponent(work.id)}`);
      if (fresh.runId !== work.execution.runId || fresh.bindingId !== binding.id || fresh.targetNodeId !== journal.nodeId ||
        fresh.targetAgentId !== work.execution.targetAgentId) {
        journal.save({ ...work, state: 'conflict', error: 'execution_identity_changed' }); continue;
      }
      work = journal.save({ ...work, execution: fresh });
      if (fresh.state !== 'accepted' || fresh.cancellationRequested) continue;
      if (!capacityAvailable()) continue;
      const snapshot = await binding.native.snapshot();
      if (!snapshot.idle || snapshot.inbox?.length) continue;
      const invocation = { runId: work.execution.runId, messageId: `msg_${digest([occurrence.id, work.execution.runId])}`, priorMessageIds: snapshot.messages.map(message => message.id),
        ...(binding.prepareInvocation?.(snapshot) ?? {}), createdAt: now(), prompt:
          `Relay scheduled continuation ${occurrence.id}.\n${occurrence.definition.instructions}\nAnswer: ${work.answer.body}\n${binding.workerInstructions?.(work.execution) ?? ''}` };
      work = journal.save({ ...work, invocation, state: 'intent' }); saveOccurrence('admitted');
      try { await binding.native.send(invocation); }
      catch (error) { journal.save({ ...journal.work(work.id), state: 'uncertain', error: error.code ?? 'native_delivery_uncertain' }); saveOccurrence('uncertain'); continue; }
    }
    if (!work) {
      if (journal.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state IN ('pending','conflict')").get().n >= journal.maxPending) continue;
      if (!capacityAvailable()) continue;
      const snapshot = await binding.native.snapshot();
      if (!snapshot.idle || snapshot.inbox?.length) continue;
      const execution = { id: occurrence.id, runId: `run_${digest(occurrence.id)}`, targetAgentId: occurrence.definition.targetFolder ? binding.agentId : occurrence.definition.targetAgentId,
        targetNodeId: journal.nodeId, state: 'accepted', instructions: occurrence.definition.instructions, localOccurrence: true,
        cancellationRequested: false };
      const invocation = { runId: execution.runId, messageId: `msg_${digest(occurrence.id)}`, priorMessageIds: snapshot.messages.map(message => message.id),
        ...(binding.prepareInvocation?.(snapshot) ?? {}),
        prompt: `Relay local occurrence ${occurrence.id}.\n${execution.instructions}\n${binding.workerInstructions?.(execution) ?? ''}`, createdAt: now() };
      journal.transaction(() => {
        work = journal.save({ id: occurrence.id, bindingId: binding.id, nativeConversationId: exactConversation, execution, invocation, state: 'intent' });
        saveOccurrence('admitted', { bindingId: binding.id });
      });
      try { await binding.native.send(invocation); }
      catch (error) {
        journal.save({ ...journal.work(work.id), state: 'uncertain', error: error.code ?? 'native_delivery_uncertain' });
        saveOccurrence('uncertain'); continue;
      }
      work = journal.save({ ...journal.work(work.id), state: 'observing' });
    }
    if (work.state === 'conflict') continue;
    const observation = binding.observe(await binding.native.snapshot(), work.invocation);
    work = journal.work(work.id);
    if (observation.state === 'conflict') { journal.save({ ...work, observation, state: 'conflict' }); continue; }
    if (observation.state !== 'finished') continue;
    journal.save({ ...work, observation, state: 'native_finished' });
    if (observation.outcome !== 'succeeded') { saveOccurrence('failed', { observation }); continue; }
    if (work.staged?.kind === 'question') {
      journal.transaction(() => {
        journal.queue({ key: `schedule-question:${occurrence.id}:${work.execution.runId}:${work.staged.key}`, action: 'schedule.ask', payload: {
          id: `question_${digest([occurrence.id, work.execution.runId, work.staged.key])}`, occurrenceId: occurrence.id,
          scheduleId: occurrence.scheduleId, definitionRevision: occurrence.definition.revision, intendedAt: occurrence.intendedAt,
          bindingId: binding.id, runId: work.execution.runId, targetAgentId: work.execution.targetAgentId,
          prompt: work.staged.payload.prompt, humanRequired: work.staged.payload.humanRequired ?? true,
        } });
        journal.save({ ...work, observation, state: 'settled_waiting' });
        saveOccurrence('waiting_question');
      });
      continue;
    }
    if (work.staged?.kind !== 'result') continue;
    journal.transaction(() => {
      journal.queue({ key: `occurrence-publish:${occurrence.id}`, action: 'schedule.publish', payload: {
        id: occurrence.id, scheduleId: occurrence.scheduleId, definitionRevision: occurrence.definition.revision,
        intendedAt: occurrence.intendedAt, ...work.staged.payload,
        evidence: `Native terminal ${observation.messageId}, run ${work.execution.runId}`,
      } });
      saveOccurrence('completed', { observation, result: work.staged.payload });
      journal.archive({ ...work, observation });
      journal.save({ ...journal.work(work.id), observation, state: 'settled' });
    });
  }
}
