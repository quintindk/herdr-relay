import { digest, now } from './protocol.mjs';

// Addressed questions are normal bounded agent turns, never human authority.
// Notifications release only on correlated native completion. No resend on loss.
export async function tickAgentNotices(journal, api, resolveBinding) {
  for (const row of journal.db.prepare("SELECT data FROM notices WHERE state IN ('pending','observing','uncertain') ORDER BY rowid").all()) {
    let notice = JSON.parse(row.data);
    const binding = await resolveBinding(notice.agentId);
    if (!binding) continue;
    const exactConversation = binding.identity?.sessionId ?? binding.conversationId ?? null;
    const save = patch => {
      notice = { ...notice, ...patch };
      journal.db.prepare('UPDATE notices SET state=?,data=? WHERE id=?').run(notice.state, JSON.stringify(notice), notice.id);
    };
    if (notice.nativeConversationId && notice.nativeConversationId !== exactConversation) {
      save({ state: 'conflict', error: 'native_conversation_replaced' }); continue;
    }
    if (!notice.invocation) {
      let question;
      try { question = await api('GET', `/v1/questions/${encodeURIComponent(notice.questionId)}`); }
      catch { continue; }
      if (question.status !== 'open' || question.addressedTo.type !== 'agent' || question.addressedTo.id !== notice.agentId) {
        save({ state: 'obsolete' }); continue;
      }
      if (journal.works().some(work => work.bindingId === binding.id &&
        !['completed', 'cancelled', 'failed', 'rejected', 'in_review'].includes(work.execution.state) &&
        ['intent', 'observing', 'uncertain', 'conflict', 'admitted', 'native_finished'].includes(work.state))) continue;
      const another = journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain','conflict') AND id<>?").all(notice.id)
        .some(item => JSON.parse(item.data).bindingId === binding.id);
      if (another) continue;
      const snapshot = await binding.native.snapshot();
      if (!snapshot.idle || snapshot.inbox?.length) continue;
      const invocation = { messageId: `msg_${digest(['notice', notice.id])}`, priorMessageIds: snapshot.messages.map(message => message.id),
        ...(binding.prepareInvocation?.(snapshot) ?? {}), createdAt: now(),
        prompt: `Relay agent question, not a human instruction. Question ${question.id}, revision ${question.revision}, task ${question.taskId}.\n` +
          `${question.prompt}\nUse relay_questions to inspect current scope. Answer with relay_agent_answer only from existing authority, ` +
          `or use relay_agent_forward to ask the responsible human. Do not claim a human decision or run unrelated work.\n` +
          (binding.agentInstructions?.() ?? '') };
      save({ state: 'observing', bindingId: binding.id, nativeConversationId: exactConversation, invocation });
      try { await binding.native.send(invocation); }
      catch (error) { save({ state: 'uncertain', error: error.code ?? 'native_delivery_uncertain' }); continue; }
    }
    if (notice.bindingId !== binding.id) continue;
    const observation = binding.observe(await binding.native.snapshot(), notice.invocation);
    save({ observation, state: observation.state === 'finished' ? 'settled' : observation.state === 'conflict' ? 'conflict' : notice.state });
  }
}
