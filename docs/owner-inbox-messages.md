# Plain agent-to-owner Inbox messages

From **0.2.10**, an agent can send the human owner a plain, persistent **Message**
in the native Inbox. It is not a question, task, approval, reminder or scheduled
result notification. Sending or reading it does not start another model turn.

For example, ask an agent: “Message my Inbox when validation passes.” The agent
can continue its authorised work after sending the update. A message does not
replace a required result submission, review or decision.

## Plugin tool

```json
{
  "key": "validation-passed-v1",
  "subject": "Validation passed",
  "body": "All validation checks passed. Deployment has not started."
}
```

Pass this to **`relay_owner_message`**. `key` and `body` are required. The optional
subject defaults to **Agent update**. Subjects are one line, up to 256 characters;
bodies preserve paragraphs and may contain up to 16,000 characters.

The owner is implicit. The node supplies the exact sending agent/chat identity,
and the backend verifies it. The caller cannot select another human, spoof a
sender or borrow an owner credential. The message retains the sender's name,
agent, node and conversation even if that sender is subsequently renamed/deleted.

## CLI

Use the sender's existing scoped worker context, never the owner's context:

```sh
herdr-relay native work owner-message --context EXISTING_WORKER_JSON \
  --key validation-passed-v1 --file message.json
```

`message.json` contains `{ "subject": "Validation passed", "body": "..." }`.
An enrolled interactive sender needs no task or active execution.

Independent headless workers use the same tool. CLI callers also provide
`--execution EXECUTION_ID --run RUN_ID`. The exact run must be accepted,
uncancelled and not a readiness probe, with no staged outcome and a current grant
and contract. Send before `relay_work_submit`. This native reporting primitive
does not require MCP or shell permission. Existing headless sessions refresh their
derived native tool policy through their normal `relay_headless_permissions` check.

## Read and acknowledge

- The Inbox labels the item **Message** and shows its subject, sender and node.
- List previews contain at most five wrapped body lines. Search uses the full body.
- **Enter** opens the complete scrollable text. Opening/closing does not mark it read.
- From **0.3.0**, **c** in details copies the full body without marking it read.
  It uses the native clipboard where available and sends OSC 52 to compatible
  terminals, including over SSH or through Herdr. The terminal must allow OSC 52,
  and tmux must allow passthrough when used. The copy limit is 64 KiB of UTF-8.
- **m** in the list marks it read directly. In message details, **m** or **Enter**
  marks it read without a confirmation dialog.
- The body and sender history remain stored. Read acknowledgement changes no task,
  execution, permission or schedule and sends no reply to the agent.

Only unread messages are fetched for the list. Human owner/operator API clients
can inspect retained messages at `/v1/owner_messages/ID` and paginate
`/v1/owner_messages?status=unread&limit=100`, following `nextCursor`. Ordinary
agent tools cannot list the human's Inbox or mark messages read.

## Retries and limits

Use one immutable key per intended message. An interactive key is scoped to the
sending agent; a headless key is scoped to its exact run. An unchanged retry
reconciles the original message. A changed body/subject under that key conflicts.
Lost replies and process reopen do not justify another key or duplicate message.
`state: recorded` confirms durable storage, **not that the human has read it**.
The original send receipt remains historical after a later read acknowledgement.

Incoming peer messages and online result notices do not authorise forwarding new
messages to the owner. There is no automatic reply chain, email delivery, toast
subscription, state watcher or cron created by this feature.

Upgrade the backend, sending node, Relay plugin and CLI/TUI to **0.2.10** to use
the complete path. An older backend is refused before a send is queued. Protocol
`relay/0.2` and database schemas remain unchanged. See [service upgrades](service-upgrades.md).
