import { posix } from 'node:path';
import { requireValue } from './protocol.mjs';

export const headlessTaskActions = ['task.create', 'task.update', 'comment.create', 'reference.attach'];
export const relativeArtifactPath = path => typeof path === 'string' && path.length > 0 && path.length <= 4096 &&
  !path.includes('\\') && !/[\x00-\x1f]/.test(path) && !posix.isAbsolute(path) && posix.normalize(path) === path && path !== '.' &&
  !path.split('/').some(part => part === '..' || part === '.git');

export function validateHeadlessCapabilities(profile) {
  requireValue(profile && typeof profile === 'object' && !Array.isArray(profile) && Object.keys(profile).every(k => ['sourceNamespaces', 'taskActions', 'artifacts'].includes(k)) &&
    Array.isArray(profile.sourceNamespaces) && profile.sourceNamespaces.length > 0 && profile.sourceNamespaces.length <= 32 &&
    new Set(profile.sourceNamespaces).size === profile.sourceNamespaces.length && profile.sourceNamespaces.every(ns => typeof ns === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(ns)) &&
    Array.isArray(profile.taskActions) && new Set(profile.taskActions).size === profile.taskActions.length && profile.taskActions.every(action => headlessTaskActions.includes(action)),
  'invalid_headless_capabilities', 'Explicit source namespaces and bounded native task actions required');
  if (profile.artifacts !== undefined) {
    const a = profile.artifacts, keys = ['receipts', 'state', 'history', 'runs', 'summaries'];
    requireValue(a && typeof a === 'object' && !Array.isArray(a) && Object.keys(a).length === keys.length && keys.every(k => Object.hasOwn(a, k)) &&
      ['receipts', 'state', 'history', 'runs'].every(k => relativeArtifactPath(a[k])) && a.state.endsWith('.json') &&
      (relativeArtifactPath(a.summaries) || a.summaries === '/tmp/opencode') && new Set(Object.values(a)).size === keys.length &&
      !a.state.startsWith(`${a.receipts}/`), 'invalid_headless_capabilities', 'Distinct explicit workspace artifact paths required; summaries may use the approved temporary directory');
  }
  requireValue(profile.taskActions.length > 0 || profile.artifacts, 'invalid_headless_capabilities', 'At least one capability must be granted');
  return profile;
}

export function headlessSource(profile, source) {
  requireValue(source && typeof source === 'object' && !Array.isArray(source) && Object.keys(source).every(k => ['namespace', 'externalId', 'url'].includes(k)) &&
    profile.sourceNamespaces.includes(source.namespace) && typeof source.externalId === 'string' && source.externalId.trim() && source.externalId.length <= 512 && !/[\x00-\x1f]/.test(source.externalId),
  'headless_source_forbidden', 'Source identity must belong to the explicitly granted namespace', 403);
  if (source.url !== undefined) {
    let url; try { url = new URL(source.url); } catch {}
    requireValue(typeof source.url === 'string' && source.url.length <= 4096 && url?.protocol === 'https:' && !url.username && !url.password,
      'invalid_reference', 'Source URLs must be HTTPS without embedded credentials');
  }
  return source;
}
