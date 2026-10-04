import { isAbsolute } from 'node:path';
import { requireValue, text } from './protocol.mjs';

export function systemdUnit({ node, cli, stateDirectory, paperclipUrl }) {
  for (const path of [node, cli, stateDirectory]) requireValue(isAbsolute(text(path, 'path')), 'invalid_installation', 'Installation paths must be absolute');
  const url = new URL(paperclipUrl);
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
    'invalid_backend', 'Backend URL requires HTTP(S) without embedded credentials');
  const quote = value => `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '$$')}"`;
  requireValue([node, cli, stateDirectory, paperclipUrl].every(value => !/[\r\n\0]/.test(value)), 'invalid_installation', 'Multiline installation values are unsupported');
  return `[Unit]\nDescription=Herdr Relay coordination service\nAfter=network.target\n\n[Service]\nType=simple\n` +
    `ExecStart=${[node, cli, 'service', '--state-dir', stateDirectory, '--paperclip-url', paperclipUrl].map(quote).join(' ')}\n` +
    `Restart=on-failure\nRestartSec=2\nTimeoutStopSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
