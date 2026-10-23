# Native task identity, references, labels and search

Status: draft for review before implementation.
Recorded: 2026-10-23.
Scope: general native Relay Tasks, for every consumer and internal creation path.
This document specifies proposed behaviour. It does not describe features already
available in the installed RC8 release and does not authorise a build or deployment.

## 1. Outcome

Humans can discuss a task as `REL-32`, consumers can create tasks without knowing
anything about numbering, approved consumers can supply a reference when needed,
and labels are usable for classification/search without making the TUI unreadable.

Relay owns generation, allocation integrity and resolution. Consumer conventions,
business workflows and label meaning remain outside the platform.

## 2. Decisions captured from the discussion

1. Every task has a permanent machine ID and a permanent human-readable reference.
2. Relay generates a reference when the consumer omits it. No consumer must allocate
   numbers, check availability or retry allocation collisions.
3. A consumer may request a reference, subject to namespace approval and an atomic
   backend claim. Occupied references produce an explicit conflict.
4. References are identity, not labels. They must not be encoded as special tags.
5. Idempotency, source deduplication and reference uniqueness are separate concerns.
6. Numbering covers ordinary, internal, scheduled, delegated and imported tasks.
7. Canonical references remain stable. Original imported identifiers remain aliases.
8. Labels need API filtering and TUI support. Ten labels must not consume the title row.
9. No task IDs, source provenance, comments or relationships are reset to add numbering.
10. The new approved-headless capability layer remains general-purpose. No private
    job name, folder layout, source-coverage rule or business watermark policy belongs
    in this feature.

The concrete format and UI defaults below are proposed implementation defaults,
not a claim that every detail was separately approved in conversation.

## 3. Terminology and invariants

| Concept | Role | Invariant |
|---|---|---|
| Native task ID (`id`) | Machine identity, foreign keys and API addressing | Immutable; never derived from a mutable label/reference |
| Primary reference (`reference`) | Human identity, for example `REL-32` | Exactly one per task after migration; immutable; unique in this backend |
| Reference namespace | Allocation/claim policy, for example `REL` or `TWD` | Authenticated approval determines who may claim it |
| Display alias | A previous/consumer-facing identifier such as an imported `DEF-32` | Retained with explicit source scope; cannot silently retarget a task |
| Source reference | Structured provenance `(namespace, externalId, optional URL)` | Exact source identity; not a title match or a label |
| Label | Mutable classification shared by tasks | Does not identify a task or confer authority |
| Idempotency key | Identity of one caller operation | Reuse requires the same action/request; not a replacement for source identity |

All uniqueness described here is scoped to one backend instance. This is not a
distributed numbering scheme across unrelated backends.

## 4. Reference format and namespaces

### 4.1 Proposed v1 format

- Default generated reference: `REL-<positive integer>`, beginning at `REL-1`.
- Canonical custom form: `<PREFIX>-<positive integer>`.
- Proposed prefix grammar: `[A-Z][A-Z0-9]{0,15}`.
- No zero value, sign, decimal, leading zeroes or padding in stored primary references.
- Numbers must fit the implementation's explicitly checked integer range. Never
  allow precision loss, overflow or counter wraparound.
- Stored references are canonical. Reject non-canonical create input with a useful
  validation error rather than silently changing a consumer's requested identity.
- Human lookup may accept case-insensitive primary-reference input. Alias values
  retain their source meaning and are not automatically rewritten.

Arbitrary external identifiers that do not fit this primary-reference format remain
valid source references/display aliases. Do not discard or truncate them to fit it.

V1 automatically allocates only the default `REL` namespace. There is no automatic
workspace-name inference, per-chat counter or mandatory consumer configuration.
Additional automatic prefix selection is a later feature unless explicitly approved.

### 4.2 Approval and claim policy

- Permission to create a task includes receiving an automatically generated reference.
- It does not automatically include choosing arbitrary references/prefixes.
- Namespace claim permissions are bound to a durable authenticated principal or
  explicit grant. A request body cannot self-declare namespace ownership.
- Custom claims in `REL` are privileged because a large supplied value can advance
  the shared counter. Do not grant unrestricted callers the ability to exhaust it.
- A namespace approval may constrain allowed values or allocation jumps. Define
  that policy before exposing custom claims to headless agents.
- An approved custom claim updates that namespace's high-water mark to at least
  the claimed number in the same transaction.
- Cancellation/removal never releases a claimed reference or decreases a counter.

## 5. Task creation contract

The following are proposed native payloads, not current CLI syntax guarantees:

```json
{
  "key": "capture:external-record-123",
  "title": "Confirm deployment requirements",
  "labels": ["customer:contoso", "follow-up"]
}
```

