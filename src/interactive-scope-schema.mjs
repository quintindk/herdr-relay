const boolean = { type: 'boolean' };
export const interactiveScopeSchema = { type: 'object', properties: {
  mode: { enum: ['roots'] }, roots: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', maxLength: 4096 } },
  profiles: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', maxLength: 64 } },
  allowNewEnrolments: boolean, allowCreateDirectories: boolean, allowReplacement: boolean, allowDispatch: boolean,
  maxAgents: { type: 'integer', minimum: 1, maximum: 100,
    description: 'Node-wide enrolment ceiling, not the number of agents this request may create. Omit to inherit the joined node ceiling. Approve once binds permission to one saved preparation.' },
  reviewPolicy: { enum: ['none', 'human'] }, expiresAt: { type: 'string', format: 'date-time' },
}, additionalProperties: false };
