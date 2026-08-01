# AI Runtime Specification

**Document:** `docs/specifications/runtime/ai.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/runtime/jobs.md`
- `docs/specifications/runtime/search.md`

# 1. Purpose

The AI Runtime invokes local or explicitly authorized remote processors over authenticated Vault
content. Results are untrusted processor output until exact schema, size, provenance, and source
checks pass.

# 2. Providers and capabilities

A provider advertises exact capability keys, model and implementation identity, supported input and
output codecs, resource requirements, privacy location, and deterministic or stochastic behavior.
Summarization, OCR, embeddings, captions, extraction, classification, translation, and language
detection are examples, not implicit authoritative types.

# 3. Jobs

Every operation runs as a durable Job bound to exact source Object IDs and revisions, capability,
provider, model digest, parameter and prompt revisions, output codec, and local policy. Retries use
the same source and logical request. Cancellation and provider failure leave existing state valid.

# 4. Local Materializations

By default, validated output is a local encrypted Materialization with complete provenance. It may
feed Search or a user-facing derived view through that Materialization's owning projection. It does
not become a Vault Object or Event merely because it is useful, immutable, or expensive to
recompute.

# 5. Preserved output

A result becomes synchronized Vault content only through a separate explicit user Command and an
active Required Feature defining:

- exact Object and Event types;
- source and processor provenance;
- authorization and conflict reduction;
- Baseline codec and reachability;
- Vacuum behavior; and
- rendering and unsupported-client behavior.

The selected Client Credential signs that Event. A provider and Job cannot author it directly.

# 6. Remote provider privacy

Remote plaintext processing requires a visible provider choice, exact origin permission, explicit
disclosure of transmitted data and purpose, protected local credentials, and no silent network
fallback. Only bounded inputs needed for the selected task may be sent. Zero-knowledge Replica
storage does not make remote AI zero knowledge.

# 7. Managed Resources

Local models, OCR packs, tokenizers, and dictionaries are Managed Resources. Downloads require
user action where material, exact byte length and digest verification, license metadata, and
independent eviction. They do not synchronize or enter Complete Export.

# 8. Diagnostics

Diagnostics contain provider availability, stable error keys, duration, and safe aggregate counts.
They exclude prompts, source or result plaintext, credentials, keys, Vault identifiers, and remote
response bodies.

# 9. Invariants

- AI output never mutates a Bundle.
- Local processing is the privacy-preserving default.
- Provider output cannot bypass canonical validation.
- Search-only vectors remain disposable Materializations.
- Shared generated content requires explicit Vault semantics.

# References

- `docs/architecture/12-processing-pipeline.md`
- `docs/specifications/runtime/storage.md`