```json
{
  "key": "import:consumer-task-456",
  "reference": "TWD-456",
  "title": "Confirm deployment requirements",
  "externalReference": {
    "namespace": "consumer:tasks",
    "externalId": "456"
  }
}
```

The create path generates `id` when omitted. Existing native clients that provide
a valid stable `id` remain supported. A supplied machine ID does not suppress
primary-reference allocation or bypass any uniqueness constraint.

The creation receipt includes at least `id`, `reference` and the creation revision.
Replaying it is not an assertion that the task still has its original mutable fields.
Inspect the task separately to obtain current state.

Pre-feature creation receipts require explicit compatibility handling: preserve
their original request hash and stored receipt. Transport responses may enrich
them with the immutable reference subsequently assigned by migration, without
substituting current mutable fields or pretending it existed at original creation.
Do not consume a number or rewrite audit history when replaying such a receipt.

### 5.1 Behaviour table

| Situation | Required result |
|---|---|
| Reference omitted, new task | Allocate default reference atomically |
| Approved custom reference, unused | Claim that exact reference atomically |
| Unapproved namespace/custom claim | Refuse before mutation/allocation |
| Reference already identifies another task | `task_reference_conflict`; no silent fallback/renumbering |
| Same caller/key/action/request | Return original creation receipt |
| Same caller/key with changed action/request | Idempotency conflict; no mutation/allocation |
| New key, existing exact source identity, no requested reference | Return existing task; do not consume another number or overwrite its fields |
| Existing source task, requested reference equals its primary | Return existing task |
| Existing source task, requested reference differs | Explicit source/reference conflict; do not re-reference it or silently attach an alias |
| Supplied native ID already exists outside a valid source/idempotency reuse | Explicit task-identity conflict |

## 6. Idempotent allocation

### 6.1 Identity of an operation

Use durable authenticated caller identity plus a suitably namespaced caller key.
The current native receipt mechanism scopes keys to `${actor.type}:${actor.id}`
and hashes `{action,payload}`. Extend/reuse that atomic mechanism rather than adding
another independent receipt store.

Do not scope create idempotency to a chat ID, credential token, process ID or wall
clock. Credential rotation/new conversations must not turn retries into new tasks.
Callers sharing one principal must namespace their operation keys appropriately.

For reference-bearing creation, define a versioned canonical request hash:

- Canonical object key ordering.
- Deterministic validation/default handling.
- Generated reference/native ID and timestamps excluded when not supplied.
- Supplied identities, custom reference, task content, labels and source identity included.
- Set-like fields handled consistently and documented.
- No silent ignoring of unsupported fields.

Keep canonicalisation stable across upgrades. Do not reinterpret an old receipt
using changed defaults and accidentally reject or duplicate an old operation.

### 6.2 Transaction order

```text
BEGIN IMMEDIATE
  authenticate/authorise the operation
  find caller's receipt by durable identity and key
  if receipt exists:
    compare the versioned action/request hash
    return original receipt or idempotency conflict

  validate request and custom-namespace permission
  resolve supplied native/source identities
  if an existing source task is legitimately reused:
    validate requested-reference consistency
    record reuse receipt without allocation or task-field replacement
  otherwise:
    allocate next default number OR claim supplied reference
    update namespace high-water mark
    create task and permanent reference claim
    record task creation/activity
    persist creation receipt
COMMIT
return committed receipt
```

- The counter, task, reference claim, event and receipt commit together.
- A database uniqueness constraint is the final protection against duplicate claims.
- All task creation paths call the same identity-aware store primitive, including
  internal `store.apply` paths. Fixing only the HTTP task-create handler is insufficient.
- Never expose a reference before commit.
- A rollback may reuse an uncommitted allocation that was never issued externally.
- Committed references are never reused. Gaps are acceptable and are not repaired.
- Keep creation receipts for the task/reference lifetime. No unannounced TTL that
  makes an old retry create another task.

### 6.3 Storage recommendation

Use a backend-owned allocation counter per approved namespace plus a permanent
reference-claim registry. A unique index on live task rows alone is insufficient:
future task deletion must not free an issued reference.

An implementation may reuse the existing entities/settings storage or introduce
dedicated tables. It must still enforce atomic claims, retained ownership/tombstones,
checked integer bounds and the migration/old-writer protections in section 11.

## 7. Aliases and source identity

- Primary references are immutable and cannot be changed through ordinary task updates.
- Consumer/imported display identifiers remain explicitly scoped aliases.
- Source `(namespace, externalId)` remains independently indexed for exact deduplication.
- Renaming/moving a task or changing labels does not change any identity.
- Do not generate aliases by interpreting a `ref:*` label or matching task titles.
- Do not automatically translate imported provider label IDs into references.

