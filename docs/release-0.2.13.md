# Herdr Relay 0.2.13

Removes interactive `concurrent_native_input (agent-switched)` conflicts when
switching OpenCode primary agents or submitting from the TUI in a Home-created
session.

## Interactive OpenCode agent selection and Plan reminders

- Verified interactive assignments now accept structured native `agent-switched`
  events when the live `session.agent` matches, including `Tab` switches across
  `build`, `plan` and custom primary agents as well as the initial TUI commit on
  sessions created with `session.agent` unset.
- Built-in `opencode.plan` `<system-reminder>` `synthetic` messages emitted when
  entering or leaving Plan mode (or reconciled across compaction) are recognised
  as supporting controls without pausing the assignment or advancing human
  authority.
- Active interactive assignments paused on `agent-switched` under 0.2.12 or
  earlier recover in place automatically after upgrading the owning node and
  plugin, without prompt replay or premature result submission. Legacy
  pre-interactive conflicts also pass `relay_interactive_reconcile` preview and
  apply.
- Agent switches rotate the local `inputRevision` to supersede stale unattempted
  staged outcomes, preserve CLI human/execution provenance, and leave headless
  workers, cron occurrences, standing monitors, workspace changes and peer
  notices fenced.

## Upgrade and verification

Upgrade the owning Relay node and its OpenCode plugin using the [service upgrade
procedure](https://github.com/quintindk/herdr-relay/blob/v0.2.13/docs/service-upgrades.md).
Activating the CLI alone does not update a running node or plugin. Publication
does not upgrade running services.

Protocol and database schemas are unchanged. Release verification exercises real
OpenCode `switchAgent` transitions (`plan` and `build`) plus `opencode.plan`
`<system-reminder>` synthetics and historical recovery across the supported
**2.1.0, 2.1.2 and 2.2.5** OpenCode hosts, alongside a zero-vulnerability
production dependency audit.
