# Changelog

## Unreleased

- Add explicit, previewed relocation for an enrolled root chat moved to another
  workspace. Preserve its agent, session, model, permissions and schedule definitions.
  Use the chat's current native directory in TUI attachment and prevent duplicate
  enrolment after a move.
- Keep Tasks list rows and group headings on one line, truncating overflow with
  `...`. Task details and the other terminal panes retain their wrapping.
- Add previewed, revision-checked recovery for a stale headless model sign-in.
  Preserve the existing worker, session, scope, approved instructions and schedule.
  Require fresh readiness and admit only subsequent cron ticks, without replaying
  failed business work or clearing uncertain effects.
- Distinguish a changed connection identity from unavailable authentication or a
  missing model.

## 0.2.1 — 28 October 2026

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
