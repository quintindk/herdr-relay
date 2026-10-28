import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'tui',
  ...process.argv.slice(2)], { stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => {
  process.exitCode = code ?? 1;
  if (process.env.HERDR_ENV === '1' && process.env.RELAY_RETURN_PANE) {
    const restore = spawn('python3', [fileURLToPath(new URL('./toggle-board.py', import.meta.url)), '--restore'], { stdio: ['ignore', 'ignore', 'inherit'] });
    restore.once('error', error => console.error(`Relay focus restore: ${error.message}`));
  }
});
