// Shared by the executable router and its OpenCode bridge. A new native root
// belongs here once, rather than in a second plugin command allowlist.
export const nativeAdministrationGroups = Object.freeze(['backend', 'node', 'plugin', 'doctor', 'tasks', 'headless', 'skills']);

export function nativeCliInvocation(args) {
  return args[0] === 'native' || args[0] === 'tui' || args[0] === 'upgrade' ||
    args[0] === 'release' ||
    nativeAdministrationGroups.includes(args[0]) && !(args[0] === 'backend' && args[1] === 'recover') ||
    args.length === 1 && ['--help', '--version'].includes(args[0]);
}
