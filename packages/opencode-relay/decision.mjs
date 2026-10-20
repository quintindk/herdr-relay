import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Client-local confirmation prototype. The caller must authenticate the client
// channel and persist intent/receipt before this can authorise backend writes.
export function decisionPresenter({ selectedSession, readSource, confirm, clientId, now = Date.now }) {
  let generation = 0;
  let disposed = false;
  let pending = false;
  const invalidate = () => { generation++; };
  return {
    invalidate,
    dispose() { disposed = true; invalidate(); },
    async present(proposal) {
      if (disposed) fail('decision_presenter_disposed');
      if (pending) fail('decision_already_pending');
      const keys = ['requestId', 'sessionId', 'sourceMessageId', 'action', 'targetId', 'revision', 'details'];
      if (!proposal || Object.keys(proposal).some(key => !keys.includes(key)) ||
        keys.some(key => typeof proposal[key] !== 'string' || !proposal[key].trim() || proposal[key].length > 16000)) fail('invalid_decision_proposal');
      const request = Object.freeze(structuredClone(proposal));
      const epoch = generation;
      const check = () => {
        if (disposed || generation !== epoch || selectedSession() !== request.sessionId) fail('stale_decision_context');
      };
      const source = value => {
        if (!value || value.id !== request.sourceMessageId || value.type !== 'user' ||
          typeof value.text !== 'string' || !value.text.trim() || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0 ||
          value.synthetic || value.notification || value.worker) fail('invalid_decision_source');
        return digest({ id: value.id, text: value.text, createdAt: value.createdAt });
      };
      pending = true;
      try {
        check();
        const before = source(await readSource(request.sessionId));
        check();
        const answer = await confirm({ title: `Relay: ${request.action}`, message:
          `Target: ${request.targetId}\nRevision: ${request.revision}\n\n${request.details}` });
        check();
        if (source(await readSource(request.sessionId)) !== before) fail('decision_source_changed');
        check();
        return Object.freeze({ requestId: request.requestId, clientId, sessionId: request.sessionId,
          sourceMessageId: request.sourceMessageId, sourceDigest: before, proposalDigest: digest(request),
          decision: answer === true ? 'confirmed' : answer === false ? 'declined' : 'dismissed',
          recordedAt: now(), authority: 'unverified_client_local' });
      } finally { pending = false; }
    },
  };
}
