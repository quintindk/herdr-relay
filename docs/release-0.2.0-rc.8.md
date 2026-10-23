# Herdr Relay 0.2.0-rc.8

RC8 supersedes the unpublished RC7 candidate. RC7's tag is retained unchanged;
its release workflow correctly stopped when new high-severity TOML advisories
appeared. No RC7 assets were published and no live services were upgraded to it.

## Security correction

The legacy OpenCode bridge used `@opencode-ai/plugin` only for its identity-function
tool-definition helper and Zod schema accessor. Importing that SDK also installed
an unused Effect/TOML chain affected by:

- [GHSA-4qx8-w7c3-pj3p](https://github.com/advisories/GHSA-4qx8-w7c3-pj3p)
- [GHSA-9j65-hcg3-gc64](https://github.com/advisories/GHSA-9j65-hcg3-gc64)
- [GHSA-9qmh-m7c6-f92p](https://github.com/advisories/GHSA-9qmh-m7c6-f92p)

RC8 implements that small compatibility contract locally with the same pinned
Zod 4.1.8 version. The unused V1 SDK/Effect/TOML chain is removed rather than
overriding it across a TOML major version. Existing legacy definitions and strict
argument validation remain covered by regressions. The new package and every
production activation still require a fresh zero-finding production audit.

## Included functionality

All [RC7 functionality](release-0.2.0-rc.7.md) is included:

- Explicit, revocable model/WorkIQ connection reuse for a dedicated headless session.
  Actual model/read/result readiness gates schedule activation. No copied credential
  store, second login, owner context in the worker or unrelated node restart.
- Safe native skill installation/update with local-edit conflicts and private backups.
- Green `LOCAL` badges identifying the local node and its agents by scoped identity.
- At most one informational reply per explicit message envelope. No reply-to-reply,
  no task authority from peer claims and negotiated compatibility with older backends.

## Historical upgrade verification

Old immutable releases may acquire advisories after publication. A test-only
historical installer verifies their published bytes, installs ignored scripts in
an exact disposable upgrade-smoke directory and records actual audit findings.
It never claims production approval and is not shipped in the public package.
The normal `stageRelease` API remains unchanged and refuses audit findings/outages.
This proves upgrading away from RC6/RC4 without weakening RC8's security gate.

CI runs root/V2 regressions, actual headless/MCP/reply rehearsals, installed upgrade
and code rollback/data/chat continuity, clean production packaging and a fresh audit.
Historical fixture advisory counts and the separately audited candidate result are
reported explicitly. No fixture uses real account credentials or user services.

## Deployment boundaries

Publishing is separate from deployment. Explicit service upgrade preserves node
and backend identities, enrolments, credentials, journals, tasks and comments.
No database is automatically restored. Activate the verified RC8 CLI before
applying an upgrade. On a first RC6-to-RC8 transition run `skills install` once;
older CLIs cannot execute the new skill synchronisation code. Local edits still
require reviewed explicit replacement, never silent overwriting.

Authenticated headless setup still requires a human backend-operator grant,
coordinator and worker on the same node, and an existing authenticated OpenCode
service. This is session isolation, not a separate account/process. Cross-node
authenticated setup, automatic reconfiguration to another connection and standalone
execution-completion handback remain outside this release. Real Microsoft tenant
and physical Surface acceptance are separate from the deterministic MCP fixture.
No live inbox-sweep agent or schedule is created by release verification.
