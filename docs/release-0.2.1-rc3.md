# Herdr Relay 0.2.1-rc3

This prerelease adds opt-in run result reporting and supported maintenance
recovery. Published RC1 and RC2 tags/assets remain immutable. Publishing this
package does not upgrade running services or change live schedules.

## Run result visibility

- Per-schedule `runResultNotifications: {inbox, requester}` has two independent,
  explicit booleans, both off by default. These are run **result** notifications,
  not cron firing, admission, progress or model-start alerts.
- Inbox reporting atomically retains the exact completed/failed run report as
  unread information. **Mark result read** is not result acceptance or task
  completion. Pending review is not successful completion.
- Requester reporting is service-authored and online-only, with bounded in-memory
  queues for busy receiving chats. Offline/replaced chats, service restarts and
  uncertain sends drop it without replay, delivery alarms or impact on the run.
  It confers no messaging authority on headless workers.
- Settings are exposed during headless setup, through a revisioned coordinator/
  operator CLI/tool operation, and in Schedule under **Run result notifications**.
  Existing workers, grants, credentials, crons and previous results are preserved.
  New preferences apply to future acknowledged schedule revisions, without backfill.
- Full reports and failure diagnostics remain available. Native execution
  completion is not proof of business completeness or external-effect delivery.

See [run result notifications](run-result-notifications.md).

## Compatible upgrades and administrative recovery

- Schema-compatible code upgrades and rollbacks no longer depend on active work,
  conflicts, publication state or native turns settling. Actual database
  migrations retain strict settlement checks. Identity, integrity, configuration
  and release verification remain mandatory.
- Compatible service maintenance preserves live owned model processes and original
  invocation/publication keys. Pending UI decisions defer only the plugin reload.
- Audited `node recover list|work|publication` previews and exact-hash application
  provide a distinct administrative abandonment, backup and preserved original
  evidence. Unknown effects remain fenced; no native success is manufactured.
- Human `native execution handback` returns the task to Todo and withdraws its
  assignment without claiming native completion or process termination.
- Shared operation-specific headless task schemas reject unsupported fields before
  enqueue. Validation refusals, revision conflicts and uncertainty are distinct.

See [maintenance recovery](maintenance-recovery.md) and
[service upgrades](service-upgrades.md).

## Compatibility and release boundary

Protocol remains **relay/0.2**, backend schema **2**, node journal schema **1**.
No database migration, credential rotation or re-enrolment is introduced.

Validation uses disposable backend/node/OpenCode processes and fixture-only
model/MCP effects. It does not certify complete live mailbox/Teams collection.
Publication requires the clean-tagged-source, supported-host, installed-package
and zero-vulnerability audit release gates. Supported-host package checks cover
OpenCode 2.1.0 and 2.1.2. Service upgrades and notification opt-in remain separate
explicit operations. No OpenCode restart is required to reload plugins or skills.
