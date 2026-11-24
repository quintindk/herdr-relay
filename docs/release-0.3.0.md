# Herdr Relay 0.3.0

24 November 2026

Share files across machines directly on Relay tasks without `scp` or `rsync`.
SQLite retains attachment history while file content stays in a private blob
store on the backend host.

## Task file attachments

- Attach, list, download and detach files with the native CLI. Uploads stream
  up to 64 MiB per file, including empty files. Task Detail shows active
  attachment metadata and download hints.
- Accepted interactive workers can list, download and attach files on their
  assigned task through the node socket. File transfers stay inside the anchored
  workspace. Enrolled read-only callers can list metadata, not transfer content.
- Only the human owner or node operator can detach. Detach retains audit history
  and removes unreferenced blob content after commit.

## Inbox clipboard shortcut

Press **c** in an Inbox detail view to copy the full message without marking it
read. Relay uses the native clipboard and sends OSC 52 to compatible terminals,
including over SSH or through Herdr.

## Upgrade and verification

Upgrade the backend and participating nodes and OpenCode plugins using the
[service upgrade procedure](https://github.com/quintindk/herdr-relay/blob/v0.3.0/docs/service-upgrades.md).
Activating the CLI alone does not update running services or plugins. Publication
does not upgrade them.

Protocol and database schemas are unchanged. The blob directory is outside
SQLite snapshots. See [task file attachments](https://github.com/quintindk/herdr-relay/blob/v0.3.0/docs/task-attachments.md)
for commands, scope and full-state backup requirements.

The installed-package release gate runs an isolated two-node fixture with a real
OpenCode runtime and deterministic provider responses on the supported
**2.1.0, 2.1.2 and 2.2.5** hosts. It checks operator upload, scoped worker download
and return of a deliverable, operator download, detach and blob collection.
Local verification also covers OpenCode **2.3.2**. The fixture does not use live
services or copied credentials, and does not qualify physical two-machine
deployments. Publication also requires a zero-vulnerability production audit.
