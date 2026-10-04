# Herdr placement reconciliation

Operator commands bind a reported native conversation to an exact herdr terminal:

```bash
herdr-relay placement bind --file placement.json
herdr-relay placement reconcile --file placement.json
```

```json
{"bindingId":"daily-driver","paneId":"EXACT_HERDR_PANE_ID"}
```

Relay must run within the intended herdr context for these calls. It checks the
pane's harness and reported native conversation, then records pane, terminal,
workspace and tab identities. Reconciliation never recreates a missing pane or
stops a replacement occupant. A changed terminal or conversation is unresolved.
Registered placement is rechecked before native supervision effects.

Herdr owns terminal restoration. Relay reuses a restored matching terminal and
does not launch a duplicate terminal. A moved pane requires explicit placement
rebinding using its newly reported ID. Cross-machine placement is not implemented.
Managed headless runtimes do not require a terminal placement record.

`scripts/placement-smoke.mjs` verifies the actual current pane read-only. Unit tests
exercise a replaced terminal and retain the original binding identity on failure.