Proposed lookup supports native ID, primary reference and display alias, with
optional explicit consumer/source scope. It returns the matched kind and native ID.

If an unqualified token can identify different tasks through aliases or a primary/
alias collision, return an ambiguity result with candidate references. Never silently
choose a task for a mutation. Exact primary-reference addressing remains available
through its explicit API parameter; conversational resolution must honour ambiguity.

`DEF-32` can therefore remain useful after import without replacing the task's new
canonical `REL-*` identity or pretending all external systems share one namespace.

## 8. Labels

Labels remain classification, not identity or a hidden consumer-specific schema.

### 8.1 Proposed v1 label contract

- Preserve the existing native string-label representation.
- At most 64 labels, each non-empty, without whitespace and at most 256 characters.
- Treat the array as a set: reject duplicates or return a documented canonical set.
- Proposed matching default: exact, case-sensitive label equality. Text search and
  discovery suggestions may be case-insensitive, but must not merge stored labels
  such as `Finance` and `finance` without an explicit migration decision.
- No mandatory label registry, colours, workflow semantics or business taxonomy in v1.
- Update labels through normal revision/idempotency guards. Concurrent writers must
  not silently replace each other's changes.
- Imported labels remain in provenance until explicitly mapped/promoted. Invalid or
  ambiguous legacy values are reported; do not silently slugify or discard them.

Approved headless label/reference writes need explicit capability decisions and
input-schema changes. Existing `task.update` grants must not silently acquire new
fields or reference-namespace privileges.

### 8.2 Search contract

Proposed backend query shape:

```text
GET /v1/tasks?q=deployment&label=customer%3Acontoso&label=follow-up&labelMode=all
```

- `labelMode=all` is the default intersection; `any` requests a union.
- Label filters use exact stored values, not substring matches.
- Combine text, labels and status predictably using AND between filter categories.
- Proposed v1 text-search scope: primary reference, indexed display aliases, title,
  description and labels. Comments and imported historical blobs are not implicitly
  claimed as full-text indexed; expose them later through an explicit search contract.
- Filter and sort before pagination. Never search only the first fetched page.
- Cursors bind the complete canonical query, label mode, sort, backend instance and
  page size. Changing the query invalidates the cursor.
- Preserve completeness/staleness reporting and authority scope.
- Search is read-only. Resolving a result does not dispatch or mutate it.

## 9. TUI and conversation behaviour

### 9.1 Default task row

```text
REL-32  Prepare architecture review                 #10   Todo
REL-33  Confirm deployment requirements              #3   Blocked
```

- Show the primary reference in full, consistently, before the title.
- Keep opaque IDs out of normal rows; retain them in technical details.
- Default labels to a compact count badge rather than consuming title width.
- An optional expanded-label view on wide terminals shows at most two labels and
  `+N`. It must not reduce the title to a token-width column.
- Narrow terminals hide optional metadata or use a stacked row. Do not ambiguously
  abbreviate the reference or overflow controls.
- Task details show all labels, primary reference, aliases, source links, timestamps,
  ownership, revision and relationships, with the existing scrollable presentation.
- Keep active label filters visible in the header; do not repeat every matching tag
  on every row just to establish filter context.

### 9.2 Conversation

For “add follow-up to REL-32”, the consumer resolves the reference, inspects the
native task/revision, checks its authority and submits the guarded label update.
It must not guess a task from a shortened opaque ID or an ambiguous alias.
All mutation responses and subsequent task reads expose the canonical reference.

## 10. Existing task data and backfill

- Backfill missing primary references deterministically, proposed ordering
  `(createdAt, native id)` with explicit handling for invalid/missing timestamps.
- Re-running the migration never renumbers a task or consumes another reference.
- Preserve task IDs, relationships, comments, executions, source metadata, imported
  identifiers, label provenance, idempotency receipts and event history.
- A task row receiving a new reference advances its revision, so cached writers
  must re-inspect. Preserve `createdAt`; record the system migration event/time.
  Proposed default: `updatedAt` follows the normal record-mutation rule. Do not
  describe this identity metadata change as a user edit or silently alter business fields.
- Index original display identifiers as scoped aliases; retain ambiguity instead
  of arbitrarily choosing which imported task owns a bare alias.
- Treat pre-existing primary-reference claims as data to validate. Conflicts block
  migration for explicit reconciliation, not silent renumbering.
- Record a migration receipt and reconcile counts/full graph/reference coverage.
- Capture a recoverable backend backup before applying the migration.

## 11. Upgrade, rollback and recovery

This changes a write invariant, even if storage can fit inside the current JSON
tables. Do not declare it compatible merely because old code can read the new fields.

