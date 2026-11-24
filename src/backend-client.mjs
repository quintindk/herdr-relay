import { RelayError, requireValue } from './protocol.mjs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { attachmentRequest } from './attachment-transport.mjs';
import { validateAttachmentSize, validateSha256 } from './task-attachments.mjs';

export function nativeBackendClient({ url, token, ingressKey, cloudflareAccess, trustedHttpProxyOrigin, fetch: request = fetch }) {
  const origin = new URL(url);
  requireValue(origin.pathname === '/' && !origin.search && !origin.hash, 'invalid_backend', 'Backend URL must be an origin');
  if (trustedHttpProxyOrigin !== undefined) {
    let proxy;
    try { proxy = new URL(trustedHttpProxyOrigin); } catch {}
    requireValue(typeof trustedHttpProxyOrigin === 'string' && proxy?.protocol === 'http:' &&
      !proxy.username && !proxy.password && proxy.pathname === '/' && !proxy.search && !proxy.hash &&
      proxy.origin === origin.origin, 'invalid_backend', 'Trusted HTTP proxy must match the exact backend origin');
  }
  requireValue(!origin.username && !origin.password && (origin.protocol === 'https:' ||
    origin.protocol === 'http:' && (['127.0.0.1', '[::1]'].includes(origin.hostname) || trustedHttpProxyOrigin !== undefined)),
  'invalid_backend', 'Use HTTPS, local loopback or an explicitly trusted HTTP proxy origin');
  requireValue(typeof token === 'string' && token.length > 0 && (!cloudflareAccess ||
    typeof cloudflareAccess.clientId === 'string' && cloudflareAccess.clientId &&
    typeof cloudflareAccess.clientSecret === 'string' && cloudflareAccess.clientSecret), 'invalid_credentials', 'Explicit actor and optional complete Access credentials required');
  const client = async (method, path, body, { signal } = {}) => {
    requireValue(typeof path === 'string' && path.startsWith('/v1/') && !path.includes('\\'), 'invalid_request', 'Native backend route required');
    const target = new URL(path, origin);
    requireValue(target.origin === origin.origin && target.pathname.startsWith('/v1/') && !target.hash,
      'invalid_request', 'Native backend route must remain inside the configured origin');
    const timeout = AbortSignal.timeout(10000);
    const response = await request(target, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(ingressKey ? { 'X-API-Key': ingressKey } : {}),
        ...(cloudflareAccess ? { 'CF-Access-Client-Id': cloudflareAccess.clientId, 'CF-Access-Client-Secret': cloudflareAccess.clientSecret } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    let result;
    if (response.headers.get('content-type')?.includes('application/json')) result = await response.json();
    else {
      await response.body?.cancel();
      throw new RelayError(response.status >= 300 && response.status < 400 ? 'access_authentication_required' : 'invalid_backend_response',
        'Native backend returned a non-JSON response', response.status >= 300 && response.status < 400 ? 401 : 502);
    }
    if (!response.ok) throw new RelayError(result.code ?? 'backend_error', result.message ?? 'Native backend request failed', response.status);
    return result;
  };
  const binaryRequest = (method, path, headers, options) => attachmentRequest(origin.protocol === 'https:' ? httpsRequest : httpRequest, {
    protocol: origin.protocol, hostname: origin.hostname.replace(/^\[|\]$/g, ''), port: origin.port, agent: false, method, path,
    headers: { Authorization: `Bearer ${token}`, ...(ingressKey ? { 'X-API-Key': ingressKey } : {}),
      ...(cloudflareAccess ? { 'CF-Access-Client-Id': cloudflareAccess.clientId, 'CF-Access-Client-Secret': cloudflareAccess.clientSecret } : {}), ...headers },
  }, options);
  client.uploadBlob = async (sha256, readable, { size, signal, timeoutMs = 120000 } = {}) => {
    validateSha256(sha256);
    validateAttachmentSize(size);
    const result = await binaryRequest('PUT', `/v1/blobs/${sha256}`, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      { readable, signal, timeoutMs });
    requireValue(result.sha256 === sha256 && result.size === size, 'invalid_backend_response', 'Invalid attachment upload receipt', 502);
    return result;
  };
  client.downloadAttachment = (taskId, attachmentId, { signal, timeoutMs = 120000 } = {}) => binaryRequest('GET',
    `/v1/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/content`, {}, { signal, timeoutMs });
  client.withToken = value => nativeBackendClient({ url, token: value, ingressKey, cloudflareAccess, trustedHttpProxyOrigin, fetch: request });
  return client;
}
