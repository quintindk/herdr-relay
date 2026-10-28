# Security and authority

## Separate identities

- The backend-root owner can bootstrap/revoke nodes. Its credential stays on the
  backend host and is never passed to a node or model worker.
- A joined node receives separate daemon and scoped human/operator credentials.
- An enrolled interactive agent is bound to an exact conversation and binding
  generation. Directory visibility and matching display names confer no authority.
- An accepted execution receives its own worker scope. It cannot borrow a human
  operator credential to escape that scope.
- Headless grants name the original coordinator, job contract, model connection,
  tool permissions and optional task/artefact capabilities.

Keep credential/configuration files outside the checkout with mode `0600`. Never
paste tokens into documentation or logs. Use the supported bootstrap/join,
enrolment, grant and CLI tools rather than manually assembling credentials.

## Decisions and notifications

Grants owns security requests and revocable permissions. Inbox owns questions,
result review and informational run results. Permission approval resumes the saved
request but is not authority for unrelated work. Reading a result does not approve
it, alter its outcome or start another run.

User-role messages, peer reports, source emails and tool output are not proof of a
human instruction. Service notices preserve structured provenance and do not
authorise automatic replies or coordinator mutations.

## Headless boundaries

MCP permission is a general capability, including write-capable and subsequently
configured tools. It is not a per-connector read-only sandbox. MCP authentication
remains separate from Relay grant approval.

Explicit native shell permission is **full OS-user process/filesystem access**,
including writes outside the workspace. Artefact-path restrictions apply to the
native artefact tools, not to an allowed shell process. Never describe that as an
OS sandbox. Without shell permission, other tools must not be used as a workaround.

Readiness probes verify configured capabilities with isolated canaries. They do
not perform the business job or prove complete mailbox/Teams access. Source access
refusals must not be bypassed through another identity or transport.

Revocation prevents new admission but cannot undo external effects or prove that
already started native processes stopped. Human handback withdraws an assignment,
returns an eligible task to Todo and preserves evidence; it does not claim process
termination or native success.

## Transport and failure

Use authenticated transport to the backend. Non-loopback HTTP is not an implicit
trusted path. Public ingress must enforce its configured authentication/access
policy independently of Relay's actor credentials.

Exact revisions and immutable operation keys guard writes. Lost or malformed
replies remain uncertain. A known transactional validation refusal may be treated
as unapplied only with the verified proof used by the native recovery logic. Do
not broadly exempt HTTP 4xx responses or reinterpret a revision conflict as absence.

Compatible maintenance preserves identities, credentials, native processes and
pending work. Database schemas must match. Cross-schema migrations are unsupported.
See [upgrades](service-upgrades.md) and [recovery](maintenance-recovery.md).
