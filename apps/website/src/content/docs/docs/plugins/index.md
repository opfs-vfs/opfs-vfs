---
title: Plugins
description: Add file subscriptions or premium encryption to OPFS VFS, and see the planned cloud sync plugin.
---

Plugins add optional capabilities to a volume. Choose them when creating the mount; every client sharing that volume must request the same plugin profile. You can also build a plugin for your own storage or file-change behavior.

| Plugin                                             | Availability         | License   |
| -------------------------------------------------- | -------------------- | --------- |
| [File subscriptions](/docs/plugins/subscriptions/) | Available            | Community |
| [Encryption](/docs/plugins/encryption/)            | Available separately | Premium   |
| [Cloud sync](#cloud-sync)                          | Planned              | Premium   |

## File subscriptions

React to file creation, updates, and deletion, including edits from other clients on the same volume. Use metadata-only events to refresh your interface, or request bounded copies of a completed operation's file contents.

`@opfs-vfs/plugin-subscriptions` lives in the public repository under `packages/plugin-subscriptions` and uses the repository's [PolyForm Noncommercial License](/licensing/). Follow the [subscription guide](/docs/plugins/subscriptions/) for installation, custom workers, filters, and recovery.

## Encryption

The premium encryption plugin adds encrypted volumes and passkey-based access. It is available separately from the core filesystem and the community subscription plugin, under separate premium terms. The core PolyForm Noncommercial License does not grant access to premium plugins. Follow the [encryption guide](/docs/plugins/encryption/) for package access, custom workers, opening encrypted volumes, and passkeys.

Encryption and subscriptions can be enabled together. In that combination, included subscription content contains decrypted application bytes. Treat those bytes with the same care as a normal file read.

## Cloud sync

A premium sync plugin is planned to synchronize a local OPFS VFS volume with backend cloud storage. It is not available yet. Supported storage providers, configuration, and release timing have not been announced.

File subscriptions report local logical changes. They do not upload files or synchronize a volume with a server. Local persistence operations such as `flushVfs()` also do not perform cloud sync.
