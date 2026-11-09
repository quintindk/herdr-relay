import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickNode } from '../src/node-execution.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';
import { observeV2 } from '../packages/opencode-relay/native.mjs';
import { reconcileInteractiveWork, previewInteractiveRecovery, installInteractionPublicationGuard } from '../src/native-interaction.mjs';

function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/relay-steering-'), store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const command = (key, action, payload, actor = owner) => store.command(actor, { key, action, payload });
  command('node', 'node.enrol', { id: 'node', name: 'Node' });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  command('agent', 'agent.enrol', { id: 'agent', nodeId: 'node', name: 'Tokenomics', directory: root });
  command('attach', 'agent.attach', { id: 'agent', expectedBindingRevision: 0, conversationId: 'session', directory: root, bindingId: 'binding' });
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: store.instance });
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:agent', JSON.stringify({ state: 'active', bindingId: 'binding', generation: 1 }));
  const f = { root, store, owner, node, journal, command, messages: [], idle: true, sends: 0 };
  f.api = async (method, path, body) => {
    if (method === 'POST') return store.command(node, body);
    if (path.startsWith('/v1/events')) return store.events({ cursor: new URL(path, 'http://local').searchParams.get('cursor') ?? undefined });
    if (path.startsWith('/v1/command-receipts/')) { const url = new URL(path, 'http://local'); return store.commandReceipt(node, decodeURIComponent(url.pathname.split('/')[3]), url.searchParams.get('executionId')); }
    const [, , collection, id] = path.split('/'); return store.get(collection.slice(0, -1), id);
  };
  f.binding = { id: 'binding', agentId: 'agent', interactive: true, receiverGeneration: 1, identity: { sessionId: 'session' },
    observe: observeV2, native: { snapshot: async () => ({ messages: f.messages, idle: f.idle, inbox: [], ...(f.model ? { model: structuredClone(f.model) } : {}) }), send: async invocation => {
      f.sends++; f.messages.push({ id: invocation.messageId, text: invocation.prompt, type: 'user', metadata: { herdrRelayInvocation: invocation.messageId } }); f.idle = false;
    } } };
  f.resolve = async () => f.binding;
  f.tick = () => tickNode(journal, f.api, f.resolve);
  f.request = (options = {}) => { command('task', 'task.create', { id: 'task', title: 'REL-285' });
    command('request', 'execution.request', { id: 'current', taskId: 'task', taskRevision: 1, targetAgentId: 'agent', instructions: 'Investigate tokenomics', ...options }); };
  t.after(() => { journal.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('human steering recovers in place, later turns require their own terminal, old REL-7 continuation stays separate', async t => {
  const f = fixture(t), { command: c, node, store, journal } = f;
  c('old-task', 'task.create', { id: 'old-task', title: 'REL-7' });
  c('old', 'execution.request', { id: 'zz-old', taskId: 'old-task', taskRevision: 1, targetAgentId: 'agent', instructions: 'Earlier scope' });
  const admitted = c('old-admit', 'execution.admit', { id: 'zz-old', expectedRevision: 1, bindingId: 'binding', runId: 'old-run' }, node);
  c('question', 'question.ask', { id: 'question', executionId: admitted.id, expectedRevision: admitted.revision, prompt: 'Confirm task scope', humanRequired: true }, node);
  await journal.poll(f.api);
  const oldInvocation = { messageId: 'old-root', prompt: 'Earlier scope', priorMessageIds: [], runId: 'old-run' };
  f.messages.push({ id: 'old-root', text: 'Earlier scope', type: 'user' }, { id: 'old-idle', type: 'idle', outcome: 'succeeded' });
  journal.save({ ...journal.work('zz-old'), bindingId: 'binding', nativeConversationId: 'session', state: 'settled_waiting', invocation: oldInvocation,
    observation: { state: 'finished', messageId: 'old-idle', outcome: 'succeeded' } });
  f.request(); await f.tick();
  c('answer', 'question.answer', { id: 'question', expectedRevision: 1, body: 'The successor task is REL-285' });
  f.messages.push({ id: 'per-account', type: 'user', text: 'there is a per account cost too...' });
  journal.save({ ...journal.work('current'), state: 'conflict', observation: { state: 'conflict', reason: 'concurrent_native_input', inputId: 'per-account', inputType: 'user' } });
  f.messages.push({ id: 'first-idle', type: 'idle', outcome: 'succeeded' }); f.idle = true;
  await f.tick();
  let work = journal.work('current');
  assert.equal(work.state, 'native_finished'); assert.equal(work.observation.messageId, 'first-idle');
  assert.equal(work.recovery.previousObservation.inputId, 'per-account'); assert.equal(f.sends, 1);
  assert.equal(store.get('execution', 'current').state, 'accepted', 'Native success is not a submitted result');
  assert.equal(store.get('execution', 'zz-old').state, 'continuation_ready');
  const firstRevision = work.interaction.revision;
  f.messages.push({ id: 'power-bi', type: 'user', text: 'Investigate the Power BI report too' }); f.idle = false;
  await f.tick(); work = journal.work('current');
  assert.equal(work.state, 'observing'); assert.notEqual(work.interaction.revision, firstRevision);
  assert.equal(work.observation.state, 'observed', 'Earlier idle must not settle later Power BI work');
  const worker = { socketPath: join(f.root, 'node.sock'), token: 'worker', agentId: 'agent', sessionId: 'session', bindingId: 'binding', bindingRevision: 1 };
  const service = await startNodeService({ journal, api: f.api, socketPath: worker.socketPath, workers: [worker], resolveBinding: f.resolve });
  t.after(() => service.close());
  const current = await call(worker, 'POST', '/work/current', { sessionId: 'session' });
  const stage = (key, revision) => call(worker, 'POST', '/work/submit', { executionId: 'current', runId: current.execution.runId, inputRevision: revision, key,
    payload: { candidate: 'tested-dashboard', summary: 'Account costs and Power BI investigated' } });
  await assert.rejects(stage('stale', firstRevision), { code: 'stale_input_revision' });
  f.messages.push({ id: 'second-idle', type: 'idle', outcome: 'succeeded' }); f.idle = true;
  assert.throws(() => c('premature-close', 'task.update', { id: 'old-task', expectedRevision: store.get('task', 'old-task').revision, changes: { status: 'done' } }), { code: 'execution_unsettled' });
  c('cancel-old', 'execution.cancel', { id: 'zz-old', expectedRevision: store.get('execution', 'zz-old').revision, reason: 'Obsolete assignment, successor is REL-285' });
  await f.tick();
  assert.equal(store.get('execution', 'zz-old').state, 'cancelled'); assert.equal(f.sends, 1, 'No old continuation or replay');
  c('close-old', 'task.update', { id: 'old-task', expectedRevision: store.get('task', 'old-task').revision, changes: { status: 'done' } });
  assert.equal(store.get('execution', 'current').state, 'accepted');
  await stage('result', current.inputRevision); await f.tick(); await f.tick();
  const complete = store.get('execution', 'current');
  assert.equal(complete.state, 'completed'); assert.match(complete.result.evidence ?? journal.work('current').observation.messageId, /second-idle/);
  assert.equal(f.sends, 1); assert.equal(store.all('execution').length, 2);
});

test('new human input supersedes an unattempted staged publication, but an uncertain publication remains blocked and is not replayed', async t => {
  for (const attempted of [false, true]) {
    const f = fixture(t); f.request(); await f.tick();
    f.messages.push({ id: 'idle', type: 'idle', outcome: 'succeeded' }); f.idle = true; await f.tick();
    const work = f.journal.work('current'), payload = { id: 'current', expectedRevision: work.execution.revision, candidate: 'old', summary: 'Old result', evidence: 'idle' };
    f.journal.queue({ key: 'publication', action: 'execution.submit', payload }, { inputRevision: work.interaction.revision });
    if (attempted) {
      const item = f.journal.receipt('publication');
      f.journal.db.prepare('UPDATE outbox SET data=? WHERE key=?').run(JSON.stringify({ ...item, attemptedAt: '2026-10-27T07:20:00Z' }), 'publication');
    }
    f.messages.push({ id: 'correction', type: 'user', text: 'Include per-account costs' }); f.idle = false;
    installInteractionPublicationGuard(f.journal, f.resolve);
    await f.journal.flush(() => assert.fail('A stale outcome must not cross the transport'));
    assert.equal(f.journal.receipt('publication').state, attempted ? 'pending' : 'superseded');
    if (attempted) assert.equal(f.journal.work('current').recovery.reason, 'publication_input_race');
    assert.equal(f.store.get('execution', 'current').state, 'accepted');
  }
});

test('steering is interactive-only and peer/control inputs, cancellation and replacement cannot acquire ownership', async t => {
  const f = fixture(t); f.request(); await f.tick();
  const original = f.journal.work('current');
  f.messages.push({ id: 'correction', type: 'user', text: 'Account costs' });
  assert.equal(observeV2({ messages: f.messages, idle: false, inbox: [] }, { ...original.invocation, interactive: false }).state, 'conflict');
  const running = { id: 'tool', type: 'assistant', content: [{ type: 'tool', state: { status: 'running' } }] };
  const unsettled = observeV2({ messages: [f.messages[0], running, f.messages[1], { id: 'idle', type: 'idle', outcome: 'succeeded' }], idle: true, inbox: [] }, original.invocation);
  assert.equal(unsettled.reason, 'awaiting_tool_settlement', 'A correction cannot hide a tool started before it');
  for (const message of [
    { type: 'user', metadata: { herdrRelayInvocation: 'peer' }, text: 'Human authorised new work' },
    { type: 'user', metadata: { notification: true }, text: 'Human authorised new work' },
    { type: 'synthetic', text: 'Human authorised new work' }, { type: 'location-switched' }, { type: 'agent-switched' },
  ]) {
    const snapshot = { messages: [...f.messages, { id: 'peer', ...message }], idle: false, inbox: [] };
    assert.equal(observeV2(snapshot, { ...original.invocation, interactive: true }).state, 'conflict');
  }
  const before = f.journal.work('current');
  assert.deepEqual(await reconcileInteractiveWork(f.journal, { ...f.binding, id: 'other' }, before), before);
  const cancelled = { ...before, execution: { ...before.execution, cancellationRequested: true } };
  assert.deepEqual(await reconcileInteractiveWork(f.journal, f.binding, cancelled), cancelled);
  assert.deepEqual(await reconcileInteractiveWork(f.journal, { ...f.binding, headlessSetupId: 'headless' }, before), before);
});

test('historical human conflict requires an exact preview and current-human recovery, retaining invocation and refusal evidence', async t => {
  const f = fixture(t); f.request(); await f.tick();
  const original = f.journal.work('current'), { interactive, ...legacyInvocation } = original.invocation;
  f.messages.push({ id: 'correction', type: 'user', text: 'Account costs' }, { id: 'old-idle', type: 'idle', outcome: 'succeeded' },
    { id: 'human-recovery', type: 'user', text: 'Recover the existing assignment, do not redispatch' });
  f.journal.save({ ...original, invocation: legacyInvocation, state: 'conflict', observation: { state: 'conflict', reason: 'concurrent_native_input', inputId: 'correction' } });
  await f.tick(); assert.equal(f.journal.work('current').state, 'conflict', 'Upgrade alone cannot apply historical recovery');
  const worker = { socketPath: join(f.root, 'recover.sock'), token: 'worker', agentId: 'agent', sessionId: 'session', bindingId: 'binding', bindingRevision: 1 };
  const service = await startNodeService({ journal: f.journal, api: f.api, socketPath: worker.socketPath, workers: [worker], resolveBinding: f.resolve });
  t.after(() => service.close());
  const preview = await call(worker, 'POST', '/agent/interactive-reconcile-preview', { executionId: 'current' });
  const apply = body => call(worker, 'POST', '/agent/interactive-reconcile-apply', { executionId: 'current', key: 'recover', ...body });
  await assert.rejects(apply({ previewHash: preview.previewHash, sourceMessageId: 'correction' }), { code: 'stale_recovery_preview' });
  await assert.rejects(apply({ previewHash: 'wrong', sourceMessageId: 'human-recovery' }), { code: 'stale_recovery_preview' });
  const receipt = await apply({ previewHash: preview.previewHash, sourceMessageId: 'human-recovery' });
  assert.equal(receipt.promptReplayed, false); assert.equal(receipt.localState, 'observing');
  assert.deepEqual(await apply({ previewHash: preview.previewHash, sourceMessageId: 'human-recovery' }), receipt);
  assert.deepEqual(f.journal.work('current').invocation, legacyInvocation);
  assert.equal(f.journal.work('current').recovery.previousObservation.inputId, 'correction');
  await f.tick(); assert.equal(f.sends, 1); assert.equal(f.store.get('execution', 'current').state, 'accepted');
});

test('attempted publications reconcile actual receipts or a proven revision fence, never replaying a stale effect', async t => {
  for (const committed of [false, true]) {
    const f = fixture(t); f.request(); await f.tick();
    f.messages.push({ id: 'terminal', type: 'idle', outcome: 'succeeded' }); f.idle = true; await f.tick();
    const work = f.journal.work('current'), command = { key: 'uncertain', action: 'execution.submit', payload: {
      id: work.id, expectedRevision: work.execution.revision, candidate: 'previous-input', summary: 'Earlier result', evidence: 'terminal' } };
    f.journal.queue(command, { inputRevision: work.interaction.revision });
    const item = f.journal.receipt(command.key);
    f.journal.db.prepare('UPDATE outbox SET data=? WHERE key=?').run(JSON.stringify({ ...item, attemptedAt: '2026-10-27T07:20:00Z' }), command.key);
    if (committed) await f.api('POST', '/v1/commands', command);
    else f.command('cancel', 'execution.cancel', { id: work.id, expectedRevision: work.execution.revision, reason: 'Stop the original execution' });
    f.messages.push({ id: 'later', type: 'user', text: 'New requirements' }); f.idle = false;
    let posts = 0;
    const api = async (method, ...rest) => { if (method === 'POST') posts++; return f.api(method, ...rest); };
    installInteractionPublicationGuard(f.journal, f.resolve, api); await f.journal.flush(api);
    assert.equal(posts, 0); assert.equal(f.journal.receipt(command.key).state, committed ? 'recorded' : 'superseded');
    assert.equal(f.journal.work(work.id).recovery.state, 'publication_reconciled');
    if (committed) assert.equal(f.journal.receipt(command.key).reconciledWithoutReplay, true);
    else assert.equal(f.journal.receipt(command.key).applied, false);
    assert.throws(() => f.store.commandReceipt(f.owner, command.key, work.id), { code: 'forbidden' });
  }
});

test('receiver replacement and multiple accepted assignments fence new steering rather than guessing ownership', async t => {
  for (const ambiguous of [false, true]) {
    const f = fixture(t); f.request(); await f.tick();
    const work = f.journal.work('current');
    f.messages.push({ id: 'human', type: 'user', text: 'Change the account handling' });
    if (ambiguous) f.journal.save({ id: 'other', bindingId: 'binding', state: 'observing', execution: { id: 'other', state: 'accepted', targetAgentId: 'agent' } });
    else f.journal.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ state: 'active', bindingId: 'replacement', generation: 2 }), 'receiver:agent');
    const next = await reconcileInteractiveWork(f.journal, f.binding, work);
    assert.equal(next.state, 'conflict'); assert.equal(next.observation.reason, ambiguous ? 'ambiguous_execution_ownership' : 'receiver_replaced');
    assert.equal(f.sends, 1);
  }
});

