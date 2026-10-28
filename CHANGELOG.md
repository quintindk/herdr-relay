# Changelog

## 0.2.1 — unreleased

First stable release of the native product:

- Human-owned tasks with immutable references and scoped source aliases.
- Durable agent identities, explicit dispatch, questions, steering and human handback.
- Task-independent agent messaging and reviewed results.
- Human-approved provisioning, headless automation and instruction updates.
- Node-owned schedules with persistent Inbox and online requester notifications.
- Native Herdr/OpenCode terminal integration and compatible service maintenance.

Protocol remains `relay/0.2`, backend schema `2`, node journal schema `1`.
No live reset, database restore, credential rotation or re-enrolment is required.

Minimum supported upgrade source: **0.2.1-rc4**. Older development releases and
cross-schema migrations are unsupported.
