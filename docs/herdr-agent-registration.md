# Herdr-First Agent Registration

## Decision

Herdr owns harness launch, panes, workspaces and terminal placement. Relay observes
Herdr's recognised agents and registers their existing conversations in Paperclip.
The launch path is the same for shortcuts, manual shell commands and agents
starting other agents. Pane creation is not agent creation.

Relay-owned headless runtimes remain an explicit existing capability for callers
that need exclusive runtime control. They are not the default registration path.
Existing persisted owned runtimes are not migrated, stopped or removed.

## Implemented Behaviour

- Empty panes and shell commands do not create Paperclip agents.
- Detection without a native session ID or absolute session path remains pending.
- Identity is scoped by configured machine ID, Herdr session, company, harness,
  and native conversation reference. Pane IDs, names and working directories are
  mutable placement, not identity.
- Startup subscribes to events before reading a full session snapshot. Events
  trigger coalesced reconciliation. A five-second snapshot also repairs missed
  updates. Subscription and snapshot RPCs use separate socket connections.
- Exit/replacement marks a previously observed conversation offline. A session
  reference temporarily missing from the same terminal is unknown, not offline.
- Simultaneous appearances of the same conversation are ambiguous and do not
  create duplicate registrations. Resumption in another pane reuses the agent.
- Disconnect marks local observations unknown and reconnect takes a fresh
  inventory. Paperclip metadata contains the observation timestamp; its last
  observation can be stale while either service is unreachable.
- Backend creation persists a random ownership marker before POST. Lost replies
  reconcile by marker; absence never authorises another creation. Deleted or
  externally reconfigured agents produce conflicts rather than replacements.

The Herdr 0.9.3 protocol-22 API supplies `events.subscribe`, `session.snapshot`,
`pane.agent_detected`, `pane.updated`, `pane.moved`, `pane.exited` and `pane.closed`.
Inspect the installed contract with `herdr api schema --json`. No terminal output
is scraped and no prompts are sent by this observer.

## Names And Details

Paperclip names follow the explicit Herdr agent name when set. Otherwise they use
the workspace label, directory basename, pane label, or harness plus pane ID, in
that order. Conversation titles and session IDs are not included in agent names.
Titles show the harness, workspace and tab. Structured observation metadata also
retains those labels, the original terminal title, working/foreground directories,
machine, native session and exact placement IDs. Terminal controls are stripped
and display strings are bounded.

Herdr renames and moves update the existing Paperclip record, not its identity.
Relay owns the name/title of observation-only registrations, so change them in
Herdr rather than Paperclip. Offline/ambiguous observations retain their last known
display details. Other metadata, capabilities, role and instructions are preserved.

## Registration Is Not Dispatch

Automatically observed agents use the `herdr_relay` adapter with
`observationOnly: true`. They are paused in Paperclip and created with heartbeats
and on-demand wakes disabled. The adapter rejects invocation even if someone
manually unpauses one. Metadata includes `dispatch: unavailable` and
`lifecycleAuthority: observe_only`.

These records are deliberately separate from deliverable Relay bindings. Agent
detection does not provide a verified native endpoint, credentials, turn
reservation, or correlated completion receipt. Herdr's `idle`/`done` indicators
must never settle Paperclip work. Registration does not grant abort, termination,
pane close, worktree cleanup or replacement authority.

Next work is a verified attach-existing-conversation delivery contract per
harness, including coexistence with human input and explicitly authorised child
retirement. This change does not claim that capability. Creator metadata must
come from an actual launch receipt, not be inferred from pane placement.

## Configure

An operator explicitly selects the Herdr socket and company in a private JSON
file, for example `~/.local/state/herdr-relay/herdr.json`:

```json
{
  "socketPath": "/absolute/path/to/herdr.sock",
  "machineId": "stable-local-machine-label",
  "session": "default",
  "companyId": "PAPERCLIP_COMPANY_ID",
  "excludedWorkspaces": []
}
```

An empty exclusion list enrols all detected conversations in that configured
session. This is an operator opt-in, not automatic access to arbitrary local or
remote Herdr sessions. Use a stable machine label and do not reuse it for another
machine. Changing machine/session/company creates a different registration scope.

```bash
herdr-relay install --paperclip-url http://127.0.0.1:3100 \
  --backend-context /absolute/private/backend-context.json \
  --herdr-config /absolute/private/herdr.json
systemctl --user restart herdr-relay.service
herdr-relay agent observed
```

The installer updates the service definition; restart applies configuration to
an already-running coordinator. The backend context needs board authority.
Loopback trusted mode accepts `{"localTrusted":true}`. Other deployments require
an operator token. Keep both configuration files owner-readable only.

`agent observed` reports connection status, exact mappings, availability and
per-agent errors. The Herdr plugin exposes this as **Relay: Herdr agent
registrations**. `agent list` and `agent discover` still report deliverable Relay
bindings, not these observation-only entries.

Disabling the listener stops synchronisation but preserves Paperclip history.
The listener does not delete agents, modify their instructions, or change
non-Relay metadata. It synchronises names/titles from Herdr and keeps its own
observation-only agents paused until explicit delivery support exists.
