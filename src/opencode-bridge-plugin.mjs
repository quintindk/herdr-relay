import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { call } from './client.mjs';
import { tool } from '@opencode-ai/plugin';
import { digest } from './protocol.mjs';

const delegationArgs = {
  key: tool.schema.string().min(1), targetBindingId: tool.schema.string().min(1),
  title: tool.schema.string().min(1), description: tool.schema.string().min(1),
  relayReviewPolicy: tool.schema.enum(['human', 'none', 'agent_decides', 'coordinator']).optional(),
  grantId: tool.schema.string().min(1).optional(),
  parentTaskId: tool.schema.string().min(1).optional(),
};
const workerArgs = {
  key: tool.schema.string().min(1), mode: tool.schema.enum(['create', 'adopt']),
  repository: tool.schema.string().min(1), branch: tool.schema.string().optional(), base: tool.schema.string().optional(),
  label: tool.schema.string().optional(), directory: tool.schema.string().optional(), observedId: tool.schema.string().optional(),
  trustRepository: tool.schema.boolean().optional(),
};
const grantArgs = { key: tool.schema.string().min(1), parentTaskId: tool.schema.string().min(1), reviewerBindingId: tool.schema.string().min(1) };
const enrolArgs = {
  key: tool.schema.string().min(1), directory: tool.schema.string().min(1),
  observedId: tool.schema.string().min(1).optional(), reserved: tool.schema.boolean().optional(),
};

