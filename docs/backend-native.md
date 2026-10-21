# Native backend development slice

Status: native store/API, local journal, execution and clock modules under test.
Not a fully integrated 0.2.0 service.

The backend owns shared records. Nodes retain native execution authority. The
current contract implements tasks, comments, directory registration, explicit
execution admission, blocking/non-blocking questions, escalation to the human,
answers, continuation eligibility, results and human candidate review.

Every command is an actor-scoped idempotent operation with strict fields. Entity
updates, operation receipts and events commit together. Events currently retain
all history. The service binds only to `127.0.0.1`.

```bash
node src/backend-cli.mjs init --state-dir /private/new-relay-backend
node src/backend-cli.mjs serve --state-dir /private/new-relay-backend --port 3210
node --test test/backend-store.test.mjs
```

For a local user-service deployment, run `node scripts/install-native-backend.mjs`.
It uses a distinct `herdr-relay-backend` state directory, preserves the owner
credential and refuses unrelated service definitions. It does not configure a
Cloudflare route or upgrade OpenCode. Use `src/backend-operator.mjs --context
/private/owner.json read info` for authenticated inspection.

`scripts/enrol-native-node.mjs` creates an addressed node and writes its private
context without printing credentials. It is repeatable and starts with no native
bindings. `node src/node-cli.mjs --config /private/node.json` runs a local node.
Explicit v2 bindings require `reserved: true`, exact session/project/location/time
identity, a loopback URL and private native password file. Hermes bindings use the
existing reserved Hermes contract. A daemon restart with no native bindings has
been verified after stopping its backend, using its persisted instance pin.

Native version admission accepts OpenCode 2.x. Compatibility has been exercised
on 2.1.0 and 2.1.2. Other majors remain refused and API/identity/terminal checks
still fail closed. External `opencode-v2` bindings default
to direct worker tools. An operator may explicitly set `workerTransport: "cli"`
for an existing conversation whose shell tool is already available. That path
uses the same session-scoped worker credential and exact execution/run checks,
without installing a plugin, reloading the native service or changing permissions.
It is not an automatic fallback for workers whose shell access is denied.
Owned v2 bindings retain their direct-tool default and reject this override.

`opencode-v2-owned` bindings additionally accept `executable`, `directory`,
`reserved: true` and an explicit v2 `config`. Provisioning journals a dedicated
runtime and exact session before writes, reuses both on repeated calls, and exposes
interruption only through that owned process identity. A real isolated provisioning
smoke passed, including verified-stop and idle-process-crash resume. Set `resume:
true` for explicit startup adoption of a proven-dead managed process group. Runtime
identity, config and original session remain checked. Recovery of unsettled work
and daemon acceptance-retirement certification remain pending.

A [node configuration example](native-node-config.example.json) documents the
current development shape. All credentials are placeholders. Keep real node/Access
credentials outside the checkout. Dedicated runtime policy must explicitly configure
its providers, permissions and credentials rather than inheriting the active v1
installation. The example is not permission to auto-approve model tools.

Initialisation writes a private `owner.json`. It never prints the token. Do not
use the existing Relay state directory. `init` refuses an existing credential
store. `serve --config /private/ingress.json` accepts `{ "ingressKeys": ["..."] }`.
The inspected local Portcullis implementation authenticates Cloudflare Access with
`CF-Access-Client-Id` and `CF-Access-Client-Secret`, loaded from its private service
environment. Native clients support this pair without embedding it in URLs. The
shared values must be loaded from that existing secret source during deployment.
The optional development `X-API-Key` header is separate and is not Portcullis's
access contract. Cloudflare Access enforcement belongs to the protected tunnel
application, with Relay actor credentials still checked by the local origin.
`Authorization: Bearer ...` separately authenticates the human or enrolled node.

### Restricted V2 cron worker

