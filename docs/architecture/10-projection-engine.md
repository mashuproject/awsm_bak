# Projection Engine Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/09-event-model.md`
- `docs/specifications/event/reducers.md`

# Purpose

A Projection is a deterministic view derived from one authenticated Baseline plus accepted Events
and Objects. A Materialization is a disposable stored implementation of such a view.

# Replay

The engine verifies Required Features and the Continuity Proof, reads the Baseline checkpoint,
topologically traverses the current Record DAG, and applies family reducers. Authority and lifecycle
reduce over signed Authority Parents; Content reduces over causal ancestry. Where siblings are
concurrent, the exact reducer class determines composition, deterministic scalar selection, or
Conflict creation.

# Core projections

- Authority State and scoped write fences;
- Library of active and deleted Captures and effective Collections;
- Capture Timeline: causal order first, then signed `capturedAt` for concurrent presentation, then
  Record ID as the stable final tie-breaker;
- Folder tree and Unfiled view;
- Tag redirects and observed-remove assignments;
- Note revision and conflict state;
- Vault label and Credential labels;
- Search corpus and indexes.

Authority State and Baseline checkpoints are portable semantics. Stored rows for their convenient
querying are still Materializations and cannot become a second source of truth.

Local wrapper availability and Remote resolution come from Replica Safety State. A view may join
them with a Projection for presentation, but the safety records are not disposable
Materializations and replaying Vault Events alone cannot reconstruct physical availability.

# Atomicity and rebuild

An Event commit may update projections in the same transaction or enqueue replay from an exact
Frontier. A crash exposes either the prior valid Materialization or a complete successor. Corrupt,
unknown, or stale Materializations are discarded and rebuilt.

# Vacuum

Vacuum encodes complete current portable state into a new authoritative Baseline. Adoption drops
or invalidates every predecessor-Generation Materialization while retaining the Continuity Proof.
Search and other algorithm-dependent indexes rebuild rather than being flattened into the Baseline.

# Historical views

The engine can derive state at any fully authenticated available Frontier. Viewing old state never
moves the writable pointer backward; new work still appends to the current accepted Frontier.

# References

- `docs/specifications/vault/collection.md`
- `docs/specifications/vault/vacuum.md`
- `docs/architecture/11-search.md`