test('answered questions resume the same execution with a fresh run and input revision, keeping earlier steering in history', async t => {
  const f = fixture(t); f.request(); await f.tick();
  f.messages.push({ id: 'human', type: 'user', text: 'Account costs' }, { id: 'terminal', type: 'idle', outcome: 'succeeded' }); f.idle = true;
  await f.tick();
  const work = f.journal.work('current');
  f.journal.save({ ...work, staged: { kind: 'question', key: 'clarify', runId: work.execution.runId, inputRevision: work.interaction.revision,
    payload: { prompt: 'Confirm the account scope', humanRequired: true } } });
  await f.tick(); await f.tick();
  const question = f.store.all('question')[0];
  assert.equal(f.store.get('execution', 'current').state, 'waiting');
  f.command('answer', 'question.answer', { id: question.id, expectedRevision: question.revision, body: 'Use the specified account scope' });
  await f.tick();
  const resumed = f.journal.work('current');
  assert.equal(resumed.execution.id, work.id); assert.notEqual(resumed.execution.runId, work.execution.runId);
  assert.equal(resumed.state, 'observing'); assert.deepEqual(resumed.interaction.inputIds, []);
  assert.equal(resumed.interaction.anchorId, resumed.invocation.messageId);
  assert.ok(resumed.inputHistory.some(entry => entry.runId === work.execution.runId && entry.inputIds.includes('human')));
  assert.equal(f.sends, 2, 'Only the native answered-question continuation is sent, not a fresh assignment');
});

