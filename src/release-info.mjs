import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { requireValue } from './protocol.mjs';

export const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
export const releaseVersion = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')).version;
export const compatibility = Object.freeze({ protocol: 'relay/0.2', backendSchema: 2, nodeSchema: 1 });
export const minimumUpgradeVersion = '0.2.1-rc4';
export function assertSupportedRelease(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(version ?? '');
  const numbers = match?.slice(1, 4).map(Number);
  const newer = numbers && (numbers[0] > 0 || numbers[1] > 2 || numbers[1] === 2 && numbers[2] > 1);
  const baseline = numbers && numbers[0] === 0 && numbers[1] === 2 && numbers[2] === 1 &&
    (!match[4] || /^rc(?:[4-9]|[1-9]\d+)$/.test(match[4]));
  requireValue(numbers?.every(Number.isSafeInteger) && (newer || baseline), 'upgrade_incompatible',
    `Relay ${minimumUpgradeVersion} or later is required. Older development releases are unsupported`);
}
function fingerprint(directory) {
  const hash = createHash('sha256');
  const visit = relative => {
    const path = join(directory, relative), stat = lstatSync(path);
    requireValue(!stat.isSymbolicLink(), 'invalid_release', 'Installed Relay package content must not contain symlinks');
    if (stat.isDirectory()) for (const name of readdirSync(path).sort().filter(name => !['node_modules', '.git', '.firecrawl'].includes(name))) visit(join(relative, name));
    else { requireValue(stat.isFile(), 'invalid_release', 'Only regular package files are supported'); hash.update(`${relative}\0${stat.mode & 0o111}\0`); hash.update(readFileSync(path)); hash.update('\0'); }
  };
  visit(''); return hash.digest('hex');
}
export function releaseInfo(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  requireValue(manifest.name === 'herdr-relay' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version), 'invalid_release', 'A versioned Relay package is required');
  assertSupportedRelease(manifest.version);
  const contract = manifest.relayCompatibility;
  requireValue(contract && contract.protocol === compatibility.protocol && contract.backendSchema === compatibility.backendSchema && contract.nodeSchema === compatibility.nodeSchema,
    'upgrade_incompatible', 'Explicit relay/0.2 backend schema-2 and node schema-1 metadata is required');
  return { directory, version: manifest.version, compatibility: contract, fingerprint: fingerprint(directory) };
}
