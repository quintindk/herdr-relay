import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { requireValue, text } from './protocol.mjs';

export function systemdUnit({ node, cli, stateDirectory, paperclipUrl, backendContextFile, herdrConfigFile }) {
  for (const path of [node, cli, stateDirectory]) requireValue(isAbsolute(text(path, 'path')), 'invalid_installation', 'Installation paths must be absolute');
  const url = new URL(paperclipUrl);
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
    'invalid_backend', 'Backend URL requires HTTP(S) without embedded credentials');
  const quote = value => `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '$$')}"`;
  requireValue([node, cli, stateDirectory, paperclipUrl].every(value => !/[\r\n\0]/.test(value)), 'invalid_installation', 'Multiline installation values are unsupported');
  if (backendContextFile) requireValue(isAbsolute(backendContextFile) && !/[\r\n\0]/.test(backendContextFile), 'invalid_installation', 'Backend context must be an absolute single-line path');
  if (herdrConfigFile) requireValue(isAbsolute(herdrConfigFile) && !/[\r\n\0]/.test(herdrConfigFile), 'invalid_installation', 'Herdr config must be an absolute single-line path');
  return `[Unit]\nDescription=Herdr Relay coordination service\nAfter=network.target\n\n[Service]\nType=simple\n` +
    `ExecStart=${[node, cli, 'service', '--state-dir', stateDirectory, '--paperclip-url', paperclipUrl,
      ...(backendContextFile ? ['--backend-context', backendContextFile] : []),
      ...(herdrConfigFile ? ['--herdr-config', herdrConfigFile] : [])].map(quote).join(' ')}\n` +
    `Restart=on-failure\nRestartSec=2\nTimeoutStopSec=30\nKillMode=process\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

export function installService(config, { home = homedir(), execute = execFileSync } = {}) {
  requireValue(process.platform === 'linux', 'unsupported_platform', 'Automatic service installation requires Linux');
  const directory = join(home, '.config/systemd/user');
  const path = join(directory, 'herdr-relay.service');
  const receipt = join(config.stateDirectory, 'service-install.json');
  const unit = systemdUnit(config);
  if (existsSync(path)) {
    requireValue(existsSync(receipt), 'installation_conflict', 'Existing unit is not owned by this Relay state directory', 409);
    const previous = JSON.parse(readFileSync(receipt, 'utf8'));
    requireValue(previous.path === path && readFileSync(path, 'utf8') === previous.unit,
      'installation_conflict', 'Installed service was changed outside Relay', 409);
  }
  mkdirSync(directory, { recursive: true });
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(path, unit, { mode: 0o600 });
  writeFileSync(receipt, JSON.stringify({ path, unit }), { mode: 0o600 });
  execute('systemd-analyze', ['--user', 'verify', path], { stdio: 'pipe' });
  execute('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  execute('systemctl', ['--user', 'enable', '--now', 'herdr-relay.service'], { stdio: 'pipe' });
  return { installed: path, stateDirectory: config.stateDirectory };
}

export function uninstallService(stateDirectory, { execute = execFileSync } = {}) {
  const receipt = join(stateDirectory, 'service-install.json');
  if (!existsSync(receipt)) return { removed: false };
  const previous = JSON.parse(readFileSync(receipt, 'utf8'));
  requireValue(!existsSync(previous.path) || readFileSync(previous.path, 'utf8') === previous.unit,
    'installation_conflict', 'Installed service was changed outside Relay', 409);
  execute('systemctl', ['--user', 'disable', '--now', 'herdr-relay.service'], { stdio: 'pipe' });
  if (existsSync(previous.path)) unlinkSync(previous.path);
  unlinkSync(receipt);
  execute('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  return { removed: true, statePreserved: stateDirectory };
}
