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

For a new worktree, include `worktreeKey` and a `worktree` object containing
`repository`, `path`, `branch` and optional `base`. Its path must equal `directory`.
Relay creates and records the owned worktree before backend agent creation or
native launch, so the worker never starts in the wrong directory. Lost later
responses retain that same worktree for reconciliation.

Each step records progress under the provisioning key. Backend agent creation is
reconciled using a persisted random marker in adapter configuration, never a display
name alone. Native conversation creation uses the dedicated owned server's unique
provisioning label and then records its exact stored identity.
If a creation response is lost and no matching identity is visible, another create
is blocked rather than guessed safe. Native runtime launch follows its own durable
ownership protocol. A completed retry returns the same provisioning receipt.

The shared participation skill is installed into the explicitly selected workspace
before native startup. Existing differing skill content is not overwritten. The
delivery prompt also carries the implemented protocol. Model credentials are
inherited from the service environment.

The managed OpenCode smoke exercises integrated provisioning against a deterministic
Paperclip API and a real native server/model, including repeated provisioning,
acknowledgement, cancellation and shutdown. Real Paperclip agent creation and
configuration are also verified in combined native/backend tests for both OpenCode
and Hermes. See [scenario verification](scenario-verification.md).
