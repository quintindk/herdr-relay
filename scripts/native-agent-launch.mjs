#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Explicit human Herdr launch action. The core native CLI still requires an
// owner context. No credential or permission is passed to the native model.
execFileSync('bash', [fileURLToPath(new URL('./plugin-launch.sh', import.meta.url)), 'native', 'agent', 'launch',
  '--context', join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-relay-backend/owner.json'),
  '--directory', process.cwd(), ...process.argv.slice(2)], { stdio: 'inherit' });
