import { Rpc } from '@opencode/plugin/rpc';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string', minLength: 1, maxLength: 1024 };

// Status/diagnostic transport and verified local driver discovery. A supplied
// session/client ID is not human authority. This transport never grants permission.
export const RelayRuntime = Rpc.define({
  id: 'herdr.relay.runtime',
  methods: {
    interactiveDriver: { input: object({ sessionId: string, herdrSocketPath: string }), output: object({ state: string }) },
    attachment: {
      input: object({ sessionId: string }),
      output: object({ sessionId: string, state: { enum: ['attached', 'not_attached', 'pending', 'unavailable'] },
        agentName: { type: ['string', 'null'] }, agentId: { type: ['string', 'null'] }, generation: { type: ['integer', 'null'], minimum: 0 }, obligations: { type: 'integer', minimum: 0 } }),
    },
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
