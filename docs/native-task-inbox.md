# Native task board and human inbox

The native work pane has four views: **Tasks**, **Agents**, **Inbox**, and **Schedule**.
From the checkout run `npm run board`, or `node src/cli.mjs tui`. An installed build
provides `herdr-relay tui`. `herdr-relay native board` remains available too.
Board entry points use `--context`, then `RELAY_NATIVE_CONTEXT`, then
`$XDG_STATE_HOME/herdr-relay-backend/owner.json` (defaulting to `~/.local/state`).
Only opening the native board gets this local default. Other native commands still
require an explicit context. Legacy `herdr-relay board` remains Paperclip-backed
and is not silently redirected. Reopening the native Herdr work pane loads the
same new interface. No OpenCode restart is required. The OpenCode
`/relay-questions` and `/relay-reviews` commands remain available as alternative
interfaces. No model tool or controller is required to relay board decisions.

## Inbox

```text
RELAY / TASKS                              3 agents · 2 need attention
 Tasks    Agents    Inbox (2)    Schedule

Question · Prepare deployment
  Which region should I use?
  Wright · Waiting for your answer

Review · Configuration check
  Configuration prepared for South Africa North
  Wright · Ready for your review
```

Each item shows a task title, question/result summary, source and plain-language
state. The default display does not require UUIDs or protocol operation names.
Taskless scheduled reviews and reminders also appear. Agent-addressed questions
stay in the agent's inbox unless explicitly forwarded to the human.

- `Tab` / `Shift+Tab` switches views from the board. `j/k` or arrows selects an
  item. `/` searches the current task/inbox list. `Enter` opens fresh detail.
- An open question offers **Answer question**. Enter an answer, preview the exact
  question/answer and confirm with a separate Enter.
- A pending review offers **Accept result** or **Request changes**. Both require
  a reason and a separate confirmation. For ordinary tasks, Request changes returns
  the task to Todo. It does **not** dispatch another model turn. Monitoring and
  taskless scheduled-result reviews show their own effects.
- A reminder offers acknowledgement, without starting a model turn.
- `t` expands technical identity/revision/candidate details in the decision view.
  `PgUp/PgDn` scrolls long context. `Esc` goes back or leaves the item pending.
- Editing supports ordinary typing, backspace and Shift+Enter for a newline.
  Answers/reasons are bounded to 4,000 characters.

Selection follows item identity across refreshes, not its former list position.
An open editor/confirmation pins its own preview. A changed backend revision is
refused rather than silently applying the answer/review to a new revision.

## Tasks

Task status and execution state remain distinct. Rows include summaries such as
**Waiting for your answer**, **Waiting for coordinator**, **Answer recorded:
waiting for worker**, **Ready for your review**, and **Waiting for admission**.
An admission receipt is not described as proof that a model is running.

Tasks are grouped by executing agent when there is an execution. The responsible
human remains a separate field, not an agent assignee fabricated from ownership.
The detail Overview names both. Pending human actions appear in an **Actions**
section. Selecting one opens the same decision component as Inbox. Results,
comments and recorded question/review activity remain accessible after resolution.
`Tab` inside task detail changes sections rather than changing the board view.

## Agents, nodes and machines

**Agents** is a separate read-only directory, not an empty-agent list mixed into
Tasks. Task groups still name the executing agent as context, but groups without
visible tasks are omitted. The Agents view includes interactive/headless mode,
node, workspace, reported availability and last-seen time. Stale reports remain
visible as unknown, not as proof that a worker stopped. Enter opens fresh detail
and outstanding task summaries. `t` reveals stable agent/node/conversation IDs.

Agent, task detail and human decision context distinguish the **owning Relay node**
from its **reported machine**. Several nodes may run on one machine. Hostnames
are display labels, not unique identities, grants or grounds for reassignment.

Updated nodes advertise optional hostname/platform metadata in their own
authenticated heartbeat only when `/v1/info` advertises
`features.nodeMachineAdvertisement`. Older backends continue receiving the old
heartbeat shape. Older node records display **Machine not advertised** rather
than guessing from workspace paths or confusing the backend host with the worker
host. Machine labels become visible after the updated backend and node services
are deployed/restarted through their normal lifecycle. This UI update does not
restart running services or retrofit live records with guessed host data.

Status editing stays separate from acceptance. The board refuses status editing
through its status picker while executions/blocking interactions are pending, and
backend completion/review guards remain authoritative. Native dispatch is not an
assignment-picker side effect.

## Offline and uncertain publication

The board retains its last good snapshot with explicit offline and fetch-time
information. An unavailable inbox is not presented as an empty, current inbox.

Confirmed keyboard decisions are saved to private
`native-board-decisions.sqlite` beside the owner context before publication.
Each stores the exact command, operation key and preview backend instance identity.
No backend credential is copied into that journal. Answer/review source attribution
identifies this terminal/dialog, not an invented OpenCode conversation.

- An uncertain outcome appears as **Confirmed decision awaiting acknowledgement**.
  Retrying sends the original command/key, including after a board restart. It does
  not create a new answer or review. The original backend identity must still match.
- A definitive refusal appears for inspection. It can be dismissed explicitly,
  then the current item can be reopened for a fresh decision. The refused record
  remains in the journal.
- Uncertain operations cannot be dismissed as though they never committed.
- Closing an uncertain decision modal does not discard the recorded intent.
- Publication is only described as confirmed after a backend receipt. Answer
  publication does not claim the worker has already resumed.

## Scope and verification

This is the first native task/inbox integration. It does not expose every advanced
grant, transfer, adoption or local daemon recovery operation. Shared backend state
also cannot report every local uncertainty. Slash commands and the explicit native
CLI remain available. Legacy Paperclip board behaviour is unchanged.

API tests cover agent/human routing, exact review, reminders/taskless reviews,
stale decisions and lost acknowledgements. Disk-journal tests cover offline
preflight, restart, changed payload/backend identity and explicit refusal dismissal.
Ink tests cover both entry points, stable selection, locked retries, sanitised long
content and narrow terminals. A real disposable PTY drives the maintained native
CLI through answering and accepting a candidate against a fixture backend. This
uses synthetic keyboard input, not an actual-human live test of the new board.