test('a native model change plus human continuation keeps the same assignment and fences stale outcomes', async t => {
  const f = fixture(t);
  f.model = { providerID: 'fixture', id: 'first', variant: 'max' };
  f.request(); await f.tick();
  const original = f.journal.work('current');
  f.messages.push({ id: 'before-switch', type: 'idle', outcome: 'succeeded' }); f.idle = true;
  await f.tick();
  const previous = f.journal.work('current');
  f.journal.save({ ...previous, staged: { kind: 'result', key: 'old-result', runId: previous.execution.runId,
    inputRevision: previous.interaction.revision, payload: { candidate: 'old', summary: 'Before model change' } } });
  f.model = { providerID: 'fixture', id: 'second', variant: 'max' };
  f.messages.push({ id: 'model-switch', type: 'model-switched', time: { created: 1 }, previous: original.invocation.initialModel, model: f.model });
  await f.tick();
  assert.equal(f.journal.work('current').state, 'conflict', 'Selection alone grants no continuation');
  f.messages.push({ id: 'continue', type: 'user', text: 'Continue the same source preparation' }); f.idle = false;
  await f.tick();
  const continued = f.journal.work('current');
  assert.equal(continued.state, 'observing');
  assert.equal(continued.execution.runId, original.execution.runId);
  assert.deepEqual(continued.invocation, original.invocation);
  assert.equal(continued.interaction.modelSelections[0].id, 'model-switch');
  assert.equal(continued.staged, null); assert.equal(continued.supersededOutcomes[0].key, 'old-result');
  assert.equal(continued.recovery.previousObservation.inputId, 'model-switch');
  assert.equal(f.sends, 1); assert.equal(f.store.all('execution').length, 1);
  const worker = { socketPath: join(f.root, 'model.sock'), token: 'worker', agentId: 'agent', sessionId: 'session', bindingId: 'binding', bindingRevision: 1 };
  const service = await startNodeService({ journal: f.journal, api: f.api, socketPath: worker.socketPath, workers: [worker], resolveBinding: f.resolve });
  t.after(() => service.close());
  const current = await call(worker, 'POST', '/work/current', { sessionId: 'session' });
  assert.equal(current.blocked, false);
  await assert.rejects(call(worker, 'POST', '/work/submit', { executionId: 'current', runId: current.execution.runId,
    inputRevision: previous.interaction.revision, key: 'stale', payload: { candidate: 'stale', summary: 'Stale model input' } }), { code: 'stale_input_revision' });
  await call(worker, 'POST', '/work/ask', { executionId: 'current', runId: current.execution.runId,
    inputRevision: current.inputRevision, key: 'review', payload: { prompt: 'Review the new source before effects', humanRequired: true } });
  f.messages.push({ id: 'after-switch', type: 'idle', outcome: 'succeeded' }); f.idle = true;
  await f.tick(); await f.tick();
  assert.equal(f.store.get('execution', 'current').state, 'waiting');
  assert.equal(f.store.all('question').length, 1); assert.equal(f.sends, 1);
});

