# Native Relay CLI

The full native entry point is `node src/cli.mjs native`, or `herdr-relay native`
in an installed build. Public `backend`, `node`, `plugin`, `doctor`, `tasks` and
`headless` administration commands also use the native implementation. Legacy
unqualified `agent`/`schedule` commands remain separate. Native commands never
silently fall back to Paperclip.

```bash
npm ci
npm ci --prefix packages/opencode-relay
node src/cli.mjs native --help
```

Use `--context /private/owner.json` or `RELAY_NATIVE_CONTEXT` for operator commands.
This is a native backend context, not a legacy Relay admin token. Workers use
their own exact-session credential and local node socket instead. Keep credentials
outside the checkout. Enrolment never prints a token.

The `relay_cli` tool uses this same CLI implementation, with authority appropriate
to its source. A current human request uses the joined node's existing operator
context. Verified instruction loads and correlated shell/subagent completions do
not replace that request. Unrelated notifications do not inherit older authority.

An accepted interactive execution uses its exact worker connector, never the
human operator credential. Ordinary native reads, comments/updates on its assigned
task and its own execution progress are supported through the same parser and
backend commands. New task creation, dispatch and lifecycle administration require
separate authority. These worker calls are bound to the originating invocation,
execution and run. Headless jobs retain their granted tools rather than this CLI.

## Existing conversation enrolment

For dedicated recurring automation without an interactive conversation, use the
[native headless agent](native-headless-agents.md) provisioning path. The public
`herdr-relay headless provision` command plans by default; `--apply` configures one
persistent owned binding. It never starts work or silently enables a schedule.

Native enrolment now creates a **durable workspace/role agent**, not a session-
derived node and agent. See [receiving chats](native-receivers.md) for human-only
`/relay-enrol`, `/relay-attach`, automatic new-chat attachment and persistent crons.
Use a clean development config. Old session-derived enrolments are not migrated.

```bash
node src/cli.mjs native agent enrol \
  --here --reserved --transport cli \
  --name Wright --config /private/machine-node/node.json \
  --context /private/owner.json
node src/cli.mjs native node install --config /private/machine-node/node.json
```

`--here` requires the current harness's `OPENCODE_SESSION_ID`. Otherwise supply
`--session ID --directory /absolute/project`. `--service-registration FILE` selects
an existing authenticated local OpenCode service. Discovery never starts one.

Enrolment verifies session/project/directory/creation identity, creates a stable
installation and workspace/role agent, then attaches the exact initial chat.
Configuration and credentials are mode 0600. Repeating it verifies the existing
scope without issuing another credential or creating another agent.
Replacement chats use `agent attach`, not another enrolment. Transport changes
require explicit reconciliation. Historical endpoints and credentials remain
with their original bindings.
It never adopts another chat, changes permissions/model/plugins or restarts OpenCode.

`--transport cli` explicitly selects the chat's existing shell and scoped worker
CLI. It does not grant shell access. Default `tools` requires the native worker
plugin/connector to be configured separately. Enrolment is not tool-execution
certification. Validate a bounded turn before production use.

`node install` uses the maintained Linux user-service installer. `node run --config
FILE` runs the same daemon in the foreground. Separate startup is intentional.
Enrolment alone does not claim a running node. Nodes advertise their verified
conversation after startup.

## Tasks, comments and execution

```bash
node src/cli.mjs native task create --file task.json --key create-task --context /private/owner.json
node src/cli.mjs native task inspect TASK_ID --context /private/owner.json
node src/cli.mjs native task edit --file changes.json --key edit-task --context /private/owner.json
node src/cli.mjs native task comment --file comment.json --key add-comment --context /private/owner.json
node src/cli.mjs native comment list --context /private/owner.json
node src/cli.mjs native execution request --file request.json --key request-work --context /private/owner.json
node src/cli.mjs native execution inspect EXECUTION_ID --context /private/owner.json
```

Files contain native payloads, not legacy company/routine envelopes:

```json
{"id":"task-example","title":"Bounded test","description":"Inspect only the assigned scope."}
```

