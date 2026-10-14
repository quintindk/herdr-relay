import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const quit = String.raw`
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
command = [sys.argv[1], sys.argv[2], "--context", sys.argv[3], "board", "--watch"]
process = subprocess.Popen(command,
                           stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
try:
    data = b""
    deadline = time.monotonic() + 5
    marker = b"LIVE" if sys.argv[4] == "ready" else b"RELAY / TASKS"
    while marker not in data:
        assert time.monotonic() < deadline, "Board did not render"
        if select.select([master], [], [], 0.1)[0]:
            data += os.read(master, 65536)
    time.sleep(0.2)
    os.write(master, b"q")
    assert process.wait(timeout=3) == 0, "Board failed on quit"
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=5)
    os.close(master)
`;

for (const mode of ['ready', 'hung']) test(`real board CLI exits on q with ${mode} refresh`, async t => {
  if (process.platform === 'win32') { t.skip('PTY regression requires POSIX'); return; }
  const directory = mkdtempSync(join(tmpdir(), 'relay-board-exit-'));
  const socketPath = join(directory, 'relay.sock');
  const context = join(directory, 'context.json');
  writeFileSync(context, JSON.stringify({ socketPath, token: 'fixture' }), { mode: 0o600 });
  let requests = 0;
  const server = createServer((request, response) => {
    assert.equal(request.url, '/task-board'); requests++;
    if (mode === 'ready') response.end(JSON.stringify({ companies: [], agents: [], projects: [], tasks: [], fetchedAt: null }));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const { stdout } = await promisify(execFile)('python3', ['-c', quit, process.execPath,
    fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), context, mode, 'ink'], { timeout: 15000 });
  assert.equal(stdout, '');
  assert.equal(requests, 1);
});

test('board watch refuses non-TTY launch without a React stack trace', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-board-ink-no-tty-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const context = join(directory, 'context.json');
  writeFileSync(context, JSON.stringify({ socketPath: join(directory, 'missing.sock'), token: 'fixture' }), { mode: 0o600 });
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [cli, '--context', context, 'board', '--watch'], { timeout: 5000 }), error => {
    assert.match(error.stderr, /Task board watch mode requires an interactive terminal/);
    assert.doesNotMatch(error.stderr, /react-reconciler|node_modules\/ink\/build\/components\/App/);
    return true;
  });
});