function taskTools(execute) {
  const id = tool.schema.string().min(1);
  const filters = {
    projectId: id.optional(),
    statuses: tool.schema.array(tool.schema.enum(['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'])).optional(),
    assigneeAgentId: id.optional(), assigneeUserId: id.optional(),
  };
  const pagination = { limit: tool.schema.number().int().min(1).max(999).optional(), cursor: id.optional() };
  const reference = { namespace: id, externalId: id };
  const externalReference = tool.schema.object({ ...reference, url: tool.schema.string().url().optional() }).strict();
  const timestamp = tool.schema.string().datetime({ offset: true }).describe('RFC3339 timestamp with timezone; at most millisecond precision');
  const fields = {
    title: id.optional(), description: tool.schema.string().optional(),
    priority: tool.schema.enum(['critical', 'high', 'medium', 'low']).optional(),
    status: tool.schema.enum(['backlog', 'todo', 'in_progress', 'blocked']).optional(),
    unblockDescriptor: tool.schema.object({
      owner: tool.schema.union([tool.schema.literal('board'), tool.schema.object({ userId: id }).strict()]),
      action: id.max(2000),
    }).strict().optional(),
  };
  const writeArgs = { key: id, taskId: id, expectedRevision: id.describe('Revision token from relay_task_inspect'), reason: id };
  return Object.fromEntries([
    ['list', {
      description: 'List tasks in this Relay company with filters and pagination, including terminal statuses. Read-only; no native message history or permission prompt. Follow nextCursor with unchanged filters until complete. Use relay_task_inspect for full task details; relay_tasks remains a legacy preview.',
      args: { ...filters, parentId: id.optional(), ...pagination },
    }],
    ['children', {
      description: 'List direct children of an exact task with filters and pagination. Read-only; no native message history or permission prompt. Follow nextCursor with unchanged filters until complete.',
      args: { taskId: id, ...filters, ...pagination },
    }],
    ['comments', {
      description: 'Read task comments with pagination. Read-only; no native message history or permission prompt. Follow nextCursor until complete.',
      args: { taskId: id, ...pagination, limit: tool.schema.number().int().min(1).max(499).optional() },
    }],
    ['activity', {
      description: 'Read task activity in an explicit RFC3339 [from,to) interval, optionally scoped to one task. Read-only; no native message history or permission prompt. Follow nextCursor with unchanged bounds until complete.',
      args: { taskId: id.optional(), from: timestamp, to: timestamp, ...pagination,
        limit: tool.schema.number().int().min(1).max(200).optional() },
    }],
    ['reference-lookup', {
      description: 'Look up a task by its exact external namespace and ID through Relay. Read-only; no native message history or permission prompt.',
      args: { payload: tool.schema.object(reference).strict() },
    }],
    ['reference-attach', {
      description: 'Attach an external reference to an existing task on explicit human instruction. Before calling, state the exact task, reference and reason visibly in chat; the permission popup does not show these details. Use the revision token from relay_task_inspect and reuse the key on retries.',
      args: { ...writeArgs, payload: externalReference },
    }],
    ['inspect', {
      description: 'Inspect an exact task and obtain its revision token before changing it. Read-only; no native message history, permission prompt or task writes. Resolve taskId from the paginated relay_task_list or legacy relay_tasks preview.',
      args: { taskId: id },
    }],
    ['create', {
      description: 'Create a human-owned task on explicit human instruction. Before calling, state the exact proposed task, fields, human owner (or company default) and reason visibly in chat; the permission popup does not show these details. Blocked tasks require an unblock owner and action. Reuse the key on retries. Does not assign an agent.',
      args: { key: id, externalReference: externalReference.optional(), payload: tool.schema.object({ ...fields, title: id,
        parentId: id.nullable().optional(), projectId: id.nullable().optional(), assigneeUserId: id.optional(),
      }).strict() },
    }],
    ['edit', {
      description: 'Edit a task on explicit human instruction. Before calling, state the exact task, proposed changes, owner and reason visibly in chat; the permission popup does not show these details. Use the revision token from relay_task_inspect as expectedRevision. Blocked tasks require an unblock owner and action. Cannot set done or cancelled or bypass agent review; use relay_task_cancel to cancel. Reuse the key on retries.',
      args: { ...writeArgs, payload: tool.schema.object({ ...fields,
        parentId: id.nullable().optional(), blockedByIssueIds: tool.schema.array(id).max(100).optional(),
      }).strict() },
    }],
    ['assign', {
      description: 'Change task ownership on explicit human instruction. Before calling, state the exact task, proposed human or agent owner (or unassignment) and reason visibly in chat; the permission popup does not show these details. Agent assignment may wake the agent. Supply exactly one nullable assigneeUserId or assigneeAgentId. Use the revision token from relay_task_inspect as expectedRevision and reuse the key on retries.',
      args: { ...writeArgs, payload: tool.schema.union([
        tool.schema.object({ assigneeUserId: id.nullable() }).strict(),
        tool.schema.object({ assigneeAgentId: id.nullable() }).strict(),
      ]) },
    }],
    ['complete', {
      description: 'Complete only a currently human-owned task on explicit human instruction. Before calling, state the exact task, proposed completion, human owner and reason visibly in chat; the permission popup does not show these details. Cannot bypass agent result review, pending interactions or dependencies. Use the revision token from relay_task_inspect as expectedRevision and reuse the key on retries. Accepts no payload.',
      args: writeArgs,
    }],
    ['cancel', {
      description: 'Cancel a task on explicit human instruction. Before calling, state the exact task and reason visibly in chat; the permission popup does not show these details. Use the revision token from relay_task_inspect and reuse the key on retries. Accepts no payload.',
      args: writeArgs,
    }],
    ['reopen', {
      description: 'Reopen a terminal task on explicit human instruction. Before calling, state the exact task, proposed status and reason visibly in chat; the permission popup does not show these details. Use the revision token from relay_task_inspect and reuse the key on retries.',
      args: { ...writeArgs, payload: tool.schema.object({ status: tool.schema.enum(['todo', 'in_progress']).optional() }).strict() },
    }],
    ['comment', {
      description: 'Add a task comment on explicit human instruction. Before calling, state the exact task, comment and reason visibly in chat; the permission popup does not show these details. Use the revision token from relay_task_inspect and reuse the key on retries.',
      args: { ...writeArgs, payload: tool.schema.object({ body: id }).strict() },
    }],
  ].map(([action, definition]) => [`relay_task_${action.replaceAll('-', '_')}`, tool({ ...definition, execute: execute(`task-${action}`) })]));
}

