import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { requireValue } from '../src/protocol.mjs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: { 'state-dir': { type: 'string' }, port: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
const state = resolve(values['state-dir'] ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-relay-backend'));
const port = Number(values.port ?? 3210);
requireValue(Number.isInteger(port) && port > 0 && port <= 65535, 'invalid_port', 'Backend service port must be 1..65535');
const units = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user');
const unitPath = join(units, 'herdr-relay-backend.service');
const cli = join(root, 'src/backend-cli.mjs');
const marker = '# Managed by herdr-relay/scripts/install-native-backend.mjs';
if (existsSync(unitPath)) requireValue(readFileSync(unitPath, 'utf8').startsWith(marker), 'unit_conflict', 'Refuse replacing an unrelated service');
const unit = `${marker}
[Unit]
Description=Herdr Relay native backend
After=network.target

[Service]
Type=simple
ExecStart=${[process.execPath, cli, 'serve', '--state-dir', state, '--port', String(port)].map(quote).join(' ')}
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
if (values['dry-run']) {
  console.log(JSON.stringify({ state: 'dry_run', unitPath, stateDirectory: state, port, unit, mutationPerformed: false }));
  process.exit(0);
}
requireValue(process.platform === 'linux', 'unsupported_platform', 'Automatic backend installation requires Linux/systemd (including WSL2)');
mkdirSync(state, { recursive: true, mode: 0o700 }); chmodSync(state, 0o700);
mkdirSync(units, { recursive: true });
if (!existsSync(join(state, 'owner.json'))) execFileSync(process.execPath, [cli, 'init', '--state-dir', state], { stdio: ['ignore', 'pipe', 'inherit'] });
const changed = !existsSync(unitPath) || readFileSync(unitPath, 'utf8') !== unit;
if (changed) writeFileSync(unitPath, unit, { mode: 0o600 });
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', '--now', 'herdr-relay-backend.service'], { stdio: 'inherit' });
if (changed) execFileSync('systemctl', ['--user', 'restart', 'herdr-relay-backend.service'], { stdio: 'inherit' });
console.log(JSON.stringify({ unit: unitPath, stateDirectory: state, origin: `http://127.0.0.1:${port}`, publicIngressConfigured: false }));
