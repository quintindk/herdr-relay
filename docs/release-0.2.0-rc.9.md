# Herdr Relay 0.2.0-rc.9

GitHub prerelease only. No npm publication. Release publication and local service
upgrade remain separate actions.

## Changes

- General approved-headless task actions, source namespaces and durable approved
  artifact paths. Existing grants remain read-only unless explicitly expanded.
- Immutable readable task references, automatic transactional `REL-*` allocation,
  bounded consumer namespace claims, scoped legacy aliases and exact resolution.
- Visible task references, collapsible machine groups with the local node first,
  and human-owned task groups pinned above agent/unassigned groups.
- OpenCode right-sidebar attachment status for the selected conversation.
- Herdr workspace names follow successfully enrolled/attached agents, with exact
  placement checks and naming failures separated from attachment results.

Labels, tag filtering and broader full-text search remain separate work. No new
live grant, headless worker or schedule is created by installing this release.

## Backend schema migration

Backend schema is **2**. Node journal schema remains **1**. Existing schema-1
backends require an explicit backup-backed task-reference migration:

```sh
herdr-relay upgrade --services both --version 0.2.0-rc.9 --key local-rc9 --migrate-task-references
herdr-relay upgrade --services both --version 0.2.0-rc.9 --key local-rc9 --migrate-task-references --apply
```

Use the verified RC9 CLI to plan/apply this transition. An older CLI cannot apply
the new migration. CLI activation alone does not change services.

The managed procedure preserves service arguments, identity files, credentials,
enrolments, task IDs, source provenance and journals. It refuses unsettled work,
checks native pending decisions, stops selected services, verifies private backups
and migrates atomically before starting the schema-2 writer. Existing tasks gain
references and revisions advance. Old aliases and creation receipts are retained.

**After schema 2 commits, rollback to RC8/schema-1 writers is refused.** Failure
retains the exact candidate and maintenance record for `upgrade resume ID --apply`
roll-forward recovery. No database is automatically restored. Compatible node-only
code rollback remains supported. Do not delete state or re-enrol to bypass a guard.

There is no general disaster-recovery service that can infer references issued
after an older database snapshot. Restore remains an explicit recovery operation.

## Verification and deployment boundaries

Release CI requires root/V2 tests, fresh zero-finding production audit, installed
package verification, native message/headless rehearsals and actual process
RC8/RC4 migration/chat-continuity checks. Historical baseline advisory counts are
reported without treating historical fixtures as production-approved installs.

Real TUI rehearsals additionally verify sidebar mounting and receiver replacement.
These are isolated single-host fixtures, not physical Surface certification.
OpenCode services and human chats are not restarted by the upgrade. Relay plugin
configuration reload can invalidate pending client confirmations, which must be
reopened rather than approved or replayed automatically.

See [service upgrades](service-upgrades.md), [task references](native-task-references.md),
[approved headless capabilities](approved-headless-capabilities.md), and
[attachment presentation](opencode-attachment-presentation.md).
