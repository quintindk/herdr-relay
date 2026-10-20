import { readFileSync } from 'node:fs';
import { nativeBackendClient } from '../../src/backend-client.mjs';
import { proposalDigest, humanSource } from './human-proposals.mjs';

const text = { type: 'string', minLength: 1 };
const revision = { type: 'integer', minimum: 1 };
const taskChanges = { type: 'object', properties: { title: text, description: { type: 'string' },
  status: { enum: ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'] },
  priority: { enum: ['critical', 'high', 'medium', 'low'] }, parentId: { type: ['string', 'null'] },
  dependencies: { type: 'array', uniqueItems: true, maxItems: 100, items: text }, labels: { type: 'array', maxItems: 64, items: text },
}, additionalProperties: false };

export const proposedActions = Object.freeze({
  relay_enrol_folder: { action: 'agent.enrol_folder', properties: { id: text, expectedRevision: revision, directory: text }, required: ['id', 'expectedRevision', 'directory'] },
  relay_task_create: { action: 'task.create', properties: { id: text, ...taskChanges.properties }, required: ['id', 'title'] },
  relay_task_edit: { action: 'task.update', properties: { id: text, expectedRevision: revision, changes: taskChanges, comment: text }, required: ['id', 'expectedRevision', 'changes'] },
  relay_task_comment: { action: 'comment.create', properties: { id: text, taskId: text, body: text }, required: ['id', 'taskId', 'body'] },
  relay_execution_request: { action: 'execution.request', properties: { id: text, taskId: text, taskRevision: revision,
    originAgentId: text, originConversation: text, targetAgentId: text, instructions: text, reviewPolicy: { enum: ['none', 'human'] }, allowDelegation: { type: 'boolean' } },
    required: ['id', 'taskId', 'taskRevision', 'targetAgentId', 'instructions'] },
  relay_execution_cancel: { action: 'execution.cancel', properties: { id: text, expectedRevision: revision, reason: text }, required: ['id', 'expectedRevision', 'reason'] },
  relay_schedule_create: { action: 'schedule.install', properties: { id: text, expectedRevision: revision, definition: {
    type: 'object', properties: { nodeId: text, targetAgentId: text, targetFolder: text, targetConversationId: text, instructions: text, cron: text, at: { type: 'string', format: 'date-time' },
      timezone: text, enabled: { type: 'boolean' }, reviewPolicy: { enum: ['none', 'human'] }, intent: { enum: ['job', 'reminder'] }, expiresAt: { type: 'string', format: 'date-time' } },
    required: ['nodeId', 'instructions', 'enabled'], additionalProperties: false,
  } }, required: ['id', 'definition'] },
  relay_schedule_cancel: { action: 'schedule.cancel', properties: { id: text, expectedRevision: revision, reason: text }, required: ['id', 'expectedRevision', 'reason'] },
  relay_schedule_pause: { action: 'schedule.pause', properties: { id: text, expectedRevision: revision }, required: ['id', 'expectedRevision'] },
  relay_schedule_resume: { action: 'schedule.resume', properties: { id: text, expectedRevision: revision }, required: ['id', 'expectedRevision'] },
  relay_grant_review: { action: 'review.grant', properties: { id: text, parentExecutionId: text, reviewerAgentId: text }, required: ['id', 'parentExecutionId', 'reviewerAgentId'] },
  relay_revoke_review: { action: 'review.revoke', properties: { id: text, expectedRevision: revision }, required: ['id', 'expectedRevision'] },
});

export async function registerOperatorTools(ctx) {
  const registration = await ctx.tool.transform(editor => {
    if (ctx.options.readContextFile) {
      for (const [name, collection] of [['relay_task_list', 'tasks'], ['relay_agents', 'agents'], ['relay_schedules', 'schedules'],
        ['relay_questions', 'questions'], ['relay_reviews', 'executions']]) editor.add({ name,
        description: `Read native ${collection}. Results carry pagination/freshness. This never starts agents.`, options: { codemode: false },
        input: { type: 'object', properties: { cursor: text, limit: { type: 'integer', minimum: 1, maximum: 500 }, status: text, taskId: text }, additionalProperties: false },
        async execute(input) {
          const config = JSON.parse(readFileSync(ctx.options.readContextFile, 'utf8'));
          return { content: JSON.stringify(await nativeBackendClient(config)('GET', `/v1/${collection}?${new URLSearchParams(input)}`)) };
        },
      });
      editor.add({ name: 'relay_task_inspect', description: 'Read a full native task and its current revision.', options: { codemode: false },
        input: { type: 'object', properties: { id: text }, required: ['id'], additionalProperties: false },
        async execute({ id }) {
          return { content: JSON.stringify(await nativeBackendClient(JSON.parse(readFileSync(ctx.options.readContextFile, 'utf8')))
            ('GET', `/v1/tasks/${encodeURIComponent(id)}`)) };
        } });
    }
    for (const [name, definition] of Object.entries(proposedActions)) editor.add({ name,
      description: `Propose ${definition.action} from the current human instruction. Publication requires exact keyboard confirmation through /relay-decisions.`,
      options: { codemode: false }, input: { type: 'object', properties: definition.properties, required: definition.required, additionalProperties: false },
      async execute(input, context) {
        if (ctx.options.workerContextFile) throw new Error('Worker plugin cannot propose owner operations');
        if (!input || Object.keys(input).some(key => !Object.hasOwn(definition.properties, key)) ||
          definition.required.some(key => !Object.hasOwn(input, key))) throw new Error('Invalid operator proposal fields');
        const messages = await ctx.session.context({ sessionID: context.sessionID });
        const source = humanSource(messages.findLast(message => message.type === 'user'));
        if (source.text.length > 16000 || JSON.stringify(input).length > 32000) throw new Error('Operator proposal exceeds evidence bound');
        const proposal = { kind: 'command', action: definition.action, sessionId: context.sessionID,
          location: ctx.location.directory, source, payload: input, authority: 'proposal_only' };
        const id = proposalDigest(proposal);
        await ctx.storage.set(`human-proposal:${context.sessionID}:${id}`, { ...proposal, id });
        return { content: JSON.stringify({ state: 'proposed', id, action: definition.action, instruction: 'Inspect /relay-decisions. No mutation performed.' }) };
      },
    });
  });
  return registration.dispose;
}
