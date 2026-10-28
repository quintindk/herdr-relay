import { requireValue } from '../../src/protocol.mjs';

// A service notification can be displayed/read, never become a fresh instruction
// to use the coordinator's standing mutation tools. A later real user turn clears
// this restriction naturally; report prose cannot clear structured provenance.
export async function assertNotRunResultNotice(ctx, context) {
  if (!ctx.session?.context) return;
  const messages = await ctx.session.context({ sessionID: context.sessionID });
  const index = messages.findIndex(message => message.id === context.messageID);
  const prior = index < 0 ? messages : messages.slice(0, index + 1);
  const source = prior.findLast(message => message.type === 'user');
  requireValue(!source?.metadata?.herdrRelayRunResult, 'run_result_information_only',
    'Run result notifications authorise display and reads only, not mutations, acknowledgements or replies', 403);
}
