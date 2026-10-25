# Durable native agents and receiving chats

Native Relay separates the machine installation, enrolled agent, conversation
binding and execution attempt. A new chat replaces the agent's receiver, not the
agent, scheduler or schedule owner. Session-derived development enrolments are
not migrated. Use a clean stable-node configuration for the new contract.

## Human controls

Install the native server/TUI plugins with `native inbox install` as documented
in [the CLI guide](native-cli.md). The local TUI holds the owner-context path.
The server and model get only exact-session worker credentials.

Both commands also work on OpenCode's landing screen. An explicit command creates
and opens an empty root session in the current workspace, preserving the selected
model and variant, then continues to the same confirmation. It sends no prompt,
starts no model turn and changes no permissions. Repeated attempts after a lost
create reply reuse the persisted session ID. Background discovery never creates
sessions. If attachment has no enrolment to select, it reports that prerequisite
without creating an unused chat. Dismissing confirmation leaves the empty chat
open but does not attach it, including through a delayed automatic-attachment event.

- `/relay-enrol` asks for a durable agent name, displays the workspace and standing
  grant, then enrols and attaches the current root chat after keyboard confirmation.
  Repeat calls reuse the same workspace/name enrolment.
- `/relay-attach` selects an existing enrolment in this canonical workspace,
  previews its current receiver and confirms replacement. Multiple roles require
  selection. Repeating attachment in the current chat is a no-op.
- Confirmed operations are stored in the local TUI outbox before publication.
  Lost replies reconcile the same operation, key and original conversation.
  Retrying a superseded operation cannot reclaim the receiver.
  Reconciliation retains the original intent even if its chat has been archived
  or its native service has restarted. A definitive backend refusal is read back
  before restoring a previous designation. It does not leave the agent stuck in
  a pending attachment indefinitely.
- Session switches, switch-and-return, reconnection, server-plugin reload and
  disposal invalidate unconfirmed decisions. They do not rewrite a previously
  confirmed operation.

The standing enrolment permits replacement attachment, scoped management of that
agent's persistent schedules and its own headless grant records. It does not grant
backend-root tools or silently expand the current session's native permissions.
It does not allow cross-workspace access, cancellation of old turns or inheritance
of task-scoped review grants. It is not authentication against hostile processes
running as the same Unix user.

## Automatic attachment

There are two explicit continuity paths:

1. **New chat inside the designated TUI:** a newly created root chat selected in
   that TUI can attach under the existing standing grant. Home navigation while
   starting a new chat preserves the original receiver claim. Broadcast session
   creation alone, switching to an existing chat, forks and plugin startup do not
   claim anything. Competing changes are rejected using the original generation.
2. **Fresh Herdr/CLI launch:** use the **Relay agent: new receiving chat** pane or
   `native agent launch`. This creates an exact new root session, attaches it and
   verifies the node before opening its TUI. Configure a workspace's normal agent
   shortcut to use this launcher if it should have this behaviour. An unrelated
   plain `opencode` launch does not silently replace another receiving chat.

```bash
node src/cli.mjs native agent launch \
  --directory /absolute/workspace \
  --context /private/owner.json
```

With multiple enrolled roles, supply `--agent AGENT_ID`. `--key KEY` makes an
explicit launch repeat-safe. `--json` prepares the session without opening a TUI
or installing a node service. A replaced launch receipt never reclaims its chat.

The launcher does not override model, permissions or plugins. Independently
opened chats use `/relay-attach`. They are warned when they are not the designated
receiver. Never select a replacement using newest-session order, display name,
folder discovery or an idle observation.

## Storage and admission

- Default stable installation config: `~/.local/state/herdr-relay-native/node.json`
  or the corresponding `$XDG_STATE_HOME` location. One node ID is persisted before
  credential issuance and is shared by its enrolled workspace/role agents.
- Agent IDs persist independently of conversation IDs. Each attachment advances
  a generation and creates an immutable historical binding.
- Attachment intent and receiver designation share the node journal's SQLite
  transaction boundary with native admission. Intent first fences new work, then
  an owner-authenticated backend mutation is reconciled before enabling the new
  receiver. A lost response leaves a pending operation, not two receivers.
- The daemon hot-loads new bindings without restarting OpenCode or the node.
  Per-binding worker credentials remain private. Its worker index resolves only
  the actual calling session, never a guessed or globally current session.
- Fresh execution requests target the stable agent and are pinned at admission.
  Already admitted executions, scheduled occurrences and notices retain their
  exact historical binding and run, including after restart or lost delivery.
- Historical chats with unfinished pinned work cannot acquire another binding
  generation. Resume their original work instead. Archived historical chats
  expose recovery blockers without blocking unrelated native work on the node.
- Backend connectivity is required to confirm a new attachment. During an outage,
  existing installed schedules retain their last authorised receiver and offline
  policy. An attachment is not reported as applied without confirmation.

## Persistent schedules

A persistent schedule uses `{nodeId, targetAgentId}`. It does not contain a
`targetConversationId`. The node remains the clock and future occurrences resolve
the designated receiver at admission. Replacing the chat does not edit or recreate
the definition, revision, schedule ID, intended firing instants or history.

The replacement chat can use `relay_attachment_status`, `relay_schedules` and
scoped `relay_schedule_create`, `relay_schedule_pause`, `relay_schedule_resume`
and `relay_schedule_cancel` tools under the standing grant and human instruction.
Creation supplies only `{id,definition}` inside `payload`. The node supplies the
owning node and agent. Callers cannot select a foreign target or manage exact-chat
or folder schedules through these scoped mutation tools.

The equivalent scoped worker CLI commands are `status`, `schedules`,
`schedule-install`, `schedule-pause`, `schedule-resume` and `schedule-cancel`.
All mutations require an immutable key and exact revisions for existing records.
Listing reports **locally installed** definitions, not an exhaustive current
backend snapshot or acknowledgement of a newly requested change.

Exact-chat schedules remain an explicit non-persistent choice. Replacing the
receiver does not retarget them. Moving a schedule to another node remains a
separately fenced ownership transfer. An uncertain old firing is never resent to
the new chat and continues to prevent overlap for that schedule.

## Verification

```bash
node --test --test-concurrency=1 test/native-enrol.test.mjs test/native-receivers.test.mjs
npm run test:v2
npm --prefix packages/opencode-relay run smoke:receivers
npm --prefix packages/opencode-relay run smoke:receivers -- --tui
npm --prefix packages/opencode-relay run smoke:receivers -- --tui-only
npm --prefix packages/opencode-relay run smoke:receivers -- --tui-only --landing
```

The receiver smoke uses an isolated real OpenCode service, native worker tools,
backend and node daemon. Two actual minute cron ticks run in different chats
under one stable node/agent with an unchanged definition. It checks scoped
schedule controls, stale credential refusal and restart preservation. `--tui`
adds actual keyboard-driven enrolment/attachment dialogs. The model and keyboard
input are deterministic test fixtures, not actual-human or real-model acceptance.
The TUI probe also drives Home, native root-session creation and selection through
a disposable navigation plugin, then verifies automatic attachment and subsequent
scheduled delivery. `--tui-only` skips the minute-cron checks for this focused probe
and explicitly reports zero verified minute firings.
`--landing` starts the actual TUIs without a session and verifies native session
creation, navigation and both human-confirmed commands with empty transcripts.