// Loaded by OpenCode, with a binding-scoped credential. Never uses Relay admin auth.
export default async function relayBridge({ client, directory }, options = {}) {
  if (process.env.HERDR_ENV !== '1') return {};
  if (options.configDirectory !== undefined) {
    if (!isAbsolute(options.configDirectory)) throw new Error('Bridge configDirectory must be absolute');
    return discoverBridge({ client, directory }, options.configDirectory);
  }
  const files = options.configFiles ?? (options.configFile ? [options.configFile] : []);
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) throw new Error('Bridge configFiles must be an array of paths');
  const candidates = files.map(file => JSON.parse(readFileSync(file, 'utf8'))).filter(config => config.directory === directory);
  if (!candidates.length) return {};
  // Multiple enrolled conversations may share a directory. Select by the live
  // calling pane's terminal/session, never by array order or directory alone.
  const { stdout } = await promisify(execFile)('herdr', ['agent', 'list'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const agents = JSON.parse(stdout).result?.agents;
  if (!Array.isArray(agents)) throw new Error('Invalid Herdr inventory');
  const own = agents.filter(agent => agent.pane_id === process.env.HERDR_PANE_ID);
  // On initial startup Herdr may not have the native session yet. A unique
  // directory candidate can initialise, but every action still verifies ownPane.
  const matching = candidates.length === 1 ? candidates : candidates.filter(config => own.length === 1 &&
    own[0].terminal_id === config.terminalId && own[0].agent_session?.value === config.conversationId);
  if (matching.length !== 1) throw new Error('No unique bridge configuration for this Herdr conversation');
  const config = matching[0];
  const epoch = randomUUID();
  let stopped = false, active, started = false, pinnedCreation, invocation, conflict = false, answering = false;
  let timer, nextDelay = 3000, failureDelay = 1000;
  const sdkOptions = () => ({ query: { directory }, signal: AbortSignal.timeout(5000), throwOnError: true });
  const ownPane = async () => {
    const { stdout } = await promisify(execFile)('herdr', ['agent', 'list'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const agents = JSON.parse(stdout).result?.agents;
    if (!Array.isArray(agents)) throw new Error('Invalid Herdr inventory');
    const matches = agents.filter(agent => agent.agent_session?.value === config.conversationId);
    const pane = matches[0];
    if (matches.length !== 1 || pane.agent !== 'opencode' || pane.agent_session.kind !== 'id' ||
      pane.terminal_id !== config.terminalId || pane.pane_id !== process.env.HERDR_PANE_ID || pane.cwd !== directory) throw new Error('Bridge placement changed');
  };
  const snapshot = async (includeMessages = true) => {
    await ownPane();
    const session = (await client.session.get({ ...sdkOptions(), path: { id: config.conversationId } })).data;
    if (session?.id !== config.conversationId || session.directory !== directory || session.time?.archived || session.revert ||
      !session.time?.created || (pinnedCreation && pinnedCreation !== session.time.created)) throw new Error('Native identity changed');
    pinnedCreation = session.time.created;
    const messages = includeMessages ? (await client.session.messages({ ...sdkOptions(), path: { id: config.conversationId } })).data : [];
    const statuses = (await client.session.status(sdkOptions())).data;
    if (!Array.isArray(messages) || !statuses || messages.some(m => m.info.sessionID !== config.conversationId)) throw new Error('Native snapshot unavailable');
    return { session, messages, idle: !statuses[config.conversationId] || statuses[config.conversationId].type === 'idle' };
  };
  const rpc = (action, snap, fields = {}) => call(config, 'POST', `/bridge/${action}`, {
    epoch, conversationId: config.conversationId, terminalId: config.terminalId,
    sessionCreatedAt: snap.session.time.created, idle: snap.idle, ...fields,
  });
  const relayDecision = async (action, args, context) => {
    if (context.sessionID !== config.conversationId || answering) throw new Error('Tool requires the enrolled conversation');
    answering = true;
    try {
      await active;
      const snap = await snapshot();
      const toolMessage = snap.messages.find(message => message.info.id === context.messageID);
      const sourceId = toolMessage?.info.role === 'assistant' ? toolMessage.info.parentID : toolMessage?.info.role === 'user' ? toolMessage.info.id : null;
      const source = [...snap.messages].reverse().find(message => message.info.role === 'user');
      if (!source || source.info.id !== sourceId) throw new Error('Current native user message could not be verified');
      const content = source.parts.filter(part => part.type === 'text' && !part.synthetic && !part.ignored).map(part => part.text).join('\n');
      if (!content.trim()) throw new Error('No current user text found');
      const list = action === 'answer' ? 'questions' : 'reviews';
      const pending = await rpc(list, snap);
      const retries = action === 'review' ? (pending.decisions ?? []).filter(item => item.sourceMessageId === sourceId &&
        item.sourceDigest === digest(content) && item.decision === args.decision &&
        (!args.interactionId || item.interactionId === args.interactionId)) : [];
      const candidates = retries.length ? retries : pending[list];
      const selected = args.interactionId ? candidates.find(item => item.interactionId === args.interactionId)
        : candidates.length === 1 ? candidates[0] : null;
      if (!selected) throw new Error('No unique pending item. List Relay questions/reviews and ask which issue the user means; never ask them to type an internal ID.');
      await context.ask({ permission: action === 'answer' ? 'relay_answer' : 'relay_review', patterns: [selected.interactionId], always: [],
        metadata: { ...selected, ...args, interactionId: selected.interactionId, sourceMessageId: sourceId, sourceText: content } });
      const fresh = await snapshot();
      const current = [...fresh.messages].reverse().find(message => message.info.role === 'user');
      const currentText = current?.parts.filter(part => part.type === 'text' && !part.synthetic && !part.ignored).map(part => part.text).join('\n');
      if (current?.info.id !== sourceId || currentText !== content) throw new Error('The user message changed; nothing was sent');
      return JSON.stringify(await rpc(action, fresh, { ...args, interactionId: selected.interactionId,
        ...(action === 'review' ? { candidate: selected.candidate } : {}),
        source: { id: sourceId, text: content, createdAt: source.info.time.created } }));
    } finally { answering = false; }
  };
  const delegate = async (args, context, action = 'delegate') => {
    if (context.sessionID !== config.conversationId || answering) throw new Error('Tool requires the enrolled conversation');
    answering = true;
    try {
      await active;
      const snap = await snapshot();
      const message = snap.messages.find(item => item.info.id === context.messageID);
      const sourceId = message?.info.role === 'assistant' ? message.info.parentID : message?.info.role === 'user' ? message.info.id : null;
      const source = [...snap.messages].reverse().find(item => item.info.role === 'user');
      const content = source?.parts.filter(part => part.type === 'text' && !part.synthetic && !part.ignored).map(part => part.text).join('\n');
      if (!source || source.info.id !== sourceId || !content?.trim()) throw new Error('Current native user message could not be verified');
      await context.ask({ permission: action === 'delegate' ? 'relay_delegate' : action === 'prepare-worker' ? 'relay_worker_prepare' :
        action === 'enrol-agent' ? 'relay_enrol_agent' : action.startsWith('task-') ? `relay_${action.replaceAll('-', '_')}` : 'relay_coordinator_review',
        patterns: [args.taskId ?? args.payload?.title ?? args.targetBindingId ?? args.repository ?? args.directory ?? args.parentTaskId ?? args.grantId], always: [],
        metadata: { ...args, sourceMessageId: sourceId, sourceText: content } });
      const fresh = await snapshot();
      const latest = [...fresh.messages].reverse().find(item => item.info.role === 'user');
      const latestText = latest?.parts.filter(part => part.type === 'text' && !part.synthetic && !part.ignored).map(part => part.text).join('\n');
      if (latest?.info.id !== sourceId || latestText !== content) throw new Error('User message changed; no delegation sent');
      return JSON.stringify(await rpc(action, fresh, { ...args, source: { id: sourceId, text: content, createdAt: source.info.time.created } }));
    } finally { answering = false; }
  };
  const notify = async snap => {
    const { notifications } = await rpc('notification-list', snap, { includeReviews: true });
    const notification = notifications.find(item => item.state === 'pending');
    if (!notification) return;
    const fresh = await snapshot(false);
    if (!fresh.idle || answering || stopped) return;
    const begun = await rpc('notification-begin', fresh, { id: notification.id, includeReviews: true });
    if (!begun.dispatch) return;
    // UI-only: never append to model history or start a new model turn.
    await client.tui.showToast({ ...sdkOptions(), body: {
      title: `${notification.identifier} ${notification.kind === 'review' ? 'awaiting your review' : 'completed'}`,
      message: `${notification.title}\n${notification.summary.slice(0, 500)}\n${notification.kind === 'review' ? 'Review here: relay_reviews' : 'Full result: relay_delegations'}`,
      variant: notification.kind === 'review' ? 'info' : 'success', duration: 15000,
    } });
    await rpc('notification-observe', fresh, { id: notification.id, announced: true });
  };
  const tick = () => {
    if (stopped || active) return;
    if (answering) { schedule(); return; }
    active = (async () => {
      nextDelay = 3000;
      let snap = await snapshot(false);
      const response = await rpc('poll', snap);
      let run = response.run;
      if (!run) {
        invocation = null; conflict = false;
        if (response.state === 'armed' && snap.idle) await notify(snap);
        return;
      }
      if (response.state !== 'armed') return;
      nextDelay = 1000;
      if (!run.invocation) {
        if (!snap.idle || run.cancellationRequested) return;
        snap = await snapshot();
        if (!snap.idle) return;
        const latest = [...snap.messages].reverse().find(message => message.info.role === 'user')?.info;
        const model = snap.session.model ? { providerID: snap.session.model.providerID, modelID: snap.session.model.id } : latest?.model;
        const agent = snap.session.agent ?? latest?.agent;
        if (!model?.providerID || !model?.modelID || !agent) return;
        // A second read narrows the idle/send race but is not an atomic reservation.
        const next = await snapshot();
        if (!next.idle || JSON.stringify(next.messages.map(m => m.info.id)) !== JSON.stringify(snap.messages.map(m => m.info.id))) return;
        snap = next;
        const begun = await rpc('begin', snap, { runId: run.id,
          priorUserIds: snap.messages.filter(m => m.info.role === 'user').map(m => m.info.id) });
        run = begun.run;
        invocation = run.invocation;
        if (begun.dispatch && invocation) {
          await client.session.promptAsync({ ...sdkOptions(), path: { id: config.conversationId }, body: {
            messageID: invocation.messageId, agent, model,
            ...(snap.session.model?.variant || latest?.variant ? { variant: snap.session.model?.variant ?? latest.variant } : {}),
            parts: [{ type: 'text', text: invocation.prompt }],
          } });
        }
      }
      invocation = run.invocation;
      if (!invocation) return;
      snap = await snapshot();
      // Keep exact prompt/tool/parent evidence, without exporting unrelated content.
      const messages = snap.messages.filter(message => message.info.role === 'user' || message.info.parentID === invocation.messageId)
        .map(message => ({ info: { id: message.info.id, sessionID: message.info.sessionID,
        role: message.info.role, parentID: message.info.parentID, time: message.info.time, summary: message.info.summary,
        finish: message.info.finish, ...(message.info.error ? { error: { name: message.info.error.name } } : {}) },
        parts: message.info.id === invocation.messageId || message.info.parentID === invocation.messageId
          ? message.parts.filter(part => part.type === 'text' || part.type === 'tool').map(part => part.type === 'text'
            ? { type: part.type, text: message.info.id === invocation.messageId ? part.text : '', synthetic: part.synthetic }
            : { type: 'tool', state: { status: part.state?.status }, metadata: { providerExecuted: part.metadata?.providerExecuted } }) : [],
      }));
      await rpc('observe', snap, { runId: run.id, conflict, snapshot: { idle: snap.idle, messages } });
    })().then(() => { failureDelay = 1000; }).catch(() => {
      // Lost replies retain durable intent. Back off unavailable/stale hosts
      // rather than repeatedly loading history and spawning discovery processes.
      failureDelay = Math.min(failureDelay * 2, 30000);
      nextDelay = failureDelay;
    }).finally(() => { active = null; schedule(); });
  };
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, nextDelay); timer.unref();
  };
  return {
    tool: {
      ...taskTools(action => async (args, context) => {
        if (context.sessionID !== config.conversationId) throw new Error('Tool requires the enrolled conversation');
        if (['task-inspect', 'task-list', 'task-children', 'task-comments', 'task-activity', 'task-reference-lookup'].includes(action)) {
          return JSON.stringify(await rpc(action, await snapshot(false), args));
        }
        return delegate(args, context, action);
      }),
      relay_enrolment_candidates: tool({ description: 'List exact observed agents available for enrolment. Read-only; listing does not grant enrolment authority.', args: {},
        async execute(_, context) {
          if (context.sessionID !== config.conversationId) throw new Error('Tool requires the enrolled conversation');
          return JSON.stringify(await rpc('enrolment-candidates', await snapshot(false)));
        } }),
      relay_enrol_agent: tool({ description: 'Enrol an exact observed agent only on explicit human instruction. State the directory, exact candidate and any reservation visibly before calling. Resolve observedId from relay_enrolment_candidates and reuse the key on retries. Enrolment is not task assignment.',
        args: enrolArgs, execute: (args, context) => delegate(args, context, 'enrol-agent') }),
      relay_tasks: tool({ description: 'Legacy task preview for this Relay company. Use relay_task_list for filtered, paginated reads. Read-only; does not assign or start work.', args: {},
        async execute(_, context) {
          if (context.sessionID !== config.conversationId) throw new Error('Tool requires the enrolled conversation');
          return JSON.stringify(await rpc('tasks', await snapshot(false)));
        } }),
      relay_coordinator_grant: tool({ description: 'Grant the assigned parent coordinator authority to review explicitly opted-in direct child tasks. Final parent review remains human. State parent, reviewer and direct-child scope visibly and obtain explicit human authorisation first. Does not change existing child policies.',
        args: grantArgs, execute: (args, context) => delegate(args, context, 'grant-review') }),
      relay_coordinator_revoke: tool({ description: 'Revoke an exact coordinator review grant from this originating chat on explicit human instruction. Retains decisions already confirmed.',
        args: { grantId: tool.schema.string().min(1) }, execute: (args, context) => delegate(args, context, 'revoke-review') }),
      relay_workers: tool({ description: 'List this chat\'s worker preparation receipts and verified adoption candidates in its authorised repository. Read-only.', args: {},
        async execute(_, context) {
          if (context.sessionID !== config.conversationId) throw new Error('Tool requires the enrolled conversation');
          return JSON.stringify(await rpc('workers', await snapshot(false)));
        } }),
      relay_worker_prepare: tool({ description: 'Prepare an isolated interactive Herdr worker or adopt an exact existing worker. State repository, mode, branch/base or exact adoption target and any trust request visibly before calling. Requires an operator-configured repository scope. Preparation does not assign work or grant cleanup rights. Reuse the key on retries; inspect relay_workers until ready before relay_delegate.',
        args: workerArgs, execute: (args, context) => delegate(args, context, 'prepare-worker') }),
      relay_agents: tool({ description: 'List ready Relay agents available for delegation. Resolve target binding IDs from this list, not from the user.', args: {},
        async execute(_, context) {
          if (context.sessionID !== config.conversationId) throw new Error('Tool requires the enrolled conversation');
          return JSON.stringify(await rpc('agents', await snapshot(false)));
        } }),
      relay_delegate: tool({ description: 'Create a task for another ready Relay agent and return completion to this chat. Before calling, state the exact target, task and review policy visibly in chat; the permission popup does not show these fields. Use a stable key per requested task and reuse it on retries. Human review is the default. Do not approve your own work.',
        args: delegationArgs, execute: delegate }),
      relay_delegations: tool({ description: 'Read tasks delegated from this exact chat and their current Relay results. Does not delegate again.', args: {},
        async execute(_, context) {
          if (context.sessionID !== config.conversationId) throw new Error('Tool requires the enrolled conversation');
          const snap = await snapshot(false);
          return JSON.stringify({ ...await rpc('delegation-status', snap), ...await rpc('notification-history', snap) });
        } }),
      relay_questions: {
        description: 'List pending Relay clarification questions for this conversation. Resolve internal IDs yourself; do not ask the user to copy them. Read-only.',
        args: {},
        async execute(_, context) {
          if (context.sessionID !== config.conversationId) throw new Error('Tool is scoped to the enrolled conversation');
          return JSON.stringify(await rpc('questions', await snapshot(false)));
        },
      },
      relay_answer: tool({
        description: 'Record the human\'s answer to a pending Relay clarification. Interpret natural language and minor typos, not hypothetical discussion. Omit interactionId when exactly one question is pending; otherwise resolve it with relay_questions. Never require a command or UUID from the user. Permission-check the proposed answer, then end this turn and let Paperclip continue the task.',
        args: { answer: tool.schema.string().min(1).max(4000), interactionId: tool.schema.string().optional() },
        execute: (args, context) => relayDecision('answer', args, context),
      }),
      relay_reviews: {
        description: 'List pending exact candidate reviews for this enrolled conversation. Read-only; resolve internal IDs without asking the user to type them.', args: {},
        async execute(_, context) {
          if (context.sessionID !== config.conversationId) throw new Error('Tool is scoped to the enrolled conversation');
          return JSON.stringify(await rpc('reviews', await snapshot(false)));
        },
      },
      relay_review: tool({
        description: 'Relay an explicit human accept/reject decision (including obvious typos such as accpeted) for the current result. Never approve your own work or interpret hypothetical discussion as approval. Omit interactionId for one pending review; otherwise resolve with relay_reviews and clarify by issue name. Permission-check the exact candidate and decision, then end this turn; Relay owns issue completion.',
        args: { decision: tool.schema.enum(['accept', 'reject']), interactionId: tool.schema.string().optional(), reason: tool.schema.string().max(4000).optional() },
        execute: (args, context) => relayDecision('review', args, context),
      }),
    },
    async config() { if (!started) { started = true; tick(); } },
    async 'chat.message'(input, output) {
      if (input.sessionID === config.conversationId && invocation && (input.messageID ?? output.message.id) !== invocation.messageId) conflict = true;
    },
    async dispose() { stopped = true; clearTimeout(timer); await active; },
  };
}

// Keep one exact-conversation plugin alive. Discovery never grants enrolment authority.
async function discoverBridge(input, configDirectory) {
  let hooks, selected, conversationId, timer, pending, stopped = false;
  const waiters = new Set();
  const refresh = async () => {
    if (stopped) return;
    const { stdout } = await promisify(execFile)('herdr', ['agent', 'list'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const agents = JSON.parse(stdout).result?.agents;
    if (!Array.isArray(agents)) throw new Error('Invalid Herdr inventory');
    const matches = agents.filter(agent => agent.pane_id === process.env.HERDR_PANE_ID && agent.agent === 'opencode' &&
      agent.cwd === input.directory && agent.agent_session?.kind === 'id');
    let files = [];
    try { files = readdirSync(configDirectory).filter(name => name.endsWith('.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const configs = matches.length === 1 ? files.map(name => {
      const path = join(configDirectory, name);
      return { path, config: JSON.parse(readFileSync(path, 'utf8')) };
    }).filter(({ config }) => config.directory === input.directory && config.terminalId === matches[0].terminal_id &&
      config.conversationId === matches[0].agent_session.value) : [];
    const next = configs.length === 1 ? configs[0] : null;
    // Missing discovery is not replacement proof. Preserve the epoch so an
    // in-flight invocation can settle when the same placement reappears.
    if (!next) return;
    const identity = next && JSON.stringify(next.config);
    if (identity === selected) return;
    const loaded = await relayBridge(input, { configFile: next.path });
    if (!loaded.tool) return;
    if (stopped) { await loaded.dispose(); return; }
    await hooks?.dispose();
    if (stopped) { await loaded.dispose(); return; }
    hooks = loaded; selected = identity; conversationId = next.config.conversationId;
    await hooks.config();
  };
  const tick = () => {
    if (stopped || pending) return;
    clearTimeout(timer);
    pending = refresh().catch(() => {}).finally(() => {
      pending = undefined;
      for (const ready of waiters) ready();
      if (!stopped) { timer = setTimeout(tick, waiters.size ? 1000 : 5000); timer.unref(); }
    });
  };
  const execute = name => async (args, context) => {
    let timeout, ready;
    try {
      const current = await new Promise((resolve, reject) => {
        ready = () => {
          if (stopped) reject(new Error('Relay bridge is disposed'));
          else if (hooks && conversationId === context.sessionID) resolve(hooks);
          else return;
          waiters.delete(ready);
        };
        if (stopped) { ready(); return; }
        waiters.add(ready);
        timeout = setTimeout(() => reject(new Error('Relay bridge is not enrolled for this chat yet. Tool requires the enrolled conversation. Check Relay agent readiness.')), 12000);
        tick();
      });
      if (stopped) throw new Error('Relay bridge is disposed');
      // Only discovery is retried. Permission checks and mutations execute once.
      return current.tool[name].execute(args, context);
    } finally { clearTimeout(timeout); waiters.delete(ready); }
  };
  return {
    tool: {
      ...taskTools(action => execute(`relay_${action.replaceAll('-', '_')}`)),
      relay_enrolment_candidates: tool({ description: 'List exact observed agents available for enrolment. Read-only; listing does not grant enrolment authority.', args: {}, execute: execute('relay_enrolment_candidates') }),
      relay_enrol_agent: tool({ description: 'Enrol an exact observed agent only on explicit human instruction. State the directory, exact candidate and any reservation visibly before calling. Resolve observedId from relay_enrolment_candidates and reuse the key on retries. Enrolment is not task assignment.',
        args: enrolArgs, execute: execute('relay_enrol_agent') }),
      relay_tasks: tool({ description: 'Legacy task preview for this Relay company. Use relay_task_list for filtered, paginated reads. Read-only; does not assign or start work.', args: {}, execute: execute('relay_tasks') }),
      relay_coordinator_grant: tool({ description: 'Grant explicit human-authorised direct-child review to the parent assignee. State parent/reviewer/scope visibly. Final parent review remains human; existing child policies do not change.',
        args: grantArgs, execute: execute('relay_coordinator_grant') }),
      relay_coordinator_revoke: tool({ description: 'Revoke a coordinator review grant on explicit human instruction from this exact origin chat.',
        args: { grantId: tool.schema.string().min(1) }, execute: execute('relay_coordinator_revoke') }),
      relay_workers: tool({ description: 'List scoped worker preparations and verified worktree adoption candidates. Read-only.', args: {}, execute: execute('relay_workers') }),
      relay_worker_prepare: tool({ description: 'Create an isolated interactive Herdr worker or adopt an exact existing worktree agent. State repository, mode, branch/base or exact adoption target and any trust request before calling. Preparation is not task assignment or cleanup authority. Reuse the key on retries and inspect relay_workers for readiness.',
        args: workerArgs, execute: execute('relay_worker_prepare') }),
      relay_agents: tool({ description: 'List ready Relay agents available for delegation.', args: {}, execute: execute('relay_agents') }),
      relay_delegate: tool({ description: 'Delegate a task to another ready Relay agent, with completion returned to this chat. Before calling, state the exact target, task and review policy visibly in chat; the permission popup does not show these fields. Resolve targetBindingId using relay_agents. Reuse the same key for retries. Human review is the default.',
        args: delegationArgs, execute: execute('relay_delegate') }),
      relay_delegations: tool({ description: 'Read tasks delegated from this exact chat and their results.', args: {}, execute: execute('relay_delegations') }),
      relay_questions: tool({ description: 'List pending Relay clarification questions for this chat.', args: {}, execute: execute('relay_questions') }),
      relay_reviews: tool({ description: 'List pending exact candidate reviews for this chat.', args: {}, execute: execute('relay_reviews') }),
      relay_answer: tool({ description: 'Record an explicit human answer to a pending Relay clarification, with permission and native source checks.',
        args: { answer: tool.schema.string().min(1).max(4000), interactionId: tool.schema.string().optional() }, execute: execute('relay_answer') }),
      relay_review: tool({ description: 'Record an explicit human accept/reject decision for a Relay candidate. Never approve your own work.',
        args: { decision: tool.schema.enum(['accept', 'reject']), interactionId: tool.schema.string().optional(), reason: tool.schema.string().max(4000).optional() }, execute: execute('relay_review') }),
    },
    async config() { if (!timer && !pending) tick(); },
    async 'chat.message'(input, output) { await hooks?.['chat.message'](input, output); },
    async dispose() {
      stopped = true; clearTimeout(timer);
      for (const ready of waiters) ready();
      await pending; await hooks?.dispose();
    },
  };
}
