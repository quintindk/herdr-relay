import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireValue, text } from './protocol.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function remoteCommand(config, args) {
  const host = text(config.host, 'host');
  requireValue(!host.startsWith('-') && !/[\s\x00-\x1f]/.test(host), 'invalid_remote', 'Use a valid SSH host or configured host alias');
  const executable = text(config.node, 'node');
  const cli = text(config.cli, 'cli');
  const context = text(config.contextFile, 'contextFile');
  requireValue([executable, cli, context].every(value => value.startsWith('/') && !/[\r\n\0]/.test(value)),
    'invalid_remote', 'Remote executable, CLI and context paths must be absolute');
  requireValue(args.every(value => typeof value === 'string' && !value.includes('\0')), 'invalid_remote', 'Invalid remote argument');
  const options = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3'];
  if (config.port !== undefined) {
    requireValue(Number.isSafeInteger(config.port) && config.port > 0 && config.port <= 65535, 'invalid_remote', 'Invalid SSH port');
    options.push('-p', String(config.port));
  }
  for (const [key, option] of [['identityFile', 'IdentityFile'], ['knownHostsFile', 'UserKnownHostsFile']]) {
    if (config[key] === undefined) continue;
    requireValue(typeof config[key] === 'string' && config[key].startsWith('/') && !/[\r\n\0]/.test(config[key]), 'invalid_remote', 'SSH file paths must be absolute');
    options.push('-o', `${option}=${config[key]}`);
  }
  return [...options, '--', host,
    [executable, cli, '--context', context, ...args].map(quote).join(' ')];
}

export async function runRemote(config, args, { executable = 'ssh', input = process.stdin, output = process.stdout, error = process.stderr } = {}) {
  const child = spawn(executable, remoteCommand(config, args), { stdio: ['pipe', 'pipe', 'pipe'] });
  if (input.isTTY) child.stdin.end();
  else input.pipe(child.stdin);
  child.stdin.on('error', () => {});
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(error, { end: false });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { input.unpipe(child.stdin); resolve(code ?? 1); });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, ...args] = process.argv.slice(2);
  try {
    requireValue(path && args.length, 'invalid_request', 'Usage: herdr-relay-remote NODE_CONFIG COMMAND [ARGS...]');
    process.exitCode = await runRemote(JSON.parse(readFileSync(path, 'utf8')), args);
  } catch (error) {
    console.error(JSON.stringify({ code: error.code ?? 'remote_failed', message: error.message }));
    process.exitCode = 1;
  }
}
