# Backup Specification

**Document:** `docs/specifications/portability/backup.md`

**Version:** 1.0

**Status:** Draft

---

# 1. Purpose

This specification defines snapshot-based backup for Vault recovery.

Backup is not Export. Export produces a portable interchange package. Backup creates recovery points optimized for restoring a Vault replica after device loss, corruption, or operator error.

---

# 2. Design Goals

Backup MUST provide:

- durable recovery points
- snapshot identity
- incremental operation
- integrity verification
- encrypted storage
- resumable execution through the Runtime Job Framework

---

# 3. Backup Model

Conceptually:

```text
Vault

↓

Snapshot

↓

Backup Set

↓

Recovery Plan

↓

Restore
```

Snapshots describe which authoritative Objects belong to a recovery point. Backup Sets store or reference the Objects required to reconstruct that Snapshot.

---

# 4. Backup Job

Every Backup operation SHALL execute as a Backup Job submitted to the Runtime Job Framework.

The Backup Service defines backup behavior. The Job Framework owns:

- scheduling
- persistence
- retries
- cancellation
- progress reporting
- recovery after interruption

---

# 5. Snapshot

A Snapshot is an immutable logical view of a Vault at a point in time.

Every Snapshot SHALL include:

- Snapshot ID
- Vault ID
- creation timestamp
- Vault version
- object manifest
- parent Snapshot ID, for incrementals
- integrity metadata

Snapshots are metadata. They do not contain decrypted Vault contents.

---

# 6. Backup Set

A Backup Set contains or references the authoritative Objects required by one Snapshot.

Backup Sets MAY contain:

- Bundle Descriptor and Artifact Objects, including external Artifact wrappers
- Event Log Segment Objects
- Wrapped Key Objects
- Vault Metadata Objects
- Snapshot Manifest Objects

Backup Sets SHALL NOT contain:

- Projections
- Search Projection Materializations
- Search settings, model references, protected remote credentials, Jobs, and checkpoints
- caches
- Runtime state
- Job queues
- diagnostics

---

# 7. Incremental Backup

Incremental backups contain only Objects not already present in an earlier Backup Set for the same Vault lineage.

Because Objects are immutable and identified by Object Identifier, incrementals SHALL reference existing Objects rather than duplicate them when possible.

---

# 8. Encryption

Backup preserves encrypted Objects.

Backup SHALL NOT require plaintext Vault contents. If a Backup Set is stored outside trusted devices, all Object payloads remain encrypted and Wrapped Keys remain wrapped.

---

# 9. Integrity

Backup SHALL verify every Object before adding it to a Backup Set.

A complete Backup implementation SHALL source remote-only Artifact wrappers through the Runtime
Artifact resolver, using the exact active or retained Recovery Snapshot scope owned by its Snapshot.
It MUST NOT silently omit them, rehydrate the source device, or serialize device-local availability.

Backup Set manifests SHALL include sufficient integrity metadata to detect:

- missing Objects
- corrupted Objects
- incorrect Snapshot lineage
- incompatible Vault versions

---

# 10. Retention

Retention policy determines which Backup Sets remain available.

Retention MAY be based on:

- age
- count
- storage quota
- user pinning

Retention MUST NOT delete Objects required by retained Snapshots.

---

# 11. Restore Relationship

Restore begins by constructing a Recovery Plan from one or more Backup Sets.

Backup does not execute Restore. Restore validates and applies Backup Sets according to `docs/specifications/portability/restore.md`.

---

# 12. Diagnostics

The Backup Service SHOULD expose:

- active Backup Job
- Snapshot ID
- object count
- uploaded or copied Object count
- skipped Object count
- verification failures

Diagnostics SHALL NOT expose decrypted user content.

---

# 13. Invariants

- Backup creates recovery points.
- Backup is Snapshot-based.
- Backup preserves authoritative Objects only.
- Backup never stores Projections, Search Projection Materializations, Search settings, model
  references, protected remote credentials, Search Jobs, or Search checkpoints.
- Backup execution is a Runtime Job.
- Backup does not require plaintext Vault contents.
- Complete Backup includes every reachable Artifact wrapper regardless of source-device availability.

---

# 14. Vault Generation Boundary

A Backup Set records the opaque Vault Generation number and root ID that it captures. Vault Vacuum does not inspect, rewrite, or delete existing Backup Sets. Retention policy remains responsible for them.

A Backup Set from a superseded generation MUST NOT merge into the active generation. It is eligible only for isolated recovery as a retired generation or restoration into a new Vault for manual recovery.

---

# References

- `docs/specifications/portability/restore.md`
- `docs/specifications/storage/object-store.md`
- `docs/specifications/runtime/jobs.md`
- `docs/specifications/vault/vault.md`
