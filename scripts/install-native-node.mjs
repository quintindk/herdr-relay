import { parseArgs } from 'node:util';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { requireValue } from '../src/protocol.mjs';

const { values } = parseArgs({ options: { config: { type: 'string' } } });
requireValue(values.config, 'invalid_request', 'Use --config PRIVATE_NODE_JSON');
const configPath = resolve(values.config);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
requireValue(typeof config.nodeId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(config.nodeId), 'invalid_node', 'Safe stable node ID required');
const units = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user');
mkdirSync(units, { recursive: true });
const name = `herdr-relay-node-${config.nodeId}.service`;
const path = join(units, name);
const marker = '# Managed by herdr-relay/scripts/install-native-node.mjs';
requireValue(!existsSync(path) || readFileSync(path, 'utf8').startsWith(marker), 'unit_conflict', 'Refuse replacing unrelated service');
const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
const unit = `${marker}
[Unit]
Description=Herdr Relay native node ${config.nodeId}
After=network.target

[Service]
Type=simple
ExecStart=${[process.execPath, fileURLToPath(new URL('../src/node-cli.mjs', import.meta.url)), '--config', configPath].map(quote).join(' ')}
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
const changed = !existsSync(path) || readFileSync(path, 'utf8') !== unit;
if (changed) writeFileSync(path, unit, { mode: 0o600 });
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', '--now', name], { stdio: 'inherit' });
if (changed) execFileSync('systemctl', ['--user', 'restart', name], { stdio: 'inherit' });
console.log(JSON.stringify({ service: name, nodeId: config.nodeId, config: configPath }));
