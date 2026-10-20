# Version 0.2 provider contracts

Status: native and external task adapters under implementation. Fixture coverage
is not live external tracker certification.

## Selection

The native deployment implements Tasks and Collaboration. External adapters are
explicitly **task-only** in this increment. Using GitHub or Paperclip task storage
still requires native Collaboration for addressed execution, questions, directory,
review and event delivery. Do not call this GitHub-only operation.

The standalone backend/daemon currently requires native tasks. The node service
now routes task list/inspect/comment/relation reads through an injected Tasks
provider. The provider scope is pinned in its local journal, including repository,
company and label mapping. A changed scope requires explicit migration. External
read failures never fall back to cached native tasks with colliding IDs.

External adapters are not yet connected to execution admission, delegation,
scheduled task materialisation or review-driven status writes. The daemon rejects
external selection until that lifecycle is complete. Provider selection must
replace all task reads/writes, not copy native tasks into a second tracker.

## Capabilities

| Contract | Native | Paperclip adapter | GitHub adapter |
| --- | --- | --- | --- |
| Task reads | Bounded opaque cursor | Native UUID keyset and visibility proof | Repository page traversal, PRs excluded |
| Task creation | Atomic idempotency/receipt | Native creation key | Durable no-resend journal and owned marker |
| Task update | Atomic expected revision | Best-effort revision check | Best-effort revision check and journal |
| Comments | Read/write | Read, write pending | Read/write with publication journal |
| Relationships | Parent/dependency read/write | Read and task update | Read-only children/dependencies |
| Activity | Durable bounded event query | Adapter pending | Unsupported |
| Collaboration | Native | Native dependency | Native dependency |

GitHub v1 scope is one configured repository. Workflow labels use
`relay:status:STATUS`, priority labels use `relay:priority:PRIORITY`, and closed state
distinguishes completed from not-planned. Unrelated labels are retained. Provider
history and external edits cannot prove native settlement or candidate acceptance.

GitHub comment reads use bounded pagination. Child/dependency reads use the
documented [sub-issue](https://docs.github.com/en/rest/issues/sub-issues) and
[issue dependency](https://docs.github.com/en/rest/issues/issue-dependencies)
routes. Cross-repository references retain their repository and issue number,
have no local task ID and mark the local dependency projection incomplete.
Parent lookup remains unsupported. Read errors and exhausted traversal bounds
are explicit failures rather than empty relationship lists.

The external journal persists before a non-idempotent send. A lost response reads
back the original marker/current fields, never blindly repeats POST/PATCH. Failure
to find a match remains uncertain. Reconciliation is bounded and must fail visibly
when the bound is reached. It is not an exactly-once guarantee against external
writers copying markers or simultaneous updates.

Before production selection, complete shared provider tests, worker scope mapping,
the missing capabilities and real isolated tracker workflows. Current adapters
declare unsupported operations instead of silently downgrading them.

`node scripts/verify-github-provider.mjs` passed a read-only live traversal of
`quintindk/herdr-relay` through existing `gh` authentication. Its issue collection
was empty and explicitly complete. This is connectivity/query evidence only,
not task publication or lifecycle certification. No test issues were created.

Artifact exchange initially uses explicit HTTPS URLs or Git commit links with a
SHA-256 content digest bound to the exact execution candidate/result. The backend
stores references, not large blobs, and does not fetch those URLs on attachment.
Nodes must verify fetched content before using it. Plain local file paths and
unpushed branch names are not cross-machine deliverables.
