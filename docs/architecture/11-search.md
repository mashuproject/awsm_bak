# Search Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/10-projection-engine.md`
- `docs/specifications/runtime/search.md`

# Purpose

Search is a private local Projection that helps a person find Captures, Collections, Tags, and
Notes. It is not synchronized Vault state.

# Pipeline

```text
authenticated Vault corpus
  -> normalized passages and fields
  -> keyword Materialization
  -> optional semantic Materialization
  -> filters, ranking, snippets
```

Each Materialization is bound to the Vault Generation, corpus Frontier, included content domains,
tokenizer, model, vector, quantization, and ranking revisions. A changed algorithm builds a new
index and discards the old after validation; no search-schema migration is required.

# Coverage

Local indexing uses already available authenticated content. An On-demand Replica need not hydrate
every heavy wrapper merely to claim full search. The interface reports understood eligible,
indexed, unavailable, and failed coverage honestly.

# Keyword and semantic search

Keyword search is always local and available without a model. Semantic search is optional. A
downloaded local model is integrity-pinned and works offline. A remote provider requires explicit
permission and disclosure because submitted passages and queries leave the zero-knowledge client
boundary.

# Vacuum and synchronization

New Events incrementally reconcile the corpus when supported. Vacuum Adoption invalidates every
predecessor index and rebuilds from the successor Baseline. Search output never affects Record
reduction, reachability, or Vacuum inclusion.

# Preserved generated content

Embeddings, OCR, summaries, and other processor output remain local Materializations unless an
explicit user operation and Required Feature preserve them as typed Vault content. Search does not
make that choice implicitly.

# References

- `docs/specifications/runtime/search.md`
- `docs/specifications/runtime/ai.md`
- `docs/plans/18-hybrid-local-first-search.md`
