# Scheduling Integration Plan

Status: deferred. Captured on 2026-10-08; address other issues before implementation.
No schedules, timers or native routines were created during this investigation.
Previously cancelled monitoring schedules must remain cancelled.

## Direction

Emulate Horology's conversational scheduling interface, not its direct injection
of prompts into whichever OpenCode conversation is current. All agent tools and
CLI commands must use Relay APIs. The Relay connector integrates with Paperclip.

| User intent | Mechanism | Execution identity |
| --- | --- | --- |
| Recurring reports, audits or task reviews | Native Paperclip routine | New execution issue per occurrence |
| Check an existing task once later | Native issue monitor | Same issue, one delayed continuation |
| Repeat a standing task within a bounded window | Existing Relay scheduler | Same task, explicit start/end window |
| Remind the human without doing work | Relay durable notification | No model turn |

These contracts must remain distinguishable even if one tool interface serves them.

## Research Baseline

Inspected local Horology source at `~/play/horology` and installed Paperclip
`2026.1001.0` source. Source inspection is not live verification of scheduler
configuration, wake admission or timing behaviour.

Horology provides named jobs, relative delays, systemd calendar expressions,
list/cancel tools and persisted definitions with restart reconciliation. Its firing
path calls `session.promptAsync` or `session.command` without its own idle or
overlap guard. Its current-session selection can follow later session events.
One-shot cleanup follows the dispatch attempt, including caught failures. Those
behaviours must not be copied into Relay.

Relay already has bounded interval schedules in `src/schedules.mjs`: service-scoped
binding, standing task, start/end timestamps, stable pending-slot idempotency keys,
no overlap with unsettled work, and late-dispatch refusal after expiry. Preserve
that shipped behaviour rather than silently replacing it with new-issue routines.

### Paperclip Contracts

- Routines: `/api/companies/:companyId/routines`, `/api/routines/:id`,
  `/api/routines/:id/triggers`, `/api/routine-triggers/:id`,
  `/api/routines/:id/run` and `/api/routines/:id/runs`.
- Routine schedule triggers use five-field numeric cron and an IANA timezone.
  They do not accept systemd `OnCalendar`, seconds, years or weekday names.
- Day-of-month and weekday use AND matching. Sunday is 0, not 7.
- Routine ticks normally create new issues. `parentIssueId` groups executions
  beneath a parent; it does not make that parent the recurring execution target.
- `coalesce_if_active` is based on dispatch fingerprints and live backend runs.
  It is not a routine-wide or agent-wide mutex. Changing payloads, revisions or
  interpolated timestamps can defeat the expected overlap suppression.
- `skip_missed` emits one overdue occurrence before advancing beyond now.
  `enqueue_missed_with_cap` can process further batches after an outage. Neither
  should be described as an unconditional guarantee against catch-up bursts.
- Trigger claiming advances `nextRunAt` before dispatch. A crash in between can
  consume an occurrence without an execution receipt.
- Routine/trigger creation has no exposed idempotency key. Explicit routine run
  invocation supports one, but does not compare a retry's payload for key misuse.
- Paused routines can still be invoked manually/API-side. Stopping future triggers
  does not cancel already-created execution work.
- Routine triggers expose no start/end window or maximum execution count.
- Issue monitors use `executionPolicy.monitor.nextCheckAt` on an agent-assigned
  issue in an eligible state. They are one-shot and clear after firing. Updating
  a monitor must preserve the existing execution and review policy.

Relevant installed sources are the server's `routes/routines.js`,
`services/routines.js`, `services/cron.js`, `services/heartbeat.js`, and the shared
`validators/routine.js` and `validators/issue.js`. Recheck the installed contracts
before implementation; do not rely on stale upstream examples.

## Proposed Surface

Names are proposals, not currently available tools:

```text
relay_schedule_preview
relay_schedule_create
relay_schedules
relay_schedule_pause
relay_schedule_resume
relay_schedule_cancel
```

Illustrative recurring task request:

