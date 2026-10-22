import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RelaySpike } from './rpc.mjs';
import { createRoot, createEffect } from 'solid-js';

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL('../../scripts/plugin-launch.sh', import.meta.url));
export const runEnrolmentCli = async args => {
  try {
    const result = await execute('bash', [launcher, 'native', ...args], { timeout: 30000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
  } catch (error) {
    let refusal;
    try { refusal = JSON.parse(error.stderr.trim()); } catch {}
    throw Object.assign(new Error(refusal?.message ?? 'Relay CLI failed. Check the local node and retry the saved operation.'),
      { code: refusal?.code ?? 'cli_failed' });
  }
};

export function autoAttachmentCandidate({ created, selected, previous, enrolments }) {
  if (!created || created.parentID || created.sessionID !== selected || !previous || selected === previous) return null;
  const candidates = enrolments.filter(e => e.autoAttach && e.directory === created.location?.directory &&
    e.receiver?.state === 'active' && e.receiver.conversationId === previous);
  return candidates.length === 1 ? candidates[0] : null;
}

// Human-only terminal commands. The owner credential stays in the local CLI.
// No RPC method or model tool can enrol an agent or claim a receiving chat.
export function registerEnrolmentCommands(ctx, { selectedSession, record = () => {}, runCli = runEnrolmentCli,
  interval = setInterval, clear = clearInterval, observeSelection }) {
  if (!ctx.options.ownerContextFile) return () => {};
  const configFile = ctx.options.nativeNodeConfigFile ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-relay-native/node.json');
  const common = ['--context', ctx.options.ownerContextFile, '--config', configFile];
  const [outbox, updateOutbox] = ctx.storage.store('enrolment-outbox', { initial: { pending: null } });
  let closed = false, busy = false, generation = 0;
  let previous = selectedSession(), enrolments = [], continuity = null;
  const created = new Map();
  const manualSessions = new Set();
  const loadedAt = Date.now();
  const captureOrigin = session => {
    const own = enrolments.find(e => e.receiver?.state === 'active' && e.receiver.conversationId === session);
    if (own) continuity = { previous: session, enrolments: structuredClone(enrolments) };
    return own;
  };
  const track = selected => {
    if (selected !== previous) {
      generation++; previous = selected;
      if (!captureOrigin(selected) && selected) {
        // New-chat navigation passes through Home before the first prompt
        // creates its session. Keep the old receiver across that empty route,
        // but never carry it across a switch to an existing chat or a fork.
        const invalidateOldSelection = session => {
          if (closed || selected !== selectedSession()) return;
          if (session.parentID || session.time?.created < loadedAt) { continuity = null; created.clear(); }
        };
        const session = ctx.data.session?.get(selected);
        if (session) invalidateOldSelection(session);
        else void ctx.client.session.get({ sessionID: selected }).then(invalidateOldSelection).catch(() => { continuity = null; created.clear(); });
      }
    }
  };
  const stopSelection = observeSelection ? observeSelection(track) : createRoot(dispose => {
    createEffect(() => track(selectedSession()));
    return dispose;
  });
  const location = ctx.location ?? ctx.data.location.default();
  const toast = (message, variant = 'info') => ctx.ui.toast.show({ message, variant, sessionID: selectedSession() });
  const runtimeGeneration = async () => (await ctx.client.rpc(RelaySpike).inspect({}, { location })).generation;
  const check = origin => {
    if (closed || origin.session !== selectedSession() || origin.generation !== generation) throw new Error('Relay attachment context changed');
  };
  const refresh = async () => {
    enrolments = await runCli(['agent', 'enrolments', ...common, '--directory', location.directory]);
    captureOrigin(selectedSession());
  };
  const openLandingSession = async origin => {
    let input = outbox.sessionCreation ? JSON.parse(JSON.stringify(outbox.sessionCreation)) : null;
    if (!input) {
      const selectedModel = ctx.ui.model?.current();
      const id = `ses_${randomUUID().replaceAll('-', '').slice(0, 26)}`;
      input = { id, location: { directory: location.directory }, metadata: { relayLandingSession: id },
        ...(selectedModel ? { model: { providerID: selectedModel.providerID, id: selectedModel.modelID,
          ...(selectedModel.variant ? { variant: selectedModel.variant } : {}) } } : {}) };
      await updateOutbox(draft => { draft.sessionCreation = input; });
    }
    check(origin);
    if (input.location.directory !== location.directory) throw new Error('Pending session creation belongs to another workspace');
    // Explicit slash-command creation must not also trigger automatic attachment,
    // including when its creation event arrives after a dismissed confirmation.
    manualSessions.add(input.id);
    let session;
    try { session = await ctx.client.session.get({ sessionID: input.id }); }
    catch (error) { if (error.status !== 404 && !['NotFoundError', 'SessionNotFoundError'].includes(error.name)) throw error; }
    check(origin);
    if (!session) session = await ctx.client.session.create(structuredClone(input));
    check(origin);
    if (session.id !== input.id || session.location?.directory !== location.directory || session.parentID || session.time?.archived ||
      session.metadata?.relayLandingSession !== input.id) throw new Error('Created session does not match the original landing-screen request');
    if (origin.runtime !== await runtimeGeneration()) throw new Error('Relay reloaded during session creation');
    check(origin);
    ctx.ui.router.navigate({ type: 'session', sessionID: session.id });
    track(selectedSession());
    if (selectedSession() !== session.id) throw new Error('Open the created session before continuing Relay attachment');
    origin.session = session.id; origin.generation = generation;
    await updateOutbox(draft => { if (draft.sessionCreation?.id === input.id) draft.sessionCreation = null; });
    check(origin);
    record({ type: 'landing_session_created', sessionId: session.id });
    return session;
  };
  const publish = async pending => {
    const result = await runCli(pending.args);
    // Reuse a healthy node, or install/start it. Never restart OpenCode.
    await runCli(['node', 'ensure', '--config', result.configFile, '--session', result.sessionId]);
    await updateOutbox(draft => { if (draft.pending?.key === pending.key) draft.pending = null; });
    await refresh();
    const enrolment = enrolments.find(e => e.id === result.agentId);
    toast(result.sessionId === selectedSession() ?
      `Attached to ${enrolment?.name ?? result.agentId}. Future work and cron firings route here. ${enrolment?.installedSchedules ?? 0} installed schedules, ${enrolment?.obligations.length ?? 0} outstanding obligations.` :
      `Confirmed the previous attachment to ${result.sessionId}. The current chat was not attached.`, 'success');
    record({ type: 'receiver_attached', sessionId: result.sessionId, agentId: result.agentId, generation: result.generation });
  };
  const run = async (kind, automatic) => {
    if (closed || busy || automatic && !selectedSession()) return;
    busy = true;
    const origin = { session: selectedSession(), generation };
    try {
      origin.runtime = await runtimeGeneration();
      check(origin);
      if (outbox.pending) {
        if (automatic) return;
        if (!await ctx.ui.dialog.confirm({ title: 'Reconcile confirmed Relay attachment', message: 'Retry the previously confirmed operation with its original key. This does not claim another chat.' })) return;
        check(origin);
        await publish(JSON.parse(JSON.stringify(outbox.pending))); return;
      }
      await refresh(); check(origin);
      if (kind === 'attach' && !enrolments.length) { toast('No standing enrolment for this workspace. Use /relay-enrol first.'); return; }
      const session = origin.session ? await ctx.client.session.get({ sessionID: origin.session }) : await openLandingSession(origin);
      check(origin);
      if (session.parentID || session.location?.directory !== location.directory) throw new Error('Attach from a root chat in this exact workspace');
      let enrolment = automatic;
      let name;
      if (kind === 'enrol') {
        record({ type: 'enrolment_name', sessionId: origin.session });
        name = await ctx.ui.dialog.prompt({ title: 'Enrol durable Relay agent', description: `Workspace: ${session.location.directory}. Choose its stable agent name.` });
        check(origin);
        if (!name?.trim()) return;
        name = name.trim();
        const existing = enrolments.find(e => e.name === name);
        if (existing) { enrolment = existing; kind = 'attach'; }
      } else if (!enrolment) {
        if (!enrolments.length) { toast('No standing enrolment for this workspace. Use /relay-enrol first.'); return; }
        const id = enrolments.length === 1 ? enrolments[0].id : await ctx.ui.dialog.select({ title: 'Attach to Relay enrolment',
          options: enrolments.map(e => ({ value: e.id, title: e.name, description: `Receiving chat: ${e.receiver?.conversationId ?? 'none'}` })) });
        check(origin);
        if (!id) return;
        enrolment = enrolments.find(e => e.id === id);
      }
      if (automatic) {
        const current = enrolments.find(e => e.id === automatic.id);
        if (current?.receiver?.generation !== automatic.receiver.generation || current.receiver.conversationId !== automatic.receiver.conversationId) throw new Error('Automatic attachment lost its original receiver claim');
      } else {
        record({ type: 'enrolment_confirm', sessionId: origin.session });
        const confirmed = await ctx.ui.dialog.confirm({ title: kind === 'enrol' ? 'Enrol and attach Relay agent' : 'Replace receiving conversation',
          message: `Agent: ${name ?? enrolment.name}\nMachine: ${hostname()}\nWorkspace: ${session.location.directory}\nReceiving here: ${session.id}\nPrevious receiver: ${enrolment?.receiver?.conversationId ?? 'none'}\n\nStanding grant: attach replacement chats and manage this agent's persistent schedules. New admissions move here. Existing attempts remain pinned and review rights are not transferred.` });
        check(origin);
        if (!confirmed) return;
      }
      if (origin.runtime !== await runtimeGeneration()) throw new Error('Relay reloaded during attachment confirmation');
      check(origin);
      const key = randomUUID();
      const args = ['agent', kind, ...common, '--session', session.id, '--directory', session.location.directory, '--key', key,
        ...(ctx.options.nativeServiceRegistration ? ['--service-registration', ctx.options.nativeServiceRegistration] : []),
        ...(kind === 'enrol' ? ['--reserved', '--name', name, '--transport', 'tools'] : ['--agent', enrolment.id, '--generation', String(enrolment.receiver?.generation ?? 0)])];
      const pending = { key, args };
      await updateOutbox(draft => { draft.pending = pending; });
      await publish(pending);
    } catch (error) {
      if (['attachment_refused', 'attachment_superseded', 'stale_binding', 'native_session_reserved'].includes(error.code)) {
        await updateOutbox(draft => { draft.pending = null; });
      }
      // execFile's default error includes its argv. Never show the context file,
      // stack, child stdout or credentials in a toast or retained evidence.
      toast(outbox.pending ? 'Relay attachment needs reconciliation. Retry the command with its saved operation.' : error.message, 'error');
      record({ type: 'attachment_refused', reason: error.code ?? 'attachment_failed', sessionId: origin.session });
    } finally { busy = false; }
  };
  const stopConnection = ctx.data.on('server.connected', () => { generation++; created.clear(); continuity = null; });
  const stopCreated = ctx.data.on('session.created', event => {
    if (manualSessions.has(event.data.sessionID)) return;
    if (event.data.parentID || event.data.location?.directory !== location.directory || !continuity || event.created < loadedAt) return;
    created.set(event.data.sessionID, { session: event.data, ...structuredClone(continuity) });
    if (created.size > 32) created.delete(created.keys().next().value);
  });
  // Selection is local to this TUI. A broadcast session.created event alone does
  // not claim anything. Existing-chat switches, forks and reloads never attach.
  const timer = interval(() => {
    if (closed) return;
    const selected = selectedSession();
    track(selected);
    if (busy) return;
    const fresh = created.get(selected);
    if (!fresh || !continuity) return;
    created.delete(selected);
    const candidate = autoAttachmentCandidate({ created: fresh.session, selected, previous: fresh.previous, enrolments: fresh.enrolments });
    if (candidate) void run('attach', candidate);
  }, 500);
  timer.unref?.();
  void refresh().then(() => {
    if (closed || !enrolments.length || !selectedSession()) return;
    const attached = enrolments.find(e => e.receiver?.conversationId === selectedSession());
    toast(attached ? `${attached.name}: receiving here. ${attached.installedSchedules} installed schedules.` :
      'This chat is not a designated Relay receiver. Use /relay-attach.');
  }).catch(() => {});
  ctx.keymap.layer(() => ({ mode: 'global', commands: [
    { id: 'herdr.relay.enrol', title: 'Relay: enrol durable agent', palette: true, slash: { name: 'relay-enrol' }, run: () => run('enrol') },
    { id: 'herdr.relay.attach', title: 'Relay: attach this chat', palette: true, slash: { name: 'relay-attach' }, run: () => run('attach') },
  ] }));
  return () => { closed = true; generation++; clear(timer); stopCreated(); stopConnection(); stopSelection(); };
}
