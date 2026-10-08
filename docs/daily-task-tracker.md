# Daily Task Tracker

Paperclip remains the task store. Relay provides company-scoped queries, guarded
human task changes and durable external references through the service, CLI and
OpenCode bridge. This is not a second planning database: there are no due dates,
planning metadata, ingestion or migration workflow, scheduler, or engagement entity
in this contract. Activity reports are reads over explicit time bounds, not jobs.

## Authority And Routes

| Contract | Operator service route | OpenCode tools |
| --- | --- | --- |
| `queryTasks` | `POST /tasks/query` | `relay_task_list`, `relay_task_children`, `relay_task_comments`, `relay_task_activity` |
| `humanTask` | `POST /tasks/manage` | `relay_task_inspect`, `relay_task_create`, `relay_task_edit`, `relay_task_assign`, `relay_task_complete`, `relay_task_comment`, `relay_task_reopen`, `relay_task_cancel` |
| Reference lookup/attachment | `POST /tasks/references` | `relay_task_reference_lookup`, `relay_task_reference_attach` |

The service uses its configured `--backend-context` for Paperclip calls. Operator
routes require Relay operator credentials and an explicit `companyId`. Bridge
routes are `POST /bridge/task-<action>` with hyphenated actions such as
`reference-lookup`. Their company comes from the authenticated binding, never the
tool arguments. Worker credentials cannot access these operator or bridge routes.

Read tools require an exact active `configured` or `armed` OpenCode bridge, but no
prior delegation or worker run. They do not fetch native message history, request
tool permission, arm incoming work, assign tasks or start execution. They can read
while the bridge is busy. Backend errors remain errors, not empty task lists.

Human-chat writes require explicit human instruction. State the exact task,
changes, owner and reason visibly before calling, because the permission popup
does not display all those details. The plugin asks permission and rechecks the
latest native user message. The service checks unchanged source and bridge
identity around backend calls. Synthetic notices and Relay invocations are not
human authority. Active Relay workers cannot use this human operator connector.
Operator CLI use requires the user's authority, not a workaround for a refused
bridge call. Missing tools require a plugin reload when idle, not a service restart
or interruption of existing work.

## Reads And Pagination

All `queryTasks` requests carry `kind` and server-authorised `companyId`.
Unknown fields, undefined optionals and unsupported per-kind filters are rejected.

| Kind | Arguments beyond company/kind | Default / maximum page size |
| --- | --- | --- |
| `list` | Optional `projectId`, `statuses`, `assigneeAgentId`, `assigneeUserId`, `parentId`, `limit`, `cursor` | 50 / 999 |
| `children` | Required `taskId`; list filters except `parentId`, plus `limit`, `cursor` | 50 / 999 |
| `comments` | Required `taskId`; optional `limit`, `cursor` | 50 / 499 |
| `activity` | Required `from`, `to`; optional `taskId`, `limit`, `cursor` | 50 / 200 |

