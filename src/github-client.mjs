import { RelayError, requireValue } from './protocol.mjs';

export function githubClient({ token, fetch: request = fetch }) {
  requireValue(typeof token === 'string' && token, 'invalid_credentials', 'GitHub token required');
  return async (method, path, body) => {
    requireValue(/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(path) && !path.includes('://') && !path.includes('..') &&
      !path.includes('\\'), 'invalid_request', 'Repository API route required');
    const response = await request(new URL(path, 'https://api.github.com'), { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
        'Content-Type': 'application/json', 'User-Agent': 'herdr-relay/0.2' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new RelayError('github_error', `GitHub returned HTTP ${response.status}`, response.status);
    if (response.status === 204) return null;
    return response.json();
  };
}
