# Herdr Relay 0.2.1-rc4

This prerelease fixes contract activation blocked by rejected historical writes
and improves native task handback, text layout and terminal integration. Publishing
the package does not upgrade running services or change live schedules.

## Changes

- Fix contract activation blocked by a historical, hash-verified transactional
  validation refusal. Retain the original command and evidence without replay,
  abandonment or a general HTTP-4xx exemption. Uncertain effects, revision
  conflicts, unresolved native evidence and active work remain fenced.
- Report activation waits with specific reasons and relevant work/publication
  identities. Schedule must show approved-but-unapplied instructions as awaiting
  contract activation, not Active with a misleading next-run estimate.
- Put **You (human)** first in the node-grouped assignment picker. Preview and
  confirm the exact assignment handback to Todo with task/execution revision
  fences and durable original-key receipt reconciliation. Keep submitted-result
  review and child-work safeguards. Human ownership is unchanged; process
  termination and successful native completion are never inferred.
- Wrap all descriptive TUI text using terminal-cell/grapheme-aware word wrapping,
  retaining long URLs, whitespace, explicit paragraphs and full submitted content.
  Scroll by physical lines without losing logical row/occurrence selection. Use
  shared bounded viewports for entry and inspection. Cover narrow panes and resize.
- Use a compact themed OpenCode sidebar with attachment icons, agent/node identity,
  semantic status colours and outstanding-count text. Preserve exact-chat and
  stale-response guards. Attachment is not readiness or business completion.
- Route Herdr **prefix+t** to the native TUI with immediate keyboard focus. Close
  only the toggle's own panel; restore its original pane when still present and
  identity-matched. Quitting the panel must not steal focus after the human has
  already moved elsewhere. Keep narrow/wide placement and repeated-toggle guards.
- Provide explicit, idempotent and conflict-aware shortcut installation, preserving
  unrelated Herdr preferences and retaining a backup. No automatic live key edits.

## Operator use after a separately authorised installation

Open the native board with `herdr-relay tui`. In Tasks, **a** opens the assignment
picker. Select **You (human)** to inspect an existing assignment and confirm its
withdrawal to Todo. No operation is created when the task is already with you.
An unconfirmed handback is reconciled from Inbox with its original operation key.

Use **PgUp/PgDn** to inspect long selected list cards. In cron detail, **j/k** and
arrows scroll lines, **PgUp/PgDn** scroll pages, **[ / ]** move between occurrences
and **o** opens only the exactly correlated selected task. Full result paragraphs
are retained. **Shift+Enter** inserts an explicit newline in multiline editors;
Enter keeps its preview/confirmation or send meaning.

The OpenCode card uses theme colours rather than fixed RGB values. Generation
numbers and private configuration are not part of its compact default display.
No additional notification, model turn or messaging permission is introduced.

Herdr plugin paths must point at the installed release, not an old release or
unrelated checkout. After linking that plugin through Herdr's normal mechanism:

```sh
herdr-relay plugin shortcut --dry-run
herdr-relay plugin shortcut
herdr server reload-config
```

The installer requires Python 3.11+ (`tomllib`), as well as the existing Python 3
toggle dependency. `--herdr-config PATH` selects a non-default configuration.
A conflicting `prefix+t` binding is refused without replacing it. The installer
does not link/reload plugins, start services or restart OpenCode implicitly.

## Release boundary

Protocol remains **relay/0.2**, backend schema **2**, node journal schema **1**.
Published RC1/RC2/RC3 tags and assets remain immutable. Live service upgrades,
shortcut installation, cron changes and recovery remain separate explicit
operations. No credential rotation or OpenCode restart is introduced.

Local verification passed 1,807 regression tests (one skipped, zero failures),
106 plugin tests, installed-package cron/notification and legacy-refusal activation
checks, real isolated Herdr focus/quit checks and an active-model upgrade/rollback
smoke. The installed sidebar also passed on OpenCode 2.2.0. That supplemental
sidebar check does not expand the complete supported-host release matrix.

Publication is gated on clean committed source, exact-tag verification, installed
OpenCode 2.1.0/2.1.2 host checks and a fresh zero-vulnerability production audit.
