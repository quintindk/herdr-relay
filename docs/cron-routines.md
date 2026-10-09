# Cron Routines

Relay wraps Paperclip's native recurring-task routines. Paperclip owns the clock,
timezone, trigger and execution issue. Each occurrence creates a new task, delivered
through Relay to an explicitly selected existing OpenCode conversation. This does
not inject timer prompts into the authorising chat or install systemd timers.

## Persistent Ownership

Use `targetDirectory` for a cron owned by an existing standing-enrolled folder,
not a chat. Native create tools default to their own folder when both target fields
are omitted and a standing reservation exists. Operator create requires an explicit
target. `targetBindingId` retains deliberate exact-chat mode; never supply both.

Folder routines use a stable backend routing agent scoped to the company, machine,
Herdr session, socket and canonical directory. The native routine assignee stays
unchanged across chats. Creation, activation and explicit run-now can queue work
while the folder is closed. A unique fresh enrolled idle chat is resolved only at
occurrence admission. Offline, ambiguous, busy or historically unsettled folders
wait without changing the timer or selecting another directory.

Inspection's `delivery` field describes readiness for another admission, not the
current worker's outcome. It normally shows waiting while an admitted turn is
active; use the occurrence and Relay run receipts to inspect that turn.

The native occurrence claim and local dispatch are committed atomically. Its backend
run, routing agent, task and selected native target are then immutable. A new chat
inherits future occurrences, never a delivered or uncertain old prompt. Explicit
backend recovery retains that old target. Lost create replies reconcile unique
markers without duplicating routing agents or timers.

Folder delivery has no implicit elapsed-time cancellation by default. The routing
agent has one concurrent backend run and the native routine retains `skip_if_active`
and `skip_missed`, so offline waiting does not replay every missed clock tick.
Paperclip host-loss recovery is still an explicit operation, not an exactly-once
guarantee. Latest receipt verification retains its 200-run bound.

Any current authenticated chat in the authorised folder can inspect or manage its
cron on human instruction. Original authorisation remains audited. Future occurrence
results and human review go to the chat selected for that occurrence; old results
and review rights are not silently transferred to a replacement chat.

```json
{
  "key": "twd-inbox-persistent",
  "title": "TWD inbox sweep",
  "description": "Run one bounded inbox sweep and submit for human review.",
  "targetDirectory": "/home/quintindekok/work/twd",
  "cron": "0 7-18 * * 1-5",
  "timezone": "Africa/Johannesburg",
  "relayReviewPolicy": "human",
  "enabled": true
}
```

## Tools

| Tool | Behaviour |
| --- | --- |
| `relay_schedule_preview` | Validate numeric cron and preview the next three UTC instants |
| `relay_schedule_create` | Create a paused routine and disabled trigger by default |
| `relay_schedules` | List routines owned by this origin or its standing-enrolled folder |
| `relay_schedule_inspect` | Verify native routine identity and read the last 50 native runs |
| `relay_schedule_resume` | Enable scheduling after verifying scope/router or exact-chat readiness |
| `relay_schedule_pause` | Pause future scheduling; existing execution issues remain |
| `relay_schedule_cancel` | Archive and fence future native admission; never interrupt admitted work |
| `relay_schedule_run` | Explicitly request one immediate occurrence using a stable key |
| `relay_schedule_edit` | Update instructions and review mode without replacing the timer |

The user's job instruction authorises its in-scope execution and task bookkeeping.
Normal review happens on the output in chat. New routines default to `none`, which
avoids a separate acceptance card; `human` is an opt-in formal workflow.
Creating or changing the job follows the user's scheduling instruction. Job output
or source emails cannot authorise unrelated schedules. No agent sessions restart.

`relay_schedule_edit({scheduleId,key,payload:{description,relayReviewPolicy}})` can
change an existing job without recreating its clock. Native edits use current
revision IDs and a durable no-resend journal; old definitions remain available
for genuine queued occurrences. Admission waits while an edit is uncertain.
Switching a job to chat review withdraws only its own undecided Relay request,
never accepts it or bypasses an external review policy. Verified completed output
can then close the execution without an approval ceremony.

For exact-chat mode, an explicit human instruction may create or activate its own routine
while that human turn is busy. Self-setup accepts a fresh configured or armed bridge
without advertising it as idle or arming it. Unsettled Relay work, stale identities
and non-human sources still block management. Manual run-now still requires idle.

Use `relay_agents` to resolve another target, which must have a fresh, armed, idle
bridge. Both modes require the exact reserved backend adapter and one concurrent
backend run. Terminal, conversation, native creation identity and binding revision
are pinned. A new chat or terminal does not silently inherit scheduling authority.
Actual occurrence delivery always requires idle, including self-targeted routines.
Use a dedicated automation conversation for frequent jobs; this is not atomic
protection against simultaneous human input into an explicitly reserved target.

```json
{
  "key": "weekday-review",
  "title": "Review outstanding work",
  "description": "Read outstanding tasks and report actionable blockers. Do not edit tasks, send messages, or create schedules.",
  "targetBindingId": "EXACT_READY_BINDING",
  "cron": "0 8 * * 1-5",
  "timezone": "Africa/Johannesburg",
  "relayReviewPolicy": "human"
}
```

