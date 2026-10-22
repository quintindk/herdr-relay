# Herdr Relay 0.2.0-rc.6

Native reusable headless agents, a less cramped task board, scrollable human
decisions and a generated-cache upgrade guard correction.

## Changes

- `herdr-relay headless provision` plans a dedicated persistent OpenCode agent on
  an existing joined node. Explicit `--apply` saves the binding, with private
  configuration backup and stable node/key identity. It does not start a runtime
  or install/enable a schedule. `headless inspect` reports saved configuration
  and recorded runtime identity without claiming live readiness.
- Optional schedule export targets that durable headless agent, not a human chat,
  and is always disabled. Schedule installation remains a separately authorised
  backend-owner operation. No Paperclip service or backend-root credential on a
  worker node is required.
- Native task titles receive width reclaimed from short status labels. The status
  column is content-sized and capped at one third of row width and 48 cells.
- Questions, result reviews and task detail support line/page/beginning/end
  scrolling. Answer drafts and decision choices survive scrolling. Review choice
  arrows retain their selection behaviour. Long unbroken task text wraps, and full
  titles are available in the scrollable Overview.
- New upgrade records canonicalise only generated `worker-index.json` JSON when
  checking identity. Key reordering no longer looks like changed credentials.
  Changed session mappings still fail. All other private/configuration files keep
  byte-level guards. Historical RC5 records retain their original guard semantics.
- Compatible rollback waits for the restored node to acknowledge cleared
  maintenance before reporting success, so the next maintenance command does not
  race a stale paused-runtime report.

## Verification

- Root regressions, V2 plugin tests, syntax/whitespace and workflow lint checks.
- Disposable native headless rehearsal uses real OpenCode and a deterministic
  local model, with no interactive client. Two scheduled occurrences complete
  across node restart; idle-runtime stop/resume retains the session identity.
- TUI tests cover reclaimed title width, narrow terminals, full long-text scrolling,
  retained answers/review reasons and separate explicit decision confirmation.
- CI rehearses installed RC5-to-RC6 and retained RC4 adoption, code rollback,
  task/credential/chat continuity, node-only isolation and failed-health rollback.
- Clean production installation/onboarding and fresh zero-finding audit gate
  publication. Download the package, checksums and verification report together.

## Limits and deployment

- This is a GitHub prerelease, not an npm publication or full v3 certification.
- Publishing does not upgrade services, change an existing OpenCode configuration,
  create an `inbox-sweep` agent or enable any live schedule.
- Headless provisioning is a destination-local operator command. Remote headless
  provisioning through agent tools is not introduced by this release.
- The dedicated runtime needs explicit provider/integration authentication and tool
  policy. Human OpenCode credentials/configuration are not silently inherited.
- A persistent node and WSL environment must remain running. Missed recurring
  ticks are skipped, not replayed. Unsettled/uncertain native work blocks unsafe
  runtime recovery rather than fabricating completion.
- No automatic database restoration or arbitrary schema migration. Backend/node
  protocol and schema compatibility remain unchanged from RC5.
- Standalone execution-completion handback remains a separate known gap.
- Physical Surface headless/reboot acceptance remains separate from isolated tests.

See [native headless agents](native-headless-agents.md),
[task board and Inbox](native-task-inbox.md), and
[service upgrades](service-upgrades.md). Use the verified RC6 CLI for an explicit
upgrade plan/apply. Existing credentials, enrolments, journals and data are retained.
