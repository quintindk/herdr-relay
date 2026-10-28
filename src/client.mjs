import { request } from 'node:http';
import { RelayError } from './protocol.mjs';

export function call(connection, method, path, body, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: connection.socketPath, path, method, signal,
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
