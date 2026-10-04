// Paperclip process adapter: holds legitimate run context for an external conversation.
// This is evaluation bridge code, not a built-in persistent-session adapter.
import fs from 'node:fs';
const path = `/home/node/native-${process.env.PAPERCLIP_AGENT_ID}.json`;
fs.writeFileSync(path, JSON.stringify({ runId: process.env.PAPERCLIP_RUN_ID,
  token: process.env.PAPERCLIP_API_KEY, agentId: process.env.PAPERCLIP_AGENT_ID }), { mode: 0o600 });
for (let i = 0; i < 600; i++) {
  if (fs.existsSync(path + '.done')) process.exit(0);
  await new Promise(resolve => setTimeout(resolve, 500));
}
process.exit(2);
