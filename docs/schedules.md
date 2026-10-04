# Bounded service schedules

Start Relay with `--backend-context /private/operator-backend.json` to enable
operator-authorised scheduling. The file contains `{"token":"BACKEND_TOKEN"}`,
or `{"localTrusted":true}` only for an explicitly trusted loopback Paperclip instance.
Keep it outside the repository with mode `0600`.

```bash
herdr-relay schedule create --file schedule.json
herdr-relay schedule stop --file stop.json
```

```json
{
  "key": "morning-inbox",
  "bindingId": "inbox-monitor",
  "taskId": "PAPERCLIP_STANDING_BRIEF",
  "startsAt": "2026-10-04T06:00:00Z",
  "endsAt": "2026-10-04T15:00:00Z",
  "intervalSec": 300
}
```

The binding must be service-scoped. Each wake targets the existing Paperclip task
and agent. Pending slots retain a stable backend idempotency key across lost
responses and Relay restarts. Unsettled work prevents another wake. Missed slots
coalesce into the next bounded check rather than replaying an entire outage.

The schedule ends at its boundary. Stopping prevents future wakes and does not
assert that an already-running turn stopped. Cancel that invocation separately.
`stop.json` contains the schedule `key`.

Source checkpoints remain separate. A connector reads its cursor and records
events atomically. Production email and Teams source access are outside the
synthetic scenario fixtures.
