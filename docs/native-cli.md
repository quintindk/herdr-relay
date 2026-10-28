# Native CLI

Use the installed `herdr-relay` executable. The `native` prefix selects task,
agent, execution, question/review and schedule operations. `backend`, `node`,
`plugin`, `doctor`, `headless`, `skills`, `release` and `upgrade` are public
administration groups. There is no second legacy CLI/service or provider fallback.

```sh
herdr-relay --help
herdr-relay native --help
herdr-relay tui
```

In a checkout, `node src/cli.mjs` invokes the same router. Most commands return
JSON. Interactive TUI use requires a terminal; `tui --json` is a read-only projection.

## Context and authority

Backend mutations require the appropriate explicit `--context FILE` or configured
`RELAY_NATIVE_CONTEXT`. The board prefers the joined node's scoped `operator.json`,
otherwise the local backend owner context. Workers use their own exact-session
socket context, not a human credential. Keep private files outside the checkout.

The [agent CLI bridge](node-cli-bridge.md) invokes this same parser. It substitutes
configured `{operator}`, `{worker}`, `{node-config}`, `{session}` and `{payload}`
references internally. A current human operation and an execution-scoped operation
have different authority. Ordinary enrolled-agent read-only reconciliation needs
no active execution but cannot borrow operator scope or perform administration.

## Tasks and executions

```sh
herdr-relay native task list --context OPERATOR_JSON
herdr-relay native task resolve REL-32 --context OPERATOR_JSON
herdr-relay native task inspect TASK_ID --context OPERATOR_JSON
herdr-relay native task create --file task.json --key capture-once --context OPERATOR_JSON
herdr-relay native task edit --file changes.json --key edit-once --context OPERATOR_JSON
herdr-relay native task comment --file comment.json --key comment-once --context OPERATOR_JSON
herdr-relay native execution request --file request.json --key dispatch-once --context OPERATOR_JSON
```

Task capture:

```json
{"id":"task-example","title":"Bounded work","description":"Inspect only the assigned scope."}
```

Task edit:

```json
{"id":"task-example","expectedRevision":1,"changes":{"status":"todo"}}
```

Comment:

```json
{"id":"comment-example","taskId":"task-example","body":"Verified progress."}
```

Execution request:

```json
{"id":"execution-example","taskId":"task-example","taskRevision":1,"targetAgentId":"ENROLLED_AGENT_ID","instructions":"Perform one bounded check.","reviewPolicy":"none"}
```

Capture is not dispatch. An execution request is not admission/completion. Follow
pagination and preserve reported completeness/freshness warnings. Resolve readable
references to the native task ID and inspect its revision before writing. Ambiguous
aliases must not select a task automatically.

```sh
herdr-relay native execution inspect EXECUTION_ID --context OPERATOR_JSON
herdr-relay native execution cancel EXECUTION_ID --revision N --reason TEXT --key KEY --context OPERATOR_JSON
herdr-relay native execution handback EXECUTION_ID --revision N --reason TEXT --key KEY --context OPERATOR_JSON
herdr-relay native task complete TASK_ID --revision N --key KEY --context OPERATOR_JSON
```

Cancellation requests do not claim native termination. Human handback withdraws an
eligible assignment and returns its task to Todo; it cannot discard a submitted
result or active child work. Task completion is not execution settlement or review
acceptance. The [TUI](task-board.md) provides a fresh, confirmed handback preview.

## Enrolment and receiving chats

Prefer human `/relay-enrol` and `/relay-attach` in the intended OpenCode chat.
Equivalent explicit CLI operations use `native agent enrol|attach|enrolments`.
`--here` requires the harness's actual session identity; otherwise supply the exact
session/directory. Enrolment does not start work or restart OpenCode.

See [receiving chats](native-receivers.md), [interactive provisioning](native-interactive-provisioning.md)
and [headless setup](headless-authenticated-setup.md) for the distinct workflows.

## Schedules

```sh
herdr-relay native schedule preview --cron '0 8 * * 1-5' --timezone Africa/Johannesburg
herdr-relay native schedule create --file schedule.json --key schedule-once --context OPERATOR_JSON
herdr-relay native schedule inspect SCHEDULE_ID --context OPERATOR_JSON
herdr-relay native schedule pause SCHEDULE_ID --revision N --key KEY --context OPERATOR_JSON
herdr-relay native schedule resume SCHEDULE_ID --revision N --key KEY --context OPERATOR_JSON
herdr-relay native occurrence list --context OPERATOR_JSON
```

```json
{
  "id": "weekday-check",
  "definition": {
    "nodeId": "ENROLLED_NODE_ID",
    "targetAgentId": "ENROLLED_AGENT_ID",
    "instructions": "Perform one bounded check and submit its result.",
    "cron": "0 8 * * 1-5",
    "timezone": "Africa/Johannesburg",
    "enabled": false,
    "reviewPolicy": "none",
    "runResultNotifications": {"inbox": false, "requester": false}
  }
}
```

Creation/activation is explicit. Compare requested and applied revisions; an applied
schedule may still await contract activation. There is no cron run-now verb. Do
not emulate a tick by inventing an occurrence/result or editing SQLite. One-shot
schedules use `at`; separately authorised immediate work uses an execution request.
See [result notifications](run-result-notifications.md).

## Worker protocol and recovery

```sh
herdr-relay native work read --context WORKER_JSON --execution EXECUTION_ID --run RUN_ID
herdr-relay native work submit --context WORKER_JSON --execution EXECUTION_ID --run RUN_ID --key KEY --file result.json
herdr-relay node recover list
```

Submission stages a result; the worker must finish the turn. The node requires
correlated terminal evidence before publication. Interactive worker mutations use
the exact returned `inputRevision` where supplied. New steering is not a reason to
cancel/recreate an assignment.

Every mutation uses an immutable operation key. Lost replies reconcile that key,
not a changed request or duplicate execution. Advanced supported actions use
`native command --file COMMAND_JSON` with `{key,action,payload}` and the same scope
checks. See [maintenance/recovery](maintenance-recovery.md) for audited previews,
backups and exact-hash application. Never delete evidence to clear a conflict.
