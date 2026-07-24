# Architecture Consistency Review

**Document:** `docs/architecture/consistency-review.md`

**Status:** Review Record

**Reviewed Against:** `docs/plans/02-chrome-extension-capture-vertical-slice.md`

**Last Updated:** 2026-07-18

---

# 1. Executive Summary

The architecture now consistently treats the Runtime as the application, Hosts as platform integrations, Services as owners of business logic, and the Runtime Job Framework as the execution mechanism for long-running work.

The most important correction was clarifying the authoritative model: immutable Objects are the authoritative persistence records, while Bundles, Event Log Segments, Wrapped Keys, and Vault Metadata are Object Types with semantics defined by their specifications. Registries, stores, Projections, Search Materializations, and UI views are derived or operational views over those Objects.

The review also separated Backup from Import/Export, added Capture capability preflight, normalized Search Index terminology into Search Projection Materializations, and documented Job-based execution for Synchronization, Import, Export, Backup, and Restore.

---

# 2. Global Terminology Changes

| Older wording                            | Current wording                                      | Reason                                                                       |
| ---------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Search Index                             | Search Projection Materialization                    | Search owns no authoritative data; indexes are rebuildable materializations. |
| Capture workflow                         | Capture Job pipeline                                 | Capture is long-running work owned by the Runtime Job Framework.             |
| Upload/download synchronization          | Synchronization reconciliation                       | Synchronization converges replicas through Work Items and checkpoints.       |
| Backup as export package                 | Snapshot-based Backup Set                            | Backup creates recovery points; Export creates interchange packages.         |
| Bundle/Event as only authoritative state | Authoritative Objects with Bundle/Event Object Types | Matches Object Store authority while preserving Bundle/Event semantics.      |

---

# 3. Cross-Document Inconsistencies Resolved

## 3.1 Authoritative Object Model

**Document:** `docs/specifications/vault/vault.md`

**Section:** Vault Contents and Authoritative State

**Existing text:** The authoritative state of a Vault consisted exclusively of immutable Bundles and immutable Events.

**Conflict:** The current architecture says Objects are immutable and authoritative. Treating Bundles and Events as the only authoritative layer bypassed the Object Store abstraction.

**Replacement:** Vault authoritative state consists of immutable Objects whose Object Types include
Bundle Descriptor Objects, Artifact Objects, Event Log Segment Objects, Wrapped Key Objects, and
Vault Metadata Objects.

**Ripple effects:** Bundle Registry and Event Store are now logical views over authoritative Objects. Search Projection, Device Registry, Trust Registry, and Synchronization State are derived or operational.

**Other documents updated:** `docs/specifications/storage/object-store.md`, `docs/specifications/portability/backup.md`, `docs/specifications/portability/import-export.md`, `docs/specifications/portability/restore.md`.

---

## 3.2 Search Index as Architectural Concept

**Document:** `docs/specifications/runtime/search.md`

**Section:** Architecture, Projection Materializations, Rebuild, Encryption

**Existing text:** Search used “indexes” as the main architectural object.

**Conflict:** The current architecture prefers Projection and Materialization for rebuildable derived state. Search should query projections and not own authoritative data.

**Replacement:** Search docs now describe Search Projection Materializations. Search executes queries; Projection Builders maintain Materializations.

**Ripple effects:** Vault no longer lists Search Index as a top-level Vault component. It lists Search Projection.

**Other documents updated:** `docs/specifications/vault/vault.md`, `docs/specifications/runtime/ai.md`, `docs/architecture/01-system-overview.md`, `docs/architecture/05-client-runtime.md`, `docs/architecture/11-search.md`.

---

## 3.3 Missing Capture Capability Preflight

**Document:** `docs/specifications/runtime/capture.md`

**Section:** Capture Pipeline

**Existing text:** The pipeline began with permission validation and then froze page state.

**Conflict:** Capture must begin with capability/preflight so the Runtime can adapt to Host capabilities and Capture Profiles.

**Replacement:** The Capture Pipeline now includes capability preflight after permission validation and before page freeze.