```json
{"id":"task-example","expectedRevision":1,"changes":{"status":"in_progress"}}
```

```json
{"id":"comment-example","taskId":"task-example","body":"Progress evidence."}
```

```json
{"id":"execution-example","taskId":"task-example","taskRevision":2,"targetAgentId":"ENROLLED_AGENT_ID","instructions":"Perform one bounded check.","reviewPolicy":"none"}
```

An execution request is not proof of admission/completion. The node admits,
journals and invokes native work. Workers read and stage through scoped commands:

```bash
node src/cli.mjs native work read --context /private/worker.json --execution EXECUTION_ID --run RUN_ID
node src/cli.mjs native work submit --context /private/worker.json --execution EXECUTION_ID --run RUN_ID --key submit-result --file result.json
```

Submission stages a candidate, then the worker must finish its turn. The node
requires correlated native terminal evidence before publishing. Required review
remains separate. No CLI verb fabricates native completion.

`native task complete TASK_ID --revision N --key KEY` changes a task's status as
the human operator. It is **not** execution settlement, result submission or
candidate acceptance. `execution cancel` requests cancellation without claiming
the harness stopped. Backend ownership/revision/policy checks still apply.

## Schedules

```bash
node src/cli.mjs native schedule preview --cron '0 8 * * 1-5' --timezone Africa/Johannesburg
node src/cli.mjs native schedule create --file schedule.json --key create-schedule --context /private/owner.json
node src/cli.mjs native schedule list --context /private/owner.json
node src/cli.mjs native schedule inspect SCHEDULE_ID --context /private/owner.json
node src/cli.mjs native schedule pause SCHEDULE_ID --revision N --key pause-schedule --context /private/owner.json
node src/cli.mjs native schedule resume SCHEDULE_ID --revision N --key resume-schedule --context /private/owner.json
node src/cli.mjs native occurrence list --context /private/owner.json
```

```json
{
  "id": "weekday-check",
  "definition": {
    "nodeId": "ENROLLED_NODE_ID",
    "targetAgentId": "ENROLLED_AGENT_ID",
    "targetConversationId": "EXACT_ADVERTISED_SESSION_ID",
    "instructions": "Perform one bounded check and submit its result.",
    "cron": "0 8 * * 1-5",
    "timezone": "Africa/Johannesburg",
    "enabled": false,
    "reviewPolicy": "none"
  }
}
```

Activation is explicit through `enabled` or `schedule resume`. Enabled recurring
schedules continue until paused/cancelled/expired. Completion does not implicitly
pause them. Compare backend `revision` with node `appliedRevision`. Remote changes
are not effective until acknowledged. Admitted work retains settlement obligations.

Native cron run-now is not implemented. Do not emulate an occurrence by posting
a result, editing SQLite or inventing terminal evidence. Immediate ordinary work
uses an execution request. One-shot schedules use `at` instead of `cron`.

Mutations require an explicit stable `--key`. Retry with the same key and payload.
Backend transactions own idempotency, revision/ownership checks and events. Lists
expose pagination. Advanced actions use `native command --file command.json` with
`{key,action,payload}`. Review/grant/transfer and some other advanced operations
still use that command API or their existing scoped tools/UI, not named CLI verbs.

## Native task pane

Run `npm run board` from the checkout, or `herdr-relay tui` in an installed build.
`node src/cli.mjs tui` is the equivalent development command. These open the native
board with the local owner context by default. `--context` and
`RELAY_NATIVE_CONTEXT` override it. No other native mutation gets an implicit
owner context, and the legacy Paperclip `board` command is unchanged.

The [native task board and Inbox](native-task-inbox.md) has Tasks, Agents, Inbox,
Grants and Schedule views. Human questions, candidate reviews and reminders can be handled
directly in the board with explicit previews/confirmations. Native task detail
links to those same actions. Confirmed board decisions use a private durable local
journal for uncertain publication and restart reconciliation. The OpenCode slash
commands below remain available, but are not required for the board workflow.

