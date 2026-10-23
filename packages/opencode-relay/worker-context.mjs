import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

// Worker credentials remain exact-session contexts, never an owner context.
export function workerContextPath(options, sessionId) {
  let path = options.workerContextFile;
  if (options.workerDirectory) {
    const directory = resolve(options.workerDirectory);
    const index = JSON.parse(readFileSync(join(directory, 'worker-index.json'), 'utf8'));
    path = index.sessions[sessionId];
    if (!path) throw Object.assign(new Error('This conversation is not attached to a Relay enrolment'), { code: 'relay_not_attached' });
    if (dirname(resolve(path)) !== directory) throw new Error('Relay worker context is outside the approved directory');
  }
  if (!path) throw Object.assign(new Error('No scoped Relay worker context configured'), { code: 'relay_not_attached' });
  return path;
}

export function workerConnection(options, sessionId) {
  const connection = JSON.parse(readFileSync(workerContextPath(options, sessionId), 'utf8'));
  if (connection.sessionId !== sessionId) throw new Error('Relay credential belongs to another exact conversation');
  return connection;
}
