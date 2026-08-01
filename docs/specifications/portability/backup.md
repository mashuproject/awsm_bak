# Backup Specification

**Document:** `docs/specifications/portability/backup.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/portability/import-export.md`
- `docs/specifications/runtime/storage.md`

# 1. Purpose

A Backup preserves authenticated Vault state outside active Replica synchronization. It is a
Transfer Artifact, not a Replica, Remote, retention promise, or global redundancy fact.

# 2. Backup Set

A Backup Set has one local backup identity, protection profile, destination, and immutable
Snapshots. Each Snapshot binds one Vault ID, Generation ID, exact Frontier, Required Feature Set,
state digest, complete logical reachability, complete Continuity Proof, and exact stored-entry
inventory.

A Snapshot may reference earlier entries in the same verified Backup Set for deduplication. The
dependency graph is explicit, content-addressed, and closed under retention. No Snapshot relies on
an active Replica or Host after successful verification.

# 3. Protection

Backup protection uses either the Complete Export passphrase profile or a separately configured
local backup key protected by the platform secure store. It includes required Key Epoch Keys but
excludes Client Credential and Recovery Credential private keys, Accounts, sessions, and Channel
Authenticators. Losing both backup protection and every member Recovery path may make restored
authoring unavailable.

# 4. Creation

Creation authenticates the selected Frontier, retrieves every required wrapper, writes immutable
entries, verifies the destination byte-for-byte, then commits the Snapshot manifest last. An
interrupted uncommitted Snapshot is cleanup state and is never reported as a successful backup.

# 5. Retention

Retention deletes only Snapshots explicitly selected by policy and only entries unreachable from
every retained Snapshot. Vacuum does not inspect or rewrite Backup Sets. A predecessor Snapshot may
remain available after the active Vault adopts a successor.

# 6. Restore boundary

Restore validates the complete Snapshot before activation and follows Vault ID collision and
Generation rules in `restore.md`. A superseded Snapshot never silently merges into a successor or
rewinds the selected Vault.

# 7. Invariants

- A Backup does not synchronize or receive Events.
- Backup success requires independent destination verification.
- Retention never deletes a retained Snapshot dependency.
- Local availability markers and Materializations are excluded.
- Backup existence is not tracked as portable Vault redundancy.

# References

- `docs/specifications/portability/restore.md`
- `docs/specifications/vault/vacuum.md`