test('a retained native stream-continuation conflict recovers in place without replay, a new human source or a fabricated result', async t => {
  const f = fixture(t); f.request(); await f.tick();
  const original = f.journal.work('current');
  f.messages.push({ id: 'failed', type: 'assistant', time: { created: 1, completed: 2 }, finish: 'error',
    error: { type: 'provider.unknown', message: 'Fixture interrupted stream' }, content: [] },
  { id: 'continuation', type: 'synthetic', time: { created: 3 },
    text: 'The previous response was interrupted. Continue from where you left off without repeating completed content.' },
  { id: 'terminal', type: 'idle', outcome: 'succeeded' }); f.idle = true;
  f.journal.save({ ...original, state: 'conflict', observation: {
    state: 'conflict', reason: 'concurrent_native_input', inputId: 'continuation', inputType: 'synthetic' } });
  await f.tick();
  const recovered = f.journal.work('current');
  assert.equal(recovered.state, 'native_finished'); assert.equal(recovered.observation.messageId, 'terminal');
  assert.deepEqual(recovered.invocation, original.invocation);
  assert.deepEqual(recovered.interaction.inputIds, []); assert.equal(recovered.interaction.anchorId, original.invocation.messageId);
  assert.equal(recovered.recovery.previousObservation.inputId, 'continuation');
  assert.equal(recovered.execution.runId, original.execution.runId); assert.equal(recovered.staged, original.staged);
  assert.equal(f.store.get('execution', 'current').state, 'accepted'); assert.equal(f.sends, 1);
});

