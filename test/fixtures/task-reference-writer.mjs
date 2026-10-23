import { BackendStore } from '../../src/backend-store.mjs';

const [database, lane, crash] = process.argv.slice(2);
const store = new BackendStore(database);
try {
  const owner = { type: 'user', id: store.owner };
  if (crash === 'claim') {
    try { console.log(JSON.stringify({ task: store.command(owner, { key: `claim:${lane}`, action: 'task.create', payload: { title: `Claim ${lane}`, reference: 'TWD-32' } }) })); }
    catch (error) { console.log(JSON.stringify({ code: error.code })); }
  } else {
  const shared = store.command(owner, { key: 'shared', action: 'task.create', payload: { title: 'Shared retry' } });
  const unique = store.command(owner, { key: `lane:${lane}`, action: 'task.create', payload: { title: `Lane ${lane}` } });
  if (crash) process.exit(93); // Committed, but the caller never received a response.
  console.log(JSON.stringify({ shared, unique }));
  }
} finally { store.close(); }
