# Search Service Specification

**Document:** `specifications/runtime/search.md`

**Version:** 1.0

**Status:** Draft

---

# 1. Purpose

The Search Service provides private hybrid keyword and semantic querying of archived content.

Search executes entirely within trusted clients.

No plaintext Search Projection Materializations are transmitted to synchronization servers.

---

# 2. Design Goals

The Search Service MUST provide:

- useful offline keyword search
- incremental materialization updates
- deterministic results
- encrypted persistence
- explicit consent before any remote plaintext processing
- reproducibility from authoritative local state

---

# 3. Architecture

```
Bundles

↓

Events

↓

Projection Builder

↓

Search Projection Materializations

↓

Search Service
```

The Search Service executes queries.

Projection Builders maintain Search Projection Materializations.

---

# 4. Responsibilities

The Search Service SHALL:

- parse queries
- execute searches
- rank results
- return matching Bundle and passage identifiers
- expose indexing coverage and lifecycle state

The Search Service SHALL NOT directly modify Projections or Materializations.

Query execution SHALL NOT modify authoritative Vault state.

---

# 5. Searchable Sources

The initial Search Projection MAY include:

- Bundle metadata
- authenticated local structured content
- authenticated local extracted text
- URLs
- titles

Remote-only body Artifacts SHALL NOT be fetched merely to build Search. A metadata-only Capture
remains keyword eligible.

OCR, AI summaries, annotations, tags, arbitrary Artifact roles, and cross-Vault sources are outside
the initial implementation.

---

# 6. Projection Materializations

The Runtime MAY maintain independent Search Projection Materializations.

The initial materializations include:

- encrypted keyword rows and statistics
- opaque keyed keyword postings
- encrypted semantic Capture centroids
- encrypted semantic passage vectors
- local-only indexing Jobs and checkpoints

Materializations SHALL be independently rebuildable.

Search settings, model references, remote protected credentials, Jobs, checkpoints, and every
Search Materialization are local-only operational state.

---

# 7. Projection Updates

Search Projection Materializations are reconciled from the authenticated authoritative Vault head.
The Runtime SHALL compare the last successfully indexed Vault generation to the active generation
and rebuild after any mismatch.

Capture completion, synchronization or Import activation, recovery or replacement, delete or
restore, Collection operations, Vacuum, epoch changes, tokenizer changes, Search schema changes,
and semantic provider identity changes SHALL trigger reconciliation.

---

# 8. Query Language

The Search Service SHALL support:

- keyword search
- balanced quoted phrases
- date filtering
- host filtering
- Collection filtering
- Active or Deleted scope
- optional hybrid semantic relevance

Tag syntax and a general query language are not part of the initial contract.

---

# 9. Ranking

Ranking SHALL apply these tiers in order:

1. exact normalized title
2. exact normalized canonical or known URL
3. required exact phrase
4. keyword relevance
5. semantic relevance
6. fused keyword and semantic relevance

Keyword ranking uses deterministic BM25F. Hybrid ranking uses deterministic reciprocal-rank
fusion. Stable Bundle and passage ordering breaks all remaining ties. Recency SHALL NOT silently
alter relevance.

Each result identifies one deterministic best passage and includes only an escaped bounded
snippet.

---

# 10. Rebuild

Search Projection Materializations SHALL be rebuildable from authoritative Objects and Events.

Search Projection Materializations are derived data.

Search Projection Materializations SHALL NOT become authoritative.

---

# 11. Encryption

Persisted Search Projection Materializations SHALL be encrypted.

Materialization persistence SHALL use the Projection Domain keys.

---

# 12. Failure Recovery

Corrupted Search Projection Materializations MAY be discarded.

The Runtime SHALL rebuild Search Projection Materializations from authoritative data.

An indexing Job SHALL use durable per-Capture checkpoints and a renewable lease. Hidden,
disconnected, locked, switched, paused, permission-revoked, or offline state SHALL abort the
current plaintext batch and yield the lease into the corresponding waiting state. Already
committed Captures remain searchable.

Provider failures SHALL persist only stable local error identifiers. Failed Capture accounting and
its checkpoint transition SHALL be atomic. Resume SHALL retry the same generation unless an
authoritative or provider identity change requires a rebuild.

---

# 13. Diagnostics

The Search Service SHOULD expose:

- materialized bundle count
- last materialization update time
- pending updates
- rebuild progress

---

# 14. Semantic Providers

Semantic Search is optional.

The default provider is a pinned English MiniLM model downloaded only after explicit user action.
Its files SHALL be verified against exact byte counts and SHA-256 digests before promotion. Local
inference SHALL remain useful offline after download and SHALL disable network fallback.

A remote OpenAI-compatible embedding endpoint MAY be configured only through an explicit
disclosure, exact optional-origin permission, user-initiated connection probe, and protected
credential commit. Only the selected Vault's bounded passages and submitted Search queries may be
sent to that exact endpoint. AWSM synchronization remains end-to-end encrypted, but remote
embedding processing is not local.

Remote credentials SHALL be encrypted with device-local non-exportable key material and excluded
from Export, Import, Backup, synchronization, diagnostics, and logs.

# 15. Future Extensions

Future Search capabilities MAY include image similarity, handwriting recognition, multilingual
normalization, and reviewed permissively licensed local model profiles.

---

# 16. Invariants

Bundles remain authoritative.

Search results come from Projections or Materializations.

Search Projection Materializations are rebuildable.

Queries never modify stored data.

Search executes locally.

Keyword Search remains available when semantic Search is disabled or unavailable.

No content crosses a remote embedding boundary without explicit opt-in.

Search rows, settings, credentials, Jobs, checkpoints, and model references never synchronize or
enter Vault packages.

Result navigation carries only Bundle and passage identifiers in process memory. Query and passage
text SHALL NOT enter the detail URL.

---

# References

runtime.md

`docs/architecture/10-projection-engine.md`

`docs/specifications/bundle/bundle.md`

`docs/specifications/crypto/key-derivation.md`
