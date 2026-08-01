# Processing Pipeline Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/10-projection-engine.md`
- `docs/specifications/runtime/jobs.md`

# Purpose

Processing derives local results from authenticated Vault content through bounded, durable Jobs.
OCR, embeddings, summaries, previews, classification, and future processors share this execution
shape without automatically becoming Vault authority.

# Flow

```text
authenticated source Object
  -> capability and policy check
  -> bounded plaintext processor
  -> Prepared Data
  -> local Materialization
     or explicit typed Vault-content preservation
```

Jobs bind exact source identity, processor key and revision, model or tool integrity, parameters,
and output codec. Retry consumes the same immutable input. Superseded results remain independently
verifiable until ordinary local cleanup.

# Authority boundary

A processor may write disposable Materializations directly through its owning Job transaction. It
cannot append a portable Event or Derived Artifact on its own. Shared preservation requires an
explicit Command, active Client Credential, Content Event, Required Feature, exact provenance, and
Baseline/reachability rules.

# Local and remote providers

Local providers retain plaintext inside the Client. Remote providers are explicit privacy
exceptions with exact origin permission, disclosure, credential protection, bounded inputs, and no
silent fallback. Provider output is untrusted until validated against the requested codec and
limits.

# Scheduling

Processing can pause for selected Vault, keys, battery, resource budget, model availability,
permission, or network. Scheduling is installation policy and requires no central Host. A headless
Client may expose processor Commands through its own API credentials.

# Evolution

New local-only processors add Managed Resource, Job, and Materialization namespaces. A new shared
authoritative output adds a Required Vault Feature; unknown clients do not guess its semantics.

# References

- `docs/specifications/runtime/ai.md`
- `docs/specifications/runtime/search.md`
- `docs/specifications/runtime/storage.md`
