# Reusable native headless agents

The native headless provisioning command configures a dedicated Relay-owned
OpenCode runtime on an **existing joined node**. It does not open
a terminal client, attach a human conversation or schedule an interactive agent.
For explicit reuse of an already authorised model connection and existing MCP transports without another
login, use the [authenticated coordinator setup flow](headless-authenticated-setup.md).
The isolated-runtime provisioner below remains separate and does not inherit those connections.
The destination node runs it under its own Linux account, including WSL2/systemd.

Installing or enabling a live worker is a separate operator action.

## Provision on the destination node

Create a private manifest. Paths belong to that node, not the backend machine.
Select a real provider/model and explicit tool permissions suitable for the job.
The following policy is deliberately read/result-only, not permission to access
an email inbox or modify external systems:

```json
{
  "key": "inbox-sweep",
  "name": "inbox-sweep",
  "directory": "/home/operator/workspace",
  "executable": "/absolute/path/to/opencode",
  "config": {
    "$schema": "https://opencode.ai/config.json",
    "model": "provider/model",
    "permissions": [
      { "action": "*", "resource": "*", "effect": "deny" },
      { "action": "relay_work_read", "resource": "*", "effect": "allow" },
      { "action": "relay_work_submit", "resource": "*", "effect": "allow" }
    ]
  },
  "schedule": {
    "id": "inbox-sweep-weekdays",
    "instructions": "Replace with the authorised inbox scope, permitted actions and reporting requirements.",
    "cron": "0 7-18 * * 1-5",
    "timezone": "Africa/Johannesburg",
    "reviewPolicy": "none"
  }
}
```

Provider, MCP and other integration configuration belongs in the explicit V2
`config`. The owned runtime has a private HOME and does not inherit the human's
OpenCode configuration, authentication store or shell environment. Do not assume
an interactive provider login makes the dedicated runtime ready. Supply its own
authorised configuration/credentials and validate model/tool execution separately.
Use private files for manifests containing credentials. CLI results omit runtime
configuration and credentials.

```bash
# Read-only plan. No process, backend record or schedule is created.
herdr-relay headless provision --file /private/inbox-sweep.json

# Explicit local configuration change. Still no process or schedule is started.
herdr-relay headless provision --file /private/inbox-sweep.json --apply \
  --schedule-output /private/inbox-sweep-schedule.json

# Configuration and recorded runtime identity, not a live readiness assertion.
herdr-relay headless inspect --file /private/inbox-sweep.json
```

Use `--config /private/node.json` for a non-default node installation. The native
alias is `herdr-relay native agent provision`. Unqualified agent commands are not
part of the supported CLI.

Apply appends one `opencode-v2-owned` headless binding and retains the node's
credentials, existing bindings and unrelated settings. It writes a private exact
configuration backup. Same node/key retries retain the same agent/binding IDs and
leave an identical node configuration unchanged. Different policy/name/workspace
under an existing key fails instead of replacing a running identity. Different
keys cannot silently duplicate the same configured workspace/name.

Restart **only the destination Relay node** after safely settling its work. This
is explicit because a restart must not interrupt another agent's active turn.
The node provisions/registers the dedicated runtime and advertises its availability.
No human chat or TUI is needed. Inspect its agent record from the backend before
installing a schedule. No backend-root credential belongs on the destination node.

## Install a durable schedule from the backend operator

The exported schedule is always **disabled** and targets the durable headless
agent ID. It contains no node token, Access pair, runtime policy or exact human
conversation ID. Transfer that schedule file privately to the backend operator.

```bash
herdr-relay native schedule create \
  --file /private/inbox-sweep-schedule.json \
  --key inbox-sweep-schedule-v1 --context /private/owner.json

herdr-relay native schedule inspect inbox-sweep-weekdays \
  --context /private/owner.json

# Only after explicit approval and runtime/model/tool verification:
herdr-relay native schedule resume inbox-sweep-weekdays \
  --revision ACTUAL_REVISION --key inbox-sweep-enable-v1 \
  --context /private/owner.json
```

Repeated schedule creation uses the same key/payload to reconcile its original
receipt. Later changes use inspected revisions and new operation keys. Check the
node's `appliedRevision`, not just acceptance by the backend.

The example runs hourly from 07:00 through 18:00 on weekdays in SAST. The node and
WSL environment must be running. Recurring downtime skips old ticks, rather than
replaying a backlog, and active occurrences prevent overlap. `reviewPolicy: none`
removes result review, not native tool permission checks or authentication.

## Persistence and recovery

- Provisioning/runtime receipts and the OpenCode data home are persisted under the
  node's `managed/` state. Do not delete them to force recreation.
- Node restarts reuse the dedicated runtime/session when its identity still matches.
- Proven-dead idle runtimes can resume using the original session and saved policy.
  Unsettled native work, uncertain launches and changed policy fail closed.
- Completion does not retire this persistent binding or cancel its cron.
- Human conversations and client restarts do not replace its agent or schedule.
- Physical Surface/reboot certification is separate from isolated process tests.

## Verification

```bash
node --test test/native-headless.test.mjs
node scripts/verify-headless.mjs
```

The rehearsal uses an isolated native backend/node, real OpenCode and a local
deterministic model. It completes two scheduled occurrences with no interactive
client, reopens the node, stops/resumes an idle owned runtime, and checks retained
session/agent/schedule identity. It never controls user services or a real inbox.

OpenCode configuration and permission syntax follows the official
[V2 configuration](https://opencode.ai/v2/docs/config) and
[plugin/permission](https://opencode.ai/v2/docs/build/plugins#permissions) references.
