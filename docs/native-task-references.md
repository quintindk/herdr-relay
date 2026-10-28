# Native task references

Every new native task has an immutable machine `id` and an immutable readable
`reference`. Relay automatically allocates `REL-1`, `REL-2`, etc. Consumers do not
have to supply either identity. Existing clients supplying native IDs still work.

Backend schema **2** is required and node journals remain schema **1**. An older
schema-1 backend requires the explicit native migration described below. RC4 and
current schema-2 installations do not repeat it. Reading this guide changes no state.

## Create and retry

```json
{
  "key": "capture:record-123",
  "action": "task.create",
  "payload": { "title": "Confirm deployment requirements" }
}
```

Submit through `/v1/commands`, or use the native task-create CLI with the payload
file and `--key`. The returned task includes `id`, `reference` and `revision`.

- Allocation, task creation, source reference, activity and operation receipt share
  one SQLite transaction. Ordinary, delegated, scheduled, imported, interactive
  preparation and headless tasks use the same primitive.
- Receipt identity is the durable authenticated actor plus the caller key, not a
  token or conversation. Keep keys stable across retries and credential rotations.
- The existing request hash is the v1 canonical JSON digest of `{action,payload}`.
  Object keys are sorted, array order and explicit defaults remain significant.
  Generated IDs/references/timestamps are not added to the hashed request. This
  preserves historical receipts without changing their hash contract.
- Same key/request returns its creation receipt, even after later human edits.
  Inspect separately for current state. Changed request/action conflicts.
- Exact source deduplication happens before allocation. It does not replace task
  fields or consume another number. A conflicting requested primary reference fails.
- Claims survive task removal. Neither a reference nor a removed machine identity
  can be issued to a new task. Counters cannot move backwards. Gaps are acceptable.
- A reference is exposed only after commit. A rolled-back readiness canary does not
  consume a number. Precision loss and sequence exhaustion fail closed.

## Consumer-supplied references

Add `"reference": "TWD-456"` to the creation payload. The canonical format is
`[A-Z][A-Z0-9]{0,15}-<positive integer>` without padding. The number is bounded by
`Number.MAX_SAFE_INTEGER` (9007199254740991).

The root human owner may explicitly claim any valid prefix. Node operators need
an explicit namespace grant. Ordinary task-create permission gives automatic
numbering, not custom-claim permission. Existing headless write payloads still
exclude custom claims. Their capability scope has not been expanded.

Example root-approved namespace payload:

```json
{
  "principal": { "type": "node_operator", "id": "the-enrolled-node-id" },
  "prefix": "TWD",
  "maxNumber": 10000
}
```

```sh
herdr-relay native task-reference grant --file namespace.json --key approve-twd --context ROOT_CONTEXT
```

Namespace grants also support the durable `node` principal for internal authorised
creation paths. They do not themselves authorise task creation. Operator grants
are scoped to that node's durable operator identity, not a credential token.

The namespace maximum bounds exhaustion/jump risk, especially for `REL`. A custom
claim advances its namespace's high-water mark atomically. Only `REL` allocates
automatically in this version. Occupied references fail explicitly. There is no
silent fallback, rename or namespace inference from workspace/agent names.

Revoke with the same principal/prefix plus `expectedRevision` through
`task-reference revoke`. Updating/reapproving an existing grant requires its
inspected `expectedRevision` through `grant`. Root-only grant actions have durable
events and idempotent receipts. Revocation prevents new claims, not replay of an
already committed creation receipt.
Use `native task-reference list` or `GET /v1/task_reference_grants` to inspect the
grant identities, maximum values and revisions before changing them.

## Resolve references and aliases

```sh
herdr-relay native task resolve REL-32 --context CONTEXT
herdr-relay native task resolve DEF-32 --scope paperclip:SOURCE_SCOPE --context CONTEXT
herdr-relay native task resolve --reference REL-32 --context CONTEXT
```

Equivalent backend reads:

