# Architecture Glossary

**Document:** `docs/architecture/glossary.md`

**Version:** 1.0

**Status:** Normative

---

# 1. Purpose

This document defines the canonical terminology used throughout the Archive Platform specifications.

All specifications SHALL use these definitions consistently.

Where another specification conflicts with this glossary, this glossary is authoritative.

---

# 2. Design Principles

Architectural terms SHALL have exactly one meaning.

A concept SHALL have one preferred name.

Synonyms SHOULD be avoided.

Implementation-specific terminology SHALL NOT replace architectural terminology.

---

# 3. Primary Concepts

## Account

The authenticated principal that owns at most one synchronized Vault replica record at a
Coordination Server.

An Account owns its Vault directly, but authentication alone does not grant cryptographic access.
Rails receives the Account password over TLS and stores only its password digest. A certified
Device must separately possess locally protected Vault key material. Memberships, shared Vault
authority, and Organizations remain future concepts.

## Account Session

An authenticated Rails session scoped to Account identity and Account-level operations. It can
discover whether the Account owns a synchronized Vault and authorize Device enrollment ceremonies,
but cannot synchronize Vault Objects or decrypt Vault content.

## VaultDevice Session

An authenticated API session bound to one current certified Device and one synchronized Vault.
It authorizes opaque synchronization operations but carries no Vault decryption key.

## Recovery Phrase

The canonical 12-word BIP39 representation of 128 bits of client-generated recovery entropy. It
recovers the encrypted Recovery Kit and authorizes enrollment of a fresh Device. Neither the words
nor the entropy cross the Coordination Server boundary.

## Recovery Kit

An encrypted client-created package containing the complete key-epoch root-key set and the recovery
administrator seed for one Recovery Generation. The Coordination Server stores it as opaque
ciphertext.

## Device

A browser installation with independent signing and wrapping key pairs, certified for one Recovery
Generation. Device secrets remain protected in trusted client storage.

## Device Certificate

A recovery-administrator-signed statement binding a Device ID, public signing and wrapping keys,
display metadata, Vault ID, and Recovery Generation.

## Key Epoch

A numbered content-encryption authority within one Vault. Every encrypted Object declares its Key
Epoch. Future Protection activates a new epoch while retaining prior keys for authorized Devices to
read history.

## Remote-only Artifact

An Artifact whose authoritative immutable Object record remains in a local Vault Replica while its
encrypted wrapper is intentionally absent from one device after exact active-server membership and
ciphertext metadata were proved. Remote-only availability is device-local operational state, not an
Object, Event, synchronized fact, or permission for unexplained absence. Access retrieves and
integrity-checks the wrapper through the trusted Runtime.

## Replica

One synchronized copy of opaque Vault records. A client Replica retains trusted local state; the
Coordination Server maintains an untrusted operational Vault replica record scoped to an Account.

## Delivery Cursor

A per-Vault, monotonically increasing Coordination Server sequence used only to discover accepted
changes. Delivery Cursor order does not define canonical Event replay order.

## Recovery Snapshot

The exact membership of a superseded Vault Generation retained temporarily for explicit encrypted
recovery access.

## Purge Job

A durable, non-cancellable operational workflow that removes selected superseded Generation
memberships and deletes only opaque bytes no remaining Generation references.

## Workspace

A management context that enumerates one or more independent Vaults.

A Workspace does not combine Vault ownership, authority, cryptographic material, synchronization state, or storage identity.

The active Vault selection within a Workspace is device-local operational state. It is not authoritative Vault history and is not synchronized.

## Active Vault

The Vault selected on a device as the context for new Commands and user-interface operations.

Changing the Active Vault does not create a Vault Event. A Command accepted in one Vault context MUST NOT be executed in another Vault context.

## Vault

The complete authoritative archive belonging to a user or shared context.

A Vault contains authoritative data required to reconstruct the archive.

A Vault is the highest-level logical container.

---

## Vault Generation

An immutable encrypted reachability manifest identifying one authoritative history generation of a stable Vault.

## Vault History Rewrite

The verified construction of a successor Vault Generation without modifying existing Objects.

## Vault Vacuum

A destructive Runtime Job that replaces authoritative history with a verified successor Vault Generation and reclaims predecessor-only Objects belonging to Deleted Captures.

## Deleted

The logical Capture state in which content is absent from the main Library but remains retained, inspectable, and restorable until Vault Vacuum.

## Collection

A stable logical identity grouping Captures that the user considers versions of one page.

Collection membership and redirects are derived by replaying immutable Events. A Collection is not an authoritative Object or mutable container.

---

## Capture

An immutable snapshot of information at a specific moment.

Every successful Capture produces exactly one immutable Bundle. A Capture retains its source,
timestamp, and preservation context; later changes produce another Capture rather than modifying
the original.

---

## Library

The user-facing Projection through which Captures and Collections are browsed and managed.

The Library is rebuildable. It is not an authoritative container and does not own Capture content.

---

## Bundle

An immutable Capture package represented by Object semantics.

A Bundle is a logical graph containing exactly one Bundle Descriptor Object and every independently
encrypted Artifact Object referenced by that descriptor.

Bundles are authoritative.

Bundles are never modified after creation.

---

## Bundle Descriptor

The compact encrypted Object that contains a Bundle's Capture metadata and exact Artifact
references without embedding Artifact payload bytes.

---

## Artifact

