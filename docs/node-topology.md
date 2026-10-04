# Owned-runtime node topology

Decision approved on 2026-10-04: dedicated Relay-owned runtimes are the automatic
control boundary. Each machine runs a local Relay service against a shared
Paperclip backend. Shared human-controlled conversations remain an opt-in,
operator-reserved mode without automatic interruption.

## Remote administration

Install the same Relay build and Node 24+ on the target node. Configure its service
and private operator context there. Establish SSH authentication and verify the
server host key using the normal administrative process. Relay never accepts an
unknown host key or disables host verification.

```json
{
  "host": "relay-user@worker-node",
  "node": "/usr/bin/node",
  "cli": "/srv/herdr-relay/src/cli.mjs",
  "contextFile": "/private/relay-operator.json"
}
```

Save as a local node configuration, then:

```bash
herdr-relay-remote node.json status
herdr-relay-remote node.json operation list
herdr-relay-remote node.json runtime launch --file /remote/path/runtime.json
```

Paths in commands are remote paths. Optional `port`, `identityFile` and
`knownHostsFile` select a port and local SSH files. SSH uses batch mode, strict host
verification, bounded connection attempts and keepalives. Commands are quoted as
literal shell arguments. Credentials remain in the remote context file.

## Paperclip remote adapter

The Paperclip host can use the same `herdr_relay` adapter with:

```json
{
  "relayNodeFile": "/private/node.json",
  "bindingId": "remote-worker",
  "bindingRevision": 1,
  "timeoutSec": 300
}
```

The adapter opens SSH and runs a framed stdio attachment on the node. Backend run
credentials travel over SSH stdin, never command arguments. The remote attachment
uses the local node's Relay socket and existing native binding. No public Relay
HTTP listener or shared SQLite database is needed.

SSH disconnect ends only the attachment. The caller reconnects with the original
backend run key, so native work is not delivered twice. Cancellation is forwarded
but still waits for verified native settlement. An elapsed timeout persists across
reconnections. Native work and results remain in the node's durable state.

Each logical Paperclip agent must have one owning node. Peer tasks are coordinated
through Paperclip. The per-node `agent discover` and receipt-only inbox currently
show local registered peers, not a global machine inventory. Use Paperclip task
identities for cross-node delegation.

## Verification

- `test/remote.test.mjs` runs real adapter child processes with a deterministic SSH
  boundary, checking literal arguments, disconnect recovery and cancellation.
- `scripts/remote-smoke.mjs` ran actual SSH against an isolated local sshd with
  freshly generated client/server keys and a pinned test host key. It verified
  remote status and stdio adapter execution. It needs passwordless sudo to start
  its own test daemon. It does not change system SSH configuration or known hosts.
- The test uses `StrictModes no` only in its isolated daemon because its private
  key directory lives below `/tmp`. Client host-key verification stays enabled.

This verifies transport and process separation on one host. A physical second-node
deployment remains an environment-specific integration check.
