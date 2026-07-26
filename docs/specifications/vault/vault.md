# Vault Specification

**Document:** `specifications/vault/vault.md`

**Version:** 1.0

**Status:** Draft

---

# 1. Purpose

A Vault is the authoritative logical container for archived information.

A Vault contains authoritative Objects, cryptographic material, and derived Projections.

Every preserved object belongs to exactly one Vault.

A Vault is independent of any particular device or server.

---

# 2. Design Goals

A Vault MUST provide:

- a stable identity
- cryptographic isolation
- synchronization boundaries
- deterministic replay
- offline operation
- long-term portability

---

# 3. Logical Model

```
Workspace

├── Vault
│
├── Vault
│
└── Vault
```

A Workspace manages one or more Vaults.

Each Vault is logically independent.

Workspace membership and the device-local active Vault selection are operational state. They MUST NOT combine Vault Root Keys, authoritative history, synchronization state, or Object identity across Vaults.

Exactly one registered Vault SHALL be active whenever a Workspace contains a Vault. New Commands execute only in the named active Vault context. Changing the active Vault is local and MUST NOT produce a Vault Event.

---

# 4. Vault Identity

Every Vault SHALL possess:

- Vault ID
- Vault Version
- Creation Timestamp
- encrypted Event-derived Name

The Vault ID MUST remain stable for the lifetime of the Vault.

The initial Vault name SHALL be recorded by `VaultCreated`. Later names SHALL be recorded by `VaultRenamed`. Names are labels rather than identifiers, MAY be duplicated across Vaults, and MUST remain encrypted outside trusted clients.

A local client MAY maintain an encrypted rebuildable name cache so that Vault names remain visible while Vault contents are locked. Such a cache is a Materialization: it is not authoritative, synchronized, or required in Backup.

---

# 5. Vault Contents

Conceptually a Vault contains:

```
Vault

├── Authoritative Object Store
├── Bundle Registry
├── Event Store
├── Projection Store
├── Search Projection
├── Device Registry
├── Trust Registry
├── Key Material
└── Synchronization State
```

Only authoritative Objects are authoritative.

All other components are derived or operational.

---

# 6. Authoritative State

The authoritative state of a Vault consists exclusively of immutable Objects whose Object Types are defined by their specifications.

Examples include:

- Bundle Descriptor and Artifact Objects
- Event Objects
- Event Log Segment Objects
- Wrapped Key Objects
- Vault Metadata Objects

Bundle Registries, Event Stores, Search Projections, and UI views are logical interpretations or materializations of authoritative Objects. Every derived or operational representation MUST be reproducible from authoritative Objects.

---

# 7. Bundle Registry

The Bundle Registry is a Projection over authoritative Bundle Descriptor and Artifact Objects plus
Vault Events.

Bundles are immutable.

Bundles are never modified after registration.

Bundles MAY enter Deleted through Events and remain historically addressable until explicitly removed by the Vault Vacuum retention policy.

---

# 8. Event Store

The Event Store is a logical view over authoritative Event Objects or Event Log Segment Objects.

Replay of the Event Store reconstructs all mutable state.

Events are append-only.

Vault Vacuum MAY replace the authoritative Event history with a verified successor Vault Generation. Existing Event Objects remain immutable; replacement history uses new Objects and identifiers where contents change.

---

# 9. Projection Store

The Projection Store contains derived state.

Examples include:

- folder hierarchy
- tag assignments
- favorites
- recently viewed
- user preferences

Projections MAY be deleted and rebuilt.

---

# 10. Search Projection

The Search Projection is a derived structure.

It MAY contain:

- encrypted metadata
- encrypted keyword Materializations
- embedding references

Search Materializations MUST be rebuildable.

---

# 11. Device Registry

The Device Registry records trusted devices participating in the Vault.

Examples:

- browser extension
- desktop application
- mobile application

Device enrollment and revocation occur through Events.

---

# 12. Trust Registry

The Trust Registry records trust relationships.

Examples include:

- enrolled devices
- wrapped vault keys
- revoked devices
- key rotation history

## 12.1 Local Vault Key Slots

A client MAY store multiple local device wrappers for the same Vault Root Key when device enrollment requires them.

The initial browser implementation SHALL create one mandatory device slot backed by a non-exportable local device wrapping key. It SHALL NOT create or persist a local passphrase slot.

Every slot SHALL include an explicit slot version, wrapping algorithm identifier, Vault ID, and Device ID where applicable.

A local AES-KW device slot SHALL be verified after unwrap using a Vault verifier derived from the Vault Root Key and bound to the slot metadata.

A synchronized Vault SHALL have one active Recovery Generation, one active key epoch, an encrypted
Recovery Kit, and one signed key envelope per authorized Device and readable key epoch. One Account
SHALL own at most one synchronized Vault. Account authentication does not wrap Vault keys or grant
cryptographic access. Additional Vaults in the local Workspace remain local-only unless a future
contract changes the one-Vault Account rule.

An export key envelope belongs to a Vault Package, not to the Vault Trust Registry or local key-slot collection.

The Vault Root Key MUST NOT be persisted unwrapped.

Key slots protect the Vault Root Key. Bundle, Event, and Projection keys are derived from the unwrapped Vault Root Key according to the Key Derivation Specification.

---

# 13. Synchronization State

Synchronization State records operational information such as:

- synchronization cursor
- last successful synchronization
- pending uploads
- pending downloads

Synchronization State SHALL NOT alter Vault semantics.

---

# 14. Replica Model

A Vault MAY have multiple replicas.

Examples:

- browser extension
- desktop application
- synchronization backend

Replicas synchronize through the Archive Synchronization Protocol.

Replicas SHALL converge through successful synchronization.

---

# 15. Ownership

Bundles belong to a Vault.

Events belong to a Vault.

Devices participate in a Vault.

Replicas store copies of a Vault.

---

# 16. Portability

A Vault SHOULD be exportable.

A Complete Vault Package MAY be imported only as a new Vault with the package's stable Vault ID.
Import preserves the exact active Generation, head, Events, Objects, and encrypted Artifact bytes;
it never merges with or replaces an existing Vault. The importing Device creates a fresh Device ID,
non-exportable device key, slot, and verifier. Rebuildable Projections and encrypted Workspace name
cache are derived locally. The imported Vault commits manually locked.

Export SHALL preserve:

- authoritative Objects
- cryptographic metadata
- version information

Implementations MAY exclude ephemeral caches.

---

# 17. Versioning

A Vault SHALL declare:

- Vault Version
- Bundle Specification Version
- Event Specification Version
- Protocol Version

---

# 18. Invariants

A Vault possesses a single stable identity.

Authoritative Objects are immutable.

Derived state is disposable.

Replicas converge through synchronization.

Object identities never migrate between Vaults.

Every persisted Vault-owned record, Runtime Job, Projection, and operational lease MUST identify its Vault. Reads, enumeration, replay, recovery, and destructive work MUST remain scoped to that Vault.

Event Log Segment Objects are append-only by protocol semantics.

---

# References

bundle/bundle.md

event/event.md

protocol/protocol.md
