# Integrated agent provisioning

`agent provision --file agent.json` is operator-only and requires Relay's
`--backend-context` configuration. Install the external Relay adapter in Paperclip
first. The command creates an independent Paperclip agent with automatic wakes
disabled, launches an owned native server, creates a conversation, registers the
binding and configures the backend adapter.

```json
{
  "key": "graph-worker-1",
  "companyId": "PAPERCLIP_COMPANY_ID",
  "bindingId": "graph-worker-1",
  "harness": "opencode",
  "directory": "/absolute/workspace",
  "lifetime": "persistent"
}
```

Use `harness: "hermes"` for the Hermes gateway. Optional `model` contains
`providerID` and `modelID`. `executable` selects an installed harness binary.
Task lifetime also needs `controllerBindingId` and `taskId`. Worktree lifecycle can
be linked through `worktreeKey` once an owned resource has been provisioned.

Each step records progress under the provisioning key. Agent and conversation
creation are reconciled using recorded identity and unique provisioning labels.
If a creation response is lost and no matching identity is visible, another create
is blocked rather than guessed safe. Native runtime launch follows its own durable
ownership protocol. A completed retry returns the same provisioning receipt.

The shared participation skill is installed into the explicitly selected workspace.
Existing differing skill content is not overwritten. OpenCode/Hermes may load
skills at session creation or startup, so the delivery prompt also carries the
implemented protocol. Model credentials are inherited from the service environment.

The managed OpenCode smoke exercises integrated provisioning against a deterministic
Paperclip API and a real native server/model, including repeated provisioning,
acknowledgement, cancellation and shutdown. Real Paperclip agent creation and
configuration are covered separately by the backend smoke tests. A combined native
and real-backend provisioning scenario remains part of the full acceptance audit.
