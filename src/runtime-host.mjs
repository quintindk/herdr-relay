// Private launch helper. Its descriptor is persisted before native process start.
import { readFileSync, writeFileSync, openSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const directory = process.argv[2];
const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'));
const identity = pid => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
const descriptor = { ownerPid: process.pid, ownerStart: identity(process.pid), nonce: config.nonce, state: 'starting' };
const save = () => {
  const temporary = join(directory, 'runtime.json.next');
  writeFileSync(temporary, JSON.stringify(descriptor), { mode: 0o600 });
  renameSync(temporary, join(directory, 'runtime.json'));
};
save();
const auth = JSON.parse(readFileSync(join(directory, 'auth.json'), 'utf8'));
const log = openSync(join(directory, 'native.log'), 'a', 0o600);
const hermes = config.harness === 'hermes';
const child = spawn(config.executable, hermes
  ? ['serve', '--host', '127.0.0.1', '--port', String(config.port), '--skip-build', '--isolated']
  : ['serve', '--hostname', '127.0.0.1', '--port', String(config.port), '--pure'], {
  cwd: config.directory, env: { ...process.env, ...(hermes
    ? { HERMES_DASHBOARD_SESSION_TOKEN: auth.password }
    : { OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: auth.password,
      OPENCODE_PURE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1' }) },
  stdio: ['ignore', log, log],
});
child.once('spawn', () => { descriptor.childPid = child.pid; descriptor.childStart = identity(child.pid); descriptor.state = 'running'; save(); });
child.once('error', () => { descriptor.state = 'failed'; save(); process.exitCode = 1; });
child.once('exit', (code, signal) => { descriptor.state = 'exited'; descriptor.exitCode = code; descriptor.signal = signal; save(); });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
