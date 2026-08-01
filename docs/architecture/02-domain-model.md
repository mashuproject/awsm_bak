# Domain Model

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/glossary.md`
- `docs/architecture/01-system-overview.md`

# Purpose

This document maps AWSM concepts and cardinalities. The normative glossary and owning formal specs
win if this explanatory view differs.

# Portable Vault model

```text
Vault 1
  |-- 1 Generation currently recognized by a Replica
  |-- 1..* Vault Members while writable
  |     |-- 0..1 Administrator role
  |     |-- 0..* active Client Credentials
  |     `-- 1 effective Recovery Credential path
  |-- 0..* Collections
  |     `-- 0..* Captures (Bundles)
  |-- 0..* Folders, Tags, Tag Assignments, and Notes
  |-- 1 authenticated Vault Record DAG per Generation
  |-- 1 retained cross-Generation Authority Parent Continuity Proof
  `-- immutable dependency-referenced Vault Objects
```

A Vault exists independently of storage location. It may have zero or more Replicas. A Complete
Export or Backup is a static transfer artifact, not another Replica.

# Identity and authority

A Vault Member is portable identity inside one Vault. Administrator is a capability-bearing role,
not a decryption class. Every member has the same Vault access and recovery class; a member's
Recovery Phrase controls that member's Recovery Credential.

A Client Credential signs Events on behalf of one member. The physical machine and Client
Installation are not portable authors. Account is separate Host-local access identity.

# Content model

A Bundle is one immutable Capture. A Collection groups Captures considered observations of the
same subject. Folder navigation contains Collections; Tags target Collections or Captures; Notes
target exactly one Collection or Capture. IDs establish identity, while titles and names may be
duplicated and change through Events.

The Library, Unfiled bucket, Collection Tail, history views, and search results are derived
Projections. There is no portable `Archive` entity between Vault and Collection.

# Storage and execution model

```text
Client Installation 1 -> 0..* local Replicas
Client Installation 1 -> 0..* Client Credentials
Vault 1              -> 0..* Remotes in local Installation State
Replica Host 1       -> 0..* Hosted Replicas
Channel Principal *  -> * Hosted Replicas through Replica Access Grants
```

One installation can be both Client and Host. One Account can access several Hosted Replicas, and
several Accounts or other principals can access one Hosted Replica when Host policy grants it.

# Lifecycle

- Delete and restore are additive current-state facts until Vacuum.
- Closure prevents later Events but leaves retained state readable, exportable, and Forkable.
- Vacuum keeps the Vault identity, replaces Content history with an authenticated successor
  Baseline, and retains the authority Continuity Proof.
- Fork creates fresh Vault, authority, keys, Objects, and history from selected logical state.
- Historical View never moves the writable Frontier backward.

# References

- `docs/specifications/vault/collection.md`
- `docs/specifications/vault/authority.md`
- `docs/specifications/vault/replica.md`