- Lists have no implicit status exclusion. `done` and `cancelled` are included
  unless filtered out. `statuses` is a non-empty distinct array drawn from
  `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `cancelled`.
- Filters combine, rather than expressing alternatives between owners. Query
  task, parent, project and agent IDs must be lowercase UUIDs. Human IDs are
  explicit strings, not `me`. Root-only `parentId: null` and sentinel filters are
  unsupported. Children means direct children, not a recursive graph.
- List items contain IDs, title, status, priority, owner, parent, project,
  `updatedAt` and `descriptionPreview` capped at 1,200 characters. Use
  `relay_task_inspect` for full text. `relay_tasks` remains a legacy preview,
  not a paginated report. Delegations and pending reviews are not backlog queries.
- Inspect returns `{task, revision, defaultHumanUserId?}`. The task includes full
  description, responsible/assigned owner, creation/update/completion/cancellation
  timestamps, `blockedByIssueIds`, safe `blockedBy`/`blocks` summaries,
  `unblockDescriptor` and attached `references`. It is a public projection, not
  raw backend configuration. Comments and activity are separate reads.
- Query responses are `{items, nextCursor, hasMore, complete, fetchedAt, warnings,
  scope}`. Keep every filter, bound and page limit unchanged when following
  `nextCursor`. Treat it as opaque. `complete: true` means this scoped traversal
  is exhausted at that fetch, not a transactional snapshot or all-company history.
  Retain `fetchedAt`, scope and warnings when reporting results.
- List/children use ascending ID keysets and one extra backend row for lookahead.
  Backend issue filtering can happen after SQL limiting, so a short/empty page
  needs a separate all-actor audit proof with `accessTier: "full"` before Relay
  claims exhaustion. Failure is `incomplete_query`, not an empty success. Hidden
  and conversation issues are excluded from this backend-visible scope.
- Comments return full bodies, attribution IDs and timestamps. Every page fetches
  the backend's full ascending comment collection **without a backend limit or
  `after` cursor**, validates it, then slices locally. A collection over 10,000
  rows fails rather than silently truncating. This avoids the backend's 500-row
  limited-query cap and timestamp precision loss in its `after` handling.
- Comment continuation checks the anchor and ordered ID/timestamp prefix. Deleted
  anchors or changed prefixes invalidate it. Original microsecond timestamp
  strings and backend order are retained, without local UUID sorting for displayed
  millisecond ties. Edits are fresh on each fetch, not an incremental edit feed.
  Restart traversal to reread edits to already returned comments.

Do not infer exhaustion from item count. An activity page may even contain no
items while still returning a continuation. A failed page, stale cursor, safety
cap or access refusal makes the report incomplete. Do not claim that nothing
happened or that all work was counted.

## Activity Reports

`from` and `to` are required RFC3339 timestamps with timezone, at most millisecond
precision, and `from < to`. Relay exposes the half-open interval **`[from,to)`**:
include the lower bound, exclude the upper. Use explicit bounds for the intended
day or week. For SAST, use `+02:00`, not an implicit machine timezone.

Activity reads the company `audit/agent-actions` endpoint with `actorScope=all`
and `entityType=issue`. It requires `accessTier: "full"` on every page. Basic
attribution is insufficient. An optional `taskId` restricts the exact issue.
Project, owner and status list filters are not activity filters.

Items expose audit ID, task ID, actor `{type, id}` (user, agent, system or plugin),
action, timestamp `at`, selected `changes` and `transition`. Changes are limited
to status, priority, assigned human/agent, project and parent. `completed` and
`reopened` transitions are normalised from audit evidence. Optional `currentStatus`
is current issue context, not its status at the historical event. Arbitrary audit
details, full text changes and native messages are not returned.

The backend upper bound is inclusive. Relay drops upper-bound rows but preserves
the backend's exact opaque continuation, including precision not present in JSON
dates. Never manufacture cursors from displayed timestamps or use those timestamps
as precision-safe incremental checkpoints. Fetch until `nextCursor` is null,
including empty boundary pages. Count completion/reopening events from this audit,
not from a current-status list or `updatedAt`. A task can complete and reopen
within the same interval. Attribute reported actions to their recorded actors.

## Human Changes

`humanTask` actions are `create`, `inspect`, `edit`, `assign`, `complete`, `comment`,
`reopen`, `cancel`. CLI uses **`capture` for create** and **`reassign` for assign**.
Generic `task create --company ...` is unchanged and is not the human-safe capture
route. Exact CLI syntax and JSON envelopes are in [Task Commands](task-commands.md).

Create requires a title and chooses `assigneeUserId` or the company's
`defaultResponsibleUserId`. Missing both is an error. It defaults to `todo` and an
empty description, never assigns an agent, and accepts optional description,
priority, nonterminal status, unblock descriptor, parent, project and dependencies.
The plugin create schema exposes parent/project/human ownership but **not**
`blockedByIssueIds`. Add dependencies afterwards with `relay_task_edit`; the
operator capture/service payload supports them at creation.

Create/edit status values are `backlog`, `todo`, `in_progress`, `blocked` only.
Priority values are `critical`, `high`, `medium`, `low`.

For an existing task, inspect first, then pass `key`, `taskId`, `expectedRevision`
and the action's payload. Plugin writes also require `reason`, except create,
whose reason is stated visibly rather than passed as an argument. Operator
mutations require a reason for cancellation and agent assignment; other reasons
are optional. Do not send a `payload` to complete or cancel.

| Action | Supported change |
| --- | --- |
| `edit` | Title, description, priority, nonterminal status, `unblockDescriptor`, `parentId`, `blockedByIssueIds`. No project, owner, review-policy or arbitrary metadata edits. |
| `assign` | One nullable `assigneeUserId` or `assigneeAgentId`, clearing the opposite owner. Operator/service also accept both explicitly null. Agent assignment requires a reason and may wake the agent. |
| `complete` | Request `done` for a currently human-assigned task. All blockers must be freshly confirmed done, with no active children/descendants. |
| `reopen` | Only `done` or `cancelled` tasks, currently human-assigned. Payload `{}` defaults to `todo`, or specify `todo` / `in_progress`. |
| `cancel` | Request `cancelled` for a currently human-assigned task. Required reason is retained in the Relay operation journal, not posted as a backend comment. |
| `comment` | Payload `{body}` on a currently human-assigned task, including terminal tasks subject to the guards below. No custom author or wake fields. |

Blocked status requires `unblockDescriptor: {owner: "board", action: "..."}` or
an explicit human `owner: {userId: "..."}`. The action is at most 2,000 characters.
Parentage and dependencies are independent. `parentId: null` clears parentage;
`blockedByIssueIds: []` clears dependencies. Validation rejects self-links,
transitive cycles, foreign-company graphs and traversals over 100 related tasks.
At most 100 distinct dependency IDs are accepted. It is bounded validation, not
an atomic graph lock.

Existing-task writes refuse execution/checkout holds, active recovery, pending
interactions, unsettled Relay work and uncertain review/completion decisions.
Only known inert normal execution policies are accepted. Non-comment mutations
with a prior result require the **latest result-bearing run** to be settled as
completed and published, with exact backend candidate acceptance or an already
recorded policy-matched no-review completion. Older rejected history alone does
not block a later accepted result. Merely selecting `none`, clearing ownership,
or setting a status is not a review bypass. Comments retain the execution and
interaction guards but do not themselves require acceptance of a settled result.

Completion also refuses native review policy and blocked, in-review or cancelled
dispositions. Use explicit reopen for terminal status changes, not edit. Agent
assignment validates company and any matching OpenCode bridge readiness/admission.
It does not grant authority to provision or interrupt workers.

Comments reject `agent://` anywhere, case-insensitively, including plain text and
code. Paperclip parses these links as agent mentions that can wake agents. Relay
posts `reopen: false`, `resume: false`, `interrupt: false` and a durable request ID,
then requires an exact user-authored receipt with no agent/run attribution. Plain
matching text is not enough to reconcile a lost response. Receipt reconciliation
also reads the unbounded ascending collection with a 10,000-row safety cap.

