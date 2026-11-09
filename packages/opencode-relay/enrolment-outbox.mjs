import { digest, requireValue } from '../../src/protocol.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const same = (left, right) => digest(left ?? null) === digest(right ?? null);
const argument = (args, name) => Array.isArray(args) && args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined;

export const enrolmentOutboxName = (configFile, directory) => `enrolment-outbox-${digest([configFile, directory])}`;

export function enrolmentOperationScope(pending) {
  if (!pending || typeof pending.key !== 'string' || !pending.key || !Array.isArray(pending.args) || !pending.args.every(arg => typeof arg === 'string') ||
    pending.args[0] !== 'agent' || !['enrol', 'attach', 'relocate'].includes(pending.args[1]) ||
    ['--key', '--config', '--directory', '--session'].some(name => pending.args.filter(arg => arg === name).length !== 1 || !argument(pending.args, name)) ||
    argument(pending.args, '--key') !== pending.key) return null;
  return { configFile: argument(pending.args, '--config'), directory: argument(pending.args, '--directory'),
    sessionId: argument(pending.args, '--session'), agentId: argument(pending.args, '--agent'), name: argument(pending.args, '--name') };
}

export function enrolmentOutboxes(storage, configFile) {
  const [legacy, updateLegacy] = storage.store('enrolment-outbox', { initial: { pending: null, sessionCreation: null } });
  const scopes = new Map();
  return { async forDirectory(directory) {
    const name = enrolmentOutboxName(configFile, directory);
    if (!scopes.has(name)) {
      const [outbox, updateOutbox] = storage.store(name, { initial: { pending: null, sessionCreation: null } });
      scopes.set(name, { outbox, updateOutbox });
    }
    const scope = scopes.get(name), originalScope = enrolmentOperationScope(legacy.pending);
    const pending = originalScope?.configFile === configFile && originalScope.directory === directory ? copy(legacy.pending) : null;
    const sessionCreation = legacy.sessionCreation?.location?.directory === directory ? copy(legacy.sessionCreation) : null;
    if (pending || sessionCreation) {
      // Persist the same intent in its own workspace before acknowledging the
      // legacy slot. A lost migration reply leaves repeat-safe duplicate evidence.
      await scope.updateOutbox(draft => {
        for (const [field, value] of Object.entries({ pending, sessionCreation })) if (value) {
          requireValue(!draft[field] || same(draft[field], value), 'enrolment_outbox_conflict',
            'This workspace already has another saved Relay operation. Neither operation was discarded');
          draft[field] = value;
        }
      });
      await updateLegacy(draft => {
        if (pending && same(draft.pending, pending)) draft.pending = null;
        if (sessionCreation && same(draft.sessionCreation, sessionCreation)) draft.sessionCreation = null;
      });
    }
    return scope;
  } };
}
