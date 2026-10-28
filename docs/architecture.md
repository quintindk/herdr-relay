# Architecture

Relay has one native task backend and independently enrolled nodes. OpenCode and
Herdr are runtime/UI integrations, not task providers.

## Components

| Component | Owns |
| --- | --- |
| Backend | Human-owned tasks, references, agents, executions, questions, grants, schedules, published results and durable mutation receipts |
| Node service | Local admission, native invocation/observation, node journal, schedule clock, bindings and durable publication queue |
| OpenCode server plugin | Exact-chat tools, native CLI transport and granted headless capabilities |
| OpenCode TUI plugin | Attachment presentation and human-confirmed decisions |
| Native board | Tasks, Agents, Inbox, Grants and Schedule, using the local human/operator scope |
| Herdr integration | Explicit pane/workspace placement, native panel toggle and focus restoration |
| CLI | Native task/agent operations, installation, maintenance, recovery and release activation |

Backend and node journals are local SQLite databases. Do not share a live database
over a network filesystem. Additional machines join the backend using separately
scoped credentials, not by copying its database or owner credential.

## Identity and work

A node is a Relay participant; nodejs is its runtime. Durable agent identity is
separate from its current receiving chat. Reattachment changes the receiving
binding without moving an already admitted execution to another conversation.

Task capture is not dispatch. Human responsibility remains with the human while
an execution identifies the selected worker and exact task revision. Workers stage
questions/results through their assigned scope. The node correlates the native
terminal before publishing. A successful native turn is not automatically a Relay
submission, and a published partial business report is not complete source coverage.

The protocol retains original operation keys and distinguishes definitive refusal,
revision conflict and uncertain effects. Unknown effects are not blindly retried
under new keys. Administrative recovery preserves original evidence rather than
manufacturing successful completion.

## Schedules and results

Nodes own cron clocks and installed schedule revisions. Backend acknowledgement
does not prove a future tick was admitted. Downtime skips old recurring ticks;
active occurrences prevent overlap. Admission waits for an approved headless
contract to be applied and pinned to the run.

Result notifications are optional per schedule. Inbox entries persist until read.
Requester messages are online-only and use bounded memory while busy. Disconnect,
restart and uncertain sends may drop them without changing the execution outcome.
See [reporting semantics](run-result-notifications.md).

## Native state and historical metadata

External tracker services and provider selection are not part of this product.
Previously imported records remain native tasks. Their source fields, aliases and
reference claims are historical provenance, not a live integration or permission
to contact another service. Upgrades must retain them byte-for-byte where required.

Development run reports are not authoritative runtime state and do not belong in
the source tree. Runtime journals, receipts, backups and recovery evidence remain
in the operator's private state directories. See [development](development.md),
[security](security.md) and [maintenance](service-upgrades.md).
