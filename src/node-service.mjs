import { createServer } from 'node:http';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { digest, requireValue, RelayError, canonical } from './protocol.mjs';
import { nativeTasksProvider } from './tasks-provider.mjs';

// Worker credentials are exact agent scopes. They confer neither owner backend
// access nor authority over a different node's execution.
export async function startNodeService({ journal, socketPath, workers, api, tasks }) {
  tasks ??= api ? { ...nativeTasksProvider(api), type: 'native' } : null;
  requireValue(!existsSync(socketPath), 'socket_exists', 'Node socket already exists. Verify the old service before removing it');
  const server = createServer(async (req, res) => {
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const worker = workers.find(item => digest(item.token) === digest(token));
      requireValue(worker && token, 'unauthorised', 'Worker credential required', 401);
      requireValue(req.method === 'POST', 'invalid_request', 'POST required');
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length; requireValue(size <= 128 * 1024, 'request_too_large', 'Request too large', 413); chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { throw new RelayError('invalid_json', 'JSON request required'); }
      requireValue(body && typeof body === 'object' && !Array.isArray(body), 'invalid_request', 'Object required');
      const path = new URL(req.url, 'http://node').pathname;
      if (path === '/agent/notifications') {
        requireValue(Object.keys(body).length === 0, 'invalid_request', 'No notification scope override supported');
        const items = journal.db.prepare('SELECT data FROM local_notifications ORDER BY id').all().map(row => JSON.parse(row.data));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ items, complete: true })); return;
      }
      if (['/agent/tasks', '/agent/agents'].includes(path)) {
        requireValue((path.endsWith('tasks') ? tasks : api) && Object.keys(body).every(key => ['cursor', 'limit'].includes(key)), 'invalid_request', 'Only pagination fields are supported');
        const query = new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]));
        let result;
        try { result = path.endsWith('tasks') ? await tasks.listTasks(body) : await api('GET', `/v1/agents?${query}`); }
        catch (error) {
          if (error.status && error.status < 500) throw error;
          if (path.endsWith('tasks') && tasks.type !== 'native') throw error;
          const limit = body.limit ?? 100;
          requireValue(Number.isInteger(limit) && limit > 0 && limit <= 500, 'invalid_query', 'Bounded cache limit required');
          result = { items: journal.cached(path.endsWith('tasks') ? 'task' : 'agent').slice(0, limit).map(item => ({ ...item.entity, fetchedAt: item.fetchedAt })),
            complete: false, nextCursor: null, stale: true, warnings: ['Backend unavailable. Local event cache is incomplete, bounded and not current.'] };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (['/agent/task', '/agent/comments', '/agent/relations'].includes(path)) {
        requireValue(tasks && typeof body.taskId === 'string' && body.taskId && Object.keys(body).every(key =>
          (path === '/agent/comments' ? ['taskId', 'cursor', 'limit'] : ['taskId']).includes(key)),
        'invalid_request', 'Exact task ID and supported pagination required');
        const operation = path === '/agent/task' ? 'getTask' : path === '/agent/comments' ? 'listComments' : 'listRelations';
        requireValue(typeof tasks[operation] === 'function', 'unsupported_operation', 'Selected Tasks provider does not support this read');
        const { taskId, ...query } = body;
        const result = await tasks[operation](taskId, query);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (path === '/work/current') {
        requireValue(typeof worker.sessionId === 'string' && body.sessionId === worker.sessionId && Object.keys(body).length === 1,
          'forbidden', 'Exact enrolled native session required', 403);
        const candidates = journal.works().filter(work => work.execution.targetAgentId === worker.agentId &&
          ['intent', 'observing', 'uncertain', 'native_finished'].includes(work.state) && work.execution.state === 'accepted');
        requireValue(candidates.length === 1, 'work_ambiguous', 'One active worker execution required', 409);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ execution: candidates[0].execution, answer: candidates[0].answer ?? null })); return;
      }
      if (path === '/work/children') {
        const parent = journal.work(body.executionId);
        requireValue(api && parent?.execution.targetAgentId === worker.agentId && parent.execution.runId === body.runId,
          'forbidden', 'Exact parent execution required', 403);
        const items = [];
        let cursor;
        do {
          const page = await api('GET', `/v1/executions?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`);
          items.push(...page.items.filter(item => item.parentExecutionId === parent.id)); cursor = page.nextCursor;
        } while (cursor);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ items, complete: true })); return;
      }
      if (['/agent/questions', '/agent/answer', '/agent/forward'].includes(path)) {
        requireValue(api, 'backend_unavailable', 'Agent interaction connector unavailable', 503);
        let result;
        if (path === '/agent/questions') {
          requireValue(Object.keys(body).length === 0, 'invalid_request', 'Question inbox takes no overrides');
          const items = [];
          let cursor;
          do {
            const query = new URLSearchParams({ status: 'open', limit: '100', ...(cursor ? { cursor } : {}) });
            const page = await api('GET', `/v1/questions?${query}`);
            items.push(...page.items.filter(q => q.addressedTo.type === 'agent' && q.addressedTo.id === worker.agentId));
            cursor = page.nextCursor;
          } while (cursor);
          result = { items, complete: true };
        } else {
          requireValue(Object.keys(body).every(key => ['id', 'expectedRevision', 'key', 'body', 'reason'].includes(key)) &&
            typeof body.id === 'string' && body.id && typeof body.key === 'string', 'invalid_request', 'Exact question, revision and key required');
          const action = path === '/agent/answer' ? 'question.answer' : 'question.forward';
          const payload = { id: body.id, expectedRevision: body.expectedRevision, agentId: worker.agentId,
            ...(action === 'question.answer' ? { body: body.body } : { reason: body.reason }) };
          const command = { key: `agent:${worker.agentId}:${body.key}`, action, payload };
          journal.queue(command); await journal.flush(api);
          result = journal.receipt(command.key);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      const work = journal.work(body.executionId);
      requireValue(work && work.execution.targetAgentId === worker.agentId && work.execution.runId === body.runId,
        'forbidden', 'Exact current worker execution required', 403);
      let result;
      if (path === '/work/read') result = { execution: work.execution, localState: work.state,
        answer: work.answer ?? null, cancellationRequested: work.execution.cancellationRequested };
      else if (path === '/work/delegate') {
        requireValue(api && work.execution.allowDelegation && work.execution.state === 'accepted' && !work.execution.cancellationRequested &&
          !work.staged, 'delegation_not_authorised', 'Current execution needs an explicit delegation grant', 403);
        requireValue(Object.keys(body).every(key => ['executionId', 'runId', 'key', 'payload'].includes(key)) && body.payload &&
          typeof body.key === 'string' && body.key.trim() &&
          Object.keys(body.payload).every(key => ['taskId', 'id', 'title', 'instructions', 'targetAgentId', 'reviewPolicy', 'reviewGrantId'].includes(key)),
        'invalid_request', 'Unsupported delegation fields');
        const command = { key: `delegate:${worker.agentId}:${body.key}`, action: 'execution.delegate', payload: {
          ...body.payload, parentExecutionId: work.id, expectedRevision: work.execution.revision,
        } };
        journal.queue(command); await journal.flush(api); result = journal.receipt(command.key);
      }
      else if (path === '/work/review-child') {
        requireValue(api && work.execution.state === 'accepted' && !work.execution.cancellationRequested && body.payload,
          'review_not_authorised', 'Current parent execution required', 403);
        requireValue(Object.keys(body.payload).every(key => ['id', 'expectedRevision', 'candidate', 'decision', 'reason'].includes(key)) &&
          typeof body.key === 'string' && body.key, 'invalid_request', 'Exact candidate decision required');
        const command = { key: `agent-review:${worker.agentId}:${body.key}`, action: 'execution.agent_review',
          payload: { ...body.payload, reviewerExecutionId: work.id, reviewerRunId: work.execution.runId } };
        journal.queue(command); await journal.flush(api); result = journal.receipt(command.key);
      }
      else if (['/work/ask', '/work/submit', '/work/wait-children', '/work/delay'].includes(path)) {
        requireValue(['intent', 'observing', 'uncertain', 'native_finished'].includes(work.state) &&
          !work.execution.cancellationRequested && work.execution.state === 'accepted', 'execution_inactive', 'Current worker turn required');
        requireValue(Object.keys(body).every(key => ['executionId', 'runId', 'key', 'payload'].includes(key)) &&
          typeof body.key === 'string' && body.key.length > 0 && body.payload && typeof body.payload === 'object', 'invalid_request', 'Key and payload required');
        let kind = path === '/work/ask' ? 'question' : path === '/work/wait-children' ? 'children' : path === '/work/delay' ? 'delay' : 'result';
        requireValue(!work.execution.localOccurrence || ['result', 'question'].includes(kind), 'unsupported_operation', 'Scheduled work supports questions/results only');
        const allowed = kind === 'question' ? ['prompt', 'humanRequired'] : kind === 'children' ? ['childExecutionIds'] : kind === 'delay' ? ['until', 'reason'] : ['candidate', 'summary'];
        requireValue(Object.keys(body.payload).every(key => allowed.includes(key)) && (kind === 'delay' ?
          Number.isFinite(Date.parse(body.payload.until)) && typeof body.payload.reason === 'string' && body.payload.reason.trim() : kind === 'children' ?
          Array.isArray(body.payload.childExecutionIds) && body.payload.childExecutionIds.length > 0 && body.payload.childExecutionIds.length <= 64 &&
          body.payload.childExecutionIds.every(id => typeof id === 'string' && id.length > 0) : kind === 'question' ?
          typeof body.payload.prompt === 'string' && body.payload.prompt.trim() && body.payload.prompt.length <= 4000 &&
          (body.payload.humanRequired === undefined || typeof body.payload.humanRequired === 'boolean') :
          typeof body.payload.candidate === 'string' && body.payload.candidate.trim() && body.payload.candidate.length <= 512 &&
          typeof body.payload.summary === 'string' && body.payload.summary.trim() && body.payload.summary.length <= 16000),
        'invalid_request', 'Invalid worker outcome');
        if (kind === 'result' && work.execution.monitor) kind = 'monitor_result';
        const staged = { kind, key: body.key, payload: body.payload, runId: body.runId };
        journal.transaction(() => {
          const current = journal.work(work.id);
          requireValue(!current.staged || canonical(current.staged) === canonical(staged), 'operation_conflict', 'Worker outcome already recorded');
          journal.save({ ...current, staged });
        });
        result = { state: 'staged', nativeSettlementRequired: true, instruction: 'Finish this native turn without further work.' };
      } else throw new RelayError('not_found', 'Unknown worker route', 404);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error instanceof RelayError ? error.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: error.code ?? 'node_error', message: error instanceof RelayError ? error.message : 'Node request failed' }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  let closing;
  return { close: () => closing ??= new Promise(resolve => {
    server.close(() => { if (existsSync(socketPath)) unlinkSync(socketPath); resolve(); }); server.closeIdleConnections();
  }) };
}
