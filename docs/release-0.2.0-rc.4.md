# Herdr Relay 0.2.0-rc.4

Prepared candidate: task-independent native agent messaging. Publication and live
installation are separate actions. The latest published package remains RC3 until
this candidate is explicitly tagged and its release pipeline succeeds.

## Changes

- `relay_message_send`, `relay_messages` and `relay_message_inspect` in enrolled
  OpenCode agent chats, without an active execution or an owner credential.
- Bounded status/message content, exact sender attribution, participant-scoped
  inbox/sent reads and immutable-key retry receipts.
- Durable backend/event queues, busy/offline deferral and an exact receiving-chat
  admission before native delivery. Lost native replies are never blindly resent.
- Native delivery receipts, original-intent recovery and replacement fencing.
- Messages are informational peer context, not human instructions, tasks, dispatch
  or permission to execute commands. Automatic acknowledgements/replies are blocked.
- Backend HTTP/node/tool tests, installed-package messaging verification and a real
  OpenCode service/node/model-tool smoke. Single-host deterministic-model evidence
  does not certify physical Surface or actual-human acceptance.

Read [agent messages](agent-messages.md) for schemas, states, safety boundaries and
rollout. Backend, node and server plugin all need this version for messaging. No live
service is upgraded or message replayed by preparing or testing this candidate.

The earlier standalone execution-completion handback gap is separate. This candidate
does not reinterpret historical approvals as new instructions or replay completed
work. Message delivery does not prove task acceptance, infrastructure health or
that an agent acted on its contents.
