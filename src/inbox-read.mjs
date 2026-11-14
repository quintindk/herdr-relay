// Read acknowledgement is not an answer, review, publication retry or approval.
export const canMarkInboxRead = item => Boolean(item && !item.disabled &&
  ['run_result', 'reminder'].includes(item.kind) && item.action === 'notification.acknowledge');
