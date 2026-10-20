import { RelayError, requireValue } from './protocol.mjs';

export function nativeBackendClient({ url, token, ingressKey, cloudflareAccess, fetch: request = fetch }) {
  const origin = new URL(url);
  requireValue(!origin.username && !origin.password && (origin.protocol === 'https:' ||
    origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname)), 'invalid_backend', 'Use HTTPS or local loopback');
  requireValue(typeof token === 'string' && token.length > 0 && (!cloudflareAccess ||
    typeof cloudflareAccess.clientId === 'string' && cloudflareAccess.clientId &&
    typeof cloudflareAccess.clientSecret === 'string' && cloudflareAccess.clientSecret), 'invalid_credentials', 'Explicit actor and optional complete Access credentials required');
  return async (method, path, body) => {
    requireValue(path.startsWith('/v1/'), 'invalid_request', 'Native backend route required');
    const response = await request(new URL(path, origin), { method, redirect: 'error', signal: AbortSignal.timeout(10000),
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
}
