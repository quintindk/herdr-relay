import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeBackendClient } from '../src/backend-client.mjs';

test('HTTP shim requires explicit exact-origin trust and preserves actor authentication', async () => {
  const config = { url: 'http://relay.shim:3999', token: 'fixture-node-token' };
  assert.throws(() => nativeBackendClient(config), { code: 'invalid_backend' });
  for (const trustedHttpProxyOrigin of ['http://other.shim:3999', 'http://relay.shim:4000', 'http://relay.shim:3999/path',
    'http://user:secret@relay.shim:3999', true]) {
    assert.throws(() => nativeBackendClient({ ...config, trustedHttpProxyOrigin }), { code: 'invalid_backend' });
  }
  let calls = 0;
  const api = nativeBackendClient({ ...config, trustedHttpProxyOrigin: config.url, fetch: async (url, options) => {
    calls++;
    assert.equal(url.href, 'http://relay.shim:3999/v1/info');
    assert.equal(options.headers.Authorization, 'Bearer fixture-node-token');
    assert.equal(options.redirect, 'error');
    return Response.json({ protocol: 'relay/0.2' });
  } });
  assert.equal((await api('GET', '/v1/info')).protocol, 'relay/0.2');
  for (const path of ['//evil.example/v1/info', '/v1/../../outside', '/v1/\\evil.example/info', '/v1/info#fragment']) {
    await assert.rejects(api('GET', path), { code: 'invalid_request' });
  }
  assert.equal(calls, 1);
});

test('HTTPS and literal loopback remain supported without proxy opt-in', () => {
  for (const url of ['https://relay.example', 'http://127.0.0.1:3210', 'http://[::1]:3210']) {
    assert.equal(typeof nativeBackendClient({ url, token: 'fixture' }), 'function');
  }
  assert.throws(() => nativeBackendClient({ url: 'https://relay.example/path', token: 'fixture' }), { code: 'invalid_backend' });
});
