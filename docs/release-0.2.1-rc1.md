# Herdr Relay 0.2.1-rc1

## Grants management and permission requests

- The native TUI adds **Grants**, with Pending, Active and History. Security
  requests stay separate from Inbox's work decisions.
- Enrolled interactive agents can request preparation without an owner credential,
  an existing grant ID or an active parent execution. Matching standing permission
  is reused. Otherwise the saved operation waits for human approval without
  creating resources or provisioning work.
- Approve once binds permission to the exact operation. Allow this scope records
  standing permission. Approval atomically authorises and resumes the saved
  preparation. Reject starts no operation.
- Active interactive, headless, task-reference and child-review grants are visible
  and revocable. Decisions retain provenance and original-key publication recovery.
  The UI can create an interactive standing permission without opening an agent.
- Human decisions use a short-lived, grant-only approval credential held in memory
  by the TUI. Agent/operator command routes cannot approve their own requests.
  The parent operator's revocation also invalidates its approval session.
- Managed preparation uses the approved scope and joined-node policy ceiling,
  without a second legacy provisioning permission gate. Missing, offline or
  ambiguous Herdr drivers wait without creating resources. Preparation does not
  dispatch work.

## Task handover and interactive execution

- Native task handover is restored: **a → select agent → enter handover → Enter**.
  It creates an execution request, not a responsibility change. Human responsibility
  stays unchanged. The result policy is `none`, matching ordinary native execution
  requests. Delivery still waits for the designated receiving chat and capacity.
- Exact task revisions and handovers are retained. Lost acknowledgements reconcile
  through Inbox using the original key rather than sending another execution.
- Automatic instruction loads and correlated shell/subagent completion notices no
  longer replace the originating human request or falsely conflict an owned run.
  Genuine competing input remains protected. Unrelated notifications cannot reuse
  an earlier human's operator authority.
- An accepted interactive execution can use the same native CLI through its exact
  worker connector for ordinary reads and comments/updates on its assigned task.
  It does not acquire human operator credentials, new task-creation authority,
  dispatch authority or lifecycle administration.
- Execution status exposes local conflicts and their reasons. Retained observation
  conflicts are rechecked against the original invocation. Recovery never replays
  that prompt or invents an unaccepted result submission.
- Creating a self-directed todo is capture, not dispatch. Agent guidance explicitly
  avoids sending a redundant execution back to the current interactive chat.
  Separately requested runs and peer handovers remain explicit actions.

## Headless cron admission and diagnostics

- The owning node now establishes the exact backend-authorised scheduled execution
  before native context preparation or granted tools run. This fixes the immediate
  `Unknown execution` failure after an otherwise successful readiness probe.
- Admission binds the acknowledged schedule revision, current grant, worker,
  binding, native session and deterministic occurrence/run identity. Lost replies
  reconcile before prompt intent. Grant revocation is rechecked before starting.
- New headless runs wait while fresh backend authority is unavailable. Existing
  installed interactive automation retains its offline behaviour.
- Ordinary headless cron runs do not manufacture human-board tasks. An asynchronous
  question can materialise a task when a human work item is needed.
- New failures retain safe stage/code diagnostics and the exact terminal reference.
  Schedule detail displays those diagnostics instead of only `native_failed`.
  Historical failed occurrences remain intact.

## Compatibility and upgrade boundaries

Backend schema remains **2**, node journal schema remains **1**, and the protocol
remains **relay/0.2**. No task/reference migration, credential rotation or
re-enrolment is required. Existing tasks, grants, identities, journals, receipts,
pending operations and unrelated preferences are preserved.

Upgrade the backend before the node/plugin components so the new admission and
Grants features are available. Older backends produce an explicit wait/upgrade
requirement, not an owner-credential workaround. Normal maintenance guards remain
in force: inspect unsettled-work blockers before upgrading. Publishing or installing
this release does not itself repair live journals, replay failed jobs, run an inbox
sweep or upgrade/restart OpenCode. Service upgrades remain separate explicit actions.

## Verification

Regression gates cover Grants decisions and credential boundaries, native keyboard
handover, scoped CLI comments, false-conflict recovery, admission replay, offline
waiting, revocation and safe failure reporting.

Real OpenCode fixtures verify that fresh, never-prompted receiving chats accept
their first task exactly once, load nested instructions, refresh execution state
and post a worker-scoped task comment. Separate real scheduled firings exercise
headless admission, fixture MCP/shell effects and native result publication.
Self-capture creates a todo without an execution or additional assignment prompt.

These checks use isolated model/MCP services, credentials and workspaces. They do
not perform a live mailbox sweep or prove business-job completeness. Release
publication additionally requires clean production installation, supported-host
verification and a fresh zero-vulnerability production dependency audit.
