import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { requireValue } from './protocol.mjs';

export function enrolledDirectory(binding) {
  const directory = binding.identity?.directory ?? binding.directory;
  requireValue(typeof directory === 'string' && isAbsolute(directory) && realpathSync(directory) === directory,
    'invalid_directory', 'Folder enrolment requires a canonical existing directory');
  return directory;
}

// Resolve only explicit bindings. Discovery records and matching display names
// never enrol a conversation. Multiple candidates are ambiguous, even if one is idle.
export async function resolveFolderBinding(bindings, directory, resolveBinding) {
  const candidates = [...bindings.entries()].filter(([, binding]) =>
    (binding.identity?.directory ?? binding.directory) === directory);
  if (candidates.length !== 1) return null;
  const [agentId] = candidates[0];
  const binding = await resolveBinding(agentId);
  if (!binding || enrolledDirectory(binding) !== directory) return null;
  return { ...binding, agentId };
}
