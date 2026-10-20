import { nativeTasksProvider, githubTasksProvider } from './tasks-provider.mjs';
import { paperclipTasksProvider } from './paperclip-provider.mjs';
import { requireValue } from './protocol.mjs';

export function selectTasksProvider(config, { nativeApi, paperclipApi, githubApi, journal }) {
  requireValue(config && ['native', 'paperclip', 'github'].includes(config.type), 'invalid_provider', 'Choose one Tasks provider');
  if (config.type === 'native') {
    requireValue(nativeApi, 'provider_unavailable', 'Native API required');
    return nativeTasksProvider(nativeApi);
  }
  if (config.type === 'paperclip') {
    requireValue(paperclipApi, 'provider_unavailable', 'Paperclip API required');
    return paperclipTasksProvider(paperclipApi, { ...config, journal });
  }
  requireValue(githubApi, 'provider_unavailable', 'GitHub API required');
  return githubTasksProvider(githubApi, { ...config, journal });
}

// Only the provider boundary is selectable yet. Native collaboration execution
// integration must be migrated before exposing this as a production node switch.
