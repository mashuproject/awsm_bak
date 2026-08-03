# ARCHITECTURE DOCUMENTATION

## OVERVIEW

This directory explains system intent, trust boundaries, component responsibilities, and trade-offs; only `00-design-principles.md` and `glossary.md` are marked Normative.

## STRUCTURE

| Area               | Documents                | Purpose                                                         |
| ------------------ | ------------------------ | --------------------------------------------------------------- |
| Foundations        | `00`-`04`, `glossary.md` | Principles, system/domain model, zero knowledge, security       |
| Client data model  | `05`-`10`                | Runtime, Bundles, storage, synchronization, Events, Projections |
| Features           | `11`-`14`                | Search, processing, capture, credential trust                   |
| Service boundaries | `15`-`18`                | Coordination server, protocol, extensions, cryptography         |
| Assurance          | `19`-`20`                | Testing and deployment/operations                               |

## WHERE TO LOOK

| Task                               | Location                                                                              | Notes                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Make an architectural decision     | `00-design-principles.md`                                                             | Apply its decision checklist first                    |
| Name a concept                     | `glossary.md`                                                                         | Canonical spelling and meaning                        |
| Place a component                  | `01-system-overview.md`, `02-domain-model.md`                                         | Domain model yields to glossary/specs on conflict     |
| Check privacy boundaries           | `03-zero-knowledge.md`, `04-security-model.md`, `18-cryptography.md`                  | Client owns plaintext; server coordinates opaque data |
| Change client behavior             | `05-client-runtime.md`                                                                | Host integrates; Runtime owns business logic          |
| Change authoritative/derived state | `07-content-storage.md`, `09-event-model.md`, `10-projection-engine.md`               | Reconcile with Object Store and Vault specs           |
| Change network behavior            | `08-synchronization.md`, `15-coordination-server.md`, `16-opaque-replica-protocol.md` | Protocol semantics remain transport-independent       |

## CONVENTIONS

- Keep numbered documents layered: foundations before runtime/storage, then features/services, then testing and operations.
- State responsibilities and invariants independently of frameworks; name concrete technologies only as reference implementations or adapters.
- Use `Depends On` metadata when a document relies on another, but inspect paths manually because existing forms are inconsistent.
- Describe authoritative persistence as immutable Vault Records and Vault Objects with typed
  dependencies; distinguish protected logical IDs from opaque storage IDs.
- Long-running capture, synchronization, AI, projection rebuild, import/export, backup/restore, and garbage collection execute through Runtime Jobs.
- Search queries operate over rebuildable Search Materializations derived from authenticated Vault
  Records and Objects.

## ANTI-PATTERNS

- Do not let draft architecture override the normative glossary or an owning formal specification.
- Do not introduce platform or vendor names as core concepts.
- Do not collapse Host, Runtime, Service, Driver, Projection, and Materialization boundaries.
- Do not describe mutable state, caches, registries, or server replicas as the source of Vault truth.

## RECONCILIATION STATUS

Keep every architecture document current. Reconcile affected documents in the same change when
the canonical direction changes; do not add a separate audit or implementation-impact document as
a substitute for updating the owning architecture and specification.
