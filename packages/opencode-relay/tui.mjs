import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Plugin } from '@opencode/plugin/tui';
import { RelaySpike } from './rpc.mjs';
import { decisionPresenter } from './decision.mjs';
import { registerHumanInbox } from './human-inbox.mjs';
import { registerEnrolmentCommands } from './enrolment-commands.mjs';

export default Plugin.define({
  id: 'herdr.relay.spike.tui',
  async setup(ctx) {
    const clientId = randomUUID();
    const rpc = ctx.client.rpc(RelaySpike);
    const location = ctx.location ?? ctx.data.location.default();
    let closed = false;
    // Opt-in disposable smoke evidence. Never includes prompts or credentials.
    const record = event => {
      if (ctx.options.evidenceFile) appendFileSync(ctx.options.evidenceFile,
        `${JSON.stringify({ ...event, clientId })}\n`, { mode: 0o600 });
    };
    const sessionId = () => {
      const route = ctx.ui.router.current();
      return route.type === 'session' ? route.sessionID : null;
    };
    const stopHumanInbox = registerHumanInbox(ctx, { clientId, selectedSession: sessionId, record });
    const stopEnrolment = registerEnrolmentCommands(ctx, { selectedSession: sessionId, record });
    const decisions = decisionPresenter({ clientId, selectedSession: sessionId,
      readSource: async sessionID => {
        const page = await ctx.client.message.list({ sessionID, order: 'desc', type: 'user', limit: 1 });
        const message = page.data[0];
        // User role is not proof of a human. The result remains explicitly
        // unverified until native invocation provenance is integrated.
        return message && { id: message.id, type: message.type, text: message.text,
          createdAt: message.time.created, synthetic: message.metadata?.synthetic === true };
      },
      confirm: async options => {
        record({ type: 'decision_displayed', sessionId: sessionId() });
        return ctx.ui.dialog.confirm(options);
      },
    });
    const stop = rpc.events.on('notification', event => {
      if (closed || event.data.clientId !== clientId || event.data.sessionId !== sessionId() ||
        event.location?.directory !== location.directory) return;
      ctx.ui.toast.show({ message: event.data.message, variant: 'success', sessionID: event.data.sessionId });
      record({ type: 'notification', sessionId: event.data.sessionId });
    });
    ctx.keymap.layer(() => ({
      mode: 'global',
      commands: [{
        id: 'herdr.relay.spike.status', title: 'Relay v2 compatibility status', palette: true,
        slash: { name: 'relay-spike' },
        async run() {
          const selected = sessionId();
          if (!selected || closed) return;
          const status = await rpc.inspect({}, { location });
          if (closed || sessionId() !== selected) return;
          record({ type: 'rpc', sessionId: selected, version: status.version });
          await rpc.notify({ clientId, sessionId: selected, message: `Relay spike: OpenCode ${status.version}` }, { location });
        },
      }, {
        id: 'herdr.relay.spike.confirm', title: 'Relay v2 diagnostic confirmation', palette: true,
        slash: { name: 'relay-spike-confirm' },
        async run() {
          const selected = sessionId();
          if (!selected || closed) return;
          const page = await ctx.client.message.list({ sessionID: selected, order: 'desc', type: 'user', limit: 1 });
          if (closed || sessionId() !== selected || !page.data[0]) return;
          try {
            const receipt = await decisions.present({ requestId: randomUUID(), sessionId: selected,
              sourceMessageId: page.data[0].id, action: 'diagnostic confirmation', targetId: 'spike-only',
              revision: '1', details: 'Confirm the disposable UI probe. This does not authorise or change any task.' });
            record({ type: 'decision', sessionId: selected, decision: receipt.decision,
              authority: receipt.authority, proposalDigest: receipt.proposalDigest });
          } catch (error) {
            record({ type: 'decision_refused', sessionId: selected, reason: error.code ?? 'decision_failed' });
          }
        },
      }],
    }));
    record({ type: 'loaded', sessionId: sessionId(), enrolmentCommandsVersion: 3 });
    return () => {
      if (closed) return;
      closed = true;
      decisions.dispose();
      stopHumanInbox();
      stopEnrolment();
      stop();
      record({ type: 'disposed' });
    };
  },
});
