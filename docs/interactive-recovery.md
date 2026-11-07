# Interactive preparation recovery

Use this flow when permission was approved but the preparation stopped, or its
node-wide ceiling leaves it waiting for capacity. Upgrade the backend, destination
node and Relay plugin to **0.2.5 or later** first. No live upgrade or repair is
implied by publication.

## One agent is not a node ceiling

- `maxAgents` counts enrolments across the destination node. It is not the number
  of agents this requester may create.
- Omit it to inherit the existing joined-node ceiling.
- **Approve once** binds permission to one saved preparation and its explicitly
  permitted dispatch. **Allow this scope** permits future matching preparations.
- Existing grants are reused only when they cover the requested scope. Their
  identity/revision and mismatch reasons are returned in `grantSelection`.
- Do not compute `current count + 1` as a creation allowance. Another enrolment
  can occur between a count and admission. Relay reserves capacity transactionally.

Capacity is admission, not permission to run arbitrary tools. Folder restrictions
remain application checks, not an OS sandbox.

## Repair in Grants

1. Open **Grants → Active**. Search for the requested agent, originating request
   or grant ID. The card links the related preparations. Blocked and waiting
   preparations are also shown in **History**.
2. Select the permission or preparation and press **p**. Choose the exact
   preparation if that permission has more than one blocked request.
3. Review the current failure, node-wide ceiling and dispatch requirement. Press
   **Enter** to fetch a fresh repair preview. It shows changed fields, retained
   identities and the verified resume phase.
4. Press **Enter** to request approval. This records a linked permission request,
   not approval or a new provisioning effect.
5. In **Pending**, inspect the repair and choose **Approve repair once** or
   **Reject**, then review and confirm. The original preparation resumes under
   its new one-off permission. Its previous state is retained in `repairHistory`.

The old standing permission is left unchanged. If it is obsolete, select it and
press **v**, inspect the revoke preview, then **Enter** to confirm. Revocation
does not remove existing agents, kill processes, delete resources or undo effects.
**r** refreshes the view. It does not revoke a grant.

## Repair from the original agent

Read `relay_interactive_status` first, then preview:

```json
{"operation":"preview","id":"original-preparation"}
```

Call `relay_interactive_repair` again to request the exact preview:

```json
{
  "operation": "request",
  "id": "linked-repair-request",
  "preparationId": "original-preparation",
  "expectedRevision": 3,
  "scope": {"mode":"roots","roots":["/work/lab"],"profiles":["build"],"allowNewEnrolments":true,"allowCreateDirectories":true,"allowReplacement":false,"allowDispatch":true,"maxAgents":100,"reviewPolicy":"human"},
  "previewHash": "EXACT_RETURNED_HASH",
  "key": "repair-original-v1",
  "reason": "Correct the node-wide ceiling without creating another lab agent."
}
```

Use the **returned** scope and revision, not the example values. A supplied scope
is a proposed permission correction requiring human approval. It cannot change the
preparation's workspace, agent, model, topic, receiving conversation or task.
Read status using either the repair request ID or original preparation ID. Once
ready, dispatch the existing task at its inspected revision through the original
preparation. Do not create a second task or execution.

The scoped worker CLI offers `native work interactive-repair-preview` and
`interactive-repair-request`. Preview payloads contain `{id,scope?}`. Request
payloads contain `{id,preparationId,expectedRevision,scope,previewHash,reason?}`
and require an immutable `--key`. The human Grants TUI remains the approval route.

## Waits and refusals

| State or reason | Meaning and action |
| --- | --- |
| `waiting_capacity` | Permission exists but no slot is available under the effective ceiling. No initial filesystem/native effect starts. Wait, cancel deliberately or request a ceiling repair. |
| `waiting_node_upgrade` | The destination driver cannot satisfy the admission protocol. Upgrade that Relay node, not Herdr or OpenCode. |
| `awaiting_node_inspection` | The original node has not published a recovery checkpoint. Let that node inspect its retained local record. |
| `unresolved_provisioning_effects` | A directory, session, workspace, launch or attachment outcome remains unproved. Reconcile that evidence. No replacement or resend is permitted. |
| `repair_approval_pending` | A linked correction already awaits approval. Inspect that request, not another preparation ID. |
| `stale_repair_preview` | The preparation, permission or checkpoint changed. Dismiss a definitively refused decision and fetch a new preview. |
| `repair_checkpoint_changed` | Local identities/observations changed after approval. The node stopped before continuing. Inspect the original resources. |
| `already_terminal` | Cancellation of an already-blocked/cancelled preparation made no change. Its failure and history are still present. |

Unconfirmed publications remain in **Grants → Pending** and retry their original
key/payload. A definite refusal offers **Dismiss refused decision**, not a blind
retry. A native response or absent observation is never manufactured as successful
completion. Held reservations are released only after the node proves a terminal
request fence and absence of an enrolment, or consumed by that exact enrolment.