V2 workers receive instructions for the direct `relay_work_read`,
`relay_work_ask` and `relay_work_submit` tools, not an additional shell transport.
Built-in tools may remain denied. An optional binding-level `sessionPermissions`
array applies explicit session-scoped rules after the agent's rules, as documented
in the [V2 plugin guide](https://opencode.ai/v2/docs/build/plugins#permissions).
For a read/submit-only smoke worker:

```json
{
  "sessionPermissions": [
    { "action": "*", "resource": "*", "effect": "deny" },
    { "action": "relay_work_read", "resource": "*", "effect": "allow" },
    { "action": "relay_work_submit", "resource": "*", "effect": "allow" }
  ]
}
```

These rules are operator configuration, not grants invented by the daemon. They
persist on the exact worker session and are reapplied on node startup. They do not
change the owned runtime's pinned provider configuration or create another session.
Validate a real tool round trip before scheduling a new model-backed job. Merely
listing a model or registering an agent does not establish tool execution.

Scheduled turns that terminate unsuccessfully, or finish without staging a result
or question, publish `schedule.fail` with the original occurrence identity and
native terminal evidence. They appear as failed occurrences, without a fabricated
candidate/result. Publication is journalled for offline retry. Proven-terminal
failure releases local capacity but never replays the original prompt.

The [live local cron evidence](evidence/native-local-cron-model.json) records two
real Qwen/LM Studio occurrences through the direct read/submit tools, without
overlap, followed by an applied pause. The first missing-submission attempt is
retained as a failed occurrence. This does not certify remote/offline/reboot
behaviour or native TUI schedule controls.

### Interactive cron smoke

```bash
npm --prefix packages/opencode-relay run smoke:interactive-cron
```

This separate smoke uses real OpenCode 2.1.0 TUIs, a native backend, a node daemon
and explicitly reserved `opencode-v2` bindings registered as `interactive`. The
test controller starts the disposable native services. The node does not own or
provision them. It never adopts or sends prompts into an existing user chat.

The default provider is LM Studio at `http://127.0.0.1:1234/v1`, using
`qwen/qwen3.8-27b`. Override with `RELAY_SMOKE_MODEL_URL` and `RELAY_SMOKE_MODEL`.
The model must support actual function calls. Session policy permits only
`relay_work_read` and `relay_work_submit`. A proxy holds the first synthetic human
turn until the test verifies that scheduled delivery remains pending while busy.

The smoke checks exact-chat delivery, two real folder cron occurrences, no-target
and ambiguous-target deferral, future-chat replacement, preserved admitted identity,
applied pause and no settled-work replay after daemon restart. Native transcripts
must contain completed read/submit calls and successful terminal receipts. Both
TUIs remain attached throughout. Keyboard/API input is synthetic, not actual human
authorisation, and there is no atomic idle-and-send guarantee.

Private state is retained under `/tmp/opencode/relay-interactive-cron-*` for
diagnosis. The script stops only its own processes. Set `RELAY_SMOKE_EVIDENCE` to
write a credential-free evidence file. This smoke does not certify physical reboot,
remote nodes, backend disconnection or interactive schedule-management controls.

The [existing-session evidence](evidence/native-current-session-cron.json)
separately records a real cron firing in the user's already-open OpenCode 2.1.2
conversation. A separate explicitly enrolled node targeted that exact chat through
the CLI transport. Native settlement and backend publication completed, and the
test controller's pause reached applied revision 2. The existing native service,
model, plugins and permissions were unchanged. The chat remains enrolled and its
test schedule is paused.

The maintained [native CLI](native-cli.md) now exposes enrolment, node installation,
tasks/comments, execution requests, schedules, scoped worker staging and the native
board under `node src/cli.mjs native`. Custom JavaScript is not required for these
operations. The advanced operator command API remains available explicitly.

## Routes

- `GET /v1/info`: protocol and instance identity.
- `GET /v1/snapshot`: atomic shared-record snapshot and exact event checkpoint.
- `POST /v1/commands`: `{key, action, payload}`.
- `POST /v1/node-credentials`: human-only `{nodeId, key}` with retry receipt.
- `POST /v1/node-credentials/rotate`: revoke older node credentials atomically.
- `GET /v1/tasks`, `/executions`, `/questions`, `/agents`, `/nodes`, `/comments`,
  `/schedules`, `/occurrences` and `/artifacts`, with bounded opaque-cursor pagination.
- Append `/ID` for a single entity.
- `GET /v1/events?cursor=...&limit=100`: opaque backend-bound event cursor.
- `GET /v1/activity?from=...&to=...`: bounded `[from,to)` history.
- `GET /v1/references?namespace=...&externalId=...`: external identity lookup.

`artifact.attach` accepts `{id, executionId, expectedRevision, runId, resultDigest,
candidate, url, sha256, kind}`. Only the execution's owning node may attach to its
exact published run/result, while in review or completed. `kind` is `git_commit`,
`file` or `report`. URLs must be HTTPS without embedded credentials and at most
4,096 characters. The lowercase SHA-256 digest identifies content, not the URL.
References are immutable, included in snapshots and emit durable events. Attachment
does not fetch content, change execution state or grant acceptance.

Execution schedules may set `definition.targetConversationId` to pin the currently
advertised conversation before their first occurrence. The backend validates the
advertisement, refuses in-place retargeting and refuses transfer of exact-chat
schedules. A replacement conversation leaves pending admission visibly blocked.
Without this field the schedule targets its explicitly enrolled agent, pinning the
actual conversation/binding when admitted.
`expiresAt` also bounds admission of pending occurrences, while admitted turns keep
their settlement obligations. Pause defers pending admission without interrupting
admitted work. Continuations honour other unsettled turns and notices on the binding.

Folder schedules use `definition.targetFolder` instead of `targetAgentId` and
`targetConversationId`. The directory must be absolute/canonical and belong to an
explicitly enrolled agent on `nodeId`. Existing agents can gain an immutable
directory through the human-only `agent.enrol_folder` command with
`{id, expectedRevision, directory}`. New configured bindings register their verified
directory. The v2 proposal tool is `relay_enrol_folder`.

The owner node selects only from its explicit bindings in that exact directory.
Zero or multiple candidates leave admission deferred. Herdr observation alone
cannot supply a target. Each admitted occurrence records its agent, binding and
conversation. Losing that target never reroutes the existing work. A later firing
may select a newly enrolled unique binding. Folder scope cannot change in place
or transfer implicitly to another node. During backend disconnection, installed
scope remains authoritative until the owner observes a change.

`src/native-board-cli.mjs --context /private/owner.json` reuses the Ink task pane
against native records, with `--json` for noninteractive output. The CRON section
includes paused schedules and requested/applied revisions. Detail shows published
occurrence status and summaries, including taskless jobs. Next times are previews,
not local admission receipts. Reopen an existing pane process to load this adapter.
Assignment is
deliberately separate from execution. Status edits and exact candidate review use
backend revisions. Status-plus-comment commits atomically. Full UI parity remains pending.

The Herdr manifest includes an additional `native-work` pane/action. It uses
`RELAY_NATIVE_CONTEXT` or this host's default private backend owner context. Existing
Paperclip actions retain their current path. Reload the Herdr plugin through its
normal mechanism to discover new actions when ready.

`src/backend-backup.mjs --database PATH --output NEW_PATH` uses SQLite's online
backup API and checks integrity, rather than copying a live WAL database. The first
local backup passed. Treat it as secret-bearing state. Restore requires stopping
the backend and explicit reconciliation of any effects since the snapshot.

This initial trusted-user installation shares readable records between enrolled
nodes. Mutations enforce node/agent ownership and human-only decisions. This is
not multi-user/tenant isolation. Workers never receive the owner credential.

## Remaining implementation

Implemented local foundations include atomic event checkpoints, replay
deduplication, durable command publication, immutable admission retries, native
send-intent fencing and a node-owned schedule clock. Recurring occurrences advance
atomically, skip missed ticks and refuse overlap across journal restart. Nine
focused tests initially exercised these paths. A development node service and
worker CLI now stage questions/results under exact agent/run credentials, then
publish only after native settlement. The explicit-binding v2 node runner is
`src/node-cli.mjs`. A real v2 service/native backend smoke passes with a deterministic
model and controlled worker connector. Actual model-driven worker CLI use and the
daemon lifecycle require separate proof. See [implementation ledger](implementation-v3.md).

- Scoped task creation/grants for autonomous node bookkeeping.
- Full provider contracts and live external tracker verification. Native and
  task-only Paperclip/GitHub adapters exist. GitHub publications use a durable
  no-resend journal, with fixture evidence rather than live tracker certification.
- Full node workflow verification, agent question delivery and Herdr discovery wiring.
- Actual native settlement evidence and managed lifecycle integration. Backend
  execution receipts currently trust authenticated nodes' reported evidence.
- Natural-chat human-source bridge. Direct owner answers and the keyboard-only
  TUI inbox prototype exist. Agent-generated input cannot claim human authority.
- Real-runtime offline scheduling and remote acknowledgement verification.
- Public ingress configuration, backend backup/restore and expanded lifecycle checks.

These routes are development contracts and must not be advertised as the complete
spec-v3 implementation. Track the remaining acceptance gates in the specification.