Child mutations PATCH only the addressed task. Relay does not PATCH its parent
or siblings, and cancellation adds no automatic comment. **Paperclip may still
wake a parent on child transitions.** No guarantee is made that a parent stays
unaffected by its own agents or backend automation. Existing review-pending wake
suppression is a narrow separate contract, not blanket parent isolation.

## Revisions And Uncertainty

The inspect revision hashes guarded backend fields, interactions, relevant Relay
run/review state and attached reference metadata. Pass it unchanged. New writes
check it before and after validation. A stale revision requires a new inspection
and reconsideration, not a blind retry. These checks are **best effort**: Paperclip
PATCH has no compare-and-swap contract. Service-local per-task serialisation does
not prevent external backend changes between validation and write.

Keys are scoped by company and durable authority owner, across human actions.
Reuse the identical key, payload, revision and native source for the same attempt.
Changed input or source under an existing key conflicts. Human create persists
intent before POST and uses stable backend idempotency for exact retries.
Uncertain existing-task PATCH/comment writes are never resent. Identical retries
only reconcile fresh task fields/ownership and, for comments, the exact receipt.
An unresolved human-task write fences different keys and authorities for that
same task. Do not use a new key, ownership change or raw API to escape it.

Mutation responses include the current `{task, revision}`, `operationId`, `state`
and `outcome.confirmed`, optionally `reconciled` and `outcome.reused`. `recorded`
means the operation and readback were recorded, not that the requested outcome
matched. Backend acknowledgement can yield `outcome.confirmed: false`, for example
when completion actually enters review. Report requested versus actual disposition.
Even recorded retries reread current state, so later changes remain visible.

