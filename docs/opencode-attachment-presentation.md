# OpenCode attachment sidebar and Herdr workspace names (RC9)

These features require the RC9 Relay server and TUI plugins. Updating a source
checkout alone does not change installed plugins or live workspaces.

## Right sidebar

The OpenCode V2 CLI plugin appends a Relay section to the documented
`sidebar.content` slot. It coexists with other sidebar contributions and does not
force the user's sidebar open or replace their layout.

```text
Relay · Mason
Attached · receiving here
Generation 3 · 0 outstanding
```

Status comes from a read-only typed RPC and the selected conversation's exact
scoped worker connection. It never borrows the human owner/operator context.
The RPC verifies the session belongs to the plugin's workspace and the returned
node status belongs to that session and agent. Agent names are display text,
not credentials or claims of authority.

- Attached means the local node designates this binding as the active receiver.
  It does not mean the agent is idle, running or permitted to perform a new task.
- Historical chats are not shown as active receivers merely because a credential
  or old binding still exists. Outstanding obligations remain independently tracked.
- Not attached, pending, checking and unavailable are distinct states. An outage
  is not reported as successful attachment or silently converted into detachment.
- Status refreshes every two seconds without overlapping reads. Selection changes,
  reconnects and disposal fence late replies, including a switch away and back.
- Opening another conversation immediately suppresses the previous agent's label.
- No attachment, dispatch, permission change or backend write is performed by polling.

The renderer uses OpenCode's supported Solid/OpenTUI plugin interface. The TSX
component is included in the package and loaded by the actual TUI, not by a Node.js
server-side import. There is no terminal overlay or direct editing of host UI nodes.

## Herdr workspace names

Successful `/relay-enrol` and `/relay-attach` commands, including authorised
new-chat attachment, set the calling Herdr workspace label to the durable agent
name. The native `agent enrol` and `agent attach` CLI commands also attempt this
presentation update after their attachment receipt commits.

Interactive provisioning also names its explicitly verified destination workspace
after attachment, retaining its unique recovery marker until placement is proven.
Naming failure is recorded locally as `workspaceNameState: unconfirmed` without
undoing the active receiver or creating another chat.

The update:

1. Requires an explicit Herdr environment and its exact socket/pane/workspace/tab IDs.
2. Reads a Herdr snapshot and verifies that pane still belongs to the expected
   workspace/tab and canonical directory.
3. For the TUI, checks the selected receiving session, directory and local context
   generation. A switched or disposed terminal cannot name a newly selected workspace.
4. For standalone CLI use, requires Herdr's actual OpenCode session report to match
   the receiving session. CLI arguments alone are not selection evidence.
5. Calls the installed `workspace.rename` API with the explicit workspace ID and
   agent label. Setting an already matching name does nothing.

It changes only the workspace label, not the OpenCode session title, tab, directory,
agent identity or lifecycle state. Outside Herdr it is inert. Missing placement,
changed selection, invalid display text or an unavailable socket does not cause a
fallback to whichever workspace happens to have UI focus.

A naming failure does not undo or replay the successful Relay attachment. Native
CLI output separates `workspaceRename` from the attachment result, and the TUI
reports an unconfirmed name update. Re-running attachment can retry naming without
allocating a new agent. A workspace shared by multiple agents has one label, so
the latest successful attachment names it. Ordinary status polling never renames it.

## Verification

- Unit tests cover scoped reads, unavailable status, late reply fencing, safe text,
  exact placement, CLI selection evidence and naming failures after attachment.
- Real OpenCode PTY tests verify the sidebar slot mounts and receives typed status
  separately in two selected chats. A wider test terminal makes the native sidebar
  visible without changing the user's preferences.
- Receiver rehearsals verify actual attached status after node acknowledgement and
  automatic new-chat attachment. Herdr naming tests use injected API fixtures,
  not the user's workspaces.

Sources: [OpenCode CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli),
the installed `@opencode/plugin` slot contract, and the installed Herdr protocol-22
schema (`herdr api schema --json`, `WorkspaceRenameParams`).