**Ripple effects:** Capture Profiles now define mandatory Host capabilities as well as required Artifacts. Invariants now require preflight before Bundle generation.

**Other documents updated:** None required beyond Capture Service Specification.

---

## 3.4 Long-Running Work Outside the Job Framework

**Document:** `docs/specifications/runtime/synchronization.md`

**Section:** Synchronization Job Lifecycle, Retry, Recovery

**Existing text:** Synchronization owned checkpoints, retries, and recovery directly.

**Conflict:** The Runtime Job Framework owns scheduling, persistence, retries, cancellation, and recovery for long-running work.

**Replacement:** Synchronization now defines Work Items and reconciliation behavior, while execution runs as a Synchronization Job. Checkpoints and retries are persisted/scheduled through the Job Framework.

**Ripple effects:** Job types now include Backup Job and Restore Job, and job dependencies are explicitly DAG-ready.

**Other documents updated:** `docs/specifications/runtime/jobs.md`, `docs/specifications/portability/import-export.md`, `docs/specifications/portability/backup.md`, `docs/specifications/portability/restore.md`, `docs/architecture/05-client-runtime.md`.

---

## 3.5 Backup Duplicated Import/Export

**Document:** `docs/specifications/portability/backup.md`

**Section:** Entire document

**Existing text:** Backup duplicated the Import and Export Specification.

**Conflict:** Backup is not Export. Backup creates recovery points and is Snapshot-based.

**Replacement:** Backup is now specified as Snapshot → Backup Set → Recovery Plan → Restore, executed as a Backup Job.

**Ripple effects:** Restore consumes Backup Sets and constructs Recovery Plans. Import/Export remains the public interchange format.

**Other documents updated:** `docs/specifications/portability/restore.md`, `docs/specifications/portability/import-export.md`, `docs/specifications/runtime/jobs.md`, `docs/architecture/20-deployment-and-operations.md`.

---

## 3.6 AI Projection Ownership

**Document:** `docs/specifications/runtime/ai.md`

**Section:** Responsibilities, Projection Integration

**Existing text:** AI could be read as interacting with search indexes.

**Conflict:** AI must not update search, Bundles, or Projections directly.

**Replacement:** AI produces Derived Artifacts and Runtime Events. Projection Builders consume AI completion events and update Search Projection Materializations.

**Ripple effects:** Search terminology is now consistent with Projection Builder ownership.

**Other documents updated:** `docs/specifications/runtime/search.md`.

---

# 4. Architectural Refactoring Recommendations

1. Treat the Object Store as the persistence root. Domain-specific specs define Object Type semantics.
2. Keep all long-running workflows behind Runtime Jobs, including import/export, backup/restore, sync, capture, AI, projection rebuild, and garbage collection.
3. Use Projection for logical derived state and Materialization for storage/index implementations.
4. Keep Capture Profiles versioned and capability-aware so Hosts can vary without changing Runtime business logic.
5. Keep Backup, Restore, Import, and Export separate: Backup is recovery; Export is interchange; Restore is idempotent recovery; Import is package ingestion.

---

# 5. Updated Dependency Graph

```text
Design Principles
↓
Glossary
↓
Core Identifiers ── Object Store ── Crypto
↓                  ↓               ↓
Vault ─────────────┴──── Bundle ─── Event
↓                         ↓         ↓
Runtime ─ Jobs ─ Storage ─ Capture ─ Synchronization
↓        ↓       ↓         ↓         ↓
Search   AI      Backup    Import/Export    Protocol
↓        ↓       ↓
Projection Materializations
↓
Restore
```

The graph is intentionally layered: Hosts integrate platforms; Runtime Services own behavior; Storage Drivers adapt persistence; Protocol transports synchronize opaque authoritative Objects and Events.

---

# 6. Documents Requiring Revision, Ordered by Priority

Completed in this review:

1. `docs/specifications/vault/vault.md`
2. `docs/specifications/storage/object-store.md`
3. `docs/specifications/runtime/capture.md`
4. `docs/specifications/runtime/synchronization.md`
5. `docs/specifications/runtime/jobs.md`
6. `docs/specifications/runtime/search.md`
7. `docs/specifications/runtime/ai.md`
8. `docs/specifications/portability/backup.md`
9. `docs/specifications/portability/import-export.md`
10. `docs/specifications/portability/restore.md`
11. `docs/architecture/01-system-overview.md`
12. `docs/architecture/05-client-runtime.md`
13. `docs/architecture/11-search.md`
14. `docs/architecture/20-deployment-and-operations.md`

Recommended next review pass, but not required before MVP implementation starts:

1. `docs/architecture/10-projection-engine.md` - verify Projection Builder wording against Search Projection Materialization terminology.
2. `docs/architecture/12-processing-pipeline.md` - verify AI artifact Events and Projection ownership against the runtime AI specification.

---

# 7. Remaining Unresolved Architectural Questions

The following questions remain intentionally unresolved and are outside the first MVP slice:

1. What is the minimum Restore flow required for MVP second-device recovery?
2. Which Backup retention policy should exist in MVP, if any?
3. How much operational metadata leakage is acceptable for synchronization routing?

The following current decisions are resolved by the approved Capture plans:

1. The synchronized Vault Event is `BundleRegistered`.
2. The first Capture Profile is `WebPageSnapshot-v1`: the canonical page snapshot is mandatory and
   a lossy full-page WebP preview is best effort.
3. Chrome implements Phase A; the Linux Firefox Host implements local-first and permission-gated
   synchronization parity, while signed-XPI proof and distribution remain a separate Roadmap
   initiative.
4. Bundle serialization is deterministic ZIP with canonical CBOR.
5. The initial browser Storage Driver is IndexedDB.
6. Bundle, Event, and Projection keys are context-derived with HKDF-SHA256.
7. Interrupted live page acquisition fails safely and requires manual retry.

---

# 8. Start Readiness

The architecture is ready to start the first MVP slice if that slice is scoped to:

```text
Host capability preflight
↓
Capture Job
↓
Capture Result
↓
Bundle Descriptor and Artifact Objects
↓
Local Object Store
↓
BundleRegistered Vault Event
↓
Library Projection Materialization
```

Synchronization, multi-device Restore, remote Backup, and AI can be added after this slice using the same Runtime Job and authoritative Object model.

---

# 9. Deleted Captures and Vault History Rewrite Reconciliation

Plan section 15 replaces the pre-release `LibraryGroupRemoved` model. The canonical lifecycle uses explicit Bundle-ID Commands, encrypted `CapturesDeleted`/`CapturesRestored` Events, Active/Deleted Library Projection state, encrypted Vault Generation manifests, and explicit Vault Vacuum.

The owning formal contract is `docs/specifications/vault/vacuum.md`; intent and trade-offs are in `docs/architecture/21-vault-history-rewrite.md`. Vault, Event, Object Store, Runtime Storage/Jobs/Synchronization, protocol errors, Backup, Restore, content storage, glossary, and testing strategy now share the same reachability and generation-fencing model.

The browser slice implements local generation activation and collection with one IndexedDB
transaction. The Coordination Server now separately proves opaque remote Generation activation,
recovery retention, and purge through independent HTTP/Cable replicas. Trusted Runtime integration
remains deferred. Vacuum and remote purge explicitly exclude old Backup Sets, exports, offline
replicas, and already transferred copies and are not Secure Scrub.

# 10. Collection Management Reconciliation

Plan section 16 replaces transient URL-only UI grouping with stable, Event-backed Collection identities. The canonical model assigns a Collection ID in `BundleRegistered`, routes only exact fragmentless URL matches automatically, and records user-directed Merge, Move, Extract, and Undo through `CollectionsMerged`, `CapturesMoved`, and `CollectionMergeReverted`.

The owning formal contract is `docs/specifications/vault/collection.md`. The glossary, Event and Command specifications, Runtime capture contract, Event model, Projection engine, Vault Vacuum, history-rewrite architecture, and testing strategy now share its assignment, redirect, atomicity, replay, and Vacuum semantics. Collection Materializations remain encrypted and rebuildable; immutable Captures and accepted Events are never edited.
