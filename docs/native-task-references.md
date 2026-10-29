# Native task references

Every new native task has an immutable machine `id` and an immutable readable
`reference`. Relay automatically allocates `REL-1`, `REL-2`, etc. Consumers do not
have to supply either identity. Existing clients supplying native IDs still work.

Backend schema **2** is required and node journals remain schema **1**. The minimum
supported upgrade source is **0.2.1-rc4**. Older development schemas are refused,
not migrated. Reading this guide changes no state.

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
  the currently retained imported identifier. Task-list rows truncate with `...`
  on narrow terminals. Open task details to read the full reference. Machine IDs
  remain available in technical details.
- Mutations and relationships still use native IDs and inspected revisions. Lookup
  confers no mutation or execution authority.

Imported identifiers are indexed from their preserved provider/source metadata,
with `paperclip:<sourceScope>` for Paperclip imports. Older top-level identifiers
are indexed in `native`. Aliases and claims are retained rather than retargeted
when metadata changes. No private export is re-imported by this feature.
Those stored scopes are historical provenance only. There is no live tracker
connection, new source-import command or planned integration behind them.

## Upgrade and recovery boundary

- SQL triggers reject writes that omit a task's registered reference.
- Startup refuses unsupported backend schemas rather than migrating them.
- Missing claim registries, inconsistent coverage or counters below retained claims
  require recovery. Startup does not reconstruct issued history from live task rows.
- Normal service upgrades require candidate and database schemas to match. They do
  not migrate or restore databases. Schema-incompatible rollback is refused before
  switching service pointers. See [service upgrades](service-upgrades.md).
- Never restore an old database and resume numbering without reconciling all issued
  high-water marks. An internally consistent older snapshot cannot prove which
  numbers were issued after that snapshot. This version has no automatic disaster-
  recovery reconciliation service. Keep it offline until explicit recovery has
  established safe counters/claims, or establish a deliberately new namespace.

Task labels do not change reference identity, namespace authority or alias scope.
