import assert from 'node:assert/strict';
import './git-fixture.mjs';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { provisionAgent } from '../src/provisioning.mjs';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('uncertain backend agent creation never blindly creates a duplicate', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let creates = 0;
  const api = async method => {
    if (method === 'GET') return [];
    creates++;
    throw new Error('Lost agent creation response');
  };
  const input = { key: 'worker', companyId: 'company', bindingId: 'worker', harness: 'opencode', directory: '/work' };
  await assert.rejects(provisionAgent(store, '/state', api, input));
  await assert.rejects(provisionAgent(store, '/state', api, input), { code: 'agent_creation_uncertain' });
  assert.equal(creates, 1);
  await assert.rejects(provisionAgent(store, '/state', api, { ...input, directory: '/changed' }), { code: 'operation_conflict' });
});

test('a matching display name never authorises adopting another backend agent', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let created = false;
  const api = async (method, path, body) => {
    if (method === 'GET') return [{ id: 'foreign', name: 'Relay worker', adapterType: 'herdr_relay', companyId: 'company', adapterConfig: {} }];
    created = Boolean(body.adapterConfig.relayProvisionMarker);
    throw new Error('Stop before launching runtime');
  };
  await assert.rejects(provisionAgent(store, '/state', api, { key: 'worker', companyId: 'company', bindingId: 'worker', harness: 'opencode', directory: '/work' }));
  assert.equal(created, true);
  assert.equal(store.operation('provision:worker').agentId, undefined);
});

test('integrated provisioning retains the same owned worktree across a lost agent-create response', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-provision-worktree-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'repository');
  execFileSync('git', ['init', '-q', repository]);
  writeFileSync(join(repository, 'graph.json'), '{}');
  execFileSync('git', ['-C', repository, 'add', '.']);
  execFileSync('git', ['-C', repository, 'commit', '-qm', 'Initial fixture']);
  const store = new Store(':memory:');
  t.after(() => store.close());
  const input = { key: 'worker', companyId: 'company', bindingId: 'worker', harness: 'opencode', directory: join(root, 'worker'),
    worktreeKey: 'worker', worktree: { repository, path: join(root, 'worker'), branch: 'relay-worker' } };
  let creates = 0;
  const api = async method => { if (method === 'GET') return []; creates++; throw new Error('Lost reply'); };
  await assert.rejects(provisionAgent(store, root, api, input));
  assert.ok(existsSync(join(input.directory, 'graph.json')));
  await assert.rejects(provisionAgent(store, root, api, input), { code: 'agent_creation_uncertain' });
  assert.equal(creates, 1);
  assert.equal(store.operation('worktree:worker').state, 'ready');
});
