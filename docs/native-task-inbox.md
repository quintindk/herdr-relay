# Task Inbox and human decisions

`herdr-relay tui` exposes Tasks, Agents, Inbox, Grants and Schedule. The board and
OpenCode human-decision commands use the same native backend records and revision
checks. There is no external task-tracker board.

## Questions

Human-addressed questions appear in Inbox and the related task detail. Inspect the
exact prompt and context, enter an answer, preview and confirm. Agent-addressed
questions remain with their coordinator until explicitly forwarded to the human.

Answering a blocking question makes its original continuation eligible; it does
not create a second execution. An answer to cancelled/ended work does not restart
it. Source attribution and the exact answer are preserved in the decision record.

## Reviews

Inspect the submitted report and exact candidate, choose acceptance or requested
changes, give a reason and confirm. Native terminal success and submission alone
cannot satisfy a required human review. Requested changes return ordinary work to
Todo without automatically dispatching another turn. Monitoring checks retain
their distinct bounded-window review semantics.

A human handback is not a shortcut around review. Submitted results and active
child assignments require their own decisions. See [the board](task-board.md).

## Informational results and reminders

Scheduled run results are optional per schedule. **Mark result read** acknowledges
the notification only. It does not approve the candidate, complete a task, change
the cron, advance business coverage or start model work. Reports preserve partial
coverage and failure diagnostics. See [run result notifications](run-result-notifications.md).

Acknowledging a reminder similarly starts no model turn. A published report and an
external-message delivery receipt are different kinds of evidence.

## Uncertain publication

Confirmed decisions persist locally before POST. Lost replies retain their exact
payload, operation key and backend identity. Reconciliation reuses that original
command; it must not create another question answer, handback or execution request.

Definitive refusal is shown for inspection. Dismissing a refused decision does not
erase its evidence. Unknown effects remain fenced; a backend outage is not an
empty Inbox or proof that a decision did not apply.

Work/result decisions recover under Inbox. Security decisions recover under
Grants. Permission approval resumes the saved authorised request; it does not
grant unrelated work or messaging authority.

## OpenCode integration

`plugin install` configures the native Relay server/TUI plugins using the joined
node's operator context. It may be installed before an agent session exists.
Optional `native inbox install --here --context OPERATOR_JSON` selects a human
session for Inbox toasts; outside that chat supply its exact session ID.

- `/relay-questions` exposes human-addressed questions.
- `/relay-reviews` exposes eligible exact candidate reviews.
- `/relay-decisions` exposes keyboard-confirmed native proposals when configured.
- `/relay-status` inspects runtime status; it is not an authority grant.

Toasts are read-only and do not answer or review anything automatically. Pending
dialogs bind the selected session and backend identity. Session changes, reloads,
reconnects and disposal fence stale decisions. Configuration reload does not require
an OpenCode restart. See [plugin implementation](../packages/opencode-relay/README.md).
