# Integrated agent provisioning

Normal interactive launch and registration follows the
[Herdr-first agent lifecycle](herdr-agent-registration.md). Start harnesses using
Herdr shortcuts or manually in panes; the configured Relay observer registers
their native conversations without creating another runtime. These registrations
are visibility-only until verified delivery is attached.

## Organisation Bootstrap

Paperclip calls organisations "companies" in its API. Relay can provision one
before any agents exist, using operator credentials and `--backend-context`:

```json
{
  "key": "default",
  "name": "Default",
  "description": "Default organisation for local Herdr Relay work."
}
```

```bash
herdr-relay company provision --file .relay/default-company.json
herdr-relay operation inspect company:default
```

The provisioning key persists the exact request and resulting company ID.
Identical retries return the same receipt, including after restart. A changed
request conflicts. A matching name does not authorise adoption of an existing
company. Paperclip has no company-create idempotency field, so Relay appends a
unique marker to the description and records uncertainty before posting. A lost
reply is reconciled by that marker; absence never triggers another create.
Do not remove the marker while a creation is unresolved.

This creates only the organisation. It does not create agents, issue work or
select a default organisation for every user's browser. Workers cannot call
this operator-only endpoint.

## Agent Provisioning

The command below is the explicit **headless, Relay-owned** provisioning path.
It remains available for exclusive runtimes, not required for Herdr registration.

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