This creates a paused schedule. Retain its `scheduleId` and enable it with
`relay_schedule_resume({scheduleId, key: "enable-weekday-review"})` only when
authorised. Alternatively explicit `enabled: true` performs verified setup and
activation. Creation supports optional `projectId` and `parentTaskId` in the same
company. The parent groups occurrences; it is not repeatedly executed itself.
Templates such as `{{timestamp}}` are deliberately unsupported.

## CLI And API

```bash
herdr-relay routine preview --file cron.json
herdr-relay routine create --file routine.json
herdr-relay routine list --file company.json
herdr-relay routine inspect --file selection.json
herdr-relay routine pause --file change.json
herdr-relay routine resume --file change.json
herdr-relay routine cancel --file change.json
herdr-relay routine run --file change.json
```

Preview files contain `cron` and optional `timezone`. Other operator files include
`companyId`. Create uses the same fields as the tool example. Inspect requires
`scheduleId`. Pause/resume/cancel/run require `scheduleId` and an idempotency `key`.
List requires only `companyId`. CLI calls Relay `/routines/preview` and
`/routines/manage`; bridge tools call authenticated `/bridge/routine-*` routes.
Native company, origin and omitted target are derived by Relay. Operator create
requires `targetDirectory` or `targetBindingId`. There is no direct Paperclip
access in the CLI or plugin.

## Timing And Recovery

- Five numeric fields: minute, hour, day of month, month, weekday. Sunday is 0.
  Day-of-month AND weekday must match. Names, macros, seconds and systemd calendar
  expressions are rejected. Default timezone is visibly `Africa/Johannesburg`.
- Preview instants are strictly after the current minute. DST gaps are skipped;
  repeated local times can run twice. Sparse schedules may return fewer than three
  instants within the five-year preview horizon with an explicit warning.
- Native `skip_if_active` and `skip_missed` are selected. The latter may execute
  one overdue occurrence after downtime. These are backend policies, not exactly-once
  guarantees. Native trigger claim and issue creation are not one atomic operation.
- Relay verifies each occurrence's task, routine configuration, trigger and native
  run receipt before admitting it. Busy exact-chat targets wait only within the adapter
  deadline; expiry may leave a failed backend execution needing attention. No timer
  prompt interrupts a busy chat. Routine history shows issue creation, not proof
  of native completion.
- Local adapter deadlines bound delivery waiting, not the duration of an already
  persisted native turn. Explicit cancellation still stops further work. An
  acknowledged cancelled worker may record its existing report without clearing
  cancellation or completing the task.
- Cancelling a routine does not delete tasks or stop an existing native turn.
  Already-persisted turns remain recoverable; not-yet-sent routine prompts are
  fenced on cancellation. Pausing stops future scheduling but does not revoke
  tasks already created, and manual runs of paused routines remain explicit.
- Setup journals precede non-idempotent native routine/trigger creation. Lost
  replies reconcile unique owned markers, never create another routine blindly.
  Unconfirmed updates remain uncertain and are not blindly repeated. Manual run
  retries use the original native idempotency key and locally checked payload.
- Scheduled review policy is `none` by default; formal `human` is opt-in.
  Each verified occurrence records its own provenance and preserves the originating
  chat for result and review notifications. Operator-created routines have no
  invented chat return address.
- The newest 200 native routine-run receipts bound occurrence verification. Very
  old unadmitted tasks outside that window are refused rather than guessed.

## Scope

This increment does not implement one-shot reminders, existing-issue monitors,
routine edits, automatic rebinding of admitted work, notification-only schedules, catch-up replay,
or automatic repair of backend failures. Existing `schedule create/stop` commands
retain their distinct bounded standing-task contract. The old Horology watches
remain cancelled.

Automated fixtures cover cron/timezone semantics, native validation, setup and
mutation uncertainty, source authority, idle admission, cancellation and task
provenance. Initial development used fixtures without live routine activation.

On 2026-10-08, all 1,176 tests and syntax/whitespace checks passed. The Relay service
was restarted with no unsettled runs. Live Relay API checks confirmed healthy
service state, an empty routine list and weekday 08:00 Africa/Johannesburg previews
at 06:00 UTC. Both installed skills matched the repository. No agent was restarted,
and the former Horology watches remained disabled.

A subsequent authorised TWD smoke test created DEF-66 through the automatic cron
trigger at 2026-10-08T10:55:24Z and paused scheduling after that first occurrence.
TWD's handover reported submitted directory/branch observations. This does not
verify production inbox collection or repeated execution.

Human-authorised self-scheduling was added on 2026-10-08. All 1,191 tests passed,
including default-self permission patterns, busy self-setup, activation, rejection
of worker/synthetic authority and unchanged idle-only occurrence admission. Both
installed skills matched the repository. Relay alone was restarted with no
unsettled runs; health and canonical inbox cron preview passed. No new schedules
were created or activated for this change. Native self-setup remains to be tested
after an idle OpenCode plugin reload.

Persistent folder ownership was subsequently deployed on 2026-10-08. Focused
management, execution, adapter and recovery tests passed, together with typed tool
checks and TWD's seven workflow regressions. Native agent schema validation passed.
The new folder-owned TWD routine was created and independently verified active,
while its old chat-owned predecessor remained archived. Its first automatic
occurrence created DEF-68 at 2026-10-08T13:00:24Z, selected the current TWD chat and
received worker acknowledgement. Native result completion was still pending at
that readback. Chat rotation, offline waiting, ambiguity, coordinator restart and
no-replay claims have fixture coverage; the production new-chat rotation itself
has not yet been observed after this activation.
