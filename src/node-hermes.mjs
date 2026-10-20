import { Hermes, observeHermes, hermesConfig } from './hermes.mjs';

// Reuse the verified Hermes transport and terminal correlation rather than
// translating backend identities into invented Paperclip agents.
export function hermesNodeBinding(entry) {
  const native = new Hermes({ conversationId: entry.conversationId, hermes: hermesConfig(entry.hermes) });
  return {
    id: entry.id,
    conversationId: entry.conversationId,
    native: {
      async snapshot() {
        const raw = await native.snapshot();
        return { idle: raw.idle, inbox: [], messages: raw.session.messages.map(message => ({ id: String(message.row_id) })), raw };
      },
      send: invocation => native.send(invocation),
    },
    prepareInvocation: snapshot => ({ priorUserIds: snapshot.raw.session.messages.filter(message => message.role === 'user').map(message => message.row_id),
      eventCursor: snapshot.raw.events.latest_seq }),
    observe(snapshot, invocation) {
      const result = observeHermes(snapshot.raw, invocation);
      return result.state === 'finished' ? { ...result, outcome: result.error === 'interrupted' ? 'interrupted' : result.error ? 'failed' : 'succeeded' } : result;
    },
  };
}
