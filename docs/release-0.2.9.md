# Herdr Relay 0.2.9

**Draft. Not published.** Release preparation does not install code, change running
services or authorise a tag/publication. The published 0.2.8 assets remain unchanged.

## Online result delivery

- Fix first-consumer registration discarding newly published notices even when
  the requester is online. Replacing a known consumer still drops pending online
  notices, rather than replaying a backlog after a node restart.
- Retain diagnostic delivery records separately from the transient send queue.
  Capture the result digest, original requester/binding, deterministic native
  message ID, stage, reason and correlated terminal outcome.
- A native queue acknowledgement is **accepted**, not delivered. Delivery requires
  the original informational turn's successful native terminal. Failed/interrupted
  native presentation and unknown outcomes remain distinct from the business result.
- A lost reply permits read-only observation of the original message, not resend.
  Restart recovery does not recreate unsent notices or retarget another chat.
- Inspect `requesterDelivery` with `native occurrence inspect OCCURRENCE_ID` using
  the existing scoped context. Inbox result detail includes the delivery state and
  reason. The submitted result, unread Inbox item, cron and worker remain unchanged.

The first-poll defect is independently reproducible. It does not establish the
exact historical loss point for previously missing inbox-sweep-v2 notices.

## Compatibility and operational limits

Protocol remains **relay/0.2**, backend schema **2** and node schema **1**. Existing
interactive provisioning, collaboration, agent deletion and installer compatibility
protocols remain **1**. No database migration or re-enrolment is introduced.

Upgrade the backend and requester node after publication to obtain backend delivery
outcomes and native correlation. Older backends can still receive online-only sends
with local observations, but do not expose the new backend diagnostics. No historical
outcome is manufactured, and old results are not backfilled.

This change does not grant peer-messaging permission to the sweep worker, add a
collector, toggle notifications, change a grant or run missed sweeps. It does not
include the separate installer downgrade-guard fix.

## Verification status

- **711 root regression tests and 149 plugin tests passed: 860 tests.**
- Repository syntax/document checks, release metadata validation and workflow lint
  passed. The checkout's production-dependency audit reported **zero vulnerabilities**.
- Isolated OpenCode **2.1.0** checks published a new actual cron result into its
  original coordinator chat and observed a correlated successful native terminal.
  The Inbox item survived node restart and the native notification was not replayed.
- The combined coordinator-grant, native task/artifact capability and shell fixture
  also passed with requester result delivery enabled. No user service or credential
  store was used, and readiness had no external effects.
- Regressions cover first polling, offline/overflow drops, known consumer replacement,
  lost native and diagnostic acknowledgements, mismatched receipts, node/backend
  restart, receiver races, native failure, observation timeout and non-secret diagnostics.
- Installed-package publication gates now require correlated requester delivery on
  **2.1.0, 2.1.2 and 2.2.5**, alongside the existing installer, keyboard and recovery
  evidence. Tests reject absent/failed delivery evidence or live fixture effects.

Exact clean-source packaging, the full installed supported-host matrix, a fresh
installed production audit and tag publication gates remain required before this
draft is published. Passing checkout tests alone does not satisfy those gates.

Fixture delivery is not proof of repaired production delivery into Mason's Surface
chat. That requires an explicitly deployed release and a newly published real result,
without replaying historical business work or sending a manual replacement notice.
