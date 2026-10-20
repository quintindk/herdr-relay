import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const context = process.env.RELAY_NATIVE_CONTEXT ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-relay-backend/owner.json');
const child = spawn(process.execPath, [fileURLToPath(new URL('../src/native-board-cli.mjs', import.meta.url)), '--context', context,
  ...process.argv.slice(2)], { stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
