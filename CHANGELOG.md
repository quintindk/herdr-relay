# Changelog

## Unreleased

- Exclude definitively refused attachment bindings from node loading without
  deleting their command, error or identity history. Preserve confirmed historical
  bindings and uncertain attachment reconciliation.
- Add previewed, repeat-safe `node recover attachment` retirement for an
  unreferenced refused binding. Verify backend ownership, retain an integrity-checked
  backup and audit, and leave the current receiver unchanged.
- Isolate terminal attachment and landing-session retries by node configuration
  and workspace. Migrate legacy intent only in its original workspace, preserve
  immutable keys, show the saved target, and inspect scoped outboxes during upgrades.

## 0.2.6 — 09 November 2026

Bug fixes for native input provenance and headless cron preflight.

- Keep native incomplete-stream and output-limit continuations in their existing
  owned turn. Correlate the fixed OpenCode control with its adjacent completed
  assistant failure/finish instead of blocking it as foreign input. Preserve the
  original invocation, CLI source and run without granting new human authority.
- Expose read-only headless scope inspection to shell/MCP-only grants. Report
  empty native task/artifact capabilities without blocking separately approved
  shell/MCP work or requiring another grant or contract revision.
- Acknowledge native interactive model selections through a subsequent human
  message without replacing the assignment or replaying its prompt. Verify the
  model chain/current selection, retain control provenance and fence stale outcomes.
  Existing model-switch conflicts use the exact current-human recovery preview.
  Scheduled/headless jobs, peer inputs and profile/workspace changes remain fenced.
- Recheck receiver generation when applying input recovery. Isolate a changed
  project identity to its owning invocation instead of aborting other agent work.
- Preserve the latest human CLI source when an owned shell/subagent completion
  arrives across a follow-up. Correlate successful native tool receipts, not IDs
  mentioned in tool input. Peer/identity boundaries remain separate authority.
- Bound transient RC4 baseline asset-download retries in the upgrade CI fixture.
  Report HTTP status and attempt, discard partial responses and retain strict
  HTTPS, size, checksum and candidate production-audit checks.

## 0.2.5 — 07 November 2026

- Match every requested interactive permission requirement before reusing a grant.
  Report selected grant/revision and mismatches. An insufficient standing grant
  no longer swallows a corrected ceiling or dispatch request.
- Reserve node enrolment capacity transactionally before directory or native
  effects. Competing preparations and ordinary enrolment cannot steal a reserved
  slot. Full capacity is an explicit wait, not a terminal provisioning failure.
- Request a linked, previewed, human-approved repair of a blocked preparation.
  Preserve its agent, conversation, verified resources, tasks, operation keys and
  failure history. Reconcile uncertain effects before permitting another attempt.
- Make Grants searchable by the requested agent and originating request. Add
  `v` for confirmed revocation and `p` for repair. Keep selection stable across
  refreshes and fence stale dialog responses. Distinguish refused decisions from
  missing acknowledgements.
- Clarify that `maxAgents` is a node-wide ceiling. Approve once authorises one
  saved preparation. Cancelling an already-blocked request returns an explicit
  no-op rather than suggesting that its history must be deleted.
- Require installed-package recovery checks on all three supported OpenCode
  hosts and real Herdr keyboard repair/approval/revocation evidence.
- Fence a switch to pre-admission code while new preparations, held reservations
  or repair approvals still require the interactive protocol. Preserve settled
  history and unrelated active work without introducing a database migration.

## 0.2.4 — 03 November 2026

- Hand local release setup to the fingerprint-verified candidate's own Node
  process instead of continuing to run the caller's older setup modules.
  Retain the installation lock through skills, Herdr registration, shortcut
  installation and running-session configuration reloads.
- Report the caller and setup executor versions. Missing or unsupported handover
  protocols fail before activation. Failed, malformed or lost setup responses
  retain activation evidence but never report successful completion.
- Preserve custom configuration paths, disabled plugins, shortcut conflicts and
  idempotent retries without restarting services or chats. Document a verified
  candidate-first bootstrap for already-published pre-handover installers.

## 0.2.3 — 02 November 2026

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
- Remove the unused OpenCode plugin SDK wrappers from production. Use the same
  pinned public RPC schema helpers directly and retain the SDK for development
  contract tests. Clean installations no longer pull in its unused provider and
  npm-tooling dependencies, including the vulnerable glob/minimatch chain.
  Keep the fresh zero-vulnerability production audit enforced.
- Add exact OpenCode 2.2.5 installed-package CI checks alongside 2.1.0 and 2.1.2.
  Require all three hosts in release evidence and keep `doctor` certification in
  sync without upgrading the pinned SDK contracts or any running service.

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
