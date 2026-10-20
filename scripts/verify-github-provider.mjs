import { execFileSync } from 'node:child_process';
import { githubTasksProvider } from '../src/tasks-provider.mjs';

// Read-only live provider check through gh's existing authentication. Does not
// extract tokens or create test issues in the user's repository.
const repo = process.argv[2] ?? 'quintindk/herdr-relay';
const [owner, name] = repo.split('/');
const provider = githubTasksProvider(async (method, path) => {
  if (method !== 'GET') throw new Error('Read-only verification');
  return JSON.parse(execFileSync('gh', ['api', path.replace(/^\//, '')], { encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 }));
}, { owner, repo: name });
const page = await provider.listTasks({ limit: 10 });
console.log(JSON.stringify({ repository: repo, tasksReturned: page.items.length, complete: page.complete,
  hasNextCursor: page.nextCursor !== null, capabilities: provider.describeCapabilities(), writeVerification: false }, null, 2));
