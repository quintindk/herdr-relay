# Herdr Relay 0.2.12

Fixes scheduled headless runs that fired but failed after a Copilot sign-in
change with HTTP 401, `input item does not belong to this connection`.

## Headless conversation history

- Relay 0.2.11 switched to the approved provider's active sign-in but could still
  resend item IDs from the previous connection. Relay 0.2.12 sends earlier text
  and tool call/result pairs inline without those IDs or encrypted checkpoints.
- The saved OpenCode conversation, current run's tool context, worker, approved
  model, grant and schedule are preserved. No rebind, re-enrolment or replay is
  needed. A sign-in change during an active run can still fail that run.
- The run record now identifies this rejection as
  `provider_history_connection_mismatch` without publishing the provider's raw
  response. Other authentication failures remain separate.

## Upgrade and verification

Upgrade the owning Relay node and its OpenCode plugin using the [service upgrade
procedure](https://github.com/quintindk/herdr-relay/blob/v0.2.12/docs/service-upgrades.md).
Activating the new CLI alone does not apply the fix. Check the first new scheduled
run after the plugin reloads. Publication does not upgrade running services.

The protocol and database schemas are unchanged. The installed-package regression
uses the native OpenCode Responses transport and disposable sign-ins on the
supported **2.1.0, 2.1.2 and 2.2.5** hosts. It checks an actual scheduled run and
its submitted result, not live Copilot service availability or mailbox coverage.
