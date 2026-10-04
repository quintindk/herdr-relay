import { createHash } from 'node:crypto';

export class RelayError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function requireValue(condition, code, message, status = 400) {
  if (!condition) throw new RelayError(code, message, status);
}

export function text(value, name) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= 65536,
    'invalid_request', `${name} must be a non-empty string`);
  return value;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const now = () => new Date().toISOString();

export function resultBody(run) {
  return `Herdr Relay submission\n\n${run.result.summary}\n\n` +
    `Candidate: ${run.result.candidate}\n\n` +
    `<!-- herdr-relay:${run.id}:${digest(run.result)} -->`;
}
