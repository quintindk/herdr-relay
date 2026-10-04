# Credential lifecycle

Worker credentials are binding-scoped. The operator can rotate a credential only
when the binding has no unsettled native work:

```bash
herdr-relay agent rotate BINDING_ID --key rotation-2026-10-04 --context-out worker.json
```

Rotation invalidates the previous token immediately, increments a credential
generation and refreshes Relay's native worker context atomically. The CLI writes
the replacement context with private permissions and never prints its token.
An existing output file must belong to the same socket and binding.

Identical retries recover the same generation. Retrying an older rotation after
a newer one is rejected. Retiring/retired bindings cannot initiate writes.
General operator-token rotation and backend/native credential renewal are not
automated. Backend run tokens remain in memory and are reattached or replaced by
the relevant backend adapter invocation.
