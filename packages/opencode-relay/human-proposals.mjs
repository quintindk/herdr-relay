import { createHash } from 'node:crypto';
import { Rpc } from '@opencode/plugin/rpc';
import { readFileSync } from 'node:fs';
import { humanInput } from './native-input.mjs';

export const proposalDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const HumanProposals = Rpc.define({
  id: 'herdr.relay.human.proposals', methods: {
    list: { input: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false },
      output: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } }, required: ['items'], additionalProperties: false } },
  }, events: {},
});

export function humanSource(message) {
  if (!humanInput(message)) throw new Error('Current human-source message required');
  return { id: message.id, text: message.text, createdAt: message.time.created };
}

export async function registerHumanProposals(ctx) {
  const transform = await ctx.tool.transform(editor => {
    for (const kind of ['answer', 'review']) editor.add({
      name: kind === 'answer' ? 'relay_answer' : 'relay_review', options: { codemode: false },
      description: kind === 'answer' ? 'Propose an answer grounded in the current human message. The human confirms it in /relay-decisions before publication.' :
        'Propose the current human candidate decision. The human confirms it in /relay-decisions. Never approves automatically.',
      input: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, expectedRevision: { type: 'integer', minimum: 1 },
        ...(kind === 'answer' ? { body: { type: 'string', minLength: 1, maxLength: 4000 } } : {
          candidate: { type: 'string', minLength: 1 }, decision: { enum: ['accept', 'reject'] }, reason: { type: 'string', minLength: 1, maxLength: 4000 },
        }) }, required: ['id', 'expectedRevision', ...(kind === 'answer' ? ['body'] : ['candidate', 'decision', 'reason'])], additionalProperties: false },
      async execute(input, context) {
        if (Object.keys(input).some(key => !['id', 'expectedRevision', ...(kind === 'answer' ? ['body'] : ['candidate', 'decision', 'reason'])].includes(key))) {
          throw new Error('Unexpected human proposal fields');
        }
        if (ctx.options.workerContextFile) {
          const connection = JSON.parse(readFileSync(ctx.options.workerContextFile, 'utf8'));
          if (connection.sessionId === context.sessionID) throw new Error('Worker-enrolled conversations cannot propose human decisions');
        }
        const page = await ctx.session.get({ sessionID: context.sessionID });
        if (page.location.directory !== ctx.location.directory) throw new Error('Source location changed');
        const messages = await ctx.session.context({ sessionID: context.sessionID });
        const source = humanSource(messages.findLast(message => message.type === 'user'));
        if (source.text.length > 16000) throw new Error('Human proposal source exceeds evidence bound');
        const proposal = { kind, sessionId: context.sessionID, location: ctx.location.directory, source,
          payload: input, authority: 'proposal_only' };
        const id = proposalDigest(proposal);
        // This is explicitly unprivileged model output. Only a later local human
        // keyboard action with an owner context can publish the exact decision.
        await ctx.storage.set(`human-proposal:${context.sessionID}:${id}`, { ...proposal, id });
        return { content: JSON.stringify({ state: 'proposed', id, instruction: 'Human must inspect /relay-decisions. No backend mutation has occurred.' }) };
      },
    });
  });
  let rpc;
  try {
    rpc = await ctx.rpc.register(HumanProposals, { list: async ({ sessionId }) => {
      const items = [];
      let after;
      do {
        const result = await ctx.storage.scan({ prefix: `human-proposal:${sessionId}:`, limit: 100, ...(after ? { after } : {}) });
        items.push(...result.entries.map(entry => entry.value));
        if (items.length > 1000 || result.next === after && result.next) throw new Error('Human proposal traversal exceeds bound');
        after = result.next;
      } while (after);
      return { items };
    } });
  } catch (error) { await transform.dispose(); throw error; }
  return async () => { try { await rpc.dispose(); } finally { await transform.dispose(); } };
}
