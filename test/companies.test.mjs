import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { provisionCompany } from '../src/companies.mjs';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';

const input = { key: 'default', name: 'Default', description: 'Default organisation' };

test('company creation reconciles a lost response across restart and rejects changed retries', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-company-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  t.after(() => store.close());
  let company;
  let creates = 0;
  const api = async (method, path, body) => {
    if (method === 'GET') return path === '/api/companies' ? [company].filter(Boolean) : company;
    creates++;
    company = { id: 'company-id', ...body };
    throw new Error('Lost committed response');
  };
  await assert.rejects(provisionCompany(store, api, input), /Lost committed response/);
  store.close();
  store = new Store(path);
  const result = await provisionCompany(store, api, input);
  assert.equal(result.companyId, 'company-id');
  assert.equal(result.state, 'recorded');
  assert.deepEqual(await provisionCompany(store, api, input), result);
  assert.equal(creates, 1);
  await assert.rejects(provisionCompany(store, api, { ...input, name: 'Changed' }), { code: 'operation_conflict' });
});

test('uncertain company creation never replays and matching names do not establish ownership', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let creates = 0;
  const api = async method => {
    if (method === 'GET') return [];
    creates++;
    throw new Error('No response');
  };
  await assert.rejects(provisionCompany(store, api, input));
  await assert.rejects(provisionCompany(store, api, input), { code: 'company_creation_uncertain' });
  assert.equal(creates, 1);
  await assert.rejects(provisionCompany(store, async () => [{ id: 'foreign', name: 'Default' }],
    { ...input, key: 'other' }), { code: 'company_name_conflict' });
});

test('company provisioning refuses ambiguous markers and invalid receipts', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  await assert.rejects(provisionCompany(store, async method => method === 'GET' ? [] : { id: 'wrong' }, input),
    { code: 'company_identity_mismatch' });
  const description = `${input.description}\n\n[herdr-relay-company:${store.operation('company:default').marker}]`;
  await assert.rejects(provisionCompany(store, async () => [{ description }, { description }], input),
    { code: 'company_identity_ambiguous' });
});

test('company provision endpoint is operator-only and requires backend authority', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-company-service-'));
  const service = await startService({ directory, paperclipUrl: 'http://127.0.0.1:3100' });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const admin = { socketPath: service.socketPath, token: service.token };
  const registration = await call(admin, 'POST', '/bindings', {
    id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'test', conversationId: 'session',
  });
  await assert.rejects(call({ socketPath: service.socketPath, token: registration.token }, 'POST', '/companies/provision', input),
    { code: 'forbidden' });
  await assert.rejects(call(admin, 'POST', '/companies/provision', input), { code: 'operator_backend_unavailable' });
});
