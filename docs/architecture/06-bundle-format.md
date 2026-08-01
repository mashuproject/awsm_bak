# Bundle and Artifact Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/02-domain-model.md`
- `docs/specifications/bundle/bundle.md`

# Purpose

A Bundle is one immutable Capture identity and dependency graph, not a file format. AWSM separates
small semantic metadata from large payload transport in the spirit of Git plus Git LFS.

# Graph

```text
generated Bundle ID
  -> content-addressed Bundle Descriptor Object
       -> content-addressed Artifact Object
            -> randomized streamable encrypted wrapper
```

The Descriptor commits to intrinsic Capture provenance, profile, exact Artifact roles, and
warnings. Each Artifact Object commits to logical payload digest, byte length, representation
metadata, and wrapper contract. The heavy wrapper can be hydrated, evicted, ranged, or physically
repacked without changing the Artifact ID.

# Identity

Bundle, Collection, Folder, Tag, and Note IDs are random stable entity identities. Record and
Object IDs are domain-separated SHA-256 digests of exact canonical authenticated bytes. An Opaque
Storage Item ID identifies only one randomized outer envelope. These identities are never
interchangeable.

# Capture profile

The base web profile preserves a canonical inert page-snapshot ZIP as mandatory primary Artifact.
Full screenshot, thumbnail, structured content, and extracted text are optional typed Artifacts.
MHTML is a derived download rather than synchronized content.

# Completeness

The Runtime prepares and verifies the complete mandatory graph before Bundle Registered admits it.
Optional failures become exact Descriptor warnings; there are no dangling optional references.
Local absence after Storage Relief is availability state, not a different Bundle.

# Portability

Complete Export transports the graph and all required wrappers as entries in a larger package. The
package is not the Bundle's canonical form and never assigns semantic filenames or paths.

# References

- `docs/specifications/bundle/manifest.md`
- `docs/specifications/bundle/artifact.md`
- `docs/specifications/bundle/page-snapshot.md`
