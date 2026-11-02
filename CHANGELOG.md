# Changelog

## 0.2.3 — Unreleased

- Rename agents from the Agents list or detail with `n`, preview and explicit
  confirmation. Preserve the agent ID, receiver, work, permissions and schedules.
  Use a separate name revision so heartbeat updates do not invalidate edits.
  Retain uncertain renames in Inbox and synchronise local enrolment labels from
  confirmed backend projections without restarting the receiving chat.
- Complete local Herdr panel setup during `release install`: relink the verified
  release, install the native `prefix+t` binding and reload running Herdr sessions.
  Preserve disabled plugins, unrelated keys and existing panel processes. Skip
  missing Herdr or explicit `--no-herdr`; support `--herdr-config` for a custom file.
- Report incomplete skill/Herdr setup with a non-zero exit while retaining CLI
  activation evidence. Keep installation locked through local setup so concurrent
  release installs cannot leave the panel linked to a different release.
- Distinguish a changed OpenCode project ID from wider conversation identity
  mismatches. Interactive preparation errors retain their code and explain the
  human-confirmed `/relay-attach` recovery, existing-worktree reuse and original-key
  retry. Never refresh identity pins or retry provisioning automatically.

## 0.2.2 — 29 October 2026

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
