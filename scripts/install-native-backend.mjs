import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { requireValue } from '../src/protocol.mjs';

const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const state = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-relay-backend');
const units = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user');
const unitPath = join(units, 'herdr-relay-backend.service');
const cli = join(root, 'src/backend-cli.mjs');
mkdirSync(state, { recursive: true, mode: 0o700 }); chmodSync(state, 0o700);
mkdirSync(units, { recursive: true });
const marker = '# Managed by herdr-relay/scripts/install-native-backend.mjs';
if (existsSync(unitPath)) requireValue(readFileSync(unitPath, 'utf8').startsWith(marker), 'unit_conflict', 'Refuse replacing an unrelated service');
if (!existsSync(join(state, 'owner.json'))) execFileSync(process.execPath, [cli, 'init', '--state-dir', state], { stdio: 'inherit' });
const unit = `${marker}
[Unit]
Description=Herdr Relay native backend (development)
After=network.target

[Service]
Type=simple
ExecStart=${[process.execPath, cli, 'serve', '--state-dir', state, '--port', '3210'].map(quote).join(' ')}
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
const changed = !existsSync(unitPath) || readFileSync(unitPath, 'utf8') !== unit;
if (changed) writeFileSync(unitPath, unit, { mode: 0o600 });
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', '--now', 'herdr-relay-backend.service'], { stdio: 'inherit' });
if (changed) execFileSync('systemctl', ['--user', 'restart', 'herdr-relay-backend.service'], { stdio: 'inherit' });
console.log(JSON.stringify({ unit: unitPath, stateDirectory: state, origin: 'http://127.0.0.1:3210', publicIngressConfigured: false }));