```json
{
  "key": "weekday-task-review",
  "name": "Weekday task review",
  "mode": "task",
  "targetBindingId": "EXACT_RESOLVED_BINDING",
  "cron": "0 8 * * 1-5",
  "timezone": "Africa/Johannesburg",
  "title": "Review today's open work",
  "description": "Identify priorities and blockers. Do not send messages or change assignments.",
  "reviewPolicy": "human"
}
```

This is an interface sketch, not a valid current Relay command. Preview must show
the exact target, timezone, next few occurrences, review policy, persistence and
busy/offline behaviour. Calculate relative times using a real clock in code.
Default visibly to `Africa/Johannesburg` for this installation. Store one-shot
instants in UTC. Specify DST behaviour rather than implying it is configurable
when the backend has no such option.

## Implementation Sequence

1. Wrap native routine creation in durable Relay operations. Create paused, add
   the trigger, verify exact backend receipts, then activate. Reconcile uncertain
   creation without duplicate routines. Preserve backend revision checks on edits.
2. Bind generated execution issues to their recorded routine, target, review policy
   and originating chat. Extend task-origin handling explicitly; do not fabricate
   ordinary operator-task creation receipts for native routine executions.
3. Add safe busy/offline admission. Keep one native turn per binding and backend
   `maxConcurrentRuns: 1`. Record deferred, expired or blocked occurrences, rather
   than injecting into an active human chat or failing every busy wake terminally.
4. Add pause, resume, cancellation and execution history through Relay APIs and CLI.
   Future scheduling and active-run cancellation require separate decisions.
   Cancelled schedules must not resurrect after service/plugin restart.
5. Add one-shot task follow-ups through native monitors, preserving policy. Add
   notification-only reminders without creating dummy tasks or model turns.
6. Add a schedules view to the Herdr pane and update both skills. Show target,
   next occurrence, last result and blockers. Timer firing, task creation, native
   execution and task completion are separate states.

## Safety And Recovery

- Use explicit native human-source and permission checks for schedule creation or
  scope changes. A timer payload or worker-generated message is not new human
  authority. Do not silently migrate existing Horology jobs.
- Never use the newest chat in a folder as an implicit execution target. Define
  whether and how a schedule survives conversation replacement before enabling it.
- Frequent monitoring should use a dedicated automation agent. Existing project
  agents can be targets only with deliberate idle-only scheduling. Even an idle
  snapshot is not atomic protection against simultaneous human input.
- Require an intentional duration or continuing authorisation policy for recurring
  work. Native cron and existing bounded Relay schedules must not both drive the
  same task accidentally.
- Preserve failed and uncertain occurrence evidence. Do not delete one-shots merely
  because a send was attempted, or replay unknown native actions after reconnect.
- Native routine activity gates observe Paperclip activity, not unseen external
  email/Teams events. They can suppress a poller intended to discover that activity.
- Notification-only reminders should use the durable UI notice model. A toast
  acknowledgement proves API acceptance, not human readership or completed work.

## Tests Before Rollout

- Permission denial, changed source, cross-company target and replaced conversation.
- Invalid cron, systemd expressions, timezone/DST boundaries and next-run previews.
- Busy developer chat, agent offline, overlapping ticks and concurrent scheduler calls.
- Lost create/activate/run responses, restart recovery and exact occurrence identity.
- Missed occurrences, bounded catch-up, cancellation during dispatch and no resurrection.
- Human review defaults, routine-generated task lineage and return notifications.
- Live isolated execution only after fixture tests pass and target behaviour is agreed.

## Open Decisions

1. Default execution target: dedicated automation agents are recommended for frequent
   checks; explicitly selected project agents for scheduled project work. Not agreed yet.
2. Fresh-chat policy: pause for explicit rebinding, or a separately authorised durable
   agent identity. Do not infer it from today's folder enrolment.
3. Recurrence bounds and missed-run policy: what the user must choose, and which
   defaults Relay can truthfully enforce above native routines.
4. Reminder scope: include notification-only reminders in the first delivery or defer
   until recurring task execution is verified.

Recommended first slice: native recurring tasks with preview, safe target admission,
pause/cancel, history and origin-bound result notifications. No implementation or
activation is authorised by this plan alone.
