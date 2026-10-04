// Evaluation-only bridge reachable on the Docker bridge network. No host port
// publication. Production authentication and deployment are not represented here.
import http from 'node:http';
const [listen, target] = process.argv.slice(2).map(Number);
http.createServer((request, response) => {
  const upstream = http.request({ host: '127.0.0.1', port: target, path: request.url,
    method: request.method, headers: { ...request.headers, host: `localhost:${target}` } }, incoming => {
    response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
  });
  upstream.on('error', () => { response.writeHead(502); response.end(); });
  request.pipe(upstream);
}).listen(listen, '0.0.0.0');
