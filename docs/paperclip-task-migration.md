# Paperclip task migration to native Relay

Status: implemented task-data migration with fixture coverage. No live production
import or full installation cutover has been performed. Primary OpenCode need not
be upgraded to export, inspect or import task data.

## Preserved data and explicit limits

- Tasks retain full title/description, status, priority and parent/dependency graph.
- Source instance origin/company/task IDs produce stable opaque native IDs and
  immutable external references. The import receipt contains the complete mapping.
- Comments retain full bodies and original author/timestamp metadata. Their author
  type is `external`, rather than falsely claiming a native human wrote them.
- Original assignees, projects, labels, timestamps and resolved interactions are
  retained under each task's `source` metadata. They are not native execution
  assignments, active projects or native review/answer authority. Native task
  responsibility belongs to the installation's owner.
- The export excludes credentials and adapter/runtime configuration. Treat the
  resulting JSON as private task content. Output files are created with `0600`.
- Local legacy Relay references, runs, worktrees, source activity history, schedules
  and agent credentials are not migrated by this command. Source project IDs are
  preserved, but project records are not imported. The export declares this coverage.
- Unresolved/unknown interactions, active runs/checkouts, execution policies,
  review obligations and `in_progress`/`in_review` tasks block import. Resolve those
  through the existing installation first. Do not edit an export to hide them.

## 1. Read-only export and plan

Create a private source context outside the checkout. For the current loopback
Paperclip installation:

```json
{"url":"http://127.0.0.1:3100","localTrusted":true}
```

Authenticated installations use `{"url":"https://...","token":"..."}` instead.
Use operator-level company visibility. Worker credentials cannot prove exhaustion.
Choose the actual Paperclip company ID, then run:

```bash
node scripts/migrate-paperclip-tasks.mjs export \
  --source /private/paperclip-source.json \
  --company COMPANY_ID \
  --output /private/paperclip-tasks.json

node scripts/migrate-paperclip-tasks.mjs plan \
  --file /private/paperclip-tasks.json \
  --output /private/paperclip-migration-plan.json
```

These commands write no backend state. The report includes counts, blockers,
warnings, stable ID mappings and the export digest. Export reads backend-visible
company issues and bounded comments/interactions. It is not a database snapshot.
Take a new final export after the source is frozen for cutover.

Parentage and dependencies are checked as separate graphs. A parent waiting on a
child is valid. Cycles within either graph are refused. Empty review-attention
containers and the explicit `{"state":"none","paths":[],"reason":null}` projection
are not pending reviews. Unknown states/fields and non-empty paths/reasons remain
blockers. Expired interactions remain historical records,
not answers or accepted candidates.

### Explicit disposition of source blockers

The private plan includes each blocking task ID, source field/value and source-task
digest, plus unresolved interaction IDs/states. Review these through the original
Paperclip/Relay installation:

- For `in_progress` tasks, inspect the native execution and outstanding publication.
  Settle through its original Relay path. If there is genuinely no active execution
  or pending result/review, explicitly return unfinished work to `todo` or `blocked`.
  Choose `done` only from actual completion evidence.
- For execution-recovery blockers, verify the original run/process identity and
  use the existing recovery/cancellation path. Clearing a status label alone does
  not settle the run. Record the disposition and evidence on the source task.
- Resolve actual pending questions/reviews through their original interaction.
  An expired interaction needs no invented answer.
- Create a new export after these dispositions and rerun the plan. Keep the old
  export unchanged as evidence. There is no `--ignore-blockers` option.

### Laptop-to-home handoff

The laptop can export and plan with its current OpenCode. It needs no native owner
credential. After the final plan is ready, privately transfer the export and plan
to the home backend host using your existing file-transfer mechanism. The path
`/tmp/opencode/paperclip-tasks-20261020.json` is local to the laptop and is not
automatically available on the home machine. Prefer a persistent private directory
for the final transfer so temporary-file cleanup cannot remove the only export.

Run section 3 in a terminal on the home host, or through an already authorised
administrative session. Keep `owner.json` on that host. The laptop's `.node_token`
cannot import or authorise a host operation. No SSH or other host access is created
by Relay enrolment. If a home-host session is unavailable, transfer the files and
defer import until you have one. Do not send the owner credential to a worker.

## 2. Freeze source work before final export

Pause source runtime-producing routines and stop new legacy admissions. Settle
existing Relay/native work, pending publications, questions and reviews through
their original path. Check the old Relay's state as well as Paperclip. A task's
status alone does not prove execution stopped.

This tool does not change either installation's services or schedules automatically.
The flags below record your explicit cutover attestations. They do not inspect or
stop a remote legacy Relay. Keep using Paperclip until those checks are complete.

## 3. Back up and import on the native backend host

Take an online backup using `src/backend-backup.mjs`. Stop only the native backend
service before import. The command shares its service lock and refuses to write
while that backend owns it.

```bash
systemctl --user stop herdr-relay-backend.service

node scripts/migrate-paperclip-tasks.mjs import \
  --file /private/paperclip-tasks.json \
  --state-dir "$HOME/.local/state/herdr-relay-backend" \
  --owner "$HOME/.local/state/herdr-relay-backend/owner.json" \
  --confirm-digest DIGEST_FROM_PLAN \
  --source-frozen \
  --legacy-relay-settled

systemctl --user start herdr-relay-backend.service
```

The entire graph, comments, mappings, events and receipt commit in one transaction.
Identical retries return the original receipt without overwriting native edits.
A different export from the same source scope conflicts. This is an explicit
one-time migration, not ongoing synchronisation or mirroring. Keep source origin
spelling stable so aliases cannot accidentally create a second source identity.

No execution request, schedule or agent is created by import. Verify counts,
sample full text/comments and graph links through the native board/API before
assigning new work. Keep the export and receipt privately for reconciliation.

## Rollback boundary

If no native work or edits have occurred, keep both stores frozen while deciding
which one remains authoritative. Once native work has executed, returning to the
old database is not a safe replay strategy. Preserve new receipts/results and
explicitly reconcile them. Do not resume the old schedules against migrated tasks.

Full cutover still requires inventory/migration of any relevant local references,
schedule definitions, pending obligations and lifecycle resources not covered by
this task-only path, plus real-machine verification.
