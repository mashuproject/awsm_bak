# Search Architecture

**Document:** `architecture/11-search.md`

**Status:** Draft

**Owner:** Engineering

**Depends On:** `architecture/03-zero-knowledge.md`, `architecture/09-event-model.md`,
`architecture/10-projection-engine.md`, `architecture/13-capture-pipeline.md`,
`specifications/runtime/search.md`

---

# Purpose

Search is a private, local-first Projection that helps a user find a Capture and its best matching
passage. It combines deterministic keyword retrieval with optional semantic retrieval in one
ranked list.

The Coordination Server never indexes or searches user content. Search settings, queries,
Materializations, vectors, rankings, snippets, cursors, and model configuration remain on the
trusted client and never synchronize.

# Product Boundary

The current Search experience provides:

- a persistent Search field in the Library;
- explicit query submission;
- Capture results with the best matching passage;
- exact-title, exact-URL, quoted-phrase, keyword, and optional semantic relevance;
- Host, captured-date, and Collection filters;
- Active or Deleted scope inherited from the current Library section;
- 50-result pages followed by **Load more**;
- passage focus when a result opens in Capture detail; and
- useful keyword Search while semantic Search is unconfigured, incomplete, offline, or
  unavailable.

The current Projection indexes title, canonical and known URLs, Host, Collection title, captured
date, and preserved text from `CONTENT_STRUCTURED` with `TEXT_EXTRACTED` fallback. It does not index
notes, tags, summaries, OCR, images, audio, video, arbitrary local models, or plugin providers.

Search performs retrieval only. It does not generate answers, summaries, citations, or prose.

# Ownership and Data Flow

Authoritative Objects, Events, Bundles, and source Artifacts remain unchanged. Projection Builders
derive deterministic Search documents and passages from authenticated source state:

```text
Objects and Events
        |
        v
CONTENT_STRUCTURED, with TEXT_EXTRACTED fallback
        |
        v
Search document and deterministic passages
        |
        +----> encrypted keyword Materialization
        |
        +----> explicit embedding provider
                    |
                    v
             encrypted vectors and centroids
```

At query time, the Search Coordinator opens only the required local Materializations, dispatches
keyword and optional semantic retrieval, applies filters, fuses rankings, deduplicates Captures,
selects the best passage, and creates a memory-only paging session. Search does not reconstruct
Bundles during ranking.

Providers accept bounded inputs and return candidates or embeddings. They never consume Events,
write Materializations, decide persistence, or mutate authoritative state.

# Search Documents and Passages

The Search document builder produces identical output for identical authenticated source inputs.
It normalizes searchable fields, preserves source order, and assigns stable passage identifiers.
Passages are bounded and overlap only as specified by the Search Runtime contract.

`CONTENT_STRUCTURED` is preferred because its ordered semantic blocks preserve useful passage
boundaries. `TEXT_EXTRACTED` is the fallback. Missing optional extraction reduces coverage without
invalidating a mandatory `PRIMARY` representation.

# Keyword Retrieval

Keyword Search is always available after keyword indexing and requires no semantic provider or
network access.

The keyword Materialization stores an encrypted term dictionary, document frequencies, postings,
field lengths, and the source data needed to return a best passage. Ranking uses field-weighted
BM25F with deterministic ties. Exact title, canonical URL, and balanced quoted-phrase matches form
deterministic tiers before ordinary fused relevance.

The current tokenizer does not perform stemming, fuzzy correction, prefix matching, or
search-as-you-type.

# Semantic Retrieval

Semantic Search is optional and is not configured by default. One provider identity is active per
Vault, and vectors created by different provider identities are never mixed.

The default setup choice is an English-first, 384-dimensional
`Xenova/all-MiniLM-L6-v2` profile pinned by immutable revision. The model runs with CPU/WASM for
Chrome and Firefox parity and downloads only after explicit user action. Verified model files are
cached locally; inference makes no later network request.

An advanced remote adapter implements the narrow OpenAI-compatible embedding contract. It uses
repository-owned `fetch`, not a provider SDK. A remote endpoint may receive plaintext passages and
queries only after the user:

