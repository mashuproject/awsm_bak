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

The base self-contained Snapshot stores one exact Complete Export package. Reusing that encrypted
container and semantic Manifest does not make the Backup Set a live Replica or synchronization
participant; the Backup Set adds destination verification, immutable Snapshot publication, and
retention semantics. Cross-Snapshot entry references are an optional physical optimization and
MUST NOT be required to restore a self-contained Snapshot.

## 2.1 Snapshot Manifest

The canonical initial Snapshot Manifest is:

```text
{
  0: 1,                           // Snapshot Manifest format
  1: backupSetId,                 // 32 random nonzero bytes
  2: snapshotId,                  // 32-byte derived identity
  3: 1,                           // Complete Export passphrase protection profile
  4: packageByteLength,           // positive safe integer
  5: packageByteDigest            // SHA-256 of exact encrypted package bytes
}
```

`snapshotId` is:

```text
SHA-256(Transcript(
  "awsm:backup-snapshot-id:v1",
  [CanonicalCBOR({0, 1, 3, 4, 5})]
))
```

The outer Snapshot Manifest exposes no Vault ID, Generation, Frontier, semantic Manifest, opaque
inventory, label, or Key Epoch material. Its exact encrypted package digest transitively binds the
Complete Export Vault, Generation, Frontiers, Required Feature Set, state digest, logical
reachability, Continuity Proof, and opaque inventory that the trusted Client verifies only after
decryption. Unknown fields, profiles, or formats fail closed. Creation time and destination are
Backup Set-local policy metadata and never influence Snapshot identity.

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

For a self-contained Snapshot, the Runtime reopens the exact destination bytes, decrypts and stages
the package through the ordinary Complete Import parser, verifies its byte length and digest,
authenticates its complete semantic and Authority closure, and requires the verified Complete Export
Manifest to equal the producer's Manifest byte-for-byte. Only then may the destination atomically
publish the Snapshot Manifest. Failure aborts the unpublished destination state and discards
verification Prepared Data; a published Snapshot is not invalidated by later cleanup residue.

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
