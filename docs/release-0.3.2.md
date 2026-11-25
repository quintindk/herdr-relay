# Herdr Relay 0.3.2

25 November 2026

Relay nodes do less work between assignments. Presence checks no longer download
OpenCode transcripts, and polling skips settled work history without deleting it.

- OpenCode presence checks verify the exact enrolled chat and read native
  activity. They do not fetch messages or queued input. Admission and result
  observation still inspect the full transcript when they need evidence.
- The scheduler and worker status endpoints use indexes to select the work they
  need. Settled records remain available for history and recovery.

## Upgrade

Upgrade each running node to pick up the CPU fix using the
[service upgrade procedure](https://github.com/quintindk/herdr-relay/blob/v0.3.2/docs/service-upgrades.md).
Updating the CLI alone does not change running services. The protocol and SQLite
schema versions are unchanged.

The [0.3.1 disk-growth fixes](https://github.com/quintindk/herdr-relay/blob/v0.3.1/docs/release-0.3.1.md)
are included. If you are still running 0.3.0 with large databases, review the
[offline compaction plan](https://github.com/quintindk/herdr-relay/blob/v0.3.2/docs/maintenance-recovery.md#offline-database-compaction)
before taking upgrade snapshots. Compaction is not required for the CPU fix itself.
