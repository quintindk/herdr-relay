# Headless setup with existing authorised integrations

The RC7 coordinator flow creates a dedicated headless session in the **existing
authenticated OpenCode service**. It does not create another private HOME, copy
credential stores, open a TUI or reuse Mason's conversation. The worker retains
its own durable Relay identity, session and default-deny permissions.
This is session isolation, not a separate operating-system account/process.
RC6's isolated-runtime provisioner remains available for separate credentials.

## Explicit, revocable handover

`relay_headless_connections` returns non-secret model/provider/integration/active
credential references and connected MCP server/tool names. Discovery grants no
authority. Relay never calls credential-list or credential-resolve APIs for this
flow. Existing credentials remain inside OpenCode and the connected MCP service.

A human backend operator authorises an exact coordinator/job through a grant:

```json
{
  "id": "surface-inbox-sweep",
  "requesterAgentId": "EXACT_MASON_AGENT_ID",
  "nodeId": "EXACT_SURFACE_NODE_ID",
  "name": "inbox-sweep",
  "directory": "/home/quintindekok/work/twd",
  "model": {
    "providerID": "EXISTING_PROVIDER_ID",
    "id": "EXISTING_MODEL_ID",
    "integrationID": "EXISTING_MODEL_INTEGRATION_ID",
    "connectionId": "EXISTING_ACTIVE_CREDENTIAL_ID"
  },
  "workiq": {
    "server": "EXISTING_WORKIQ_MCP_SERVER",
    "readTool": "EXACT_READ_ONLY_WORKIQ_TOOL_ID",
    "probeInput": { "query": "An approved bounded read-only readiness query" }
  },
  "contract": ".opencode/skills/inbox-sweep/SKILL.md",
  "schedule": {
    "id": "inbox-sweep-weekdays",
    "cron": "0 7-18 * * 1-5",
    "timezone": "Africa/Johannesburg",
    "reviewPolicy": "none"
  }
}
```

```bash
herdr-relay headless grant --file /private/inbox-sweep-grant.json \
  --key surface-inbox-sweep-authorise-v1 --context /private/owner.json
```

The coordinator can prepare this non-secret proposal, but cannot self-issue the
grant or borrow the owner context. This one-time human authorisation is distinct
from another interactive login or manual credential handling. No raw runtime
configuration needs assembling.

WorkIQ references its already connected MCP server and read-tool ID. If that server
exposes an OpenCode integration, also pin `integrationID` and `connectionId` under
`workiq`. Otherwise the explicit reference is the server registration/read tool in
that authenticated service. Local WorkIQ MCP processes keep their existing login;
Relay does not copy their caches. The human must authorise a genuinely read-only
tool and bounded probe input. A tool's name does not establish read-only semantics.
Model handover requires a saved active credential reference, not an inherited
environment or guessed provider default. Different credentials with matching
display labels are not adopted.

## One coordinator setup flow

After authorisation, Mason uses:

```text
relay_headless_grants
relay_headless_setup({"key":"surface-inbox-sweep-v1","grantId":"surface-inbox-sweep"})
relay_headless_status({"id":"EXACT_SETUP_ID_FROM_RECEIPT"})
```

CLI equivalents inside the enrolled coordinator's harness:

```bash
herdr-relay headless connections
herdr-relay headless grants
herdr-relay headless setup --grant-id surface-inbox-sweep --key surface-inbox-sweep-v1
herdr-relay headless status --id EXACT_SETUP_ID
```

Setup is asynchronous and journalled. Reuse its key after an uncertain reply.
The same node/workspace/name retains its setup/agent. Another key cannot create
a duplicate or adopt an existing interactive agent.
The setup tool/CLI normally waits for readiness and schedule acknowledgement in
one call. If its bounded wait expires, it returns `pending` with the original ID,
not success or a new operation. After fixing a blocked prerequisite, an explicit
`retry: true` (CLI `--retry`) under a new retry key retains the worker/session and
attempt history. The prior probe must be settled first. This does not permit
changing the approved connection, contract or immutable grant scope.

The destination node checks authorisation, canonical workspace, exact contract,
current model credential and WorkIQ connection before provisioning. It hot-loads
the binding and scoped worker context without editing `node.json`, restarting the
node, modifying another session or opening an interactive client.

The worker receives only the exact contract read, approved WorkIQ read and native
Relay read/result/ask capabilities. `relay_workiq_read` invokes that one existing
MCP read tool through the native plugin API, with its permission check and original
authenticated transport. This works even when the original MCP tool uses Code
Mode, without granting generic `execute` or shell access.

A bounded native readiness execution must show a successful real WorkIQ call with
the exact probe input, correlated successful native terminal evidence and actual
`relay_work_submit`. Model claims alone are insufficient. Only then is the cron
created/enabled. Status returns agent/schedule IDs, backend/applied revisions,
next firing and precise blockers. `awaiting_schedule_ack` is not activation proof.
Timeout or uncertain work never enables the schedule. Probe cancellation is
requested on failure, not described as proof that work has already stopped.

## Revocation and prerequisites

Grants support optional `expiresAt`. To revoke:

```bash
herdr-relay headless revoke --file /private/revoke.json \
  --key surface-inbox-sweep-revoke-v1 --context /private/owner.json
# revoke.json: {"id":"surface-inbox-sweep","expectedRevision":1}
```

Revocation pauses its schedule and blocks future model-step/admission checks.
It cannot undo an in-flight read. Switching/removing the pinned model credential,
disconnecting WorkIQ or changing the authorised contract also blocks access.

The backend, destination node and server plugin must support this flow. Upgrade
them normally first. Missing support is a blocker, not permission to restart
unrelated work or fall back to copying HOME/Paperclip. Normal installations use
existing authenticated service discovery. A local operator may explicitly set
`headless.serviceRegistration` for a custom service registration file.

## Verification limits

`node scripts/verify-headless-setup.mjs` uses real OpenCode, a native node/backend,
a deterministic model and a real read-only MCP fixture. It checks coordinator
setup, access reuse, result submission, schedule acknowledgement/next firing and
revocation. It does not authenticate a real Microsoft account or read a real inbox.
Physical Surface/real WorkIQ tenant acceptance remains separate. No live sweep
is created during release verification.

Official references: [V2 connections, tool execution and permissions](https://opencode.ai/v2/docs/build/plugins),
[MCP lifecycle](https://opencode.ai/v2/docs/mcp-servers),
[native session API](https://opencode.ai/v2/docs/api).
