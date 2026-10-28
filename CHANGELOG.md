# Changelog

## 0.2.1 — unreleased

Stable-release preparation of the native RC4 product:

- Remove the retired Paperclip service, adapter, bridge, external-provider
  prototypes and one-off source-import commands. There is no planned integration.
- Remove unrelated LiteLLM gateway deployment, client-configuration and verification
  tooling. Relay does not install or manage a separate model gateway.
- Retain existing imported source metadata, immutable references and aliases.
  Removing an integration does not rewrite task history or native state.
- Replace development plans, captured run journals and obsolete installation
  instructions with current operator and contributor documentation.
- Keep native tasks, agents, messaging, grants, schedules, result notifications,
  human handback, terminal integration and compatible maintenance behaviour.

Protocol remains `relay/0.2`, backend schema `2`, node journal schema `1`.
No live reset, database restore, credential rotation or re-enrolment is required.

## Published prereleases

The original source, notes and assets remain available through their immutable
tags and [GitHub releases](https://github.com/quintindk/herdr-relay/releases):

- [0.2.1-rc4](https://github.com/quintindk/herdr-relay/releases/tag/v0.2.1-rc4):
  guarded human handback, wrapped text, node-grouped selection, sidebar/panel
  improvements and contract-activation diagnostics.
- [0.2.1-rc3](https://github.com/quintindk/herdr-relay/releases/tag/v0.2.1-rc3):
  optional persistent Inbox results, online-only requester messages and compatible
  maintenance/recovery improvements.
- [0.2.1-rc2](https://github.com/quintindk/herdr-relay/releases/tag/v0.2.1-rc2):
  existing-task handover and read-only reconciliation.
- [0.2.1-rc1](https://github.com/quintindk/herdr-relay/releases/tag/v0.2.1-rc1):
  native provisioning, instruction revision and execution-continuity improvements.

Earlier development records are available in the repository's tagged history.
They are not current configuration instructions or promises of future integration.
