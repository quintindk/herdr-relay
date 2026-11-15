# Herdr Relay 0.2.10

Plain owner Inbox messages, compact list previews and faster service-upgrade
verification. Publication does not install or upgrade running services. Existing
0.2.9 tags and assets remain unchanged.

## Plain owner Inbox messages

- Add **`relay_owner_message({key,subject?,body})`** and the scoped CLI
  **`herdr-relay native work owner-message`**. Agents can report a requested state
  directly to the owner's Inbox without inventing a question or notification.
- Display a distinct **Message** with its subject, full body and attributed sender.
  The caller cannot choose another owner or spoof the sending agent/chat.
- Create no task, execution, question, approval, schedule, automatic reply or
  recipient model turn. No active execution is needed for an enrolled interactive
  sender. Headless workers require their exact accepted, uncancelled, non-readiness
  run and must send before staging their outcome.
- Preserve original keys, payloads and receipts after unknown replies and process
  reopen. Read acknowledgement retains the body and sender history, including
  after sender deletion. Storage acknowledgement does not claim human readership.
- Use five-line previews and full-text details/search. **m** marks a message read
  directly from the list; **m** or **Enter** does so in message details, with no
  confirmation dialog. Opening/closing details alone changes nothing.
- Use fresh local IPC connections after a node restart, without automatically
  retrying uncertain writes.

See [owner Inbox messages](owner-inbox-messages.md) for CLI examples and bounds.

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
already running. No live upgrade is interrupted or replaced by publication.
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

- In **Inbox**, press **m** to mark the selected plain message, informational run result or
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
protocols remain **1**. No migration or re-enrolment is introduced. Existing grants
and their MCP/shell permissions remain unchanged.

Plain owner messages require the **0.2.10 backend, sender node, plugin and CLI/TUI**.
They use a separate message/read API, not notification acknowledgements, with no
database schema change. The new native message tool does not grant MCP/shell access.
Already-open native board processes retain their loaded code until reopened. No
OpenCode restart is required, and no existing panel is restarted by this preparation.

## Verification status

- **773 root regressions and 149 plugin tests passed: 922 tests.** Source and
  installed-package evidence is required before publication. The exact-source
  verification report accompanies the release package and checksum asset.
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
- Plain-message gates cover the actual scoped CLI send, real TUI keyboard read,
  full-text preservation, no manufactured work/notifications and original-key
  recovery. The model-facing owner tool is exercised on every supported host.
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

Fresh clean-source package, production audit and OpenCode **2.1.0, 2.1.2 and 2.2.5**
certification are required for the exact published tag. Earlier CI applies only
to its earlier commit. Fixture checks do not use the human's services, credential
store or real notifications.

## Known limitations

- An inactive agent's deletion preview can still be invalidated by an “unknown”
  presence heartbeat. Close and reopen the preview before confirming. This release
  does not add a force-delete or discard active-work/dependency guards.
- A retained Copilot conversation can reject old account-bound input references
  after sign-in rebind with HTTP 401, “input item ID does not belong to this
  connection”. This release does not reset that provider history or replay failed
  runs. The isolated rebind fixture is not certification of that live Copilot case.