test('retained model-switch conflicts need exact current-human recovery, not an upgrade or a peer notice', async t => {
  const f = fixture(t);
  f.model = { providerID: 'fixture', id: 'first' };
  f.request(); await f.tick();
  const original = f.journal.work('current'), { interactiveModelSelection, initialModel, ...legacy } = original.invocation;
  f.messages.push({ id: 'old-assistant', type: 'assistant', model: f.model, content: [] });
  f.model = { providerID: 'fixture', id: 'second' };
  f.messages.push({ id: 'model-switch', type: 'model-switched', time: { created: 1 }, previous: initialModel, model: f.model },
    { id: 'human-recovery', type: 'user', text: 'Recover this model change and continue the existing assignment' });
  f.journal.save({ ...original, invocation: legacy, interaction: undefined, state: 'conflict', observation: {
    state: 'conflict', reason: 'concurrent_native_input', inputId: 'model-switch', inputType: 'model-switched' } });
  await f.tick(); assert.equal(f.journal.work('current').state, 'conflict');
  const worker = { socketPath: join(f.root, 'recover-model.sock'), token: 'worker', agentId: 'agent', sessionId: 'session', bindingId: 'binding', bindingRevision: 1 };
  const service = await startNodeService({ journal: f.journal, api: f.api, socketPath: worker.socketPath, workers: [worker], resolveBinding: f.resolve });
  t.after(() => service.close());
  const preview = await call(worker, 'POST', '/agent/interactive-reconcile-preview', { executionId: 'current' });
  assert.equal(preview.observation.interaction.modelSelections[0].id, 'model-switch');
  const apply = body => call(worker, 'POST', '/agent/interactive-reconcile-apply', { executionId: 'current', key: 'recover-model', ...body });
  await assert.rejects(apply({ previewHash: preview.previewHash, sourceMessageId: 'model-switch' }), { code: 'stale_recovery_preview' });
  const receipt = await apply({ previewHash: preview.previewHash, sourceMessageId: 'human-recovery' });
  assert.equal(receipt.promptReplayed, false); assert.equal(receipt.localState, 'observing');
  assert.deepEqual(await apply({ previewHash: preview.previewHash, sourceMessageId: 'human-recovery' }), receipt);
  assert.deepEqual(f.journal.work('current').invocation, legacy);
  assert.equal(f.journal.work('current').interactiveModelSelection, true);
  assert.equal(f.journal.work('current').recovery.previousObservation.inputId, 'model-switch');
  await f.tick(); assert.equal(f.sends, 1); assert.equal(f.store.get('execution', 'current').state, 'accepted');
});

