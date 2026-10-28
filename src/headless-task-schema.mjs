import { requireValue } from './protocol.mjs';

const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const revision = { type: 'integer', minimum: 0 };
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
export const headlessTaskPayloadSchemas = Object.freeze({
  'task.create': object({ title: text(512), description: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' } }, ['title']),
  'task.update': object({ id: text(256), expectedRevision: revision, changes: object({ title: text(512), description: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' } }, []) }, ['id', 'expectedRevision', 'changes']),
  'comment.create': object({ taskId: text(256), expectedRevision: revision, body: text(16000) }, ['taskId', 'expectedRevision', 'body']),
  'reference.attach': object({ id: text(256), expectedRevision: revision }, ['id', 'expectedRevision']),
});

function validate(value, schema, path) {
  requireValue(value !== undefined, 'invalid_headless_request', `Missing field: ${path}`);
  if (schema.type === 'object') {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_headless_request', `Expected object: ${path}`);
    for (const key of Object.keys(value)) requireValue(Object.hasOwn(schema.properties, key), 'invalid_headless_request', `Unsupported field: ${path}.${key}`);
    for (const key of schema.required) requireValue(Object.hasOwn(value, key), 'invalid_headless_request', `Missing field: ${path}.${key}`);
    for (const key of Object.keys(value)) validate(value[key], schema.properties[key], `${path}.${key}`);
  } else if (schema.type === 'integer') requireValue(Number.isSafeInteger(value) && value >= schema.minimum,
    'invalid_headless_request', `Expected non-negative integer: ${path}`);
  else requireValue(typeof value === 'string' && (schema.minLength === undefined || value.trim().length >= schema.minLength) &&
    (schema.maxLength === undefined || value.length <= schema.maxLength), 'invalid_headless_request', `Invalid text field: ${path}`);
}

export function validateHeadlessTaskPayload(operation, payload) {
  requireValue(Object.hasOwn(headlessTaskPayloadSchemas, operation), 'invalid_headless_request', 'Unsupported field value: operation');
  validate(payload, headlessTaskPayloadSchemas[operation], 'payload');
  return payload;
}

export const headlessTaskOperationVariants = Object.entries(headlessTaskPayloadSchemas).map(([operation, payload]) => ({
  properties: { operation: { const: operation }, payload }, required: ['operation', 'payload'],
}));
