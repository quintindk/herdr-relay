import { workerConnection } from './worker-context.mjs';
import { call } from '../../src/client.mjs';
import { runResultNotificationsSchema } from '../../src/run-result-notifications.mjs';
import { assertNotRunResultNotice } from './run-result-notice.mjs';

const text = { type: 'string', minLength: 1, maxLength: 256 };
export const headlessGrantInput = { type: 'object', properties: {
  id: text, name: text, requesterAgentId: text, nodeId: text, directory: { type: 'string', minLength: 1, maxLength: 4096 },
  model: { type: 'object', properties: { providerID: text, id: text, integrationID: text, connectionId: text },
    required: ['providerID', 'id', 'integrationID', 'connectionId'], additionalProperties: false },
  permissions: { type: 'object', properties: { mcp: { type: 'boolean' }, shell: { type: 'boolean' } }, required: ['mcp'], additionalProperties: false },
  contract: { type: 'string', minLength: 1, maxLength: 256 }, capabilities: { type: 'object', additionalProperties: true },
  schedule: { type: 'object', properties: { id: text, cron: text, timezone: text, reviewPolicy: { const: 'none' }, runResultNotifications: runResultNotificationsSchema },
    required: ['id', 'cron', 'timezone', 'reviewPolicy'], additionalProperties: false },
  expiresAt: { type: 'string', format: 'date-time' },
}, required: ['id', 'name', 'model', 'permissions', 'contract', 'schedule'], additionalProperties: false };

export function registerHeadlessGrantTools(editor, ctx, { connection = workerConnection, request = call } = {}) {
  editor.add({ name: 'relay_headless_connection',
    description: 'Preview or apply an explicit human-requested connection rebind for the original coordinator\'s existing headless setup. Uses the active sign-in on the destination native service for the unchanged provider/integration/model. Apply requires the exact preview hash and an immutable key. Preserves worker, session, permissions, approved instructions, cron and notifications. Runs bounded readiness and does not replay failed business work.',
    options: { codemode: false }, input: { type: 'object', properties: { operation: { enum: ['preview', 'apply'] }, setupId: text,
      key: { type: 'string', minLength: 1, maxLength: 100 }, previewHash: { type: 'string', minLength: 64, maxLength: 64 } },
    required: ['operation', 'setupId'], additionalProperties: false },
    async execute(input, context) {
      await assertNotRunResultNotice(ctx, context);
      const { operation, ...body } = input, worker = connection(ctx.options, context.sessionID);
      return { content: JSON.stringify(await request(worker, 'POST', `/agent/headless-connection-${operation === 'apply' ? 'rebind' : 'preview'}`, body)) };
    } });
  for (const operation of ['grant', 'revoke']) editor.add({ name: operation === 'grant' ? 'relay_headless_grant' : 'relay_headless_revoke',
    description: operation === 'grant' ? 'Create a headless grant for this enrolled interactive agent on its own node/workspace using its existing Relay identity, without an owner context. Requester, node and directory are inferred; supplied values must match. Use a stable key. Grant creation does not create a worker, activate a schedule or run a job.' :
      'Revoke this interactive agent\'s own headless grant using its existing Relay identity, without an owner context. Inspect the exact grant revision first. Pauses its installed schedule and blocks new dispatch, but cannot undo effects or stop processes already started.',
    options: { codemode: false }, input: { type: 'object', properties: { key: { type: 'string', minLength: 1, maxLength: 100 },
      payload: operation === 'grant' ? headlessGrantInput : { type: 'object', properties: { id: text, expectedRevision: { type: 'integer', minimum: 1 } }, required: ['id', 'expectedRevision'], additionalProperties: false },
    }, required: ['key', 'payload'], additionalProperties: false },
    async execute(input, context) {
      await assertNotRunResultNotice(ctx, context);
      const worker = connection(ctx.options, context.sessionID);
      return { content: JSON.stringify(await request(worker, 'POST', `/agent/headless-${operation}`, input)) };
    } });
}