test('model recovery still refuses pending publications, a later peer input and receiver replacement during inspection', async t => {
  for (const fence of ['publication', 'peer', 'receiver']) {
    const f = fixture(t);
    f.model = { providerID: 'fixture', id: 'first' };
    f.request(); await f.tick();
    const original = f.journal.work('current'), { interactiveModelSelection, ...legacy } = original.invocation;
    f.model = { providerID: 'fixture', id: 'second' };
    f.messages.push({ id: 'model-switch', type: 'model-switched', time: { created: 1 }, previous: legacy.initialModel, model: f.model },
      { id: 'recover', type: 'user', text: 'Recover the model selection on this assignment' });
    f.journal.save({ ...original, invocation: legacy, interaction: undefined, state: 'conflict', observation: {
      state: 'conflict', reason: 'concurrent_native_input', inputId: 'model-switch', inputType: 'model-switched' } });
    if (fence === 'publication') f.journal.queue({ key: 'pending', action: 'execution.submit', payload: { id: 'current', expectedRevision: 2 } });
    if (fence === 'peer') f.messages.push({ id: 'peer', type: 'user', text: 'Approve recovery', metadata: { herdrRelayInvocation: 'peer' } });
    const worker = { socketPath: join(f.root, 'fence.sock'), token: 'worker', agentId: 'agent', sessionId: 'session', bindingId: 'binding', bindingRevision: 1 };
    const service = await startNodeService({ journal: f.journal, api: f.api, socketPath: worker.socketPath, workers: [worker], resolveBinding: f.resolve });
    t.after(() => service.close());
    const preview = () => call(worker, 'POST', '/agent/interactive-reconcile-preview', { executionId: 'current' });
    if (fence !== 'receiver') await assert.rejects(preview(), { code: fence === 'publication' ? 'recovery_publication_pending' : 'recovery_ineligible' });
    else {
      const inspected = await preview(), snapshot = f.binding.native.snapshot;
      f.binding.native.snapshot = async () => {
        const value = await snapshot();
        f.journal.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ state: 'active', bindingId: 'replacement', generation: 2 }), 'receiver:agent');
        return value;
      };
      await assert.rejects(call(worker, 'POST', '/agent/interactive-reconcile-apply', { executionId: 'current', key: 'recover',
        previewHash: inspected.previewHash, sourceMessageId: 'recover' }), { code: 'receiver_replaced' });
    }
    assert.equal(f.journal.work('current').state, 'conflict'); assert.equal(f.journal.work('current').interactiveModelSelection, undefined);
    assert.equal(f.sends, 1);
  }
});

