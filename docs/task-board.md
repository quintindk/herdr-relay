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
| n | Configure run result notifications from Schedule |
| [ / ] | Select the previous/next occurrence in cron detail |
| o | Open the exactly correlated selected occurrence's task |
| t | Show technical details where offered |
| Esc | Back/cancel/close the current interaction |
| q | Exit the board; inside detail, close detail first |

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

## Inbox and Grants

See [task Inbox semantics](native-task-inbox.md). Questions and reviews bind the
exact inspected item/revision/candidate. **Mark result read** only acknowledges
informational reporting; it does not approve work, change a cron or start a run.
Grants owns permission decisions, not ordinary work/result decisions.

Confirmed decisions persist before publication and reconcile their original key
after a lost reply. A refusal requires inspection; an uncertain result is not
silently treated as absent. Failed refreshes retain the last snapshot with an
explicit offline/freshness warning rather than reporting an empty successful list.

## Herdr panel

After linking the installed Relay plugin:

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