```text
GET /v1/task-identity?value=REL-32
GET /v1/task-identity?value=DEF-32&scope=paperclip%3ASOURCE_SCOPE
GET /v1/task-identity?reference=REL-32
```

`relay_task_resolve` exposes this read to agents. `native work task-identity` uses
the enrolled worker context. Results include `state`, `matches` with full tasks and
matched identity kinds, and traversal completeness. Primary-reference lookup is
case-insensitive. Imported alias equality retains the original case and scope.

- Unqualified lookup considers native IDs, primary references and indexed aliases.
- Multiple tasks matching a token return `ambiguous`, never a selected task.
- Explicit `reference` lookup considers only the primary-reference registry.
- TUI rows/details prefer the full primary reference. `/` filtering also recognises
  the currently retained imported identifier. Very narrow Ink rows wrap references
  instead of shortening them. Machine IDs remain available in technical details.
- Mutations and relationships still use native IDs and inspected revisions. Lookup
  confers no mutation or execution authority.

Imported identifiers are indexed from their preserved provider/source metadata,
with `paperclip:<sourceScope>` for Paperclip imports. Older top-level identifiers
are indexed in `native`. Aliases and claims are retained rather than retargeted
when metadata changes. No private export is re-imported by this feature.
Those stored scopes are historical provenance only. There is no live tracker
connection, new source-import command or planned integration behind them.

## Explicit offline migration

Read-only plan against an existing state directory:

```sh
herdr-relay native task migrate-references --state-dir BACKEND_STATE
```

An authorised operator must settle active work and stop the backend before applying:

```sh
herdr-relay native task migrate-references --state-dir BACKEND_STATE --apply --backup NEW_BACKUP.sqlite
```

This command acquires the backend service lock and refuses an existing maintenance
operation. It never initialises a missing backend, recreates credentials or starts
services. It is also packaged as `scripts/migrate-task-references.mjs`.

The migration:

1. Checks schema, integrity, identity, existing claims and backend work blockers.
2. Takes an exclusive write boundary, creates a private consistent SQLite backup,
   verifies/syncs it and records its SHA-256.
3. Reserves any existing canonical primary references before allocating missing ones.
4. Backfills by valid creation timestamp then native ID. Invalid/missing timestamps
   sort last. IDs break ties using stable code-point ordering.
5. Preserves native IDs, creation times, provenance, graphs, comments, credentials,
   enrolments and old receipt bytes. Changed task rows advance revision/update time
   and receive a system migration event.
6. Indexes imported aliases, checks complete claim/counter coverage, records the
   migration receipt and commits schema 2 in the same transaction.

A failed migration rolls back all identity changes and retains its backup. Repeating
an already successful migration does not renumber anything or create another backup.
Historical task-create responses may be enriched with their backfilled immutable
reference. Their original hash, mutable fields and audit record remain unchanged.

## Upgrade and recovery boundary

- An older backend rejects schema 2 at startup. SQL triggers also reject an older
  process trying to insert/update tasks without their registered reference.
- The current backend refuses schema 1 rather than silently migrating on startup.
- Missing claim registries, inconsistent coverage or counters below retained claims
  require recovery. Startup does not reconstruct issued history from live task rows.
- Normal service upgrades require candidate and database schemas to match. They do
  not silently migrate or restore databases. The updater explicitly supports the managed
  `--migrate-task-references` transition described in [service upgrades](service-upgrades.md).
  Rollback to a schema-1 backend
  after migration is refused before switching service pointers.
- The cross-schema cutover is a deliberate operator-approved procedure using the
  verified candidate CLI. The managed transition retains service arguments, port,
  ingress config, unit backup and state paths. Do not use a generic reinstall that
  overwrites those settings. This transition never creates grants or schedules.
- Never restore an old database and resume numbering without reconciling all issued
  high-water marks. An internally consistent older snapshot cannot prove which
  numbers were issued after that snapshot. This version has no automatic disaster-
  recovery reconciliation service. Keep it offline until explicit recovery has
  established safe counters/claims, or establish a deliberately new namespace.

Task labels do not change reference identity, namespace authority or alias scope.
