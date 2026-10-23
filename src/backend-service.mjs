import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BackendStore, backendProtocol } from './backend-store.mjs';
import { RelayError, requireValue } from './protocol.mjs';
import { interactiveAuthority } from './interactive-contract.mjs';
import { headlessAuthority, headlessProbeId } from './headless-setup-contract.mjs';
import { headlessExecutionScope, headlessReferenceLookup } from './headless-tasks.mjs';
import { bootstrapNode } from './node-bootstrap.mjs';
import { messageParticipant, queryMessages } from './agent-messages.mjs';
import { existsSync } from 'node:fs';
import { releaseVersion, compatibility } from './release-info.mjs';

const equal = (a, b) => {
  const x = Buffer.from(a ?? ''), y = Buffer.from(b ?? '');
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

export async function startBackend({ database, userId = 'owner', port = 0, ingressKeys = [], maintenanceFile }) {
  const store = new BackendStore(database, { userId });
  const server = createServer(async (req, res) => {
    try {
      if (ingressKeys.length) requireValue(ingressKeys.some(key => equal(req.headers['x-api-key'], key)),
        'unauthorised', 'Valid ingress key required', 401);
      const actor = store.authenticate(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      const url = new URL(req.url, 'http://relay');
      const maintenance = Boolean(maintenanceFile && existsSync(maintenanceFile));
      requireValue(req.method === 'GET' || !maintenance, 'maintenance', 'Backend upgrade maintenance is active. Retry the same immutable operation after it completes', 503);
      requireValue(req.url?.startsWith('/') && !req.url.startsWith('//'), 'invalid_request', 'Relative API path required');
      // Browser-originated writes are not part of this API. Harnesses use the
      // local credential connector; cross-site pages cannot borrow that context.
      requireValue(!req.headers.origin, 'origin_not_allowed', 'Browser Origin requests are not supported by the native API', 403);
      let result;
      if (req.method === 'GET' && url.pathname === '/v1/info') result = { protocol: backendProtocol, instanceId: store.instance, userId: store.owner,
        version: releaseVersion, compatibility, maintenance,
        features: { nodeMachineAdvertisement: true, interactiveProvisioning: true, scopedNodeBootstrap: true, agentMessages: true, agentMessageReplies: true, headlessSetup: true, headlessCapabilities: true } };
      else if (req.method === 'GET' && url.pathname === '/v1/identity') result = { type: actor.type, id: actor.id,
        credentialId: actor.credentialId, scope: actor.scope ?? null, instanceId: store.instance };
      else if (req.method === 'GET' && /^\/v1\/provision_requests\/[^/]+\/authority$/.test(url.pathname)) result = interactiveAuthority(store, actor, decodeURIComponent(url.pathname.split('/')[3]));
      else if (req.method === 'GET' && /^\/v1\/headless_setups\/[^/]+\/authority$/.test(url.pathname)) result = headlessAuthority(store, actor, decodeURIComponent(url.pathname.split('/')[3]));
      else if (req.method === 'GET' && url.pathname === '/v1/snapshot') result = store.snapshot();
      else if (req.method === 'GET' && /^\/v1\/messages(?:\/[^/]+)?$/.test(url.pathname)) {
        requireValue([...url.searchParams.keys()].every(k => ['agentId', 'direction', 'limit', 'cursor'].includes(k)), 'invalid_query', 'Unsupported message filter');
        const id = url.pathname.split('/')[3];
        requireValue(!id || url.searchParams.size === 0, 'invalid_query', 'Exact message inspection takes no collection filters');
        result = id ? messageParticipant(store, actor, store.get('message', decodeURIComponent(id))) : queryMessages(store, actor, {
          agentId: url.searchParams.get('agentId'), direction: url.searchParams.get('direction') ?? undefined,
          cursor: url.searchParams.get('cursor') ?? undefined, limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        });
      }
      else if (req.method === 'GET' && url.pathname === '/v1/activity') result = store.activity({
        from: url.searchParams.get('from'), to: url.searchParams.get('to'), taskId: url.searchParams.get('taskId') ?? undefined,
        cursor: url.searchParams.get('cursor') ?? undefined, limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
      });
      else if (req.method === 'GET' && url.pathname === '/v1/references') {
        const reference = { namespace: url.searchParams.get('namespace'), externalId: url.searchParams.get('externalId') };
        result = store.get('reference', store.referenceIdentity(reference), false);
      }
      else if (req.method === 'GET' && url.pathname === '/v1/events') result = store.events({ cursor: url.searchParams.get('cursor') ?? undefined,
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined });
      else if (req.method === 'GET' && /^\/v1\/(task|execution|question|agent|node|comment|schedule|occurrence|notification|monitor_result|artifact|provision_grant|provision_request|headless_grant|headless_setup)s(?:\/[^/]+)?$/.test(url.pathname)) {
        const [, plural, id] = url.pathname.split('/').slice(1);
        const kind = plural.slice(0, -1);
        requireValue([...url.searchParams.keys()].every(key => ['cursor', 'taskId', 'status', 'limit'].includes(key)),
          'invalid_query', 'Unsupported collection filters');
        result = id ? store.get(kind, decodeURIComponent(id)) : store.query(kind, {
          cursor: url.searchParams.get('cursor') ?? undefined, taskId: url.searchParams.get('taskId') ?? undefined,
          status: url.searchParams.get('status') ?? undefined, limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        });
      } else if (req.method === 'POST' && ['/v1/commands', '/v1/node-credentials', '/v1/node-credentials/rotate', '/v1/node-bootstrap', '/v1/headless/read'].includes(url.pathname)) {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          requireValue(size <= 128 * 1024, 'request_too_large', 'Request exceeds limit', 413);
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { throw new RelayError('invalid_json', 'JSON body required', 400); }
        if (url.pathname === '/v1/headless/read') {
          requireValue(body && ['access', 'references'].includes(body.operation), 'invalid_headless_request', 'Exact headless read operation required');
          const { operation, ...payload } = body;
          if (operation === 'references') result = headlessReferenceLookup(store, actor, payload);
          else {
            requireValue(Object.keys(payload).every(k => ['executionId', 'runId'].includes(k)), 'invalid_headless_request', 'Scope lookup takes no overrides');
            const scope = headlessExecutionScope(store, actor, payload);
            result = { id: scope.setup.id, directory: scope.setup.directory, profile: scope.profile, readiness: scope.execution.id === headlessProbeId(scope.setup) };
          }
        }
        else if (url.pathname === '/v1/node-bootstrap') result = bootstrapNode(store, actor, body);
        else if (url.pathname.startsWith('/v1/node-credentials')) {
          requireValue(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => ['nodeId', 'key'].includes(key)),
            'invalid_request', 'Only nodeId and issuance key are supported');
          result = url.pathname.endsWith('/rotate') ? store.rotateCredential(actor, body.nodeId, body.key) : store.enrolCredential(actor, body.nodeId, body.key);
        }
        else {
          requireValue(body && Object.keys(body).every(key => ['key', 'action', 'payload'].includes(key)), 'invalid_request', 'Unsupported command fields');
          result = store.command(actor, body);
        }
      } else throw new RelayError('not_found', 'Unknown backend route', 404);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error instanceof RelayError ? error.status : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ code: error.code ?? 'internal_error', message: error instanceof RelayError ? error.message : 'Backend request failed' }));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) { store.close(); throw error; }
  let closing;
  return { store, origin: `http://127.0.0.1:${server.address().port}`, close: () => closing ??= new Promise(resolve => {
    server.close(() => { store.close(); resolve(); }); server.closeIdleConnections();
  }) };
}
