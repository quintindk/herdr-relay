import { dirname, basename, join, isAbsolute } from 'node:path';
import { requireValue } from './protocol.mjs';
import { releaseInfo } from './release-info.mjs';

const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
export function parseManagedUnit(source, role) {
  requireValue(['backend', 'node'].includes(role) && source.startsWith(`# Managed by herdr-relay/scripts/install-native-${role}.mjs\n`),
    'unmanaged_service', 'Refuse upgrading an unrelated or unrecognised service unit');
  const lines = source.split('\n').filter(line => line.startsWith('ExecStart='));
  requireValue(lines.length === 1, 'unmanaged_service', 'One managed ExecStart is required');
  const encoded = lines[0].slice('ExecStart='.length), args = [];
  let offset = 0;
  const pattern = /\s*"((?:\\.|[^"\\])*)"/y;
  while (offset < encoded.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(encoded);
    requireValue(match, 'unmanaged_service', 'Only generated quoted service arguments are supported');
    args.push(match[1].replace(/\\([\\"])/g, '$1').replaceAll('%%', '%'));
    offset = pattern.lastIndex;
  }
  const script = role === 'backend' ? 'backend-cli.mjs' : 'node-cli.mjs';
  requireValue(args.length >= 4 && isAbsolute(args[0]) && isAbsolute(args[1]) && basename(args[1]) === script,
    'unmanaged_service', 'Expected an absolute Relay service entrypoint');
  const option = name => {
    const indexes = args.flatMap((value, i) => value === name ? [i] : []);
    requireValue(indexes.length === 1 && args[indexes[0] + 1], 'unmanaged_service', `Missing/ambiguous ${name}`);
    return args[indexes[0] + 1];
  };
  const statePath = option(role === 'backend' ? '--state-dir' : '--config');
  requireValue(isAbsolute(statePath), 'unmanaged_service', 'Absolute private state/config path required');
  const release = releaseInfo(dirname(dirname(args[1])));
  return { role, args, statePath, release, replace(directory) {
    const next = [...args]; next[1] = join(directory, 'src', script);
    return source.replace(lines[0], `ExecStart=${next.map(quote).join(' ')}`);
  } };
}