[Grants](native-interactive-provisioning.md#grants-approval) is the separate
security-management surface. Pending requests offer Approve once, Allow this scope
and Reject. Active permissions can be revoked. History records security decisions.
Confirmed but unacknowledged security decisions recover under Grants, not Inbox.

### Human questions and reviews in OpenCode

```bash
node src/cli.mjs native inbox install --here --context /private/owner.json
```

Outside the current human chat use `--session HUMAN_SESSION_ID` instead of `--here`.
The session selects where automatic inbox notifications appear. It does not enrol
or invoke that session. `--config-dir DIR` overrides the global OpenCode config
directory. `--evidence-file /private/existing-directory/human-inbox.jsonl` enables
local load/notification/decision evidence without recording credentials or answer
text in that file.

The installer adds the native Relay server and TUI plugin to `opencode.json` and
`cli.json`, preserves other settings/plugins and creates private byte-for-byte
backups before changing existing files. Repeating it makes no duplicate entry or
backup. Conflicting Relay owner/session settings, duplicate entries and an existing
`opencode.jsonc` require explicit reconciliation instead of silent replacement.
It does not restart OpenCode or change model/permissions. Valid configuration edits
reload in running clients. Verify the slash commands actually appear before testing.

The server plugin provides the reload-generation check. The owner context path
is configured only in the local TUI, not in server/model tools. The bootstrap
owner file may omit `url`, using the same loopback default as the native CLI.

- Human-addressed questions notify only the configured selected human session.
  Agent-addressed questions still use the initiating-agent delivery path.
- Notifications are read-only, deduplicated toasts. They never start a model turn,
  open an unsolicited modal or publish an answer/review. A backend outage is shown
  without claiming there are no pending questions.
- Open `/relay-questions`, select the question, type your answer and confirm the
  exact prompt/answer. The TUI publishes the decision directly to Relay. Do not
  send the answer to the worker or paste it into a controller's question tool.
- Open `/relay-reviews`, inspect the exact candidate, choose accept/reject, give
  a reason and confirm. Submission and native settlement alone cannot pass a
  human-review policy.
- Decisions retain session/dialog attribution and a digest. This is keyboard-dialog
  provenance, not a claim that an arbitrary native user message is human-authenticated.
- Session changes, reconnects, plugin reload or disposal fence stale decisions.
  Confirmed operations are saved before publication and reuse their original key
  after a lost response.

To remove the integration, remove only its plugin entries from both configs,
preserving subsequent unrelated edits. Do not blindly restore an old whole-file
backup after other settings have changed. Inbox decisions and pending backend work
are not deleted by removing a plugin.

`native board` opens the same Ink view as the native Herdr work pane. `--json`
prints its snapshot. The CRON section includes paused schedules. Enter shows
requested/applied state, target and the last 50 published occurrence receipts,
including taskless results. Schedule detail is read-only. Use the CLI for mutations.

Next times are clock previews, not admission receipts. The backend does not contain
every local pending/running occurrence. Requested changes are not shown as applied.
Reopen an already-running task-pane process to load the updated adapter. No agent
restart is needed.

## Earlier live test and version policy

The original temporary scripts called the native API and maintained node installer.
The watcher observed state and requested a pause after first admission. It did not
run the clock, inject work itself, forge results or write database rows.

The node generated the real occurrence, persisted native intent and invoked the
exact conversation. The scoped worker CLI staged a result. Native settlement
enabled publication through `schedule.publish`. That was a taskless occurrence,
not task creation/commenting or a manual Done transition. Pause-after-first-admission
was external test control, not a built-in recurring-job policy. The test stays paused.

Normal enrolment/task/comment/execution/schedule/worker operations now have
maintained `native` commands and do not require custom JavaScript. This is not full
v3 interface parity.

Runtime admission accepts **2.x**, not a patch allow-list. Other majors and malformed
versions are refused. Exact native identity, decoded response contracts, pagination,
idle/inbox checks, send-intent journalling and correlated terminal receipts remain
mandatory. Incompatible future APIs must fail those checks, not downgrade validation.
Compatibility was exercised on 2.1.0 and 2.1.2, not every future release. SDK/test
lockfiles remain reproducible and are independent of runtime version admission.
