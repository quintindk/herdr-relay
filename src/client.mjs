import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RelayError } from './protocol.mjs';

export const stateDirectory = () => process.env.RELAY_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-relay');

export function credentials(path = process.env.RELAY_CONTEXT) {
  if (path) return JSON.parse(readFileSync(path, 'utf8'));
  const dir = stateDirectory();
  return { socketPath: join(dir, 'relay.sock'), token: readFileSync(join(dir, 'admin-token'), 'utf8').trim() };
}

export function call(connection, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: connection.socketPath, path, method,
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
