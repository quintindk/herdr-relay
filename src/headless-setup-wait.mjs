import { setTimeout as delay } from 'node:timers/promises';
import { call } from './client.mjs';

// Wait only on the original durable operation. Timeout is pending, never a
// fabricated failure or permission to create another worker/schedule.
export async function waitHeadlessSetup(connection, receipt, { signal, timeoutMs = 75000 } = {}) {
  if (receipt?.state !== 'recorded' || !receipt.receipt?.id) return receipt;
  const deadline = Date.now() + timeoutMs;
  let status;
  do {
    status = await call(connection, 'POST', '/agent/headless-status', { id: receipt.receipt.id }, { signal });
    if (status.state === 'blocked' || status.state === 'ready' && status.nextFiring && status.appliedRevision === status.revision) return status;
    await delay(250, undefined, { signal });
  } while (Date.now() < deadline);
  return { ...status, state: 'pending', blocker: status?.blocker ?? 'readiness_pending', retryOriginalKey: true };
}
