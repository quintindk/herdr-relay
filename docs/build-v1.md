# Herdr Relay: first working slice

Date: 2026-10-03. Development package `0.1.0-dev.0`.

This implements the durable CLI-pull protocol and an actual external Paperclip
adapter. It is the first part of the [v2 implementation milestone](spec-v2.md#12-first-implementation-milestone).

Update 2026-10-04: [reserved OpenCode delivery](native-opencode-v1.md) adds native
prompt delivery and message-correlated settlement. The commands below describe
the original explicit-pull mode, which remains supported.

## Implemented

- Node 24 service using SQLite WAL and a local Unix socket.
- Separate agent bindings and binding-scoped CLI credentials.
- Idempotent registration, dispatch and submission with changed-payload rejection.
- One unsettled work invocation per conversation, enforced by SQLite.
- Persistent submission and explicit operator settlement as separate events.
- Backend comment publication with the correct Paperclip run credentials.
- Read-back reconciliation after an uncertain comment POST. An absent receipt does
  not authorise another POST.
- External adapter package exporting `createServerAdapter`, type `herdr_relay`.
- Herdr plugin manifest with a service-status action.

Paperclip owns task content. `work read` fetches it through Relay using the live
adapter's run token. Run tokens are held in service memory and reattached by the
adapter after a service restart. They are not written to worker contexts or SQLite.
Relay stores agent credentials in its restricted database so registration retries
can recover the same credential. This is a trusted-user local deployment, not
isolation between hostile processes running under the same Unix account.

## Development setup

No npm dependencies or compilation step are required. Node 24 provides SQLite.

```bash
npm run check
npm test
node src/cli.mjs service --paperclip-url http://127.0.0.1:3100
```

Run the service in a separate terminal. It uses
`$XDG_STATE_HOME/herdr-relay` or `~/.local/state/herdr-relay`. Set `RELAY_STATE_DIR`
or use `--state-dir` to isolate development instances. The database is pinned to
the first configured Paperclip origin. Changing the backend requires a separate
state directory.

Create an operator context for the adapter:

```bash
node src/cli.mjs operator-context --context-out /absolute/path/operator.json
```

The output directory must exist. Context files contain credentials. Use operator
contexts for the adapter and operator commands, worker contexts for agent commands.

Install this repository as an external adapter in a local Paperclip instance:

```http
POST /api/adapters/install
Content-Type: application/json

{"packageName":"/absolute/path/to/herdr-relay","isLocalPath":true}
```

Use the board/instance-admin authentication required by your instance. This is the
route verified against Paperclip `2026.1001.0`. Its external adapter guide currently
documents a different route. The adapter also declares `supportsLocalAgentJwt: true`,
which the server requires before supplying `ctx.authToken`.

Configure a Paperclip agent with:

```json
{
  "adapterType": "herdr_relay",
  "adapterConfig": {
    "relayContextFile": "/absolute/path/operator.json",
    "bindingId": "daily-driver",
    "bindingRevision": 1,
    "timeoutSec": 300
  }
}
```

Keep automatic wakes disabled until its binding exists. Create `binding.json`:

```json
{
  "id": "daily-driver",
  "companyId": "PAPERCLIP_COMPANY_ID",
  "agentId": "PAPERCLIP_AGENT_ID",
  "harness": "opencode",
  "instanceId": "EXPLICIT_NATIVE_INSTANCE_REFERENCE",
  "conversationId": "EXACT_EXISTING_CONVERSATION_REFERENCE"
}
```

```bash
node src/cli.mjs agent register --file binding.json --context-out worker.json
node src/cli.mjs --context worker.json work list
node src/cli.mjs --context worker.json work read RELAY_RUN_ID
node src/cli.mjs --context worker.json work acknowledge RELAY_RUN_ID
node src/cli.mjs --context worker.json work submit RELAY_RUN_ID \
  --key candidate-1 --summary-file result.md --candidate sha256:ACTUAL_CANDIDATE_DIGEST
```

Paperclip initiates the run using its normal issue dispatch or heartbeat invocation
with `payload.taskId`/`payload.issueId`. The worker uses its **Relay run ID** from
`work list`, not the Paperclip run ID. Repeated registration with identical input
recovers the same worker context. Different binding configuration conflicts.

After observing the native turn has ended, the operator records settlement:

```bash
node src/cli.mjs operation settle RELAY_RUN_ID \
  --outcome completed --evidence 'Observed the assigned native turn finish'
```

The Paperclip run succeeds only after submission is published and settlement is
recorded. The task itself is not marked done or moved into review by this slice.
A comment receipt is not acceptance.

For cancellation:

```bash
node src/cli.mjs operation cancel RELAY_RUN_ID
# Interrupt the assigned native work and verify it has stopped, then:
node src/cli.mjs operation settle RELAY_RUN_ID \
  --outcome cancelled --evidence 'Observed the assigned invocation stop'
```

Unacknowledged pull work can be cancelled immediately because it has not been
claimed. Claimed work remains reserved until operator settlement. A timeout
requests cancellation but cannot prove an external turn stopped. Adapter execution
can therefore remain pending beyond its configured deadline. This is deliberate
in this development slice and must be replaced by verified harness supervision.

## Herdr plugin

```bash
herdr plugin link /absolute/path/to/herdr-relay
```

The manifest exposes `Relay: service status`. The status action uses the default
Relay state directory and runs independently of the service. It does not install
service supervision. Task/inbox panes and runtime placement follow later.

Herdr `0.9.3` accepted the manifest through `plugin link --disabled`. The temporary
link was removed after validation. `HERDR_CONFIG_PATH` did not isolate the plugin
registry in that test, so it must not be used as a plugin-registry sandbox.

## Verification

`npm test` covers persistence across database reopen, service restart while an
adapter is active, registration/dispatch/submission retries, stale and overlapping
work, scoped credentials, cancellation settlement and uncertain backend writes.
Those tests use a deterministic backend where fault injection is needed.

`scripts/paperclip-smoke.mjs` was also executed against real Paperclip
`2026.1001.0` in an isolated evaluation container. It installed this external
package, created two separate agents with no managers, published exactly one
attributed comment per result, and verified both runs stayed active until explicit
settlement before succeeding. See [sanitised evidence](evidence/relay-build-smoke.json).

The smoke bindings were labelled OpenCode and Hermes, but used deterministic CLI
protocol calls. This build test did not start native harnesses. Earlier native
continuity experiments are separate evidence, not proof of these connectors.

Reproduce with the existing evaluation image:

```bash
docker run -d --name herdr-relay-build-smoke \
  -v "$PWD:/relay:ro" retinue-evaluation:2026-10-03
docker exec -d -e PAPERCLIP_RUNNER_ENABLED=false herdr-relay-build-smoke \
  paperclipai onboard --yes --no-install-service --data-dir /home/node/relay-paperclip-state
# Wait for /api/health before running the probe.
docker exec herdr-relay-build-smoke node /relay/scripts/paperclip-smoke.mjs
docker stop herdr-relay-build-smoke
```

Each successful probe creates fresh identities. It does not alter your normal
Paperclip or herdr setup. The evaluation container retains its database when stopped.

## Next implementation work

1. Native OpenCode and Hermes delivery, identity verification and turn settlement.
2. Exact invocation cancellation and recovery when the adapter host also restarts.
3. Shared agent skill and binding provisioning in native runtime context.
4. Questions, waiting/continuation and Paperclip review transitions.
5. Task-scoped provisioning, acceptance-driven retirement and herdr views.

Binding revisions are checked, but rebinding and native continuation verification
are not implemented. Candidate strings are recorded, not computed or verified.
Uncertain publication with no matching receipt remains unresolved. There is no
automatic replay or operator override for that case yet. Service supervision,
cross-machine transport and credential rotation are also pending.
