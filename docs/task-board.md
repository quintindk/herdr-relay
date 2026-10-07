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
| Tab | Toggle selected item preview |
| `r` | Refresh |
| `q` / Ctrl+C | Exit the view |

Refreshes run every five seconds only while the pane is open. Failed refreshes
retain the last good snapshot with an explicit offline message and its age. This
does not install a schedule, wake an agent or inject prompts. Non-interactive
output is a single plain-text viewport; use JSON for the complete projection.

## API Boundary

The pane talks only to the operator-authorised Relay `GET /task-board` endpoint.
Worker and native bridge credentials cannot read this cross-agent dashboard.
The Relay connector reads backend collections, paginates issues, and returns an
allowlisted projection without adapter credentials or runtime configuration.
Refreshes share a short server-side cache. Collection descriptions are previews,
not full documents. Agent presence is not task completion.

The view offers no edit, assignment, approval, deletion or dispatch controls.
Paperclip 2026.1001.0 may revalidate stale recovery actions during collection GETs;
therefore read-only describes the Relay/view operations, not a guarantee that the
upstream backend performs no incidental maintenance writes.

The live pane was verified against the imported Today I Did project: 42 open
human-owned items, including 15 subtasks, with completed source parents retained
as context. Tests cover narrow/wide rendering, hostile terminal input, cycles,
orphans, cross-owner ancestry, pagination, authentication, stale snapshots and
terminal cleanup. Access and other running agents are not restarted by this view.
