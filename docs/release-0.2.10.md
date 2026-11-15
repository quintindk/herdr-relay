# Herdr Relay 0.2.10

**Draft. Not published.** Release preparation does not tag, publish, install or
upgrade running services. Existing 0.2.9 tags and assets remain unchanged.

## Faster service-upgrade backup verification

- Replace the backup's exhaustive SQLite index-integrity scan with a WAL-safe
  SQLite snapshot and streaming SHA-256 comparison of the snapshot copy.
- Perform one linear source `quick_check` before stopping services. Keep fresh
  identity, credential, schema, task-reference and compatibility checks without
  repeating whole-database scans during health verification or routine status.
- Expose the current validation/snapshot/copy/checksum step on stderr and in saved
  operation status, including byte progress where available. Keep stdout JSON.
- Save a private checksum receipt and verify it on retry. Do not overwrite changed
  backups or accept incomplete scratch files. Adopt old unsealed backups only
  after a linear integrity check and matching service identity.
- Preserve SQLite WAL consistency, original operation keys, compatible rollback
  semantics and all work history. Hashes verify copied bytes, not the additional
  UNIQUE/index consistency checks of SQLite's exhaustive `integrity_check`.

The private snapshot temporarily needs space for an additional copy of the
database being backed up. This fixes the **0.2.10 upgrader**, not a 0.2.9 process
already running. No live upgrade is interrupted or replaced by this draft.
See [service-upgrade verification](service-upgrades.md#maintenance-safety).

## Compact Inbox list

- Show at most **five wrapped terminal lines of message body** in each Inbox
  card. Titles, sender/status and location remain separate from that budget.
- Add truncation dots on the fifth line when more text exists. Wrapping respects
  terminal-cell widths, including CJK text, combining marks and joined emoji.
- Keep the full stored message unchanged. **Enter** opens scrollable details with
  the complete body. Search still uses the full message, not just the preview.
- Stop preview wrapping after enough lines to render the preview and truncation
  marker, rather than wrapping the entire report on every list refresh.

## Direct mark as read

- In **Inbox**, press **m** to mark the selected informational run result or
  reminder read immediately. No details dialog or confirmation is required.
- This acknowledges reporting only. It cannot answer a question, approve/reject
  work, retry/dismiss a publication, change permissions or start another run.
- Keep full-message inspection and the existing confirmed decision paths available
  through **Enter**. Questions and reviews retain their existing safeguards.
- Preserve original durable operation keys after unknown replies or process reopen.
  Refused reads remain available for inspection rather than being silently retried
  under another key. Validate the notification identity and acknowledgement revision.
- Remove a card as read only after a confirmed receipt. Duplicate in-flight key
  presses do not send another acknowledgement, and a late reply does not move the
  selection away from an item the human selected in the meantime.

## Compatibility

Protocol remains **relay/0.2**, backend schema **2** and node schema **1**. Existing
interactive provisioning, collaboration, agent deletion and installer compatibility
protocols remain **1**. No migration, re-enrolment or new permission is introduced.

These are CLI/TUI changes using the existing notification acknowledgement API.
They do not require a backend schema change. Use the 0.2.10 CLI/TUI to obtain them.
Already-open native board processes retain their loaded code until reopened. No
OpenCode restart is required, and no existing panel is restarted by this preparation.

## Verification status

- The updated Inbox and upgrade-fix draft passed **757 root regression tests and
  149 plugin tests: 906 tests**.
- Repository checks, release metadata validation and workflow lint passed. The
  production-dependency audit reported **zero vulnerabilities**.
- Real native TUI keyboard checks showed the five-line preview, full detail tail
  and direct read path for both results and reminders. A pending question remained
  open, and the published report and schedule were unchanged. No model turn started.
- Regressions cover narrow/wide and Unicode wrapping, complete hidden-text search,
  duplicate inputs, selection changes, delayed acknowledgements, original-key
  retries after lost replies/journal reopen, and incorrect acknowledgement receipts.
- The installed-package verifier and publication gate require the same keyboard
  evidence, with no user-service changes or copied credentials.
- Checksum regressions cover committed WAL data, excluded uncommitted changes,
  a stable snapshot across concurrent writes, corrupted copy bytes, interrupted
  copies, retained checksum receipts, legacy backups and disk-space preflight.
- Upgrade regressions prove one source structural check before shutdown, no
  whole-database scans in plans/status/health or completed retries, fresh identity
  refusal and unchanged read-only rollback previews. CLI progress is separate
  from the final stdout JSON.
- Real isolated backend/node upgrade and rollback passed with the installed
  candidate. Checksum copies and progress were verified, an active owned worker
  survived, and the same execution continued without replay. No user service,
  conversation, credential or database was replaced or restored by the fixture.

Fresh clean-source package preflight and full supported-host certification are
being collected for the updated `release/0.2.10` draft. Earlier CI applies only to
its earlier commit. Fresh checks and the exact-tag publication gates must pass
before publication. Fixture checks do not use the human's services, credential
store or real notifications.