- Introduce an explicit storage/write-contract version or equivalent guard.
- An older backend must not start writing tasks without references after migration.
- Existing maintenance only supports explicitly compatible schema-1 switches.
  Extend and test migration/preflight/compatibility before deploying this feature.
- Read-only planning must not backfill tasks or advance counters.
- Migration is explicit, transactional, backup-backed and performed under the
  required maintenance/locking boundary. No reset or re-enrolment.
- Bootstrap the identity-aware CLI through a verified supported path; do not lie
  about compatibility to make an older installer accept a migration-capable package.
- Block rollback to an identity-unaware writer after migration unless an explicitly
  tested compatibility path preserves the invariant. Never restore a database
  snapshot automatically to force a code rollback.

Backups must include tasks, claims, counters, events and receipts consistently.
Restoring an older snapshot can lose allocations issued after it. Recovery must
reconcile a verified issued high-water mark from retained evidence or deliberately
establish a new reference namespace. Never silently resume an old counter or infer
the complete issued history from only the tasks still present in that snapshot.

## 12. Acceptance tests

### Identity and allocation

1. A caller ignoring references still receives a task with native ID and `REL-*`.
2. Parallel retries of one key create one task/claim and one allocation.
3. Parallel distinct creates receive distinct references.
4. Same key with a changed reference, source, content or action conflicts.
5. Crash before commit leaves no issued identity; lost response after commit replays it.
6. Source deduplication consumes no number and never overwrites later edits.
7. Supplied-reference/source conflicts are explicit, with no partial claim/allocation.
8. Custom claims require the correct namespace permission and update high-water marks.
9. Unauthorised callers cannot claim another consumer's namespace or exhaust `REL`.
10. Every internal creation path uses the shared allocator.
11. Cancelled/removed tasks do not release references. Backfill is repeatable.

### Aliases, labels, queries and UI

12. Imported identifiers resolve to their original task, or report scoped ambiguity.
13. Native IDs and graphs stay unchanged throughout backfill.
14. Label writes enforce revisions, limits, explicit headless permissions and no lost updates.
15. Exact all/any label filters combine correctly with text/status filters.
16. Search finds matching tasks beyond the first page and rejects changed-query cursors.
17. Scope and traversal warnings are retained; no unsupported full-text coverage claim.
18. Rows/details show canonical references; ten labels do not consume the title row.
19. Narrow/wide/colourless terminals remain readable and scroll/navigation still work.

### Deployment and recovery

20. Dry-run planning is read-only. Migration failures roll back data and allocation.
21. Older writers are refused after migration; compatible clients keep their source IDs.
22. Partial migration/restart reconciles its original operation without double numbering.
23. Restore exercises cannot silently reuse previously issued references.
24. Packaging, production audit, normal CI and migration/rollback rehearsals gate release.

## 13. Out of scope

- A consumer-specific business workflow, classification or notification policy.
- Per-chat/workspace numbering inferred from paths or agent names.
- References stored in labels or numbers extracted from task titles.
- Globally ordered numbering across independent backends/offline partitions.
- Gap-free externally visible counters or renumbering to fill gaps.
- A new tag-colour/taxonomy administration system.
- Due dates, estimates, project management and arbitrary custom-field schemas.
- Automatic grant issuance, live job activation, service upgrade or release publication.

## 14. Compaction/build handoff

At the time this document was written:

- RC8 is the published active release on Evo. RC7 remained unpublished after its
  security gate failed; its tag was not rewritten.
- The general approved-headless capability implementation is committed locally as
  `d7de881` on `v2`, ahead of `origin/v2`. It is **not released or deployed**.
- See [approved headless capabilities](approved-headless-capabilities.md) for that
  separate implementation: task actions, source namespaces, approved artifact paths,
  durable receipts/history and opaque revisioned checkpoints.
- Its reported validation was 1,635 root tests, one skipped, all 57 V2 tests, and a
  real OpenCode/MCP capability rehearsal. Do not equate that with tests for this spec.
- References, numbering, alias resolution and tag/search UI in this document remain
  **unimplemented**. Preserve the existing headless work; do not rebuild it around
  a particular consumer/job.
- `paperclip-final.json` and `paperclip-final-plan.json` are private untracked user
  exports in the checkout. Do not commit, delete or re-import them as part of this work.
- The human explicitly requested continued iteration before release. This spec-only
  request does not lift that hold. Do not tag, publish, deploy or enable a live schedule.
- Before building, review the proposed format, matching/label equality, namespace
  permissions and migration design above. Then implement against this spec with
  explicit acceptance evidence, not a silent change to current production behaviour.

Related: [native task board](native-task-inbox.md), [headless capabilities](approved-headless-capabilities.md),
[service maintenance](service-upgrades.md), [native API/CLI](native-cli.md).
