# Run result notifications

Run result reporting is separate from cron firing, execution admission and model
startup. The per-schedule setting is **Run result notifications**, stored as:

```json
{
  "runResultNotifications": {
    "inbox": true,
    "requester": true
  }
}
```

Both switches default to `false`. Neither is inferred from job instructions.
An absent field preserves the existing silent behaviour. When the setting is
supplied, both booleans must be explicit. There is no global opt-in.

## Independent outputs

**Save run results to Inbox** (`inbox`) creates one persistent, unread information
item when Relay records a completed or failed scheduled result. It includes the
schedule, intended/result-recorded times, exact occurrence, full submitted report,
result digest and any recorded failure diagnostic. The result and Inbox entry
commit atomically. Retried publication cannot create another entry.

Open the item in Inbox, scroll its full report and choose **Mark result read**.
This acknowledges only the notification. It does not approve the work, change the
execution, close a task or start another run. A completed execution with a report
of partial coverage remains partial coverage, not an inbox all-clear.

**Message requester when online** (`requester`) is service-generated, best-effort
delivery to the recorded interactive requester. It does not grant messaging
permissions to the worker or impersonate an interactive sender. The recipient
comes from the platform-owned coordinator relationship, not the submitted report.

- Fresh requester and node heartbeats plus the exact enrolled receiving chat are
  required. Busy counts as online; an unknown/stale/offline receiver does not.
- Online but busy delivery waits in bounded memory until safe. An offline or
  replaced receiving chat causes the notice to be dropped.
- Backend/node restart drops transient messages. A lost transport/native send
  reply is not retried. There are no durable delivery receipts, backlog replay,
  delivery alarms or attempts to launch an offline agent.
- The message is information only, never human authority or an execution grant.
  It asks the requester to present the report, not acknowledge it, resume earlier
  work or dispatch anything. No automatic reply chain is authorised.
- Dropping the message cannot change a committed run or remove its Inbox entry.

Only published completed/failed run results trigger reporting. Pending human
review is not completion; accepted review can produce the completed result notice.
Run creation, progress, unanswered questions, readiness probes, reminders and
skipped ticks do not produce run result notifications. Uncertain/unpublished work
is not silently relabelled completed or failed to generate an alert.

## Configure a new headless setup

The enrolled coordinator can pass `runResultNotifications` to
`relay_headless_setup`, or set it under `schedule` in its headless grant request.
A setup selection overrides the grant's initial reporting preference without
changing the grant or worker permissions. CLI equivalent:

```sh
herdr-relay headless setup --grant-id GRANT_ID --key NEW_SETUP_KEY \
  --run-result-inbox true --run-result-requester true
```

The destination-local provisioning manifest also accepts
`schedule.runResultNotifications` for Inbox reporting. Requester reporting needs
authenticated coordinator setup: the local provisioning flow has no requester
agent and refuses `requester: true` rather than guessing one. As before,
provisioning only prepares a disabled schedule export; it does not activate a
cron or start model work.

## Change an existing schedule

In **Schedule**, select a cron and press **n** for **Run result notifications**.
Toggle each output independently, preview, then confirm. The same settings are
available from the schedule detail. They are not Grants/security decisions.

CLI, after inspecting the exact schedule revision:

```sh
herdr-relay native schedule inspect SCHEDULE_ID --context OPERATOR_JSON
herdr-relay native schedule result-notifications SCHEDULE_ID \
  --revision N --inbox true --requester true --key IMMUTABLE_KEY \
  --context OPERATOR_JSON
```

The enrolled original coordinator can use `relay_schedule_result_notifications`
with `{key,payload:{id,expectedRevision,runResultNotifications}}`. This route is
scoped to that coordinator's schedules, including its headless worker's cron.
Workers cannot choose another requester or expand their grant. The joined node
operator is restricted to its own node/workspace; the backend owner can manage
the owner's schedules. Requester delivery requires a recorded interactive
requester. Schedules without one can still use Inbox reporting.

The revisioned update changes only reporting preferences. It preserves the worker,
grant, identity, instructions, cron, enabled state and previous results. The node
must acknowledge the new schedule revision before using it. Already admitted
runs retain their original revision's policy. No old results are backfilled.
Reusing a key with changed flags is a conflict, not a settings edit.

Use backend, node and plugin versions supporting reporting before enabling it.
Unknown old backends fail capability checks rather than silently accepting a
setting they cannot honour. The implementation uses existing JSON records and
journals: backend schema stays 2, node schema stays 1. No live job is opted in by
installing the release, and no OpenCode restart is required to reload plugins.
