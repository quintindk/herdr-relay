import { readdirSync, readFileSync } from 'node:fs';
import { requireValue } from './protocol.mjs';

/** Inspect an owned Linux process group without signalling or adopting it. */
export function processGroupMembers(groupId) {
  requireValue(Number.isSafeInteger(groupId) && groupId > 1, 'runtime_identity_mismatch', 'Valid owned process group required');
  const members = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const fields = readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ')[1].split(' ');
      if (Number(fields[2]) === groupId && fields[0] !== 'Z') members.push({ pid: Number(entry), start: fields[19] });
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  return members;
}
