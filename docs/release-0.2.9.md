# Herdr Relay 0.2.9

Online requester result-delivery fixes and diagnostic outcomes.
Release date: **13 November 2026**. Installation and live service upgrades remain
separate operations from publication. Published older releases remain unchanged.

## Online result delivery

- Fix first-consumer registration discarding newly published notices even when
  the requester is online. Replacing a known consumer still drops pending online
  notices, rather than replaying a backlog after a node restart.
- Fix steady-running eligibility checks comparing backend heartbeat timestamps
  against the receiving node's wall clock. Use backend-observed time plus monotonic
  request/processing time, retaining the same 15-second online window.
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

Both first-poll loss and steady-running clock-skew loss are independently
reproducible. Neither establishes the exact loss point for a particular historical
missing notification or proves that an affected machine's clock was skewed.

## Compatibility and operational limits

Protocol remains **relay/0.2**, backend schema **2** and node schema **1**. Existing
interactive provisioning, collaboration, agent deletion and installer compatibility
protocols remain **1**. No database migration or re-enrolment is introduced.

Upgrade the backend and requester node after publication to obtain backend-clock
presence validation, delivery outcomes and native correlation. Older backends can
still receive online-only sends with local observations, but retain legacy wall-clock
validation and do not expose the new backend diagnostics. No historical outcome is
manufactured, and old results are not backfilled.

This change does not grant peer-messaging permission to the sweep worker, add a
collector, toggle notifications, change a grant or run missed sweeps. It does not
include the separate installer downgrade-guard fix.

## Verification

- **714 root regression tests and 149 plugin tests passed: 863 tests.**
- Repository syntax/document checks, release metadata validation and workflow lint
  passed. The checkout and installed production-package audits reported **zero vulnerabilities**.
- Isolated OpenCode **2.1.0** checks published a new actual cron result into its
  original coordinator chat and observed a correlated successful native terminal.
  The Inbox item survived node restart and the native notification was not replayed.
- The combined coordinator-grant, native task/artifact capability and shell fixture
  also passed with requester result delivery enabled. No user service or credential
  store was used, and readiness had no external effects.
- Regressions cover first polling, offline/overflow drops, known consumer replacement,
  lost native and diagnostic acknowledgements, mismatched receipts, node/backend
  restart, receiver races, native failure, observation timeout and non-secret diagnostics.
- Steady-running regressions reproduce loss with the requester-node clock both
  30 seconds ahead and behind. Both now deliver, while delayed responses still
  expire the unchanged online presence window.
- [Release-candidate CI](https://github.com/quintindk/herdr-relay/actions/runs/43398467433)
  passed clean-source production-package verification on **2.1.0, 2.1.2 and 2.2.5**,
  including correlated requester delivery, retained Inbox results and no replay after
  restart, alongside the installer, keyboard and recovery evidence. Tests reject
  absent/failed delivery evidence or live fixture effects.

The exact-tag workflow repeats all [release gates](releasing.md) before publication.
Its supplied verification report binds the package to the tagged clean source,
supported-host checks and a fresh installed production audit. Passing checkout
tests alone does not satisfy those gates.

Fixture delivery is not proof of repaired delivery in a production receiving chat.
That requires an explicitly deployed release and a newly published real result,
without replaying historical business work or sending a manual replacement notice.
