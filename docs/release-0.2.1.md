# Herdr Relay 0.2.1 — unreleased

Stable-release preparation of the native product established in RC4. This source
tree is not a published stable package, and preparation does not upgrade services.

## Supported product

Native human-owned tasks, durable agent identities, explicit dispatch and steering,
questions/escalation, grants, headless automation, node-owned schedules, result
notifications, human handback, native terminal views and compatible maintenance.
See [architecture](architecture.md) and [installation](installation-and-onboarding.md).

## Repository and package cleanup

- Remove retired Paperclip services/adapters, bridge code, provider prototypes and
  one-off source import commands. No future Paperclip integration is planned.
- Remove old development ledgers, design roadmaps, static run reports and evaluation
  workspaces from the current source/package. Original tags and Git history remain.
- Replace stale setup and upgrade instructions with current native workflows.
- Guard source imports, local documentation links and package contents in checks.

Existing imported task metadata, aliases, references, comments and relationships
remain valid. This cleanup does not rewrite live data, credentials, enrolments,
journals, schedules, receipts or recovery records.

Protocol remains **relay/0.2**, backend schema **2**, node journal schema **1**.
RC4-to-0.2.1 is intended as a compatible code switch, not a database migration.
Publication still requires the separate clean-source, exact-tag, supported-host,
installed-package and zero-vulnerability audit gates in [releasing](releasing.md).
