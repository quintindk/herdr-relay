#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const project = dirname(fileURLToPath(import.meta.url));
const root = resolve(project, '../..');
const local = resolve(root, '.litellm');
const unitDirectory = resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'), 'systemd/user');
const unitName = 'herdr-relay-litellm.service';
const quote = value => {
  if (/[\r\n\0]/.test(value)) throw new Error('Service paths must not contain control characters');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`;
};
const pathSetting = value => {
  if (/[\r\n\0]/.test(value)) throw new Error('Service paths must not contain control characters');
  return value.replaceAll('%', '%%').replaceAll('\\', '\\x5c').replaceAll(' ', '\\x20');
};

process.umask(0o077);
mkdirSync(local, { recursive: true, mode: 0o700 });
chmodSync(local, 0o700);
mkdirSync(unitDirectory, { recursive: true });
const environment = resolve(local, 'service.env');
if (!existsSync(environment)) {
  writeFileSync(environment, `LITELLM_MASTER_KEY=sk-${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
}
chmodSync(environment, 0o600);
const config = resolve(local, 'config.yaml');
if (!existsSync(config)) copyFileSync(resolve(project, 'config.example.yaml'), config);
chmodSync(config, 0o600);
if (!/^LITELLM_MASTER_KEY=.+$/m.test(readFileSync(environment, 'utf8'))) {
  throw new Error(`Set LITELLM_MASTER_KEY in ${environment} before starting the service`);
}

execFileSync('uv', ['sync', '--frozen', '--no-dev', '--project', project], { stdio: 'inherit' });
const unit = `[Unit]
Description=Herdr Relay local LiteLLM model gateway
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${pathSetting(root)}
EnvironmentFile=${pathSetting(environment)}
Environment=LITELLM_LOCAL_MODEL_COST_MAP=True
Environment=DISABLE_ADMIN_UI=True
Environment=PYTHONUNBUFFERED=1
ExecStart=${quote(resolve(project, '.venv/bin/litellm'))} --config ${quote(config)} --host 127.0.0.1 --port 4000 --telemetry False
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
writeFileSync(resolve(unitDirectory, unitName), unit, { mode: 0o600 });
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', unitName], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'restart', unitName], { stdio: 'inherit' });
let ready = false;
for (let attempt = 0; attempt < 240; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:4000/health/liveliness', { signal: AbortSignal.timeout(1000) });
    ready = response.ok;
    await response.body?.cancel();
    if (ready) break;
  } catch { /* The server may still be starting. */ }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!ready) throw new Error(`Gateway did not become live. Inspect journalctl --user -u ${unitName}`);
console.log(`Installed ${unitName}. API: http://127.0.0.1:4000/v1`);
console.log(`Private configuration and key: ${local}`);
