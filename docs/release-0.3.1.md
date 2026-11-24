# Herdr Relay 0.3.1

24 November 2026

Relay no longer writes steady-state presence to SQLite. Offline compaction
reclaims space already used by legacy presence records.

## Ephemeral presence and idle polling

- `node.heartbeat` and `agent.advertise` no longer append to backend `changes`
  or `receipts`, or to the node journal's `inbox`. Unchanged heartbeats refresh
  `lastSeenAt` in memory with no SQLite writes. Changes to `machine`,
  `availability`, `bindingRevision` or `conversationId` still persist.
- The node journal skips write transactions on idle polls with an unchanged
  cursor. With older backends, it updates cached entities from legacy presence
  events without keeping those events in `inbox`.
- Snapshots keep durable node and agent collections compatible with 0.3.0 nodes
  and expose live timestamps under `snapshot.presence`.

## Bounded TUI evidence logging

Sidebar polling suppresses unchanged replies. Opt-in `evidenceFile` logging
(`human-inbox.jsonl`) suppresses unchanged render events, repairs torn tails and
requires private `0600` files that are not symlinks. A kernel-managed exclusive
lock serialises writes and rotation. The active log and its `.1` archive are
limited to 2 MiB each. The first rotation trims an oversized legacy log without
loading the whole file into memory.

## Offline database compaction

`herdr-relay backend compact` and `herdr-relay node compact` default to a
read-only plan. Apply streams surviving rows into a fresh private database, so
temporary space is based on the surviving data plus SQLite overhead, not twice
the bloated database size. Compaction strictly validates legacy presence event
envelopes and requires SHA-256 preimage proof for legacy presence receipts.
It preserves `sqlite_sequence` high-water marks and keeps at most one trailing
presence row in `changes` so 0.3.0 can still validate node cursors after a code
rollback. Compaction does not repair an existing gap between `sqlite_sequence`
and `MAX(changes.seq)` caused by external truncation. It fences writers through
atomic cutover and removes the old database unless `--keep-original` is set.

## Upgrade bloated installations

1. Activate the published CLI with `herdr-relay release install --version 0.3.1`.
2. Stop the affected Relay systemd user services, nodes before the backend when
   stopping both.
3. Run `herdr-relay backend compact` and/or `herdr-relay node compact` for the
   local services. Review each plan, then repeat with `--apply`.
4. If the services already use 0.3.1, restart them, backend first. Otherwise
   follow the [service upgrade procedure](https://github.com/quintindk/herdr-relay/blob/v0.3.1/docs/service-upgrades.md)
   with `herdr-relay upgrade --services ROLE --version 0.3.1` and the documented
   key and apply steps. Start units left stopped after the upgrade.

Compacting first lets upgrade snapshots copy the compacted database, not tens
of GiB of legacy presence history. See [offline compaction](https://github.com/quintindk/herdr-relay/blob/v0.3.1/docs/maintenance-recovery.md#offline-database-compaction).
Protocol `relay/0.2`, backend schema 2 and node schema 1 are unchanged. CLI
activation alone does not update running services or OpenCode plugins.
