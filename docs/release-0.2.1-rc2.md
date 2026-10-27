# Herdr Relay 0.2.1-rc2

## Existing-task handover and read-only reconciliation

- Prepared dispatch reuses an existing task at its inspected `taskRevision`,
  without recreating it or changing its content. A positive revision never
  recreates a missing task. `title` is required only when creating a new task.
- Definitive dispatch refusals are reported as `refused`, with `applied: false`,
  rather than uncertain effects. Original commands and refusal evidence remain
  retained. Hash-verified historical refusals are distinguished from unresolved
  publications during maintenance inspection.
- Original-key reconciliation of an existing-task identity refusal checks current
  task, preparation and execution evidence. An intervening TUI assignment must
  not produce a duplicate execution.
- Enrolled interactive agents can reconcile ordinary read-only task, execution
  and preparation queries without an active execution or another human message,
  including on approval-notice turns. This uses worker read scope, not operator
  authority. Preparation reads remain requester-scoped. Read failures do not
  claim uncertain external effects.

## Approved headless instruction revisions

- The existing coordinator can preview an exact candidate contract bundle with
  `relay_headless_contract`, then request human approval of that preview digest.
  CLI equivalents are `headless contract-preview` and `headless contract-request`.
  Candidate Markdown content is supplied separately from the active skill.
- Grants Pending presents the approved/proposed content and exact digest.
  **Approve instruction revision** authorises only that content under the
  existing job purpose. It does not repeat unchanged business-scope approval,
  create a new grant or authorise capability expansion. Decisions retain human
  provenance and resume the original saved update automatically.
- Linked protocols can be included in the pinned bundle. Paths stay within the
  original skill directory, with canonical parents and no symlink redirection.
  Candidate instruction content is retained in private native Grants history.
- Activation preserves the worker, session, binding, grant, authentication and
  schedule. New work requests and cron admissions wait for acknowledgement.
  Previously requested/accepted work drains under the previous applied revision.
  Native activity and publications must settle before files change.
- Write-ahead intent, before/after checks and durable atomic file renames support
  interrupted activation recovery. Unexpected edits block rather than being
  overwritten. Rollback is another explicit revision approval.
- Each newly admitted run pins the applied revision. Every pinned resource is
  checked, and verified instructions are supplied to each native model turn so
  stale skill context cannot silently substitute an older contract.
- Status distinguishes approval, pending activation and the applied revision.
  Activation does not restart OpenCode, execute business queries or establish
  mailbox/Teams/calendar collection completeness.

## Interactive human steering and historical recovery

- Ordinary human corrections in a verified interactive receiving chat preserve
  the assignment, including corrections within a busy native turn and later
  human turns after idle. The original task, execution, session and binding are
  retained. The original dispatch is not replayed.
- Native input IDs and input revisions are recorded. Terminal evidence must
  belong to the turn after the latest adopted input. A successful native idle
  marker is not a submitted Relay result or proof that later work completed.
- Only verified interactive assignments use this ownership policy. Headless and
  scheduled work, peer/Relay inputs, identity changes, receiver replacement and
  ambiguous simultaneous assignments remain fenced. Human steering does not
  itself grant operator authority.
- Staged outcomes are bound to their input revision. New corrections retain
  stale staged outcomes as superseded evidence. Unattempted stale publications
  are not sent. Attempted publications reconcile actual backend receipts without
  replay. An absent receipt proves non-application only with an atomic execution
  revision fence; otherwise uncertainty remains explicit.
- RC1 input conflicts require explicit inspected recovery, not silent repair on
  upgrade. `relay_interactive_reconcile` previews the exact execution and applies
  its unchanged digest under a current human request and immutable key. It keeps
  the old invocation/conflict and never replays a prompt, submits a result,
  closes a task or redispatches work.
- Separately authorised human task operations use their configured human route,
  without expanding worker credentials. CLI results identify the source,
  authority and selected context without exposing credentials. An unattempted
  operation must not be reported as a permission refusal.
- An earlier task's outstanding question continuation remains its own lifecycle
  obligation, not a dependency of a successor assignment. Task completion still
  requires its executions to settle. Answered questions resume the same execution
  with a fresh run and input revision, preserving previous input history.

## Compatibility, rollout and verification

Protocol remains **relay/0.2**, backend schema **2**, and node journal schema **1**.
No task/reference migration, credential rotation or re-enrolment is required.
Existing identities, tasks, grants, schedules, journals, pending commands and
receipts are preserved. RC1 and all previously published assets remain immutable.

Upgrade the backend before node/plugin components. Existing unsettled-work
maintenance guards still apply: inspect live blockers and plan recovery before
changing services. Publishing or installing this release does not itself upgrade
services, repair a live conflict, approve a contract revision, replay a job or
restart OpenCode. Those remain separate authorised operations.

Regression coverage includes existing-task refusal/retry, exact contract
approval, stale previews, scope boundaries, interrupted activation, old-revision
draining, human steering, historical recovery, stale publications and answered
question continuations. Isolated real OpenCode fixtures additionally exercise
production-installed recovery/steering and actual cron admission under revised
instructions, using disposable model/MCP services and workspaces. They do not
perform a live business inbox sweep.

Release publication requires the exact tagged source to pass CI, clean production
installation, supported-host checks and a fresh zero-vulnerability production
dependency audit. Publishing is refused if the release already exists.
