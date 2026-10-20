import { Rpc } from '@opencode/plugin/rpc';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string', minLength: 1, maxLength: 1024 };

// Diagnostic transport only. A client-supplied session/client ID is NOT proof of
// pane identity or human authority. No backend mutations are exposed by this spike.
export const RelaySpike = Rpc.define({
  id: 'herdr.relay.spike',
  methods: {
    inspect: {
      input: object({}),
      output: object({ version: string, directory: string, generation: string, tools: { type: 'array', items: string } }),
    },
    notify: {
      input: object({ clientId: string, sessionId: string, message: string }),
      output: object({ emitted: { type: 'boolean' } }),
    },
  },
  events: {
    notification: { schema: object({ clientId: string, sessionId: string, message: string }) },
  },
});
