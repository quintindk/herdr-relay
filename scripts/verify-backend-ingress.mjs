// Read private contexts without printing credentials, redirects or response bodies.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { requireValue } from '../src/protocol.mjs';
import { ingressCheckPassed } from '../src/backend-ingress.mjs';

const { values } = parseArgs({ options: { url: { type: 'string' }, owner: { type: 'string' }, access: { type: 'string' } } });
const origin = new URL(values.url ?? 'https://relay.synthswarm.com');
requireValue(origin.protocol === 'https:' && !origin.username && !origin.password, 'invalid_url', 'HTTPS origin required');
const owner = JSON.parse(readFileSync(values.owner ?? join(homedir(), '.local/state/herdr-relay-backend/owner.json'), 'utf8'));
const env = Object.fromEntries(readFileSync(values.access ?? join(homedir(), '.config/portcullis/access.env'), 'utf8')
  .split('\n').flatMap(line => {
    const match = /^\s*(?:export\s+)?(CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) return [];
    const value = match[2];
    return [[match[1], /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value]];
  }));
requireValue(env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET, 'missing_access_credentials', 'Existing Access pair required');
const access = { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET };
let failed = false;
for (const [name, headers] of [
  ['unauthenticated', {}],
  ['actor_only', { Authorization: `Bearer ${owner.token}` }],
  ['access_only', access],
  ['access_and_actor', { ...access, Authorization: `Bearer ${owner.token}` }],
]) {
  try {
    const response = await fetch(new URL('/v1/info', origin), { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const contentType = response.headers.get('content-type') ?? '';
    let protocol;
    let relayDenied = false;
    if (contentType.includes('application/json')) {
      const body = await response.json();
      if (body.protocol === 'relay/0.2') protocol = body.protocol;
      relayDenied = body.code === 'unauthorised' && body.message === 'Valid node or user credential required';
    } else await response.body?.cancel();
    const passed = ingressCheckPassed(name, { status: response.status, protocol, relayDenied });
    console.log(JSON.stringify({ hostname: origin.hostname, check: name, status: response.status, protocol, relayDenied, passed }));
    if (!passed) failed = true;
  } catch (error) {
    console.log(JSON.stringify({ hostname: origin.hostname, check: name, error: error.cause?.code ?? error.name, passed: false }));
    failed = true;
  }
}
if (failed) process.exitCode = 1;
