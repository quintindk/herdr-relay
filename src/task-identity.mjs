import { digest, requireValue } from './protocol.mjs';

export const backendSchema = 2;
export const referencePrefix = /^[A-Z][A-Z0-9]{0,15}$/;
export function parseTaskReference(value) {
  const match = typeof value === 'string' && /^([A-Z][A-Z0-9]{0,15})-([1-9][0-9]*)$/.exec(value);
  const number = match && Number(match[2]);
  requireValue(match && Number.isSafeInteger(number), 'invalid_task_reference', 'Reference must be PREFIX-positiveInteger without padding, within the safe integer range');
  return { prefix: match[1], number };
}

// Claims outlive task rows. SQL guards also fence an already-running older writer.
export const taskIdentitySchema = `
  CREATE TABLE IF NOT EXISTS task_reference_counters (prefix TEXT PRIMARY KEY, high_water INTEGER NOT NULL CHECK(high_water>=0 AND high_water<=9007199254740991));
  CREATE TABLE IF NOT EXISTS task_reference_claims (reference TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, number INTEGER NOT NULL CHECK(number>0 AND number<=9007199254740991), UNIQUE(prefix,number));
  CREATE TABLE IF NOT EXISTS task_aliases (scope TEXT NOT NULL, alias TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY(scope,alias,task_id));
  CREATE INDEX IF NOT EXISTS task_alias_lookup ON task_aliases(alias,scope);
  CREATE TRIGGER IF NOT EXISTS task_reference_required_insert BEFORE INSERT ON entities WHEN NEW.kind='task' BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM task_reference_claims WHERE task_id=NEW.id AND reference=json_extract(NEW.data,'$.reference'))
      THEN RAISE(ABORT,'task_reference_required') END;
  END;
  CREATE TRIGGER IF NOT EXISTS task_reference_required_update BEFORE UPDATE ON entities WHEN NEW.kind='task' BEGIN
    SELECT CASE WHEN NEW.id<>OLD.id OR NOT EXISTS(SELECT 1 FROM task_reference_claims WHERE task_id=NEW.id AND reference=json_extract(NEW.data,'$.reference'))
      THEN RAISE(ABORT,'task_reference_immutable') END;
  END;
  CREATE TRIGGER IF NOT EXISTS task_claim_immutable_update BEFORE UPDATE ON task_reference_claims BEGIN SELECT RAISE(ABORT,'task_claim_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS task_claim_immutable_delete BEFORE DELETE ON task_reference_claims BEGIN SELECT RAISE(ABORT,'task_claim_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS task_counter_monotonic BEFORE UPDATE ON task_reference_counters WHEN NEW.high_water<OLD.high_water OR NEW.prefix<>OLD.prefix BEGIN SELECT RAISE(ABORT,'task_counter_regression'); END;
  CREATE TRIGGER IF NOT EXISTS task_counter_retained BEFORE DELETE ON task_reference_counters BEGIN SELECT RAISE(ABORT,'task_counter_retained'); END;
  CREATE TRIGGER IF NOT EXISTS task_alias_retained_update BEFORE UPDATE ON task_aliases BEGIN SELECT RAISE(ABORT,'task_alias_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS task_alias_retained_delete BEFORE DELETE ON task_aliases BEGIN SELECT RAISE(ABORT,'task_alias_immutable'); END;
`;

export function assertTaskIdentityIntegrity(db) {
  const tables = ['task_reference_claims', 'task_reference_counters', 'task_aliases'];
  requireValue(tables.every(name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)),
    'task_identity_recovery_required', 'Reference registry is missing. Do not recreate it or resume numbering from task rows');
  requireValue(!db.prepare(`SELECT 1 FROM entities t LEFT JOIN task_reference_claims c ON c.task_id=t.id AND c.reference=json_extract(t.data,'$.reference')
    WHERE t.kind='task' AND c.task_id IS NULL LIMIT 1`).get(), 'task_identity_recovery_required', 'Task reference claim coverage is inconsistent');
  requireValue(!db.prepare(`SELECT 1 FROM task_reference_claims c LEFT JOIN task_reference_counters n ON n.prefix=c.prefix
    WHERE n.high_water IS NULL OR n.high_water<c.number LIMIT 1`).get(), 'task_identity_recovery_required', 'Namespace counters are behind issued claims. Explicit recovery is required');
  for (const claim of db.prepare('SELECT reference,prefix,number FROM task_reference_claims').all()) {
    const parsed = parseTaskReference(claim.reference);
    requireValue(parsed.prefix === claim.prefix && parsed.number === claim.number, 'task_identity_recovery_required', 'Reference registry contains inconsistent claims');
  }
}

