#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { requireValue } from './protocol.mjs';
import { maintenanceCli, upgradeHelp } from './upgrade-cli.mjs';
import { releaseVersion } from './release-info.mjs';
import { nativeAdministrationGroups } from './native-cli-surface.mjs';
import { main as native, nativeHelp } from './native-cli.mjs';
import { adminHelp } from './native-admin-cli.mjs';

export const help = `herdr-relay ${releaseVersion}
Native tasks, agent collaboration and node services for Herdr and OpenCode.

${upgradeHelp}
${nativeHelp}

${adminHelp}

  tui [--context OPERATOR_JSON] [--json]  [Tasks, Agents, Inbox, Grants and Schedule]
Use native task/agent/execution commands with the native prefix.
Service maintenance preserves existing identities, credentials, journals and work.`;

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--version') { console.log(releaseVersion); return; }
  if (!args.length || args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) { console.log(help); return; }
  if (await maintenanceCli(args)) return;
  if (args[0] === 'native') return native(args.slice(1));
  if (args[0] === 'tui') return native(['board', ...args.slice(1)]);
  if (nativeAdministrationGroups.includes(args[0])) return native(args);
  requireValue(false, 'unsupported_command', 'Unsupported command. Use herdr-relay --help for the native CLI. No operation was attempted.');
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { await main(); }
  catch (error) { console.error(JSON.stringify({ code: error.code ?? 'cli_failed', message: error.message })); process.exitCode = 1; }
}