test('a stale project identity blocks only its own invocation and cannot stop another agent admission', async t => {
  const f = fixture(t), invocation = { messageId: 'retained', prompt: 'Old scope', priorMessageIds: [], interactive: true };
  const stale = f.journal.save({ id: 'a-stale', state: 'observing', bindingId: 'old-binding', nativeConversationId: 'old-session', invocation,
    execution: { id: 'a-stale', state: 'accepted', targetNodeId: 'node', targetAgentId: 'old-agent', runId: 'retained-run' } });
  const resolve = f.resolve;
  f.resolve = async agentId => agentId === 'old-agent' ? { id: 'old-binding', agentId, interactive: true, identity: { sessionId: 'old-session' },
    native: { snapshot: async () => { throw Object.assign(Error('Changed project'), { code: 'native_project_identity_changed' }); } } } : resolve(agentId);
  f.request(); await f.tick();
  const retained = f.journal.work('a-stale');
  assert.equal(retained.recovery.reason, 'native_project_identity_changed');
  assert.deepEqual(retained.invocation, stale.invocation); assert.equal(retained.state, 'observing');
  assert.equal(f.journal.work('current').execution.state, 'accepted'); assert.equal(f.sends, 1);
});

test('standing monitors and headless bindings never acquire interactive model acknowledgement or recovery', async t => {
  for (const kind of ['monitor', 'headless']) {
    const f = fixture(t);
    f.model = { providerID: 'fixture', id: 'first' };
    if (kind === 'headless') f.binding.headlessSetupId = 'setup';
    f.request(kind === 'monitor' ? { monitor: { startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 60000).toISOString(), intervalSec: 10 } } : {});
    await f.tick();
    const original = f.journal.work('current');
    assert.equal(original.invocation.interactive, undefined);
    assert.equal(original.invocation.interactiveModelSelection, undefined);
    f.model = { providerID: 'fixture', id: 'second' };
    f.messages.push({ id: 'model-switch', type: 'model-switched', time: { created: 1 }, model: f.model },
      { id: 'human', type: 'user', text: 'Continue' }, { id: 'terminal', type: 'idle', outcome: 'succeeded' });
    f.idle = true; await f.tick();
    const blocked = f.journal.work('current');
    assert.equal(blocked.state, 'conflict'); assert.equal(f.sends, 1);
    await assert.rejects(previewInteractiveRecovery(f.journal, f.binding, blocked), { code: 'recovery_ineligible' });
  }
});
