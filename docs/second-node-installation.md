# Install a second native Relay node manually

Status: development installation for the spec-v3 physical-machine acceptance gate.
No inbound node port or SSH access is required. This does not upgrade the active
OpenCode installation. The isolated v2 dependency is pinned to 2.1.0.

## 1. Prepare the remote machine

Requirements: Linux, Node.js 24+, npm, Git, an authenticated native harness and
outbound HTTPS access to `relay.synthswarm.com`.

Use branch `feat/native-v3-remote-testing` on both machines. Never transfer
node_modules, owner contexts, runtime auth, SQLite state or configuration secrets
as part of the source checkout.

```bash
git fetch origin
git switch --track origin/feat/native-v3-remote-testing
npm ci
npm ci --prefix packages/opencode-relay
npm run check
npm run test:v2
```

## 2. Enrol from the backend host

Run this on the backend machine using its private owner context. Choose a stable
node ID and the state path that will exist on the remote machine:

```bash
node scripts/enrol-native-node.mjs \
  --owner "$HOME/.local/state/herdr-relay-backend/owner.json" \
  --id second-node --name "Second machine" \
  --state-dir /absolute/remote/private/relay-node \
  --backend-url http://127.0.0.1:3210 \
  --url https://relay.synthswarm.com \
  --output /private/transfer/second-node.json
```

Enrolment publishes only a node identity, not an execution request. It writes a
private scoped node credential. The remote must never receive the owner context.
Copy the resulting node JSON through your normal private transfer mechanism and
set its permissions to `0600` in a directory owned by your user.

The owner context does not normally contain the existing Cloudflare Access pair.
Set `backend.cloudflareAccess.clientId` and `.clientSecret` in the transferred
private JSON using the same values as Portcullis. Load them from the existing
secret source, not source control or terminal command arguments. Do not print
the file. Confirm the Cloudflare Access application enforces those credentials
for this hostname before treating the public deployment as complete.

### Portcullis shim transport

Enrolment contacts the owner context's URL or `--backend-url`, defaulting to local
loopback. `--url` configures only the generated node's endpoint. For a shim config,
use `--url http://relay.shim:3999 --trusted-http-proxy-origin http://relay.shim:3999`
on the backend host alongside `--backend-url http://127.0.0.1:3210`.

When Portcullis on the remote machine provides `relay.shim:3999`, edit only the
transport fields in that machine's private node configuration:

```json
{
  "backend": {
    "url": "http://relay.shim:3999",
    "trustedHttpProxyOrigin": "http://relay.shim:3999",
    "token": "REPLACE_WITH_ENROLLED_NODE_TOKEN"
  }
}
```

`trustedHttpProxyOrigin` explicitly trusts this exact HTTP origin to carry the
node credential. Portcullis owns HTTPS forwarding and Cloudflare Access headers.
Relay still sends its distinct scoped Bearer credential. A shim response saying
`Valid node or user credential required` confirms connectivity only.

Choose this transport before the node's first start. Existing node journals pin
the backend URL and refuse changing it silently. Do not delete an existing journal
to bypass that guard. Use a fresh node identity/state directory for this remote
test if it was already initialised against another URL.

## 3. Start with no native bindings

The enrolment file has `bindings: []`. This verifies backend connectivity without
starting a native model or adopting a conversation:

```bash
node src/node-cli.mjs --config /private/second-node.json
```

The expected message is `state: running` with zero bindings. Stop it with Ctrl-C.
Its state directory contains a backend-instance pin and a local journal. Do not
copy another node's state directory to initialise this node.

For persistence after the foreground check:

```bash
node scripts/install-native-node.mjs --config /private/second-node.json
systemctl --user status herdr-relay-node-second-node.service
```

The installer is repeatable and refuses replacing an unrelated unit. User-service
startup after logout/reboot depends on the machine's user-service/lingering setup.

## 4. Add an explicit worker

Use [the node example](native-node-config.example.json) as a shape reference.
For `opencode-v2-owned`, configure:

- The absolute isolated executable, for example
  `/absolute/checkout/packages/opencode-relay/node_modules/.bin/opencode2`.
- An explicit existing workspace directory.
- A stable agent ID, binding ID and `reserved: true`.
- Private provider configuration/credentials in the isolated runtime's supported
  configuration. The launcher does not copy the active v1 credentials.
- Deliberate permissions for the intended task. Do not use global auto-approval
  as a substitute for task scope.

The first owned binding starts its dedicated v2 service and creates a session.
The directory advertisement becomes available through the backend. Existing
conversations instead require exact native identity, auth and explicit reservation.
Observation-only Herdr inventory does not grant delivery.

Restart only this new node service after editing its private configuration.
Do not replace the active OpenCode binary or restart unrelated agent work.

## 5. Physical acceptance

After the remote node is running, provide its stable node/agent IDs in chat.
The backend host can inspect them without remote shell access:

```bash
node src/backend-operator.mjs \
  --context "$HOME/.local/state/herdr-relay-backend/owner.json" read nodes
node src/backend-operator.mjs \
  --context "$HOME/.local/state/herdr-relay-backend/owner.json" read agents
```

Then exercise bounded work through the backend:

1. Explicitly address one execution to the remote agent.
2. Observe its acceptance, native result and exact review/completion receipts.
3. Ask a question back to the initiating agent and escalate one to the human.
4. Disconnect the remote node from the backend while an installed local job runs.
5. Reconnect and verify one result/occurrence without replayed native work.
6. Restart the node and verify the same identities and original receipts.

A directory heartbeat alone is not evidence of these behaviours. Record actual
runtime versions and receipts before closing the physical-machine acceptance gate.
