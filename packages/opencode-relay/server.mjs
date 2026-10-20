import { Plugin } from '@opencode/plugin';
import { RelaySpike } from './rpc.mjs';
import { readFileSync } from 'node:fs';
import { call } from '../../src/client.mjs';
import { registerHumanProposals } from './human-proposals.mjs';
import { registerOperatorTools } from './operator-tools.mjs';
import { randomUUID } from 'node:crypto';

export default Plugin.define({
  id: 'herdr.relay.spike.server',
  async setup(ctx) {
    const generation = randomUUID();
    const closeProposals = ctx.options.humanProposals === true ? await registerHumanProposals(ctx) : null;
    let closeOperator, transform;
    try {
    closeOperator = ctx.options.humanProposals === true ? await registerOperatorTools(ctx) : null;
    transform = await ctx.tool.transform(editor => {
      editor.add({
        name: 'relay_spike_status',
        description: 'Read the isolated Relay v2 compatibility status. Does not dispatch or change work.',
        options: { codemode: false },
        input: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_input, context) {
          return { content: JSON.stringify({ version: ctx.app.version, sessionId: context.sessionID, mode: 'read_only_spike' }) };
        },
      });
      if (ctx.options.workerContextFile) {
        const worker = async (context, action, input) => {
          const connection = JSON.parse(readFileSync(ctx.options.workerContextFile, 'utf8'));
          if (connection.sessionId !== context.sessionID) throw new Error('Worker tool belongs to another exact conversation');
          const current = await call(connection, 'POST', '/work/current', { sessionId: context.sessionID });
          const payload = action === 'ask' ? { prompt: input.prompt, humanRequired: input.humanRequired ?? false } :
            action === 'submit' ? { candidate: input.candidate, summary: input.summary } : input.payload;
          const result = action === 'read' ? current : await call(connection, 'POST', `/work/${action}`, {
            executionId: current.execution.id, runId: current.execution.runId,
            ...(input.key ? { key: input.key } : {}), ...(payload ? { payload } : {}),
          });
          return { content: JSON.stringify(result) };
        };
        editor.add({ name: 'relay_work_read', description: 'Read your exact Relay execution and cancellation state.',
          options: { codemode: false }, input: { type: 'object', properties: {}, additionalProperties: false },
          execute: (input, context) => worker(context, 'read', input) });
        editor.add({ name: 'relay_children', description: 'Refresh direct child execution results and exact candidate revisions for inspection.',
          options: { codemode: false }, input: { type: 'object', properties: {}, additionalProperties: false },
          execute: (input, context) => worker(context, 'children', input) });
        editor.add({ name: 'relay_work_ask', description: 'Stage an asynchronous question. Finish this turn immediately after success.',
          options: { codemode: false }, input: { type: 'object', properties: {
            key: { type: 'string', minLength: 1 }, prompt: { type: 'string', minLength: 1, maxLength: 4000 }, humanRequired: { type: 'boolean' },
          }, required: ['key', 'prompt'], additionalProperties: false }, execute: (input, context) => worker(context, 'ask', input) });
        editor.add({ name: 'relay_work_submit', description: 'Stage an exact candidate and result. Finish this turn immediately after success.',
          options: { codemode: false }, input: { type: 'object', properties: {
            key: { type: 'string', minLength: 1 }, candidate: { type: 'string', minLength: 1, maxLength: 512 }, summary: { type: 'string', minLength: 1, maxLength: 16000 },
          }, required: ['key', 'candidate', 'summary'], additionalProperties: false }, execute: (input, context) => worker(context, 'submit', input) });
        for (const [name, action, properties, required, description] of [
          ['relay_delegate', 'delegate', { id: { type: 'string' }, taskId: { type: 'string' }, title: { type: 'string' },
            instructions: { type: 'string' }, targetAgentId: { type: 'string' }, reviewPolicy: { enum: ['none', 'human', 'agent'] }, reviewGrantId: { type: 'string' } },
          ['id', 'taskId', 'title', 'instructions', 'targetAgentId'], 'Delegate a direct child within the current explicit execution grant.'],
          ['relay_wait_children', 'wait-children', { childExecutionIds: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string' } } },
          ['childExecutionIds'], 'Stage a child wait. Finish this turn immediately after success.'],
          ['relay_delay', 'delay', { until: { type: 'string', format: 'date-time' }, reason: { type: 'string' } },
          ['until', 'reason'], 'Stage a delayed continuation. Finish this turn immediately after success.'],
          ['relay_review_child', 'review-child', { id: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 1 }, candidate: { type: 'string' },
            decision: { enum: ['accept', 'reject'] }, reason: { type: 'string', minLength: 1 } },
          ['id', 'expectedRevision', 'candidate', 'decision', 'reason'], 'Review the exact child candidate under an explicit human-granted parent reviewer scope.'],
        ]) editor.add({ name, description, options: { codemode: false }, input: { type: 'object', properties: {
          key: { type: 'string', minLength: 1 }, payload: { type: 'object', properties, required, additionalProperties: false },
        }, required: ['key', 'payload'], additionalProperties: false }, execute: (input, context) => worker(context, action, input) });
        const agent = async (context, action, input) => {
          const connection = JSON.parse(readFileSync(ctx.options.workerContextFile, 'utf8'));
          if (connection.sessionId !== context.sessionID) throw new Error('Agent tool belongs to another exact conversation');
          return { content: JSON.stringify(await call(connection, 'POST', `/agent/${action}`, input)) };
        };
        for (const [name, action, description] of [
          ['relay_task_list', 'tasks', 'List task records. Follow nextCursor to complete the traversal.'],
          ['relay_agents', 'agents', 'Discover agents across nodes. Directory records do not reserve execution.'],
        ]) editor.add({ name, description, options: { codemode: false }, input: { type: 'object', properties: {
          cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 },
        }, additionalProperties: false }, execute: (input, context) => agent(context, action, input) });
        for (const [name, action, description] of [
          ['relay_task_inspect', 'task', 'Inspect one exact task in the selected Tasks provider.'],
          ['relay_task_comments', 'comments', 'Read task comments with explicit traversal completeness.'],
          ['relay_task_relations', 'relations', 'Read supported task relationships. Check completeness and provider limitations.'],
        ]) editor.add({ name, description, options: { codemode: false }, input: { type: 'object', properties: {
          taskId: { type: 'string', minLength: 1 }, ...(action === 'comments' ? {
            cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          } : {}),
        }, required: ['taskId'], additionalProperties: false }, execute: (input, context) => agent(context, action, input) });
        editor.add({ name: 'relay_questions', description: 'Read pending questions addressed to this initiating agent.', options: { codemode: false },
          input: { type: 'object', properties: {}, additionalProperties: false }, execute: (input, context) => agent(context, 'questions', input) });
        for (const action of ['answer', 'forward']) editor.add({ name: `relay_agent_${action}`,
          description: action === 'answer' ? 'Answer an agent-addressed question within delegated authority. Never impersonates the human.' : 'Forward an unresolved question to the responsible human.',
          options: { codemode: false }, input: { type: 'object', properties: { id: { type: 'string' }, key: { type: 'string' },
            expectedRevision: { type: 'integer', minimum: 1 }, [action === 'answer' ? 'body' : 'reason']: { type: 'string', minLength: 1, maxLength: 4000 },
          }, required: ['id', 'key', 'expectedRevision', action === 'answer' ? 'body' : 'reason'], additionalProperties: false },
          execute: (input, context) => agent(context, action, input) });
      }
    });
    } catch (error) {
      try { await closeOperator?.(); } finally { await closeProposals?.(); }
      throw error;
    }
    let rpc;
    try {
      rpc = await ctx.rpc.register(RelaySpike, {
        inspect: async () => ({
          version: ctx.app.version, directory: ctx.location.directory, generation,
          tools: (await ctx.tool.list()).map(tool => tool.name),
        }),
        notify: async input => {
          await ctx.session.get({ sessionID: input.sessionId });
          await rpc.events.emit('notification', input);
          return { emitted: true };
        },
      });
    } catch (error) {
      await transform.dispose();
      await closeProposals?.();
      await closeOperator?.();
      throw error;
    }
    let closed = false;
    return async () => {
      if (closed) return;
      closed = true;
      try { await rpc.dispose(); } finally { try { await transform.dispose(); } finally {
        try { await closeProposals?.(); } finally { await closeOperator?.(); }
      } }
    };
  },
});
