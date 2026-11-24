import { request } from 'node:http';
import { RelayError } from './protocol.mjs';
import { isAbsolute } from 'node:path';
import { attachmentRequest } from './attachment-transport.mjs';

export function call(connection, method, path, body, { signal } = {}) {
  if (!connection || typeof connection.socketPath !== 'string' || !isAbsolute(connection.socketPath) ||
    typeof connection.token !== 'string' || !connection.token) throw new RelayError('invalid_worker_context',
    'An exact scoped worker socket context is required, not an owner/backend context', 403);
  return new Promise((resolve, reject) => {
    // This is local scoped IPC. A pooled socket can outlive a restarted node;
    // open a fresh connection rather than retrying an uncertain write implicitly.
    const req = request({ socketPath: connection.socketPath, path, method, signal, agent: false,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const data = JSON.parse(text);
          if (res.statusCode >= 400) reject(new RelayError(data.code, data.message, res.statusCode));
          else resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Relay request timed out')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function socketOptions(connection, path, method, headers = {}) {
  if (!connection || typeof connection.socketPath !== 'string' || !isAbsolute(connection.socketPath) ||
    typeof connection.token !== 'string' || !connection.token) throw new RelayError('invalid_worker_context',
    'An exact scoped worker socket context is required, not an owner/backend context', 403);
  return { socketPath: connection.socketPath, path, method, agent: false, headers: { ...headers, Authorization: `Bearer ${connection.token}` } };
}

export function callUploadStream(connection, path, readable, { headers = {}, signal, timeoutMs = 120000 } = {}) {
  return attachmentRequest(request, socketOptions(connection, path, 'PUT', { 'Content-Type': 'application/octet-stream', ...headers, Expect: '100-continue' }),
    { readable, signal, timeoutMs, waitForContinue: true });
}

export function callDownloadStream(connection, path, { signal, timeoutMs = 120000 } = {}) {
  return attachmentRequest(request, socketOptions(connection, path, 'GET'), { signal, timeoutMs });
}
