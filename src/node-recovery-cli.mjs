import { parseArgs } from 'node:util';
import { requireValue } from './protocol.mjs';
import { nodeRecovery } from './node-recovery.mjs';

export const nodeRecoveryHelp = `Local node recovery (no credential copying, journal deletion, prompt replay or database restore):
  node recover list [--config NODE_JSON]
  node recover work EXECUTION_ID --reason TEXT --key KEY [--config NODE_JSON]
  node recover publication ORIGINAL_KEY --reason TEXT --key KEY [--config NODE_JSON]
  Repeat the exact preview command with --preview-hash HASH --apply to abandon it.
Work requires terminal backend ownership or a cancelled local-only schedule.
Only proven transactional validation refusals or inspected absent receipts with
an execution-revision fence may be abandoned as publications.
Uncertain effects and revision conflicts require inspection/reconciliation.
Application creates an integrity-checked backup and immutable administrative audit.
Administrative abandonment claims neither native completion nor process termination.`;

export async function nodeRecoveryCli(args) {
  if (args[0] !== 'node' || args[1] !== 'recover') return false;
  if (args.includes('--help')) { console.log(nodeRecoveryHelp); return true; }
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, reason: { type: 'string' }, key: { type: 'string' }, 'preview-hash': { type: 'string' }, apply: { type: 'boolean' },
  } });
  const kind = positionals[2], id = positionals[3];
  requireValue(kind === 'list' ? positionals.length === 3 && Object.keys(values).every(k => k === 'config') :
    ['work', 'publication'].includes(kind) && positionals.length === 4, 'invalid_request', nodeRecoveryHelp);
  console.log(JSON.stringify(await nodeRecovery({ kind, id, configFile: values.config, reason: values.reason, key: values.key,
    apply: values.apply, previewHash: values['preview-hash'] }), null, 2));
  return true;
}
