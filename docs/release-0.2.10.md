# Herdr Relay 0.2.10

**Draft. Not published.** Release preparation does not tag, publish, install or
upgrade running services. Existing 0.2.9 tags and assets remain unchanged.

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

- **741 root regression tests and 149 plugin tests passed: 890 tests.**
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

Exact-source package preflight and full supported-host certification are being
collected on `release/0.2.10`. Those checks and the exact-tag publication gates must
pass before this draft is published. Fixture checks do not use the human's services,
credential store or real notifications.
