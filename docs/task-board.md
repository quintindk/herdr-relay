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
| h | Include/exclude completed tasks and cancelled schedules |
| a | Open the human/agent assignment picker for a task |
| s | Inspect eligible human task-status changes |
| n | Rename the selected agent in Agents, or configure run result notifications from Schedule |
| c in Schedule | Create a cron schedule for an existing interactive agent or a human reminder |
| x in Agents / Schedule | Preview and confirm inactive-agent deletion or schedule cancellation |
| p in Schedule | Preview and confirm pause/resume of the selected schedule |
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

## Delete an inactive agent

In **Agents**, select an agent and press **x**, including from agent detail. Inspect
the deletion preview, edit the reason, then use **Enter** to review and **Enter**
again to apply. **Esc** backs out without submitting an unconfirmed change.

Fresh available/busy receiving chats are protected. Offline, unknown or stale
entries are eligible only after backend checks for recorded work and dependencies:

- No outstanding executions, candidate reviews or open agent questions.
- No pending messages, preparations or active provisioning/headless/review grants.
- No remaining schedule references, including paused schedules. Cancel those
  schedules first and wait for the owning node to acknowledge cancellation.

A blocked preview lists the dependencies. **r** refreshes that preview after they
are resolved. There is no force-delete or automatic cascade through permissions.
The transaction rechecks the guards, so a newly assigned job can refuse deletion
even after a clean preview.

Deletion removes the agent from the current directory and prevents new Relay
admission. It retains the agent ID, receiving-chat records, credentials and audit
history. Its node excludes the binding after observing the deletion, including on
restart. The original ID cannot be reused. No native process, chat, workspace or
file is deleted, and unknown local effects are not declared settled.

A node operator can delete only agents in its own node/workspace scope. Upgrade
the backend, TUI and owning node for these controls. Retained deletion records
require agent deletion compatibility protocol **1** for subsequent code switches.

## Create and manage cron schedules

In **Schedule**, press **c**. The editor offers:

- An existing enrolled **interactive agent**, or a **human reminder** on a permitted
  node. New independent headless workers keep their separate approved setup flow.
- A unique name/ID without spaces, five-field numeric cron and an explicit IANA
  timezone. The timezone defaults to **Africa/Johannesburg**.
- Job instructions or reminder text, result review for agent jobs, and activation.
  New definitions default to **Paused**. Reminders have no agent or result review.

Use **Tab / Shift+Tab** to move fields, arrows or **Space** for choices, **Ctrl+U**
to clear an editor and **Shift+Enter** for multiline instructions. **Enter** validates
the draft and previews its next times and cron warnings. **Enter** again confirms
the exact definition. A reused ID cannot silently edit or reactivate an old schedule.
The next times are estimates, not admission reservations or a run-now command.

From the schedule list or detail, **p** previews pause/resume and **x** previews
deletion. Both require confirmation. Deletion permanently cancels future ticks
after node acknowledgement, hides the trigger from the default list and keeps its
past reports. **h** includes cancelled schedules. Already admitted work is not
interrupted, and a disconnected node has not applied a change merely because the
backend recorded it. The requested/applied revisions show that distinction.

The joined node's human operator can manage only schedules on its own node and
within its workspace scope. Daemon/worker credentials do not acquire these human
controls. Existing **n** run-result notification settings remain separate.

Confirmed creation, activation and deletion commands persist before publication.
An unconfirmed reply locks the exact payload and key. Retry that original operation
or reconcile it from **Inbox**. A definite refusal must be inspected and dismissed
before taking a fresh decision. Historical receipts remain reconcilable even if a
later human operation deleted the target agent.

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
