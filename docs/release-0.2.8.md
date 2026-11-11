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

## Verification completed during implementation

- 661 root regression tests and 149 plugin tests passed, with repository checks.
- A production-only installed package rendered the clock on Home and session
  screens in real OpenCode **2.1.0** and **2.2.6** terminals. Sidebar rendering and
  scoped runtime commands continued to work, with no plugin-load errors.
- Unit checks cover local formatting, zero padding, midnight, delayed ticks,
  wall-clock changes, cleanup and partial slot-registration failure.
- Installed-package CI now checks both clock locations and records their results
  alongside existing terminal verification evidence.

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

Follow the [release procedure](releasing.md) for exact committed-source validation
and explicitly authorised publication. Existing pinned installations do not gain
the clock from a branch push. Installation and live service upgrades remain
separate operations.
