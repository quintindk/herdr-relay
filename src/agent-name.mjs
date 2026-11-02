import { requireValue } from './protocol.mjs';

export function agentName(value) {
  requireValue(typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 256 &&
    !/[\x00-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/.test(value),
  'invalid_agent_name', 'Use a single-line agent name of 1–256 characters without surrounding whitespace or control characters');
  return value;
}
