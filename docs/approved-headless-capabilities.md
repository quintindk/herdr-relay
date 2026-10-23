# Approved headless capabilities (RC9)

Relay supplies general headless capabilities, not a business-workflow engine.
The external job contract owns source selection, classification, pagination,
reminder horizons, cursor meaning and business completion rules. Nothing in these
APIs recognises a particular job name or hard-codes its artifact layout.

These capabilities are included in RC9, not RC8. No live grant, worker or schedule
is created by installing the release or reading these examples.

## Explicit capability profile

An optional `capabilities` section extends a human-approved headless grant:

```json
{
  "sourceNamespaces": ["external:record"],
  "taskActions": ["task.create", "task.update", "comment.create", "reference.attach"],
  "artifacts": {
    "receipts": "approved/receipts",
    "state": "approved/state.json",
    "history": "approved/history",
    "runs": "approved/runs",
    "summaries": "approved/summaries"
  }
}
```

`taskActions` is an exact allowlist and may be empty. `artifacts` is optional;
tasks-only agents do not gain file access, and artifacts-only agents do not gain
task mutations. Grants without this profile cannot mutate native tasks/artifacts.
The separate MCP permission may allow provider-side writes; it is not a read-only
classification of the whole worker.

Paths are explicit workspace-relative resources, with canonical-directory/link
checks. Only the summary directory may alternatively be `/tmp/opencode`, when
explicitly approved and owned by the local user. Other absolute paths, parent
traversal, symlinks and hardlinked files are refused. Unknown local file edits
conflict rather than being overwritten. No shell or generic write tool is granted.

## Runtime tools

- `relay_headless_scope`: inspect the exact active run's approved capabilities.
- `relay_headless_task`: create/update/comment/attach a source reference through
  native Tasks, with stable source identity, operation key and inspected revision.
- `relay_headless_reference_lookup`: inspect exact source identities and explicit
  imported aliases. It does not guess unexported legacy references.
- `relay_headless_artifacts`: inventory/read receipts, record outcomes, commit a
  revisioned checkpoint and write detailed/compact run records in the approved paths.
- `relay_headless_capabilities`: readiness-only canaries for the actual grant.

Every operation is bound to the exact headless agent, accepted execution, run,
session and current revocable grant. Cancellation or revocation does not confer
a new run. No owner context is passed to the worker. Task deletion, execution
dispatch, assignee changes, review decisions and schedule administration are not
part of these task capabilities.

Task writes retain human responsibility and existing backend graph/review guards.
Updates cannot modify a task with unsettled work. Reusing a logical source/action
operation across native runs returns its original receipt without duplicating a
task or overwriting later human edits. Read back current state before subsequent
changes. A definite transaction refusal is returned as `refused`, never `applied`.
Uncertain delivery remains unresolved and is not cleared by inventing another key.

## Durable artifacts and checkpoints

Artifact operations use caller keys and CAS revisions. A source/action has one
managed receipt with immutable revision history. The node journals intent before
file effects and reconciles the exact projection on retry after a crash. Existing
JSON receipts can be read and explicitly linked by basename/hash; their original
bytes are retained. Existing state fields are preserved, with native state under
`_relayHeadless`. Unknown legacy cursor semantics are never imported by guessing.

Receipt statuses distinguish pending/uncertain operations from known outcomes.
Applied native-task outcomes require a matching confirmed backend operation ID;
model-authored success text is insufficient. Backend outages permit only cached,
exact-run pending/uncertain audit records, not task writes or checkpoint commits.

A `checkpoint` operation is a **durability barrier**. It requires the expected
revision, settled local operation intents and confirmed receipt dependencies.
Its `data` is an opaque, job-defined object. Optional observation IDs refer to
actual connector reads from that run, with input/output digests. Relay does not
interpret timestamps, dates, source coverage or whether a business cursor may
advance. Known failures can be recorded in checkpoint data without pretending a
job succeeded. The job contract must preserve its own business invariants.

`run` records write detailed and compact projections with readback checks and
history. Run labels such as `complete` are the job's attestation, not a platform
certification of business correctness.

## Readiness

Grants carrying capabilities require an actual native capability-tool call before
activation, in addition to model execution, the approved connector read and native
result submission. Task canaries exercise only the granted actions, within a
transaction that is rolled back. Artifact canaries operate in an isolated lane
under the approved history directory, not real job receipts or state. They verify
receipt/history/readback, unresolved-outcome checkpoint guards, preservation of
legacy state and detailed/compact run records.

Passing those tests means the approved capabilities work. It does **not** mean
the external business job has run successfully or exhausted a source collection.

```bash
node --test test/headless-tasks.test.mjs test/headless-artifacts.test.mjs
node scripts/verify-headless-setup.mjs --capabilities
```

The rehearsal uses real OpenCode/native execution and an isolated connector
fixture. No real account, user service, production artifact or business schedule
is modified.
