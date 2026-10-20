import { canonical, digest, requireValue } from './protocol.mjs';
import { selectTasksProvider } from './provider-selection.mjs';
import { ProviderJournal } from './provider-journal.mjs';

// Scope lives beside the node's native intent. Reconfiguring a repository/company
// cannot reinterpret historical task IDs or external operation receipts.
export function nodeTasks(journal, config = { type: 'native' }, connectors) {
  const allowed = config?.type === 'github' ? ['type', 'owner', 'repo', 'labels'] :
    config?.type === 'paperclip' ? ['type', 'companyId'] : ['type'];
  requireValue(config && Object.keys(config).every(key => allowed.includes(key)), 'invalid_provider', 'Unsupported Tasks provider configuration');
  const scope = canonical(config);
  const key = 'tasks-provider';
  const pinned = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  requireValue(!pinned || pinned.value === scope, 'provider_migration_required', 'Node Tasks provider changed. Explicit migration required', 409);
  requireValue(pinned || config.type === 'native' ||
    !journal.db.prepare('SELECT 1 FROM work LIMIT 1').get() && !journal.db.prepare('SELECT 1 FROM cached_entities WHERE kind=? LIMIT 1').get('task') &&
    !journal.db.prepare('SELECT 1 FROM schedules LIMIT 1').get() && !journal.db.prepare('SELECT 1 FROM occurrences LIMIT 1').get() &&
    !journal.db.prepare('SELECT 1 FROM outbox LIMIT 1').get() && !journal.db.prepare('SELECT 1 FROM execution_history LIMIT 1').get(),
  'provider_migration_required', 'Existing native task state requires explicit migration before external selection', 409);
  const provider = selectTasksProvider(config, { ...connectors,
    journal: new ProviderJournal(journal.db, `node-tasks:${digest(scope)}`) });
  journal.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run(key, scope);
  return { ...provider, type: config.type, scope: digest(scope) };
}
