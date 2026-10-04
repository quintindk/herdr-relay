// Runs inside the isolated container. No credentials from the host are mounted.
const [base, method, path, body = '', actor = ''] = process.argv.slice(2);
const headers = { 'Content-Type': 'application/json' };
if (actor) headers[base.includes('17300') ? 'X-OpenRig-Session' : 'Authorization'] = actor;
const response = await fetch(`${base}${path}`, {
  method, headers, body: body ? body : undefined, signal: AbortSignal.timeout(20000),
});
console.log(JSON.stringify({ status: response.status, body: await response.text() }));