An immutable authoritative payload Object preserved or derived as part of a Bundle graph.

Each Artifact is independently identified, encrypted, stored, streamed, and verified. Artifact is
the canonical term; attachment is not a domain synonym.

---

## Object

The smallest authoritative immutable storage unit.

Objects are identified by Object Identifier.

Objects are opaque outside their defining specification.

Objects remain immutable.

---

## Object Identifier

A globally unique identifier referencing an immutable Object.

Object Identifiers remain stable for the lifetime of an Object.

---

## Manifest

Structured metadata describing another logical entity.

Examples include:

- Bundle Descriptor
- Export Manifest
- Snapshot Manifest

A Manifest describes but does not replace authoritative Objects.

---

## Runtime

The platform-independent application responsible for executing business logic.

The Runtime coordinates Services.

The Runtime is independent of browsers and operating systems.

---

## Host

A platform-specific integration layer.

Examples include:

- Chrome Extension
- Firefox Extension
- Safari Extension
- Electron
- Native Desktop

Hosts provide platform capabilities.

Hosts do not implement business logic.

---

## Service

A Runtime component responsible for one bounded capability.

Examples include:

- Storage Service
- Capture Service
- Search Service
- Synchronization Service
- AI Service

Services communicate through Runtime Events and Commands.

---

## Projection

A rebuildable derived representation of authoritative data.

Projections are never authoritative.

Examples include:

- Search
- Timeline
- Folder hierarchy
- Tag counts
- Recent documents

---

## Materialization

A concrete implementation of a Projection optimized for a particular purpose.

Examples include:

- inverted index
- SQLite FTS table
- vector index
- B-tree

Materializations are implementation details.

---

# 4. Storage Concepts

## Storage Service

The Runtime Service responsible for object persistence.

The Storage Service exposes logical storage semantics.

---

## Storage Driver

A platform-specific adapter implementing Storage Service persistence.

Examples include:

- OPFS
- SQLite
- IndexedDB
- Local Filesystem

Drivers hide persistence implementation details.

---

## Persistence Backend

The underlying storage technology used by a Storage Driver.

Examples include:

- OPFS
- SQLite
- IndexedDB

Persistence Backends are implementation details.

---

# 5. Capture Concepts

## Capture Request

A request to archive a resource.

---

## Capture Job

The Runtime Job responsible for executing a Capture Request.

---

## Capture Result

The successful output of a Capture Job prior to Bundle creation.

---

## Capture Profile

A versioned configuration describing which representations and artifacts shall be captured.

---

# 6. Synchronization Concepts

## Replica

A complete local or remote copy of a Vault.

---

## Coordination Server

A server responsible for coordinating replica synchronization.

Coordination Servers are not authoritative.

Coordination Servers do not require plaintext Vault data.

---

## Synchronization Session

A communication session between replicas.

---

## Synchronization Cycle

One reconciliation pass performed during a Session.

---

# 7. AI Concepts

## AI Provider

A component capable of executing AI Capabilities.

Providers may be local or remote.

---

## Capability

A logical AI function.

Examples include:

- OCR
- Summarization
- Embedding Generation
- Translation

Capabilities are requested independently of models.

---

## Model

A concrete implementation used by an AI Provider.

Models are implementation details.

---

## Derived Artifact

An immutable Object generated from authoritative data.

Examples include:

- Summary
- OCR text
- Embeddings
- Keywords
- Language metadata

Derived Artifacts remain immutable.

---

# 8. Job Concepts

## Job

A durable unit of long-running Runtime work.

---

## Scheduler

The Runtime component responsible for scheduling Jobs.

---

## Worker

A Runtime component responsible for executing Jobs.

---

# 9. Backup Concepts

## Complete Export

A portable, client-held export of one authenticated Vault Generation containing the complete
authoritative inventory and every referenced Artifact wrapper.

Complete Export excludes rebuildable Projections, Materializations, caches, local Device secrets,
and operational state.

---

## Snapshot

An immutable logical view of a Vault at a point in time.

---

## Backup

A durable recovery copy derived from a Snapshot.

---

## Recovery Plan

A validated execution plan describing how Restore will reconstruct a Vault.

---

# 10. Event Concepts

## Runtime Event

A local event exchanged between Runtime Services.

Runtime Events are not synchronized.

---

## Vault Event

An authoritative event synchronized between Vault replicas.

Vault Events become part of the Event Log.

---

# 11. Authoritative vs Derived

## Authoritative Data

Data required to reconstruct a Vault.

Examples:

- Bundles
- Objects
- Wrapped Keys
- Vault Events
- Vault Metadata

---

## Derived Data

Data that can be rebuilt from authoritative data.

Examples:

- Search projections
- AI projections
- Tag counts
- Timeline
- Folder hierarchy
- Recent documents

---

# 12. Implementation Concepts

The following terms are implementation-specific and SHALL NOT be used as architectural abstractions.

Examples:

- OPFS
- IndexedDB
- Chrome
- Firefox
- SQLite
- Ollama
- OpenAI
- Gemini

These belong only in implementation-specific specifications.

---

# 13. Reserved Terms

The following terms have specific architectural meanings and SHALL NOT be repurposed:

- Vault
- Bundle
- Object
- Projection
- Runtime
- Host
- Service
- Driver
- Snapshot
- Recovery Plan
- Capability
- Provider
- Manifest
- Job
- Vault Generation
- Vault Vacuum

---

# References

All specifications.
