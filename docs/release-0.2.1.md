# Herdr Relay 0.2.1 — unreleased

First stable release preparation. This source tree is not a published stable
package, and preparation does not upgrade services.

## Supported product

Native human-owned tasks, durable agent identities, explicit dispatch and steering,
questions/escalation, grants, headless automation, node-owned schedules, result
notifications, human handback, native terminal views and compatible maintenance.
See [architecture](architecture.md) and [installation](installation-and-onboarding.md).

## Installation and upgrades

New installations use the [onboarding guide](installation-and-onboarding.md).
The minimum supported upgrade source is **0.2.1-rc4**. Older development releases
and cross-schema migrations are unsupported.

Existing task metadata, aliases, references, comments and relationships remain
valid. Upgrades preserve live data, credentials, enrolments, journals, schedules,
receipts and recovery records.

Protocol remains **relay/0.2**, backend schema **2**, node journal schema **1**.
RC4-to-0.2.1 is a compatible code switch, not a database migration.
Publication still requires the separate clean-source, exact-tag, supported-host,
installed-package and zero-vulnerability audit gates in [releasing](releasing.md).
