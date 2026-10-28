# OpenCode bridge for the node CLI

`relay_cli` invokes the installed `herdr-relay` CLI, not a second implementation
of its commands. `relay_cli_help` reads that CLI's current native, maintenance and
headless help. The executable and bridge share `src/native-cli-surface.mjs` for
native entrypoint routing. Operations beneath those entrypoints are passed through
unchanged. Unqualified retired commands and external trackers are not a fallback
for native work.

## Coverage

| CLI surface | Bridge |
|---|---|
| Task create, edit, comment, resolve, inspect, list, complete, cancel | `relay_cli` with `native task ...` |
| Execution request, inspect, list, cancel | `relay_cli` with `native execution ...` |
| Worker read, submit, questions, children, messages and other worker verbs | `relay_cli` with `native work ... --context {worker}` |
| Schedule preview, create, inspect, list, pause, resume, cancel | `relay_cli` with `native schedule ...` |
| Agent enrolment, attachment, listing and launch | `relay_cli` with `native agent ...` |
| Interactive preparation, dispatch, inspection and grants | `relay_cli` with `native interactive ...` |
| Node installation, ensure, run, policy, join, bootstrap and revoke | `relay_cli` with the corresponding native/node command |
| Headless provision, inspection, connections, grants, setup and status | `relay_cli` with `headless ...` |
| Backend installation, initialisation, run, backup, status and inventory | `relay_cli` with the corresponding native/backend command |
| Task-reference grants and migration | `relay_cli` with `native task-reference ...` or `native task migrate-references ...` |
| Plugin and skill install/status/uninstall, doctor | `relay_cli` with the corresponding native CLI command |
| Release install, node/backend upgrade, upgrade status/resume/rollback | `relay_cli` with the corresponding maintenance command |
| Board and version/help | `relay_cli` with `tui --json`, `--version` or help arguments |
| Advanced native command envelope | `relay_cli` with `native command ...` |

This is method coverage, not an assertion that every operation is authorised on
every node. Existing CLI actor scopes, revisions, immutable keys, maintenance and
readiness checks still apply. Headless grants can be issued through the enrolled
agent connection or local node operator without a backend-owner context. Global
node bootstrap and other backend-root administration remain separate.

## Call shape

Arguments are an array, never a shell command. No quoting, piping, command
substitution or arbitrary executable selection is involved.

```json
{
  "args": ["native", "task", "create", "--key", "request-task-v1", "--file", "{payload}"],
  "payload": { "id": "requested-task", "title": "Review the inbox-sweep grant proposal" }
}
```

`payload` supplies a private temporary JSON file. Tokens are resolved inside the
bridge, without exposing credential contents:

- `{operator}`: existing node-local operator context.
- `{worker}`: current chat's exact worker context.
- `{node-config}`: existing node configuration.
- `{session}`: current OpenCode session ID.

Normal task commands use the existing local operator context through the CLI's
normal `RELAY_NATIVE_CONTEXT` mechanism. Explicit `--context` can select only the
configured operator or exact-session worker, not an arbitrary backend-root file.
Root-only operations remain exposed but fail unless the existing configured actor
already has the authority required by the CLI. The bridge creates no new grants.

To pass an existing task to another existing agent, inspect its current revision
and call the same CLI execution-request operation:

```json
{
  "args": ["native", "execution", "request", "--key", "send-task-v1", "--file", "{payload}"],
  "payload": {
    "id": "requested-execution",
    "taskId": "requested-task",
    "taskRevision": 1,
    "targetAgentId": "EXACT_EXISTING_AGENT_ID",
    "instructions": "Review the proposal and report the result.",
    "reviewPolicy": "human"
  }
}
```

There is no active-parent-execution requirement for this human-chat route. It does
not provision an agent. Source/origin fields, where supplied, use the actual
originating agent and chat rather than fabricated identifiers.

## Runtime behaviour

- Human-chat calls use the native source message and normal OpenCode tool permission
  evaluation. Input changes during permission evaluation cancel dispatch.
- Scheduled/delegated/peer-message input cannot silently become operator authority.
  Headless sessions retain their separately granted tools.
- `relay_status` describes the status inspection only. It is not a chat-wide
  read-only permission verdict. `relay_work_read` is an execution inspection, not
  an interactive capability probe.
- The runtime is Node.js from `PATH`, matching the CLI's executable shebang.
  `process.execPath` inside packaged OpenCode is OpenCode itself, not Node.js.
- Exit code, stdout and stderr are returned. Structured credential fields are
  redacted. This is not an OS sandbox or a generic shell tool.
- A non-zero, timed-out or interrupted invocation may already have effects.
  Its payload is retained for exact-key reconciliation. The bridge never retries
  it automatically.
- Commands that need a terminal retain their CLI terminal requirement. Use their
  documented `--json`/`--dry-run` modes for machine calls. The bridge does not
  pretend to render an interactive task board in a JSON response. Long-running
  foreground commands remain foreground; `timeout: 0` disables the default timeout.

## Verification boundaries

Unit tests cover command-family routing, future operations, internal context/payload
substitution, human input changes, headless isolation and uncertain effects. A real
OpenCode model/tool test invokes this plugin bridge, creates a task through the
actual CLI and requests execution by an existing peer without a parent execution.
That test proves request creation, not worker execution or automatic result handback.
