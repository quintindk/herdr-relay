# Herdr Relay 0.2.2

Patch release for task-list readability and two explicit recovery operations.
Publication does not upgrade existing services or apply either recovery.

## Fixes

- **Tasks list:** keep rows and group headings on one line, truncating overflow
  with `...`. Full titles and references remain in task details. Other panes and
  detail views retain their wrapping.
- **Stale model sign-in:** preview and rebind an existing headless setup to the
  current active connection for the same provider, integration and model. Preserve
  the worker, session, permissions, approved instructions, expiry, cron and
  notifications. Fresh bounded readiness is required before subsequent business
  runs. Failed work and uncertain effects are never replayed or erased.
- **Moved root chat:** preview and relocate an existing agent enrolment when its
  OpenCode root chat moves to another workspace. Preserve the agent, session,
  model, permissions and schedule definitions. Attachment uses the chat's current
  native directory rather than the TUI's original launch directory. Re-enrolment
  cannot silently create a duplicate agent for the moved chat.

## Upgrade and recovery

The minimum supported upgrade source remains **0.2.1-rc4**. Protocol stays
**relay/0.2**, backend schema **2** and node journal schema **1**. No database
migration, reset, credential copying or re-enrolment is required for the upgrade.

Upgrade the Relay backend and the relevant destination node/plugin components
using the [upgrade guide](https://github.com/quintindk/herdr-relay/blob/v0.2.2/docs/service-upgrades.md). Do not restart OpenCode to reload
configuration or skills. Pending UI decisions may defer the saved plugin update.

Recovery remains a separate explicit action:

- From the original destination-local coordinator, use `relay_headless_connection`
  or `headless connection-preview|connection-rebind` for the stale sign-in.
  Inspect readiness and the next firing. Readiness is not a business sweep.
- From the moved existing root chat, `/relay-attach` or `/relay-enrol` offers
  **Move existing Relay enrolment**. The human CLI alternative is
  `native agent relocate`, with an exact preview hash and stable operation key.
- Unsettled work, uncertain effects, stale previews and scope mismatches remain
  blocked. Neither operation creates a replacement worker/chat, cancels work or
  expands unrelated permissions.

See [headless recovery](https://github.com/quintindk/herdr-relay/blob/v0.2.2/docs/headless-authenticated-setup.md#rebinding-a-stale-model-sign-in)
and [workspace relocation](https://github.com/quintindk/herdr-relay/blob/v0.2.2/docs/native-receivers.md#moving-an-enrolled-chat-to-another-workspace).

Release gates cover clean source, the exact version tag, supported OpenCode
**2.1.0 and 2.1.2** hosts, installed-package behaviour and a zero-vulnerability
production audit. Native recovery fixtures are isolated and do not certify a
physical second machine or completion of external business work.
