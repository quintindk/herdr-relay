# Task file attachments

Share input files and deliverables across machines directly on a native Relay
task. Nodes use the existing backend connection instead of `scp` or `rsync`.
SQLite stores revisioned attachment metadata, not file bytes.

## Share a file

Use your configured [native CLI context](native-cli.md#context-and-authority).
The attachment commands accept native task IDs or primary references such as
`REL-431`. Put options before an explicit `--` separator for a custom ID that
starts with a dash, for example `native task attachments --limit 20 -- -custom-id`.

```sh
herdr-relay native task attach TASK --file PATH --key KEY [--name NAME] [--mime TYPE]
herdr-relay native task attachments TASK [--limit N] [--cursor TOKEN] [--status active|detached]
herdr-relay native task download TASK ATTACHMENT --output PATH [--force]
herdr-relay native task detach TASK ATTACHMENT --revision N --key KEY [--reason TEXT]
```

```sh
herdr-relay native task attach REL-431 --file ./brief.pdf --key brief-v1 --name brief.pdf --mime application/pdf
herdr-relay native task attachments REL-431 --limit 20
# Replace ATTACHMENT_ID and the revision with values from the listing.
herdr-relay native task download REL-431 ATTACHMENT_ID --output ./review/brief.pdf
herdr-relay native task detach REL-431 ATTACHMENT_ID --revision 1 --key withdraw-brief-v1 --reason 'Superseded'
herdr-relay native task attachments REL-431 --status detached
```

Use the original `--key` and unchanged inputs to reconcile an uncertain attach
or detach. Listing defaults to active attachments. Pass the returned cursor to
continue a paginated list. Downloads require an explicit `--output` under an
existing directory. The CLI verifies byte count and SHA-256 before publishing
the file, refuses directories and symlinks, and only replaces an existing file
with `--force`. It never chooses a download path for you.

In the [terminal board](task-board.md), Task Detail shows the attachment count
in **Overview** when there are active files. The **Attachments** tab shows
sanitised metadata and safely shell-quoted download hints.

## Authority and workspace boundaries

| Context | Attachment access |
| --- | --- |
| Human owner or node operator (`owner.json` or `operator.json`) | `attach`, `attachments`, `download` and `detach` on any task. |
| Accepted interactive execution (`worker.json` through `node.sock`) | `attachments`, `download` and `attach` only on its assigned task. Source and output paths are confined to the anchored workspace. No `detach`. |
| Enrolled `agent_read` (for example, positively tagged permission, question or message notices) | `attachments` metadata only. No file transfer or detach. |
| `grant_approval` UI session | No blob or attachment routes or commands. |

Execution-scoped file operations reject symlinks, symlink ancestors and Relay
state/configuration paths. Execution uploads also reject hard-linked sources
(`nlink > 1`). Downloads with `--force` replace the destination directory entry
atomically without changing the contents seen through another hard link.
Foreign tasks, headless workers, standing monitors, local occurrences, stale `inputRevision` and
cancelled or blocked executions are refused. See the [OpenCode bridge](node-cli-bridge.md#task-file-attachments)
for supported tool calls.

Maintenance returns `503 maintenance` for attach, detach and blob uploads.
Attachment metadata and content downloads remain available to authorised readers.

## Limits, storage and detach

- One streamed upload per file, up to **64 MiB**, below Cloudflare Tunnel's
  **100 MiB** ceiling. Empty regular files are supported. A task can have at most
  **100 active attachments**.
- The attachment name defaults to the source basename. It must be a single
  filename of 1–255 characters, with no slash, backslash, control character or
  surrounding whitespace. Names `.` and `..`, and all names starting with a dot,
  are refused. MIME is metadata only.
- The backend streams and verifies the upload by SHA-256, then records a
  `task_attachment` entity after checking the blob exists with the matching
  size. Content is stored under `<backend-state-dir>/blobs/<aa>/<sha256>`,
  where `<aa>` is the first two digest characters. Private directories use
  `0700`, and regular non-symlink files use `0600`. The store pins directory
  descriptors for filesystem operations.
- Detach sets `state: 'detached'` and retains revisioned audit history. Content
  downloads then return `410 attachment_detached`. After commit, the backend
  unlinks the blob once no active attachment on any task references that digest.

## Upgrade and backup

Upgrade the backend and participating nodes and OpenCode plugins using the
[service upgrade procedure](service-upgrades.md). No SQLite migration is
required from 0.2.x releases in the supported upgrade range (`backendSchema: 2`).
`blobs/` lives alongside `backend.sqlite` and is outside `serviceIdentity`
fingerprints and `backend backup` SQLite snapshots. A full state backup must
capture `blobs/` alongside the matching SQLite snapshot to preserve file content.
Keep attachment writes stopped while capturing the pair so detach cannot remove
a blob still referenced by the snapshot.
