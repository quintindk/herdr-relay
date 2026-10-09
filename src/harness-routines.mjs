import { canonical, digest, requireValue } from './protocol.mjs';
import { isNotificationSource } from './completion-notifications.mjs';
import { manageRoutine } from './routines.mjs';
import { previewCron } from './cron-schedule.mjs';
import { enrolmentDirectories } from './enrolment.mjs';

export async function harnessRoutine(store, bridge, action, input, api, { observationConfig, routingContextFile } = {}) {
  const reading = ['routine-preview', 'routine-list', 'routine-inspect'].includes(action);
  requireValue(['routine-preview', 'routine-list', 'routine-inspect', 'routine-create', 'routine-pause',
    'routine-resume', 'routine-cancel', 'routine-run', 'routine-edit'].includes(action), 'invalid_request', 'Unknown routine action');
  requireValue(input && input.companyId === undefined && input.authority === undefined && input.action === undefined,
    'invalid_request', 'Routine authority is derived from the native bridge');
  const binding = store.binding(bridge.identity.bindingId);
  const source = input.source;
  const sourceProof = canonical(source ?? null);
  const check = () => {
    const current = store.operation(bridge.id);
    requireValue(current && ['configured', 'armed'].includes(current.state) && !binding.lifecycleState &&
      canonical(current.identity) === canonical(bridge.identity) && current.tokenHash === bridge.tokenHash &&
      current.epoch === bridge.epoch && current.sessionCreatedAt === bridge.sessionCreatedAt &&
      canonical(store.binding(binding.id)) === canonical(binding), 'bridge_identity_mismatch', 'Routine caller changed', 409);
    if (reading) return;
    requireValue(!store.runs(binding.id).some(run => run.nativeState !== 'settled'),
      'conversation_busy', 'Active Relay work cannot authorise routines', 409);
    requireValue(source && typeof source.id === 'string' && source.id.trim() && typeof source.text === 'string' &&
      source.text.trim() && source.text.length <= 16000 && Number.isSafeInteger(source.createdAt) &&
      source.createdAt >= bridge.sessionCreatedAt && source.createdAt <= Date.now() &&
      source.synthetic !== true && source.ignored !== true && (!source.role || source.role === 'user') &&
      canonical(input.source) === sourceProof && !isNotificationSource(store, bridge, source.id) &&
      !store.runs().some(run => run.invocation?.messageId === source.id),
    'invalid_routine_source', 'Explicit native human authority is required', 403);
  };
  check();
  const { source: _, ...args } = input;
  if (action === 'routine-preview') {
    requireValue(Object.keys(args).every(key => ['cron', 'timezone'].includes(key)), 'invalid_request', 'Unsupported preview fields');
    return previewCron(args.cron, args.timezone);
  }
  if (action === 'routine-create' && args.targetBindingId === undefined && args.targetDirectory === undefined) {
    if (observationConfig && enrolmentDirectories(store, observationConfig).includes(bridge.identity.directory)) {
      args.targetDirectory = bridge.identity.directory;
    } else args.targetBindingId = binding.id;
  }
  return manageRoutine(store, api, { ...args, companyId: binding.config.companyId, action: action.slice(8) }, {
    check, observationConfig, routingContextFile, authority: { kind: 'native', bindingId: binding.id, conversationId: bridge.identity.conversationId,
      sessionCreatedAt: bridge.sessionCreatedAt, ...(!reading ? { sourceMessageId: source.id, sourceDigest: digest(source.text) } : {}) },
  });
}
