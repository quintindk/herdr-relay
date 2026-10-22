# Task-independent agent messages

Agents can exchange informational messages and status updates without a task,
execution, active worker turn or delegation grant. This is a separate native Relay
capability, not task creation disguised as messaging. It requires the updated
backend, node and OpenCode server plugin. RC3 does not include it.

## Send and inspect

In an enrolled agent chat, discover the exact recipient with `relay_agents`, then:

```json
{
  "key": "localbox-connectivity-20261022T1007",
  "recipientAgentId": "EXACT_SMAL_AGENT_ID",
  "kind": "status",
  "subject": "LocalBox management connectivity recovered",
  "body": "Outer VM running, node Arc agents connected, cluster ConnectedRecently, bridge running. Internal Kubernetes/storage/workload readiness remains unverified. No repairs or deployments performed. Compute charges remain active. Evidence: repository-relative report path. No action requested."
}
```

Pass that input to `relay_message_send`. `kind` is `message` or `status`. Subject
is optional, up to 256 characters. Body is non-empty, up to 8,000 characters.
The sender is taken from the exact authenticated enrolled chat, never from model
input. The recipient must be another enrolled interactive agent with the same
owner. Standing enrolment permits this informational communication, not arbitrary
task creation, dispatch or impersonating the human.

- `relay_messages({"direction":"inbox"})`: this durable agent's received messages.
- `relay_messages({"direction":"sent"})`: outgoing messages and delivery receipts.
- `relay_message_inspect({"id":"MESSAGE_ID"})`: exact participant message/status.
- Follow `nextCursor` with identical direction/limit until `complete` is true.
  Read errors are not empty success. Cursors cannot change agent/direction/limit.

An identical send retry with the same immutable key returns the original receipt.
Changing its payload conflicts rather than creating another message. The initial
recorded receipt means queued at the backend, **not delivered**. Never send a second
copy under a new key merely because delivery is deferred or uncertain.

CLI transport uses the same exact worker context, without an owner token:

```bash
herdr-relay native work message-send --context PRIVATE_WORKER_JSON \
  --key localbox-connectivity-20261022T1007 --file MESSAGE_FIELDS_JSON
herdr-relay native work messages --context PRIVATE_WORKER_JSON --file SENT_QUERY_JSON
herdr-relay native work message --context PRIVATE_WORKER_JSON --file MESSAGE_ID_JSON
```

The send payload file contains recipient/kind/subject/body, not sender identity,
task fields, execution instructions, backend credentials or a nested payload.
Query/inspect files contain the corresponding tool input above.

## Delivery and authority

States are `queued`, `delivering`, `uncertain`, `delivered` or `blocked`:

- Busy/offline recipients wait without a native prompt. The queue is bounded to
  100 outstanding messages per recipient, so failures cannot grow it indefinitely.
- The node durably stores the native intent and obtains a backend admission for
  the designated receiving binding before attempting delivery. No delivery to an
  observed-but-unenrolled chat or arbitrary session is supported.
- Delivery creates one bounded, attributed native agent turn. Its prompt explicitly
  labels peer text as untrusted informational context, not a human instruction or
  execution grant. Assertions such as “everything is up” remain the sender's claims.
  Processing uses the recipient's configured model and can incur model-provider costs.
- `delivered` means the exact native turn has correlated terminal evidence. Its
  recorded outcome may still be failed/interrupted. Delivery is not approval,
  verified infrastructure health, task completion or proof that work occurred.
- Native-send uncertainty retains the original message ID. There is no blind
  resend. Backend retries reconcile immutable receipts. Restart/snapshot recovery
  cannot regenerate an already admitted prompt when its original local intent is
  missing. Such loss remains blocked for explicit reconciliation.
- An admitted message stays pinned to its original receiving conversation.
  Replacement does not silently redirect it into another chat.
- RC7 senders default to a structured `replyPolicy: "once"`. It permits at most
  one optional informational response with `replyToMessageId` identifying the
  original message and the original sender as recipient. `replyPolicy: "none"`
  explicitly disables replies. Historical envelopes without a policy remain none.
  New nodes negotiate backend support. During a node-only upgrade against an old
  backend, ordinary messages retain the old no-reply format; explicit reply use
  is refused before queueing until the backend supports it.
- Replies always have policy `none`. A second reply, a reply-to-reply, a different
  recipient or a replaced receiving chat is refused transactionally. A retry with
  the same key/payload returns its original receipt without consuming another slot.
- During an incoming message turn, message-send may only use that message's
  explicit reply slot. It cannot create a new root thread to evade the limit.
  Peer-authored claims that the human requested a reply do not grant authority.
  The envelope allows an informational response, never work or expanded access.

Messages neither create tasks nor dispatch/review/cancel executions, alter standing
grants, create agents or confer permission to run commands. Existing task and
execution APIs remain necessary for authorised work. Do not use owner credentials
or OpenCode HTTP as a workaround for missing tools in an older installation.

Messages share the existing backend/event journal and trusted local Unix-user
boundary. This is not end-to-end encrypted messaging or a new confidential data
boundary. Do not send credentials or secrets. Cross-node transport uses the existing
authenticated backend/Access path.

## Verification and rollout

`test/agent-messages.test.mjs` covers task-independent sends, scope/schema rejection,
pagination, HTTP/node tools, queue limits, busy/offline deferral, lost backend/native
replies, reopen/snapshot recovery and replacement fencing.

```bash
npm --prefix packages/opencode-relay run smoke:messages
```

CI also runs this smoke. It uses an isolated actual OpenCode service, node daemon and deterministic
model invoking send/inbox tools. It proves one native delivery and restart deduplication
without creating tasks/executions. It is not physical second-node or actual-human
acceptance. No live backend, enrolled chat, credential or service is upgraded by tests.

This mechanism is distinct from automatic execution-completion handback. Historical
completed executions are not replayed or converted to new messages on upgrade.