1. configures the exact HTTPS endpoint and model;
2. accepts the disclosure for the active Vault; and
3. grants the exact endpoint Host permission.

There is no automatic local-to-remote or remote-to-local fallback.

Passage embeddings and per-Capture centroids are normalized, quantized to signed int8 values, and
encrypted before persistence. A Capture contributes to semantic coverage only after all of its
semantic Materializations commit atomically.

# Hybrid Ranking

The Coordinator combines keyword and semantic ranks with deterministic reciprocal-rank fusion.
Exact-match tiers remain ahead of the ordinary fused tier and are not duplicated. Filters are
applied consistently, and deterministic identifiers break remaining ties.

Semantic coverage may be partial. The Library exposes exact completed and eligible Capture counts.
Partial semantic coverage never disables keyword results.

# Index Lifecycle

Indexing is an incremental, restart-safe per-Vault Job with per-Capture checkpoints and a durable
lease. It runs only while the expected Vault is active and unlocked and a Library surface is
connected and visible. Local-model readiness, remote permission, and remote connectivity add
provider-specific gates.

Closing or hiding the Library, locking, switching Vaults, losing provider permission, going
offline, pausing, or restarting the background worker releases the lease into an exact durable
wait state. Resume continues the same generation from pending or failed checkpoints. A change to
the authenticated authoritative Vault generation starts a fresh Search generation, including
after a worker restart.

Keyword and semantic commits are atomic per Capture. A failed Capture records a stable,
non-sensitive error identifier on its exact checkpoint. Transient provider unavailability gains a
bounded retry deadline; explicit user action may retry sooner.

# Privacy and Persistence

All Search Materializations use Projection-domain encryption. IndexedDB contains no plaintext
titles, URLs, passages, tokens, term dictionaries, document frequencies, vectors, centroids, or
remote configuration.

The remote API key is wrapped by a non-exportable device-local key. Search queries, snippets,
result sets, rankings, cursors, highlights, and passage selections exist only in memory and never
enter URLs, logs, diagnostics, synchronization, Export, Import, or backup packages.

Lock, Vault switch, reset, permission revocation, and background restart clear plaintext Search
buffers and invalidate active cursors. Every request is bound to `expectedVaultId`; results from
different Vaults cannot be combined.

# Result Navigation

A result carries only memory-bound identifiers into Capture detail. The Runtime re-authenticates
the authoritative source and rebuilds the selected passage before focus. Detail displays a labeled,
keyboard-focusable **Search match** treatment and scrolls it into view while honoring reduced
motion.

If the passage is stale, Capture detail still opens, announces that the exact passage changed,
clears the selection, and requests a Search rebuild. Query text and passage text never enter the
URL.

# Rebuilding and Portability

Search Projection Materializations are disposable:

```text
Delete Search Projection
        |
        v
Replay authenticated authoritative state
        |
        v
Rebuild encrypted Materializations
```

Rebuild requires no server data. Search Materializations, Jobs, checkpoints, provider settings,
model references, and credentials are excluded from synchronization and portability packages.
Restore or Import rebuilds Search from authoritative content.

# Performance and Verification

The target Vault contains 10,000 Captures. Query execution uses bounded pages and avoids loading
the entire corpus into memory. Required verification covers:

- keyword latency below 100 milliseconds at p95 on the deterministic 10,000-Capture corpus;
- bounded keyword and incremental semantic memory;
- deterministic keyword and hybrid ranking;
- encrypted-at-rest and no-persistence invariants;
- indexing interruption, failure, retry, and restart behavior;
- real local MiniLM inference with network fallback disabled;
- explicit remote disclosure and permission boundaries;
- passage focus, stale passage handling, accessibility, and narrow layouts; and
- Chrome and Firefox production-build parity.

# References

- `docs/plans/18-hybrid-local-first-search.md`
- `docs/specifications/runtime/search.md`
- `docs/specifications/runtime/jobs.md`
- `docs/architecture/13-capture-pipeline.md`
- `docs/architecture/19-testing-strategy.md`
