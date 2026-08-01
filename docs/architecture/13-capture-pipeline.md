# Capture Pipeline Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/06-bundle-format.md`
- `docs/specifications/runtime/capture.md`

# Purpose

Capture observes external state, constructs one immutable Bundle in trusted Prepared Data, and
admits it through a signed Event. Source-specific adapters never own Vault semantics.

# Adapter boundary

Browser tabs, files, scanners, cameras, email, and future sources expose capabilities and a bounded
observation result. The Runtime normalizes provenance, constructs typed Artifacts, encrypts them,
validates the graph, routes the Collection, and authors Bundle Registered.

# Base browser flow

The web adapter freezes rendered state as closely as browser APIs allow, collects live non-file
form state, accessible frames, permitted resources, and explicit omissions, then produces the
mandatory inert page snapshot. Screenshot, thumbnail, structured content, and text are optional
Artifacts from that observation.

# Transaction boundary

All mandatory Objects and wrappers are complete before the Event. The final local commit promotes
the graph, Event, Replica Safety State, and workflow outcome atomically. A changed Frontier causes
revalidation and re-signing; it does not rerun external acquisition unless the Capture itself
failed.

# Availability and fences

Network partition does not block local Capture. Organization conflict does not block it either; an
ambiguous Collection route creates a fresh Collection. A security write fence may leave the
verified result visibly pending for later commit, recovery, Fork, or Export.

# Security

External content is adversarial. Scripts do not execute from preserved output; active URLs and
forms are inert; credentials and local file bodies are excluded; size, origin, redirect, timeout,
and memory limits are mandatory.

# References

- `docs/specifications/bundle/page-snapshot.md`
- `docs/specifications/vault/collection.md`
- `docs/architecture/17-extension-framework.md`
