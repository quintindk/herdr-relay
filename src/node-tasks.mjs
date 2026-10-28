import { canonical, digest, requireValue } from './protocol.mjs';
import { nativeTasksProvider } from './tasks-provider.mjs';

// Keep the persisted native scope unchanged across upgrades. Historical external
// scopes are refused rather than reinterpreted as native task identities.
export function nodeTasks(journal, config = { type: 'native' }, { nativeApi } = {}) {
  requireValue(config && config.type === 'native' && Object.keys(config).every(key => key === 'type'),
    'invalid_provider', 'Relay supports only its native task backend');
  const scope = canonical(config), key = 'tasks-provider';
  const pinned = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  requireValue(!pinned || pinned.value === scope, 'provider_migration_required', 'Stored task scope differs. Existing identities must not be reinterpreted', 409);
  requireValue(nativeApi, 'provider_unavailable', 'Native API required');
  const provider = nativeTasksProvider(nativeApi);
  journal.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run(key, scope);
  return { ...provider, type: 'native', scope: digest(scope) };
}
