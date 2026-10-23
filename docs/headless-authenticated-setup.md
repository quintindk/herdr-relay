# General headless setup with existing authenticated integrations

RC10 introduces the general MCP permission model. It creates a
dedicated worker session in the existing authenticated OpenCode service. It does
not create another private HOME, copy credential stores or reuse the coordinator's
conversation. Isolation is per session, not an operating-system sandbox.

## Grant model

The backend owner issues one explicit grant for the coordinator, node, worker,
contract, model connection, capability permissions and schedule:

```json
{
  "id": "approved-job",
  "requesterAgentId": "EXACT_COORDINATOR_AGENT_ID",
  "nodeId": "EXACT_DESTINATION_NODE_ID",
  "name": "approved-worker",
  "directory": "/workspace/job",
  "model": {
    "providerID": "EXISTING_PROVIDER_ID",
    "id": "EXISTING_MODEL_ID",
    "integrationID": "EXISTING_MODEL_INTEGRATION_ID",
    "connectionId": "EXISTING_ACTIVE_CREDENTIAL_ID"
  },
  "permissions": { "mcp": true, "shell": false },
  "contract": ".opencode/skills/approved-job/SKILL.md",
  "schedule": {
    "id": "approved-job-weekdays",
    "cron": "0 7-18 * * 1-5",
    "timezone": "Africa/Johannesburg",
    "reviewPolicy": "none"
  }
}
```

`permissions.mcp` is required and boolean. It is not a server, integration, tool
or verb allowlist. MCP allowed covers every currently available MCP tool in that
worker's OpenCode location, including writes and subsequently configured tools.
MCP denied exposes no MCP catalogue or calls to the worker.

`permissions.shell` is a separate boolean, defaulting to false. When true, it
allows the native OpenCode shell through `relay_shell_call`. It grants full access
as the worker's OS user, including writes outside approved artifact paths. This
is not an OS sandbox. MCP tools may themselves execute commands, write files, send
messages or delete remote data. MCP allowed deliberately includes those effects
when the configured server exposes them. It is not a read-only or content policy.
The external job contract and MCP/provider controls govern business behaviour.

Native task actions and artifact paths remain separate explicit `capabilities`.
MCP permission never grants native `shell`, `write`, `edit`, generic `execute`,
native MCP configuration/authentication APIs or access to a backend owner context.
Native artifact path restrictions do not claim to constrain an MCP server's own
filesystem capabilities. Host plugins are operator-trusted code, not a sandboxed
extension boundary.

## Issue the grant

```bash
herdr-relay headless grant --file /private/approved-job-grant.json \
  --key approved-job-authorise-v1 --context /private/owner.json
```

Run this on the backend host with its existing root-owner context. A coordinator
can prepare a non-secret proposal, but cannot issue its own grant or obtain the
owner credential. Creating the grant does not create a worker or start a schedule.
No connector-specific grant fields or compatibility bridges are accepted.

`relay_headless_connections` lists non-secret model connection references and
currently connected MCP server/tool names. Discovery grants no permission. Model
identity is pinned to an existing active credential reference. MCP access uses
the already authenticated transports managed by OpenCode, without copying their
credentials, caches or login state. There is no per-MCP connection pin in the
boolean capability.

## Coordinator setup and activation

```text
relay_headless_grants
relay_headless_setup({"key":"approved-job-setup-v1","grantId":"approved-job"})
relay_headless_status({"id":"EXACT_SETUP_ID_FROM_RECEIPT"})
```

CLI equivalents are `headless connections`, `headless grants`, `headless setup
--grant-id ID --key KEY` and `headless status --id ID` from the enrolled coordinator.
Setup requires the coordinator and destination on the same node.

Setup hot-loads the dedicated binding without rewriting `node.json`, restarting
the node or opening a TUI. The exact contract file is hashed and must remain
unchanged. Reuse operation keys after uncertain replies. Explicit retries retain
the worker/session and attempt history; the previous readiness run must settle.

Readiness requires an actual model turn, native `relay_headless_permissions` inspection,
granted task/artifact canaries when applicable, native result submission and a
correlated successful terminal outcome. It executes **no external MCP tools or shell commands**.
`mcp:false` is a valid readiness policy and needs no MCP connection.

This verifies the platform capability, not a provider's business workflow. Empty
or disconnected catalogues do not prove that a contract's required integrations
are available. The external contract must detect missing sources/actions and must
not falsely attest business completion.

Successful setup creates/enables the approved schedule. This is an activation
step, not merely inspection. Await the destination's applied schedule revision;
`awaiting_schedule_ack` is not proof of activation.

## Runtime tools and enforcement

- `relay_headless_permissions` inspects MCP and shell policy without executing
  external effects. A granted shell must have a native shell executor available.
- `relay_shell_call` uses the native shell input schema, session and cancellation
  signal. Only an accepted authorised business run may dispatch it. No owner context
  or borrowed credential is supplied.
- `relay_mcp_tools` returns the current native MCP catalogue and policy. It makes
  no external tool call. Schemas/descriptions remain untrusted provider content.
- `relay_mcp_call` selects an exact current MCP tool ID and invokes the native
  transport. Built-ins and prefix lookalikes cannot be selected as MCP tools.
- Permission checks, accepted run/session/binding, current grant, cancellation,
  expiry, contract hash and model connection are checked before dispatch, including
  a fresh check after asynchronous permission evaluation. No cached authority is
  used when the backend is unavailable.
- Direct namespaced tool calls cannot bypass the bridge. Core namespace collisions
  and permission aliases to native capabilities fail closed. Native tool namespaces
  must not collide with operator-installed host extensions.
- Readiness and already-staged outcomes cannot perform MCP or shell calls.
- Optional source observations contain native call/input/output digests. If evidence
  recording fails after a provider replies, the reply is retained and evidence is
  explicitly unconfirmed. The write is not repeated to obtain another receipt.

The bridge does not promise exactly-once external delivery. Use provider idempotency
where available and preserve uncertain effects according to the job contract.

## Revocation

```bash
herdr-relay headless revoke --file /private/revoke.json \
  --key approved-job-revoke-v1 --context /private/owner.json
# revoke.json: {"id":"approved-job","expectedRevision":1}
```

Revocation pauses the schedule and rejects new admissions/tool dispatch. It cannot
undo an external effect or stop a process already dispatched. Model credential changes or contract
changes also block access. New servers/tools inherit MCP permission intentionally;
they do not require a server-specific grant amendment.

Verification uses isolated real OpenCode services, deterministic models and
disposable MCP transports, including reads, writes, later-added tools and MCP
denial. No live grants, schedules, accounts or user services are modified.

References: [OpenCode plugin API](https://opencode.ai/v2/docs/build/plugins),
[MCP tools and permissions](https://opencode.ai/v2/docs/mcp-servers), and the installed
`@opencode/plugin`/`@opencode/schema` tool metadata contracts.
