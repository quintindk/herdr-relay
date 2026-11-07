# Native terminal board

Open `herdr-relay tui`. The board uses the joined node's scoped human/operator
context by default, otherwise the local backend owner context. `--context FILE`
selects an explicit context. `--json` returns a non-interactive projection.

## Views

| View | Purpose |
| --- | --- |
| Tasks | Human-owned work, task hierarchy, current worker state, descriptions, results and comments |
| Agents | Durable agents grouped by node, workspace, mode, presence and receiving-chat information |
| Inbox | Human questions, exact candidate reviews, reminders, unread run results and uncertain work decisions |
| Grants | Security requests, standing permissions, revocation and security-decision history |
| Schedule | Cron definitions, requested/applied revisions, activation state and published occurrence reports |

Presence is advisory, not readiness or a dispatch reservation. Published occurrence
history is not a complete list of pending/running node-local work. Next-run times
are clock previews, not admission receipts. Approved-but-unapplied contracts are
shown as awaiting activation rather than Active.

## Keyboard controls

| Key | Action |
| --- | --- |
| Tab / Shift+Tab | Switch views; switch sections within task detail |
| j/k or arrows | Move selection; scroll physical lines inside detail |
| Enter | Open the selected item or advance its explicit decision flow |
| Space / Left / Right | Fold or expand hierarchy |
| / | Search |
| PgUp/PgDn | Inspect a long selected card or scroll a detail viewport |
| Home/End | Move to the beginning/end of detail content |
| h | Include/exclude completed tasks |
| a | Open the human/agent assignment picker for a task |
| s | Inspect eligible human task-status changes |
| n | Rename the selected agent in Agents, or configure run result notifications from Schedule |
| v in Grants | Inspect and confirm revocation of the selected active permission |
| p in Grants | Preview and request approval for a linked preparation repair |
| [ / ] | Select the previous/next occurrence in cron detail |
| o | Open the exactly correlated selected occurrence's task |
| t | Show technical details where offered |
| Esc | Back/cancel/close the current interaction |
| q | Exit the board; inside detail, close detail first |

Task-list rows and group headings stay on one line and end with `...` when they
do not fit. Open a task to read its full title and reference. Other panes retain
their wrapping.

Descriptive text, paragraphs, long paths/URLs and editor content wrap by terminal
cells and graphemes. Fixed viewports retain controls while scrolling. Physical
wrapped lines keep their logical row/occurrence identity. Shift+Enter inserts an
explicit newline in multiline editors; Enter keeps its preview/confirmation or
send meaning. Full text remains available through the selected item's detail.

## Assignment and human handback

**You (human)** is the first choice, outside the node groups. Agents show their
node, workspace, mode and advisory availability. Selecting an agent collects a
bounded handover and requests an execution; human responsibility is unchanged.

Selecting You inspects the exact current assignment, task revision and execution
revision. Preview and confirm its withdrawal to Todo with a reason. If already
human-held, no operation is created. Submitted results and outstanding child work
require their own decisions. Questions are superseded, not answered. History is
preserved, and native process termination/success is never claimed.

## Rename an agent

In **Agents**, select an agent and press **n**. The same key works in agent detail.
Edit the name, use **Enter** to review it and **Enter** again to confirm.
**Ctrl+U** clears the editor. **Esc** cancels an unconfirmed edit.

The name is 1–256 characters on one line. The agent ID, receiving chat, workspace,
permissions, work and schedules do not change. Native chat titles and Herdr
workspace labels are not renamed. An enrolled name must remain unique within its
node/workspace. A node operator can rename only agents inside its own node and
workspace scope. Other nodes need their own operator context, not copied backend
credentials.

Rename uses a separate name revision, so presence heartbeats do not invalidate an
open editor. Another rename requires a new preview. A lost acknowledgement locks
the confirmed payload and retains the original operation in **Inbox**, where it
can be reconciled without issuing another rename. Upgrade the backend and TUI to
enable the action, and upgrade the owning node so its local enrolment labels also
follow confirmed backend updates. A stopped node catches up after reconnection.

## Inbox and Grants

See [task Inbox semantics](native-task-inbox.md). Questions and reviews bind the
exact inspected item/revision/candidate. **Mark result read** only acknowledges
informational reporting; it does not approve work, change a cron or start a run.
Grants owns permission decisions, not ordinary work/result decisions.

Confirmed decisions persist before publication and reconcile their original key
after a lost reply. A refusal requires inspection; an uncertain result is not
silently treated as absent. Failed refreshes retain the last snapshot with an
explicit offline/freshness warning rather than reporting an empty successful list.

In Grants, **1/2/3** select Pending, Active and History. Search includes the requested
agent, originating request and grant IDs, not only the requester name. Permission
cards link their preparations. Selection follows the grant identity across refreshes.
Closing a loading dialog prevents its late response from replacing another dialog.

**Approve once** authorises one saved preparation. The enrolment ceiling shown in
the editor is node-wide, not the number of new agents. **p** requests a new one-off
repair approval without editing the old standing grant. A definite refusal offers
**Dismiss refused decision**. An unconfirmed acknowledgement offers **Retry original
decision** with the original key. See [interactive repair](interactive-recovery.md).

## Herdr panel

The 0.2.3 installer configures the panel during `release install`: link the
verified release, install its shortcut and reload running Herdr sessions.
`--no-herdr` skips this setup; `--herdr-config TOML` selects a custom configuration.
Missing Herdr and explicitly disabled plugins are preserved as reported skips.
A conflict or failed reload reports incomplete setup and a non-zero exit, not
a successfully updated panel. Existing panels are never restarted automatically.

With the published 0.2.2 installer, or for manual repair, link the installed Relay
plugin and run:

```sh
herdr-relay plugin shortcut --dry-run
herdr-relay plugin shortcut
herdr server reload-config
```

The installer is explicit, idempotent and conflict-aware, retaining a backup and
unrelated preferences. It requires Python 3.11+. `--herdr-config PATH` selects a
non-default file. No OpenCode restart is needed.

**prefix+t** opens/focuses the native TUI in the invoking tab, right on wide panes
or below on narrow panes. It toggles only its own panel. Closing with the shortcut
or q restores the identity-verified original pane if still present; quitting an
unfocused panel does not steal focus. Unzoom first if the invoking pane is zoomed.
Manually opened panels in other tabs and unrelated panes are not closed.