## External References

An external identity is the unique tuple `(companyId, namespace, externalId)`.
Optional `url` must be an absolute HTTP(S) URL without credentials. Metadata is
immutable, including absent versus present URL. A different URL or task binding
conflicts, rather than overwriting or reopening anything.

- Lookup takes namespace/external ID and returns `null`, `{state: "reserved",
  reference}`, or `{state: "attached", reference, task}`. `null` means no local
  mapping, not that the external object is absent. Reserved is unresolved creation,
  not an attached task. Attached lookup freshly checks backend identity/company
  and returns a scalar public task summary. Read failure is not `null`.
- Explicit attachment takes task ID, key, fresh revision and reference payload.
  It writes Relay reference/journal metadata atomically, never a backend PATCH.
  Exact duplicate attachment is read-only, including another key/owner, while
  an existing key must still match its original request. Public wrappers require
  `expectedRevision`; the native attachment also requires a reason.
- Human create/capture optionally takes top-level `externalReference:
  {namespace, externalId, url?}`. It reserves identity before backend creation.
  Only the exact creation owner can finish an unresolved reservation. Reservations
  survive uncertainty/restart and have no automatic release or reassignment.
- An already attached identity reuses the actual task, including terminal state,
  without changing fields, applying defaults or reopening it. Read
  `outcome.reused` and actual task content rather than claiming a new task was made.
- Inspect exposes attached references as `{companyId, namespace, externalId,
  taskId, url?}` in `task.references`, in stable order. They participate in revision
  hashing. Reservations, internal keys and source evidence are not public metadata.

These are explicit identity links only. They do not fetch the URL, ingest mail or
Planner data, migrate tasks, schedule follow-ups or create an engagement model.

## Verification Scope

Contracts are implemented in [`task-query.mjs`](../src/task-query.mjs),
[`human-tasks.mjs`](../src/human-tasks.mjs),
[`task-references.mjs`](../src/task-references.mjs),
[`harness-tasks.mjs`](../src/harness-tasks.mjs),
[`service.mjs`](../src/service.mjs), [`cli.mjs`](../src/cli.mjs) and
[`opencode-bridge-plugin.mjs`](../src/opencode-bridge-plugin.mjs).
Targeted fixture tests cover service routing, plugin schemas, pagination,
reference identity, guards and uncertainty. They do not certify a live end-to-end
workflow or backend parent automation. Runnable offline checks are listed in
[Task Commands](task-commands.md#verification).
# Deployment Verification

On 2026-10-08, the full automated suite passed 1,100 tests with a 10-minute
execution budget, followed by syntax and diff checks. Relay was restarted without
restarting agents. Read-only calls through Relay verified full details and revision
for DEF-21, all 44 Today I Did project tasks across three pages, all 13 DEF-21
comments across three pages, and 130 issue activity events for
`[2026-10-07T00:00:00Z,2026-10-09T00:00:00Z)`. Continuation pages had unique IDs
and each full traversal ended explicitly complete. No imported task was edited.

Creation, mutation, reference uniqueness and lifecycle side effects were exercised
against isolated backend fixtures. This read-only deployment check does not claim
a live write test or atomic protection against other Paperclip writers.
