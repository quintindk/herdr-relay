import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { systemdUnit } from '../src/installation.mjs';

const root = mkdtempSync(join(tmpdir(), 'relay-unit-'));
try {
  const path = join(root, 'herdr-relay.service');
  writeFileSync(path, systemdUnit({ node: process.execPath, cli: fileURLToPath(new URL('../src/cli.mjs', import.meta.url)),
    stateDirectory: join(root, 'state with spaces'), paperclipUrl: 'http://127.0.0.1:3100' }));
  execFileSync('systemd-analyze', ['--user', 'verify', path], { stdio: 'pipe' });
  assert.ok(true);
  console.log(JSON.stringify({ systemdUnitVerified: true, installed: false }));
} finally { rmSync(root, { recursive: true, force: true }); }
