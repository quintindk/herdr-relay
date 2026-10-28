// Shared by the executable router and its OpenCode bridge. A new native root
// belongs here once, rather than in a second plugin command allowlist.
export const nativeAdministrationGroups = Object.freeze(['backend', 'node', 'plugin', 'doctor', 'headless', 'skills']);
export const nativeCliCollections = Object.freeze({ task: 'tasks', 'task-reference': 'task_reference_grants', comment: 'comments',
  agent: 'agents', node: 'nodes', execution: 'executions', schedule: 'schedules', occurrence: 'occurrences', interactive: 'provision_requests' });

export function readOnlyCliInvocation(args) {
  const [group, action] = args.slice(1);
  return args[0] === 'native' && (Object.hasOwn(nativeCliCollections, group) && group !== 'task-reference' && ['list', 'inspect'].includes(action) ||
    group === 'task' && action === 'resolve');
}

export function nativeCliInvocation(args) {
  return args[0] === 'native' || args[0] === 'tui' || args[0] === 'upgrade' ||
    args[0] === 'release' ||
    nativeAdministrationGroups.includes(args[0]) ||
    args.length === 1 && ['--help', '--version'].includes(args[0]);
}

// Execution credentials permit data operations only. This guard lives in the
// CLI as well as the bridge, before any local lifecycle/admin command can run.
export function executionCliInvocation(args) {
  const [group, action] = args[0] === 'native' ? args.slice(1) : args;
  return args[0] === 'native' && (group === 'command' ||
    ['task', 'comment', 'agent', 'node', 'execution', 'schedule', 'occurrence'].includes(group) && ['list', 'inspect'].includes(action) ||
    group === 'task' && ['resolve', 'edit', 'comment'].includes(action));
}
