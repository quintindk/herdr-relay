# Herdr Relay 0.2.0-rc.13

## Node-local headless grants without a backend-owner context

- Enrolled interactive agents can create and revoke their own headless grants on
  their own node and enrolled workspace. No owner context, manual proposal transfer
  or parent execution is required.
- `relay_headless_grant` and `relay_headless_revoke` use the existing authenticated
  agent connector. The node stamps the requester/session/binding. The backend checks
  that identity and records issuing-agent provenance.
- The CLI's `headless grant|revoke --file JSON --key KEY` uses the existing agent
  connection in a chat. Outside a chat, it defaults to the joined node's scoped
  operator context. Explicit context selection remains available for administration.
- Node operators may manage headless grants only within their node/workspace scope.
  Cross-node/requester/workspace overrides, stale receivers and headless-worker grant
  issuance are rejected. This is a credential/API boundary, not an OS sandbox for
  code deliberately given full OS-user shell access.
- Existing grants remain valid. Creating a grant still does not create a worker,
  activate a schedule or run a job. Readiness/activation remains a separate operation.
- Revocation pauses only the grant's own installed schedule and blocks new dispatch.
  It cannot undo effects or stop processes already started.
- Backend, node and plugin advertise/negotiate `nodeHeadlessGrants`. Older components
  report an upgrade requirement; no owner-credential workaround is attempted.

Backend schema remains **2**, node journal schema remains **1**. No task/reference
migration, credential rotation, node re-enrolment or OpenCode restart is required.
Published RC12 artifacts and existing grant records are not rewritten.

## Dependency correction

Pin Zod to **4.6.6**, the first patched version for
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The legacy tool helper retains its Zod 4 API and identity-function behaviour;
the old vulnerable exact pin is not retained merely for compatibility.

## Verification

Tests cover independent node identities issuing grants, operator workspace limits,
identity spoofing, stale bindings, headless-worker isolation, revisioned revocation
and idempotent replay. CLI tests run with no owner context or owner file on the node.
The real OpenCode rehearsal creates a grant through the coordinator tool, repeats
the same operation key without duplication, separately performs readiness/activation
and revokes through the same agent connection.

These are isolated fixtures, not permission to create live jobs or proof of a tenant
business workflow. See [headless setup](headless-authenticated-setup.md).
