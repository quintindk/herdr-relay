import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { createEffect, createRoot } from 'solid-js';
import { nativeBackendClient } from '../../src/backend-client.mjs';
import { HumanProposals, humanSource, proposalDigest } from './human-proposals.mjs';
import { proposedActions } from './operator-tools.mjs';
import { RelaySpike } from './rpc.mjs';

// Runs only from a local TUI keyboard/palette command. It never registers an
// owner-capable model tool or exposes the owner credential over server RPC.
export function registerHumanInbox(ctx, { clientId, selectedSession, record = () => {} }) {
  if (!ctx.options.ownerContextFile) return () => {};
  let disposed = false;
  let busy = false;
  let generation = 0;
  let previousSession = selectedSession();
  const stopConnection = ctx.data?.on?.('server.connected', () => {
    generation++;
    record({ type: 'connection_context_invalidated', sessionId: selectedSession() });
  });
  const runtimeGeneration = async () => (await ctx.client.rpc(RelaySpike).inspect({},
    { location: ctx.location ?? ctx.data.location.default() })).generation;
  const checkRuntime = async origin => {
    if (origin.runtimeGeneration !== await runtimeGeneration()) throw new Error('Relay service reloaded during confirmation');
    check(origin);
  };
  const stopTracking = createRoot(dispose => {
    createEffect(() => {
      const session = selectedSession();
      if (session !== previousSession) { generation++; previousSession = session; }
    });
    return dispose;
  });
  const [outbox, updateOutbox] = ctx.storage.store('human-outbox', { initial: { pending: null } });
  const current = () => ({ sessionId: selectedSession(), generation });
  const check = origin => {
    if (disposed || origin.generation !== generation || origin.sessionId !== selectedSession()) throw new Error('Human inbox context changed');
  };
  const api = () => nativeBackendClient(JSON.parse(readFileSync(ctx.options.ownerContextFile, 'utf8')));
  const pages = async (request, collection, status) => {
    const items = [];
    let cursor;
    const seen = new Set();
    do {
      const query = new URLSearchParams({ status, limit: '100', ...(cursor ? { cursor } : {}) });
      const page = await request('GET', `/v1/${collection}?${query}`);
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Human inbox traversal did not advance');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  };
  const run = async kind => {
    if (disposed || busy) return;
    busy = true;
    const origin = current();
    try {
      const request = api();
      origin.runtimeGeneration = await runtimeGeneration();
      check(origin);
      const info = await request('GET', '/v1/info');
      if (outbox.pending) {
        // A previously confirmed decision is replayed only with its immutable key.
        // No newly selected task or session changes that old authorisation.
        const pending = JSON.parse(JSON.stringify(outbox.pending));
        if (pending.instanceId !== info.instanceId) throw new Error('Pending decision belongs to another backend');
        await request('POST', '/v1/commands', pending.command);
        await updateOutbox(draft => { if (draft.pending?.command.key === pending.command.key) draft.pending = null; });
      }
      const collection = kind === 'question' ? 'questions' : 'executions';
      const baseItems = await pages(request, collection, kind === 'question' ? 'open' : 'in_review');
      const items = (kind === 'question' ? baseItems : [
        ...baseItems.map(item => ({ ...item, collection: 'executions' })),
        ...(await pages(request, 'executions', 'monitor_review')).map(item => ({ ...item, collection: 'executions', monitorReview: true,
          result: { candidate: item.monitorResultId, summary: 'Standing monitor result requires inspection' } })),
        ...(await pages(request, 'occurrences', 'in_review')).filter(item => !item.executionId).map(item => ({ ...item, collection: 'occurrences',
          taskId: item.scheduleId, result: { candidate: item.candidate, summary: item.summary } })),
      ])
        .filter(item => kind === 'question' ? item.addressedTo.type === 'user' && item.addressedTo.id === info.userId :
          item.reviewPolicy !== 'agent' || item.reviewerMode === 'human_recovery');
      check(origin);
      if (!items.length) { ctx.ui.toast.show({ message: `No pending ${kind}s`, variant: 'info' }); return; }
      record({ type: 'inbox_select', kind, sessionId: origin.sessionId });
      const id = await ctx.ui.dialog.select({ title: kind === 'question' ? 'Relay questions' : 'Relay candidate reviews',
        options: items.map(item => ({ value: item.id, title: kind === 'question' ? item.prompt : item.result.summary,
          description: `Task ${item.taskId}${kind === 'review' ? `, candidate ${item.result.candidate}` : ''}` })) });
      check(origin);
      if (!id) return;
      const selected = items.find(item => item.id === id);
      const itemCollection = selected.collection ?? collection;
      const raw = await request('GET', `/v1/${itemCollection}/${encodeURIComponent(id)}`);
      let item = itemCollection === 'occurrences' ? { ...raw, taskId: raw.scheduleId, result: { candidate: raw.candidate, summary: raw.summary } } : raw;
      if (item.state === 'monitor_review') {
        const result = await request('GET', `/v1/monitor_results/${encodeURIComponent(item.monitorResultId)}`);
        item = { ...item, result };
      }
      check(origin);
      let command;
      if (kind === 'question') {
        record({ type: 'inbox_answer', sessionId: origin.sessionId });
        const answer = await ctx.ui.dialog.prompt({ title: item.prompt, description: `Task ${item.taskId}` });
        check(origin);
        if (!answer?.trim()) return;
        command = { key: `human-answer:${randomUUID()}`, action: 'question.answer', payload: {
          id, expectedRevision: item.revision, body: answer.trim(),
          source: { conversationId: origin.sessionId ?? `tui:${clientId}`, messageId: `dialog:${randomUUID()}`,
            digest: createHash('sha256').update(answer.trim()).digest('hex') },
        } };
      } else {
        record({ type: 'review_choice', sessionId: origin.sessionId });
        const decision = await ctx.ui.dialog.select({ title: `Review ${item.result.candidate}`,
          options: [{ title: 'Accept candidate', value: 'accept' }, { title: 'Request changes', value: 'reject' }] });
        check(origin);
        if (!decision) return;
        record({ type: 'review_reason', sessionId: origin.sessionId });
        const reason = await ctx.ui.dialog.prompt({ title: decision === 'accept' ? 'Review evidence' : 'Required changes', description: item.result.summary });
        check(origin);
        if (!reason?.trim()) return;
        command = { key: `human-review:${randomUUID()}`, action: itemCollection === 'occurrences' ? 'occurrence.review' :
          item.state === 'monitor_review' ? 'execution.monitor_review' : 'execution.review', payload: {
          id, expectedRevision: item.revision, candidate: item.result.candidate, decision, reason: reason.trim(),
          ...(item.state !== 'monitor_review' ? { source: { conversationId: origin.sessionId ?? `tui:${clientId}`, messageId: `dialog:${randomUUID()}`,
            digest: createHash('sha256').update(JSON.stringify({ candidate: item.result.candidate, decision, reason: reason.trim() })).digest('hex') },
          } : {}),
        } };
      }
      const exact = JSON.stringify(command);
      record({ type: 'inbox_confirm', kind, sessionId: origin.sessionId });
      const confirmed = await ctx.ui.dialog.confirm({ title: 'Relay decision', message: kind === 'question' ?
        `${item.prompt}\n\nAnswer: ${command.payload.body}` : `Candidate: ${item.result.candidate}\nDecision: ${command.payload.decision}\n${command.payload.reason}` });
      check(origin);
      if (!confirmed) return;
      await checkRuntime(origin);
      // Persist the exact command before network publication. Reopening the inbox
      // reconciles this same key rather than making a fresh approval after loss.
      await updateOutbox(draft => {
        if (draft.pending) throw new Error('Another confirmed decision is awaiting publication');
        draft.pending = { instanceId: info.instanceId, command: JSON.parse(exact) };
      });
      check(origin);
      await request('POST', '/v1/commands', command);
      await updateOutbox(draft => { if (draft.pending?.command.key === command.key) draft.pending = null; });
      record({ type: 'human_decision', kind, sessionId: origin.sessionId });
      ctx.ui.toast.show({ message: 'Relay decision recorded', variant: 'success' });
    } catch (error) {
      record({ type: 'human_decision_refused', kind, sessionId: origin.sessionId });
      ctx.ui.toast.show({ message: error.code ?? error.message, variant: 'error' });
    } finally { busy = false; }
  };
  ctx.keymap.layer(() => ({ mode: 'global', commands: [
    { id: 'herdr.relay.decisions', title: 'Relay proposed human decisions', palette: true, slash: { name: 'relay-decisions' }, async run() {
      if (disposed || busy) return;
      busy = true;
      const origin = current();
      try {
        if (!origin.sessionId) throw new Error('Open the originating session first');
        origin.runtimeGeneration = await runtimeGeneration();
        check(origin);
        const proposals = await ctx.client.rpc(HumanProposals).list({ sessionId: origin.sessionId }, { location: ctx.location ?? ctx.data.location.default() });
        const latest = async () => humanSource((await ctx.client.message.list({ sessionID: origin.sessionId, type: 'user', order: 'desc', limit: 1 })).data[0]);
        const source = await latest();
        const candidates = proposals.items.filter(item => item.authority === 'proposal_only' && item.sessionId === origin.sessionId &&
          proposalDigest(item.source) === proposalDigest(source));
        check(origin);
        if (!candidates.length) { ctx.ui.toast.show({ message: 'No decisions for the current human message', variant: 'info' }); return; }
        record({ type: 'proposal_select', sessionId: origin.sessionId });
        const id = await ctx.ui.dialog.select({ title: 'Proposed Relay decisions', options: candidates.map(item => ({ value: item.id,
          title: item.kind === 'answer' ? item.payload.body : item.kind === 'command' ? item.action : `${item.payload.decision} ${item.payload.candidate}`, description: item.payload.id })) });
        check(origin);
        if (!id) return;
        const proposal = candidates.find(item => item.id === id);
        if (!proposal || !['answer', 'review', 'command'].includes(proposal.kind)) throw new Error('Unknown decision proposal');
        const definition = proposal.kind === 'command' ? Object.values(proposedActions).find(item => item.action === proposal.action) : null;
        if (proposal.kind === 'command' && !definition) throw new Error('Unsupported operator proposal');
        const allowed = proposal.kind === 'command' ? Object.keys(definition.properties) : proposal.kind === 'answer' ? ['id', 'expectedRevision', 'body'] : ['id', 'expectedRevision', 'candidate', 'decision', 'reason'];
        if (Object.keys(proposal.payload).some(key => !allowed.includes(key))) throw new Error('Unexpected decision proposal fields');
        if (proposalDigest(await latest()) !== proposalDigest(source)) throw new Error('Human source changed');
        const request = api();
        const info = await request('GET', '/v1/info');
        const target = proposal.kind === 'command' ? null : await request('GET', `/v1/${proposal.kind === 'answer' ? 'questions' : 'executions'}/${encodeURIComponent(proposal.payload.id)}`);
        if (target && target.revision !== proposal.payload.expectedRevision) throw new Error('Decision target changed');
        record({ type: 'proposal_confirm', sessionId: origin.sessionId });
        const confirmed = await ctx.ui.dialog.confirm({ title: 'Relay human decision', message:
          `Your message: ${source.text}\n\n` + (proposal.kind === 'command' ?
            `Action: ${proposal.action}\nExact payload:\n${JSON.stringify(proposal.payload, null, 2)}` : `Task: ${target.taskId}\n` +
          (proposal.kind === 'answer' ? `${target.prompt}\nAnswer: ${proposal.payload.body}` :
            `Candidate: ${proposal.payload.candidate}\nDecision: ${proposal.payload.decision}\n${proposal.payload.reason}`)) });
        check(origin);
        if (!confirmed) return;
        await checkRuntime(origin);
        if (proposalDigest(await latest()) !== proposalDigest(source)) throw new Error('Human source changed during confirmation');
        check(origin);
        const command = { key: `human-proposal:${proposal.id}`, action: proposal.kind === 'command' ? proposal.action : proposal.kind === 'answer' ? 'question.answer' : 'execution.review',
          payload: { ...proposal.payload, ...(proposal.kind !== 'command' ? { source: { conversationId: origin.sessionId, messageId: source.id, digest: proposalDigest(source) } } : {}) } };
        if (outbox.pending) throw new Error('Another confirmed decision awaits publication. Open the human inbox to reconcile it');
        await updateOutbox(draft => { if (draft.pending) throw new Error('Another confirmed decision awaits publication'); draft.pending = { instanceId: info.instanceId, command }; });
        check(origin);
        await request('POST', '/v1/commands', command);
        await updateOutbox(draft => { if (draft.pending?.command.key === command.key) draft.pending = null; });
        record({ type: 'human_decision', kind: proposal.kind, sessionId: origin.sessionId, source: 'current_native_message' });
        ctx.ui.toast.show({ message: 'Human decision recorded', variant: 'success' });
      } catch (error) { ctx.ui.toast.show({ message: error.code ?? error.message, variant: 'error' }); }
      finally { busy = false; }
    } },
    { id: 'herdr.relay.questions', title: 'Relay human questions', palette: true, slash: { name: 'relay-questions' }, run: () => run('question') },
    { id: 'herdr.relay.reviews', title: 'Relay candidate reviews', palette: true, slash: { name: 'relay-reviews' }, run: () => run('review') },
    { id: 'herdr.relay.reminders', title: 'Relay reminders', palette: true, slash: { name: 'relay-reminders' }, async run() {
      if (disposed || busy) return;
      busy = true;
      const origin = current();
      try {
        const request = api();
        const items = await pages(request, 'notifications', 'pending');
        check(origin);
        if (!items.length) { ctx.ui.toast.show({ message: 'No pending reminders', variant: 'info' }); return; }
        const id = await ctx.ui.dialog.select({ title: 'Relay reminders', options: items.map(item => ({ title: item.message,
          description: item.intendedAt, value: item.id })) });
        check(origin);
        if (!id) return;
        const item = items.find(item => item.id === id);
        await ctx.ui.dialog.alert({ title: 'Relay reminder', message: item.message });
        check(origin);
        await request('POST', '/v1/commands', { key: `reminder-ack:${randomUUID()}`, action: 'notification.acknowledge',
          payload: { id: item.id, expectedRevision: item.revision } });
      } catch (error) { ctx.ui.toast.show({ message: error.code ?? error.message, variant: 'error' }); }
      finally { busy = false; }
    } },
  ] }));
  return () => { disposed = true; generation++; stopTracking(); stopConnection?.(); };
}