export function claimTaskReference(db, taskId, requested) {
  const existing = db.prepare('SELECT reference FROM task_reference_claims WHERE task_id=?').get(taskId);
  requireValue(!existing, 'task_reference_conflict', 'Task identity has a retained claim and cannot be recreated', 409);
  const parsed = requested === undefined ? { prefix: 'REL', number: Number(db.prepare('SELECT high_water FROM task_reference_counters WHERE prefix=?').get('REL')?.high_water ?? 0) + 1 } : parseTaskReference(requested);
  requireValue(Number.isSafeInteger(parsed.number), 'task_reference_exhausted', 'Reference namespace exhausted. Explicit recovery is required', 409);
  const reference = `${parsed.prefix}-${parsed.number}`;
  requireValue(!db.prepare('SELECT 1 FROM task_reference_claims WHERE reference=?').get(reference), 'task_reference_conflict', 'Reference is permanently claimed by another task', 409);
  db.prepare('INSERT INTO task_reference_claims VALUES (?,?,?,?)').run(reference, taskId, parsed.prefix, parsed.number);
  db.prepare('INSERT INTO task_reference_counters VALUES (?,?) ON CONFLICT(prefix) DO UPDATE SET high_water=MAX(high_water,excluded.high_water)').run(parsed.prefix, parsed.number);
  return reference;
}

export function taskAliases(task) {
  const aliases = [];
  if (typeof task.identifier === 'string' && task.identifier) aliases.push({ scope: 'native', alias: task.identifier });
  if (typeof task.source?.metadata?.identifier === 'string' && task.source.metadata.identifier && task.source.scope) {
    aliases.push({ scope: `${task.source.provider ?? 'external'}:${task.source.scope}`, alias: task.source.metadata.identifier });
  }
  return aliases;
}
export function indexTaskAliases(db, task) {
  for (const alias of taskAliases(task)) db.prepare('INSERT OR IGNORE INTO task_aliases VALUES (?,?,?)').run(alias.scope, alias.alias, task.id);
}

export function referencePrincipal(actor) {
  return actor.scope?.kind === 'node_operator' ? { type: 'node_operator', id: actor.scope.nodeId } : { type: actor.type, id: actor.id };
}
export const namespaceGrantId = (principal, prefix) => `task_reference_grant_${digest([principal.type, principal.id, prefix])}`;
export function authoriseTaskReference(store, actor, reference) {
  const { prefix, number } = parseTaskReference(reference);
  if (actor.type === 'user' && actor.id === store.owner && !actor.scope) return;
  const grant = store.get('task_reference_grant', namespaceGrantId(referencePrincipal(actor), prefix), false);
  requireValue(grant?.state === 'active' && number <= grant.maxNumber, 'task_reference_forbidden', 'Explicit namespace claim permission within its approved number range is required', 403);
}

export function resolveTaskIdentity(store, { value, reference, scope } = {}) {
  const token = reference ?? value;
  requireValue((value !== undefined) !== (reference !== undefined) && typeof token === 'string' && token.length > 0 && token.length <= 512 &&
    (scope === undefined || typeof scope === 'string' && scope.length > 0 && scope.length <= 512), 'invalid_task_lookup', 'Choose an exact primary reference or a bounded identity/alias value, with optional alias scope');
  if (reference !== undefined) parseTaskReference(reference.toUpperCase());
  const matches = new Map();
  const add = (taskId, kind, aliasScope) => {
    const task = store.get('task', taskId, false);
    if (!task) return;
    if (!matches.has(taskId)) matches.set(taskId, { task, matched: [] });
    matches.get(taskId).matched.push({ kind, ...(aliasScope ? { scope: aliasScope } : {}) });
  };
  const claim = store.db.prepare('SELECT task_id FROM task_reference_claims WHERE reference=?').get(token.toUpperCase());
  if (claim) add(claim.task_id, 'reference');
  if (reference === undefined) {
    if (store.get('task', token, false)) add(token, 'id');
    for (const alias of store.db.prepare(`SELECT task_id,scope FROM task_aliases WHERE alias=?${scope === undefined ? '' : ' AND scope=?'} ORDER BY scope,task_id`).all(...(scope === undefined ? [token] : [token, scope]))) add(alias.task_id, 'alias', alias.scope);
  }
  const items = [...matches.values()];
  return { state: items.length === 1 ? 'resolved' : items.length ? 'ambiguous' : 'not_found', matches: items, complete: true };
}
