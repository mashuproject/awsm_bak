# Search Runtime Specification

**Document:** `docs/specifications/runtime/search.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/runtime/storage.md`
- `docs/specifications/bundle/bundle.md`

# 1. Purpose

Search is a private rebuildable Projection over the authenticated Capture corpus and organization
state. Keyword and semantic indexes are Materializations, never Vault authority or synchronized
content.

# 2. Corpus

The base corpus may include authenticated Bundle metadata, URLs, titles, structured content,
extracted text, Collection state, Tags, and Notes understood by the active client. A missing heavy
wrapper is not fetched merely to make an On-demand Replica's index complete unless the user or
local policy explicitly requests hydration.

# 3. Materialization identity

Each Search Materialization identity binds at least:

- Vault ID and exact Generation ID;
- accepted content Frontier or canonical corpus revision;
- included content-domain and lifecycle policy revisions;
- Search schema, tokenizer, language normalization, and passage revisions;
- keyword scoring and ranking revisions;
- embedding model, provider, vector, and quantization revisions; and
- corpus-selection policy.

Changing any input creates a new Materialization. The Runtime builds and validates it separately,
atomically activates it, and later deletes the old one. It never migrates index rows as if they
were authoritative data.

# 4. Indexing

Indexing authenticates source Objects and Events, processes bounded plaintext batches, and commits
per-source checkpoints with index rows. Jobs may pause for Vault selection, keys, permission,
network, model, or resource limits. Interrupted plaintext work is discarded; committed rows remain
usable for their exact Materialization identity.

Vacuum Adoption invalidates every predecessor-Generation Search Materialization. Synchronization,
Capture, organization, lifecycle, or Note changes advance the corpus revision and trigger
incremental reconciliation where the identity contract permits it.

# 5. Query and ranking

The base interface supports keyword terms, balanced phrases, URL host, Capture date, Collection,
Tag, and Active/Deleted filters plus optional semantic relevance. Results identify stable Bundle,
Collection, Note, and passage identities as applicable and use escaped bounded snippets.

Keyword ranking is deterministic BM25F. Hybrid ranking uses deterministic reciprocal-rank fusion.
The exact active ranking revision and ascending stable IDs break remaining ties. Recency does not
silently override relevance.

# 6. Local and remote processing

Keyword Search remains useful entirely locally. A pinned permissively licensed local embedding
model may be downloaded only after explicit user action and exact integrity verification, then
works offline.

A remote embedding provider requires explicit disclosure, exact origin permission, a user-
initiated connection action, and protected local credentials. Only the selected Vault's bounded
passages and submitted queries may cross that boundary. This is not zero-knowledge processing, and
the interface must say so.

# 7. Persistence and privacy

Search rows, queries, model settings, credentials, Jobs, checkpoints, and indexes are local. They
do not synchronize or enter a Complete Export or Backup. Persisted plaintext is prohibited;
protected local storage uses Installation-controlled keys. Query text does not enter navigation
URLs, logs, diagnostics, or Host requests.

# 8. Derived Artifact boundary

An embedding, summary, OCR result, or other generated result becomes Vault content only through an
explicit preservation operation and Required Feature that owns its provenance and codec. Merely
using it for search does not make it a Derived Artifact.

# 9. Invariants

- Search can always be discarded and rebuilt from understood authoritative state.
- Search does not affect Event reduction or Baselines.
- A newer algorithm replaces its Materialization instead of migrating old index truth.
- No opaque Replica Host receives plaintext search data.
- Remote plaintext processing is always explicit and separately disclosed.

# References

- `docs/specifications/runtime/ai.md`
- `docs/architecture/11-search.md`
