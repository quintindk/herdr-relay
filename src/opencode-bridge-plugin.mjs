import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { call } from './client.mjs';

// Loaded by OpenCode, with a binding-scoped credential. Never uses Relay admin auth.
export default async function relayBridge({ client, directory }, options = {}) {
  if (!options.configFile) return {};
  const config = JSON.parse(readFileSync(options.configFile, 'utf8'));
  if (directory !== config.directory || process.env.HERDR_ENV !== '1') return {};
  const epoch = randomUUID();
  let stopped = false, active, started = false, pinnedCreation, invocation, conflict = false;
  const sdkOptions = () => ({ query: { directory }, signal: AbortSignal.timeout(5000), throwOnError: true });
  const ownPane = async () => {
    const { stdout } = await promisify(execFile)('herdr', ['agent', 'list'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const agents = JSON.parse(stdout).result?.agents;
    if (!Array.isArray(agents)) throw new Error('Invalid Herdr inventory');
    const matches = agents.filter(agent => agent.agent_session?.value === config.conversationId);
    const pane = matches[0];
    if (matches.length !== 1 || pane.agent !== 'opencode' || pane.agent_session.kind !== 'id' ||
      pane.terminal_id !== config.terminalId || pane.pane_id !== process.env.HERDR_PANE_ID || pane.cwd !== directory) throw new Error('Bridge placement changed');
  };
  const snapshot = async () => {
    await ownPane();
    const session = (await client.session.get({ ...sdkOptions(), path: { id: config.conversationId } })).data;
    if (session?.id !== config.conversationId || session.directory !== directory || session.time?.archived || session.revert ||
      !session.time?.created || (pinnedCreation && pinnedCreation !== session.time.created)) throw new Error('Native identity changed');
    pinnedCreation = session.time.created;
    const messages = (await client.session.messages({ ...sdkOptions(), path: { id: config.conversationId } })).data;
    const statuses = (await client.session.status(sdkOptions())).data;
    if (!Array.isArray(messages) || !statuses || messages.some(m => m.info.sessionID !== config.conversationId)) throw new Error('Native snapshot unavailable');
    return { session, messages, idle: !statuses[config.conversationId] || statuses[config.conversationId].type === 'idle' };
  };
  const rpc = (action, snap, fields = {}) => call(config, 'POST', `/bridge/${action}`, {
    epoch, conversationId: config.conversationId, terminalId: config.terminalId,
    sessionCreatedAt: snap.session.time.created, idle: snap.idle, ...fields,
  });
  const tick = () => {
    if (stopped || active) return;
    active = (async () => {
      let snap = await snapshot();
      const response = await rpc('poll', snap);
      let run = response.run;
      if (!run) { invocation = null; conflict = false; return; }
      if (response.state !== 'armed') return;
      if (!run.invocation) {
        if (!snap.idle || run.cancellationRequested) return;
        const latest = [...snap.messages].reverse().find(message => message.info.role === 'user')?.info;
        const model = snap.session.model ? { providerID: snap.session.model.providerID, modelID: snap.session.model.id } : latest?.model;
        const agent = snap.session.agent ?? latest?.agent;
        if (!model?.providerID || !model?.modelID || !agent) return;
        // A second read narrows the idle/send race but is not an atomic reservation.
        const next = await snapshot();
        if (!next.idle || JSON.stringify(next.messages.map(m => m.info.id)) !== JSON.stringify(snap.messages.map(m => m.info.id))) return;
        snap = next;
        const begun = await rpc('begin', snap, { runId: run.id,
          priorUserIds: snap.messages.filter(m => m.info.role === 'user').map(m => m.info.id) });
        run = begun.run;
        invocation = run.invocation;
        if (begun.dispatch && invocation) {
          await client.session.promptAsync({ ...sdkOptions(), path: { id: config.conversationId }, body: {
            messageID: invocation.messageId, agent, model,
            ...(snap.session.model?.variant || latest?.variant ? { variant: snap.session.model?.variant ?? latest.variant } : {}),
            parts: [{ type: 'text', text: invocation.prompt }],
          } });
        }
      }
      invocation = run.invocation;
      if (!invocation) return;
      snap = await snapshot();
      // Keep exact prompt/tool/parent evidence, without exporting unrelated content.
      const messages = snap.messages.filter(message => message.info.role === 'user' || message.info.parentID === invocation.messageId)
        .map(message => ({ info: { id: message.info.id, sessionID: message.info.sessionID,
        role: message.info.role, parentID: message.info.parentID, time: message.info.time, summary: message.info.summary,
        finish: message.info.finish, ...(message.info.error ? { error: { name: message.info.error.name } } : {}) },
        parts: message.info.id === invocation.messageId || message.info.parentID === invocation.messageId
          ? message.parts.filter(part => part.type === 'text' || part.type === 'tool').map(part => part.type === 'text'
            ? { type: part.type, text: message.info.id === invocation.messageId ? part.text : '', synthetic: part.synthetic }
            : { type: 'tool', state: { status: part.state?.status }, metadata: { providerExecuted: part.metadata?.providerExecuted } }) : [],
      }));
      await rpc('observe', snap, { runId: run.id, conflict, snapshot: { idle: snap.idle, messages } });
    })().catch(() => { /* Lost replies leave persisted intent. The next tick only observes. */ })
      .finally(() => { active = null; });
  };
  let timer;
  return {
    async config() { if (!started) { started = true; timer = setInterval(tick, 1000); timer.unref(); tick(); } },
    async 'chat.message'(input, output) {
      if (input.sessionID === config.conversationId && invocation && (input.messageID ?? output.message.id) !== invocation.messageId) conflict = true;
    },
    async dispose() { stopped = true; clearInterval(timer); await active; },
  };
}
