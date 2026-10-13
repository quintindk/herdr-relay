# Task Board

## Shortcut

The local shortcut is **Ctrl+B, then T** (lowercase `t`): show/hide the task
board beside the invoking pane. It preserves keyboard focus, toggles only its
own pane in that tab, and uses a lower split on narrow terminals. Unzoom first
if the current pane is zoomed. The shortcut-reference plugin discovers the
binding from Herdr config automatically.

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "quintindk.herdr-relay.toggle"
description = "Toggle Relay task hierarchy"
```

The toggle uses Python 3 standard-library file locking, like herdr-utils. It
tracks pane and terminal IDs per Herdr socket, refuses reused identities and
serialises repeated key presses. Manually opened boards in other tabs are not
closed by this shortcut. Apply key changes with `herdr server reload-config`;
no agent restart is required.

The board process starts in the plugin installation directory so its relative
launcher resolves from any project. The invoking pane's folder is unchanged;
task data still comes from Relay, not the board process's working directory.

## Browse

The Herdr plugin's **Relay tasks** pane displays Paperclip tasks grouped by owner,
with parent/subtask trees, status, priority and project. Human-owned tasks and
unassigned work have separate groups. Cross-owner parents are shown as context,
not reassigned or counted twice in the header. Completed parents remain visible
when needed to explain an open child.

```bash
herdr-relay board --watch
herdr-relay board --json
herdr plugin pane open --plugin quintindk.herdr-relay --entrypoint work --placement tab
```

The existing `view` command remains the low-level Relay run/inbox diagnostic.

| Key | Action |
| --- | --- |
| `j` / `k`, arrows | Move selection |
| Enter / Space | Fold or expand selected owner or parent |
| Left / Right | Collapse / expand |
| `/` | Search titles, descriptions, owners and projects |
| Esc | Clear search |
| `h` | Show/hide completed tasks |
| `i` | Show/hide idle owners with no matching tasks |
| Tab | Load/toggle cropped details and the last three comments |
| `r` | Refresh |
| `a` | Assign the selected task to a present agent |
| `d` | Inspect the selected task and show permanent-delete confirmation |
| `A` | Confirm approval of the displayed pending candidate |
| `F` | Enter rejection feedback for the displayed pending candidate |
| `R` | Confirm rejection using the saved feedback |
| Enter / Esc | Confirm / cancel deletion while the confirmation is shown |
| `q` / Ctrl+C | Exit the view |

Refreshes run every five seconds only while the pane is open. Failed refreshes
retain the last good snapshot with an explicit offline message and its age. This
does not install a schedule, wake an agent or inject prompts. Non-interactive
output is a single plain-text viewport; use JSON for the complete projection.

Only changed screen rows are repainted. Identical frames emit no terminal output;
selection, scrolling, search and folded groups survive refreshes. The initial
display and terminal size changes repaint the full viewport. Polling still reads
the complete cached Relay projection, rather than fetching individual tasks.
Close and reopen an existing board pane to load updated display code. No Relay
service or agent restart is needed.

Quit restores the terminal, stops the input read started by the view and aborts
any pending Relay refresh. A directly launched plugin pane then closes through
Herdr's normal process-exit handling. A board launched inside an ordinary shell
returns to that shell instead of closing its pane.

## API Boundary

The pane talks only to operator-authorised Relay task-board endpoints.
Worker and native bridge credentials cannot read this cross-agent dashboard.
The Relay connector reads backend collections, paginates issues, and returns an
allowlisted projection without adapter credentials or runtime configuration.
Refreshes share a short server-side cache. Collection descriptions are previews,
not full documents. Opening details lazily fetches the complete selected task and
its final three comments without turning each board refresh into per-task reads.
Agent presence is not task completion.

The view offers guarded assignment, deletion and candidate review through Relay.
Review keys appear only for an `in_review` task with a fresh exact pending candidate.
Approval and rejection require Enter confirmation. Rejection requires non-empty
feedback, which becomes the backend rejection reason rather than an extra comment.
Relay persists the decision intent before POST and never blindly repeats an
uncertain decision. Stale task revisions, candidates and interactions fail closed.
Press `d` on a task row, then Enter to delete or Esc to cancel.
Owner headings cannot be deleted. The preview captures the task's current revision;
changes before confirmation fail rather than deleting a different version. Only
confirmed deletion removes the row. There is no owner-only restriction or recursive
child deletion. Active execution must stop first, and backend foreign-key references
can prevent removal. This also removes backend-owned task documents and attachments;
Git artefacts are not touched. Deleted task IDs stay in Relay's operation history.
Paperclip 2026.1001.0 may revalidate stale recovery actions during collection GETs;
therefore read-only describes the Relay/view operations, not a guarantee that the
upstream backend performs no incidental maintenance writes.

The live pane was verified against the imported Today I Did project: 42 open
human-owned items, including 15 subtasks, with completed source parents retained
as context. Tests cover narrow/wide rendering, hostile terminal input, cycles,
orphans, cross-owner ancestry, pagination, authentication, stale snapshots and
terminal cleanup. Access and other running agents are not restarted by this view.
