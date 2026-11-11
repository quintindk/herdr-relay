# Herdr Relay 0.2.8

**Status: draft, not published.** Release date and final verification are pending.
Branch preparation does not create a release tag, publish assets or upgrade live
services. Published installation examples remain on **0.2.7** until release.

## OpenCode status-bar clock

- Show the terminal host's local time as **HH:mm**, in 24-hour format without
  seconds, on both Home and session screens. No new configuration is required.
- Append to the existing status bars without replacing OpenCode's indicators.
  Home does not get a duplicate clock beneath its prompt.
- Update on minute boundaries and re-read wall time after every tick, including
  after sleep or a system-clock change. Avoid one-second polling.
- Use semantic theme colours. Dispose the timer when its rendered clock is
  removed, including navigation, plugin reload and disable.
- Run entirely in the terminal plugin. No Relay enrolment, backend request,
  model call, credential or permission change is needed for the clock.

## Human lifecycle controls

- In **Agents**, **x** previews deletion of an eligible inactive agent. Fresh
  available/busy receivers and recorded work, reviews, messages, preparations,
  permissions or schedule dependencies prevent deletion. Pending schedule
  cancellations must be acknowledged by their owning node first.
- Retain deleted identities and history, exclude them from directory listings and
  fence their node bindings. Stale advertisements cannot recreate an agent. This
  does not delete a workspace, chat or native process, or claim unknown effects settled.
- In **Schedule**, **c** creates a cron for an existing interactive agent or a
  human reminder. Edit the target, ID, cron, timezone, instructions, result review
  and activation. Definitions default to Paused and show their next clock previews.
- **p** pauses/resumes and **x** cancels future ticks after node acknowledgement.
  Deleted schedules leave the default list, but **h** retains access to their
  reports. Admitted work is not interrupted. New independent headless workers
  remain in their separate approved provisioning flow.
- Preview and confirmation use the current revision, scoped human context and
  durable immutable keys. Uncertain replies remain in Inbox. A later deletion
  does not prevent reconciliation of the original historical receipt.

See [native board controls](task-board.md) for keys and safety boundaries.

## Verification completed during implementation

- 697 root regression tests and 149 plugin tests passed, with repository checks.
- A production-only installed package rendered the clock on Home and session
  screens in real OpenCode **2.1.0** and **2.2.6** terminals. Sidebar rendering and
  scoped runtime commands continued to work, with no plugin-load errors.
- Unit checks cover local formatting, zero padding, midnight, delayed ticks,
  wall-clock changes, cleanup and partial slot-registration failure.
- Installed-package CI now checks both clock locations and records their results
  alongside existing terminal verification evidence.
- A real keyboard-driven TUI creates a paused cron, cancels it, waits for the
  disposable owning node acknowledgement and deletes the now-unreferenced agent.
  Installed-package verification repeats this against the production package,
  without model turns, live service changes or copied user credentials.
- Lifecycle regressions cover scope enforcement, dependencies, stale previews,
  lost replies, retained receipts, node restart/offline fencing and narrow panes.

These implementation checks do not replace exact **0.2.8** package qualification
on the supported OpenCode **2.1.0, 2.1.2 and 2.2.5** matrix, a fresh zero-finding
production audit, compatible upgrade/rollback and isolated Herdr keyboard checks.
Those remain release gates. Supplemental **2.2.6** coverage is not a replacement
for the supported-host matrix.

## Compatibility and publication

Protocol remains **relay/0.2**, backend schema **2**, node journal schema **1**,
interactive provisioning protocol **1**, collaboration protocol **1** and installer
protocol **1**. The minimum upgrade source remains **0.2.1-rc4**. No database
migration or re-enrolment is introduced.

Agent deletion declares compatibility protocol **1**. Upgrade the backend, TUI
and owning node before using it. Once deleted-agent identities are retained in a
backend or node journal, code without that protocol cannot safely replace it.
Do not erase history to make an older release appear compatible.

Follow the [release procedure](releasing.md) for exact committed-source validation
and explicitly authorised publication. Existing pinned installations do not gain
the clock from a branch push. Installation and live service upgrades remain
separate operations.
