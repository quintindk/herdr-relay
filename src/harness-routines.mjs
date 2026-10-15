import { canonical, digest, requireValue } from './protocol.mjs';
import { isNotificationSource } from './completion-notifications.mjs';
import { manageRoutine, scheduleTargets } from './routines.mjs';
import { previewCron } from './cron-schedule.mjs';
import { enrolmentDirectories } from './enrolment.mjs';
import { createScheduleTarget } from './schedule-targets.mjs';

export async function harnessRoutine(store, bridge, action, input, api, { observationConfig, routingContextFile, stateDirectory, verifyRuntime, nativeSnapshot,
  provisionAgent: provision } = {}) {
  const reading = ['routine-preview', 'routine-targets', 'routine-list', 'routine-inspect'].includes(action);
  requireValue(['routine-preview', 'routine-targets', 'routine-target-create', 'routine-list', 'routine-inspect', 'routine-create', 'routine-pause',
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
  if (action === 'routine-targets') {
    requireValue(Object.keys(args).length === 0, 'invalid_request', 'Schedule target discovery accepts no fields');
    return scheduleTargets(store, api, binding.config.companyId);
  }
  if (action === 'routine-target-create') {
    return createScheduleTarget(store, api, observationConfig, args, { kind: 'native', bindingId: binding.id,
      conversationId: bridge.identity.conversationId, sessionCreatedAt: bridge.sessionCreatedAt }, check,
    { stateDirectory, ...(provision ? { provision } : {}) });
  }
  if (action === 'routine-create' && args.executionMode === undefined && args.targetAgentId === undefined) {
    if (args.targetDirectory !== undefined) args.executionMode = 'interactive_folder';
    else if (args.targetBindingId !== undefined) {
      if (store.binding(args.targetBindingId, false)?.config.delivery !== 'opencode') args.executionMode = 'interactive_exact';
      // Leave legacy Relay-managed headless targets implicit for compatibility.
    } else args.executionMode = observationConfig && enrolmentDirectories(store, observationConfig).includes(bridge.identity.directory)
      ? 'interactive_folder' : 'interactive_exact';
  }
  if (action === 'routine-create' && args.targetAgentId === undefined && args.targetBindingId === undefined && args.targetDirectory === undefined) {
    if (args.executionMode === 'interactive_folder') {
      requireValue(observationConfig && enrolmentDirectories(store, observationConfig).includes(bridge.identity.directory),
        'routine_scope_revoked', 'Interactive folder mode requires an enrolled folder', 409);
      args.targetDirectory = bridge.identity.directory;
    } else if (args.executionMode === 'interactive_exact') args.targetBindingId = binding.id;
    else requireValue(false, 'invalid_request', 'Headless mode requires an explicit Paperclip targetAgentId');
  }
  return manageRoutine(store, api, { ...args, companyId: binding.config.companyId, action: action.slice(8) }, {
    check, observationConfig, routingContextFile, ...(verifyRuntime ? { verifyRuntime } : {}), ...(nativeSnapshot ? { nativeSnapshot } : {}),
    authority: { kind: 'native', bindingId: binding.id, conversationId: bridge.identity.conversationId,
      sessionCreatedAt: bridge.sessionCreatedAt, ...(!reading ? { sourceMessageId: source.id, sourceDigest: digest(source.text) } : {}) },
  });
}
