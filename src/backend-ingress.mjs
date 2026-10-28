// A Relay 401 proves origin reachability, not Cloudflare Access enforcement.
export function ingressCheckPassed(name, { status, protocol, relayDenied }) {
  if (name === 'access_and_actor') return status === 200 && protocol === 'relay/0.2';
  if (name === 'access_only') return status === 401 && relayDenied;
  return !relayDenied && [301, 302, 303, 307, 308, 401, 403].includes(status);
}
