import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsonc from 'jsonc-parser';
import { requireValue } from './protocol.mjs';

export function readOpenCodeConfig(path) {
  const source = readFileSync(path, 'utf8'), errors = [];
  const value = jsonc.parse(source, errors, { allowTrailingComma: true });
  requireValue(errors.length === 0 && value && typeof value === 'object' && !Array.isArray(value),
    'configuration_conflict', 'OpenCode configuration must be a valid JSON/JSONC object');
  return { source, value };
}

export function replacePluginDirectives(source, plugins) {
  const formattingOptions = {
    insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n',
  };
  const old = jsonc.parse(source, [], { allowTrailingComma: true }).plugins;
  const edit = (path, value, insertion = false) => { source = jsonc.applyEdits(source, jsonc.modify(source, path, value,
    { formattingOptions, ...(insertion ? { isArrayInsertion: true } : {}) })); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!Array.isArray(old)) edit(['plugins'], plugins);
  else if (old.length === plugins.length) {
    for (let i = 0; i < old.length; i++) if (!same(old[i], plugins[i])) edit(['plugins', i], plugins[i]);
  } else if (plugins.length >= old.length && old.every((p, i) => same(p, plugins[i]))) {
    for (let i = old.length; i < plugins.length; i++) edit(['plugins', i], plugins[i], true);
  } else {
    let next = 0;
    const removed = [];
    for (let i = 0; i < old.length; i++) { if (next < plugins.length && same(old[i], plugins[next])) next++; else removed.push(i); }
    requireValue(next === plugins.length, 'configuration_conflict', 'Unexpected plugin-array replacement; reconcile explicitly');
    for (const i of removed.reverse()) edit(['plugins', i], undefined);
  }
  return source;
}

export function isRelayPlugin(directive, directory, currentPackage) {
  const name = typeof directive === 'string' ? directive : directive?.package;
  if (typeof name !== 'string' || /^[!-]/.test(name)) return false;
  if (name === currentPackage || name === '@herdr/relay-opencode') return true;
  if (!name.startsWith('/') && !name.startsWith('.') && !name.startsWith('file:')) return false;
  try {
    const path = name.startsWith('file:') ? fileURLToPath(name) : resolve(directory, name);
    const manifest = join(path, 'package.json');
    if (!existsSync(manifest)) return false;
    if (JSON.parse(readFileSync(manifest, 'utf8')).name === '@herdr/relay-opencode') return true;
    // Recognise previously bundled releases by their owning product and stable
    // package location, not an obsolete nested package brand.
    const root = resolve(path, '../..');
    return path === join(root, 'packages/opencode-relay') && existsSync(join(root, 'package.json')) &&
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'herdr-relay';
  } catch { return false; }
}
