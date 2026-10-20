// Intent is persisted by Relay before sending. A lost response is reconciled from
// the exact message, never retried merely because the conversation is idle.
export async function deliverCompletionTurn({ notification, snapshot, rpc, client, sdkOptions, conversationId, unavailable }) {
  const snap = await snapshot();
  const existing = snap.messages.find(message => message.info.id === notification.messageId);
  if (existing) {
    await rpc('notification-turn-observe', snap, { id: notification.id, message: existing });
    return;
  }
  if (notification.turnState !== 'pending' || !snap.idle || unavailable()) return;
  const latest = [...snap.messages].reverse().find(message => message.info.role === 'user')?.info;
  const model = snap.session.model ? { providerID: snap.session.model.providerID, modelID: snap.session.model.id } : latest?.model;
  const agent = snap.session.agent ?? latest?.agent;
  if (!agent || !model?.providerID || !model?.modelID) return;
  const fresh = await snapshot();
  if (!fresh.idle || unavailable() || JSON.stringify(fresh.messages.map(message => message.info.id)) !==
    JSON.stringify(snap.messages.map(message => message.info.id))) return;
  const begun = await rpc('notification-turn-begin', fresh, { id: notification.id });
  if (!begun.dispatch) return;
  await client.session.promptAsync({ ...sdkOptions(), path: { id: conversationId }, body: {
    messageID: notification.messageId, agent, model,
    ...(snap.session.model?.variant || latest?.variant ? { variant: snap.session.model?.variant ?? latest.variant } : {}),
    parts: [{ type: 'text', text: notification.turnText }],
  } });
  const receipt = await snapshot();
  const message = receipt.messages.find(item => item.info.id === notification.messageId);
  if (message) await rpc('notification-turn-observe', receipt, { id: notification.id, message });
}
