# Bundle Specification

**Document:** `docs/specifications/bundle/bundle.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/bundle/manifest.md`
- `docs/specifications/bundle/artifact.md`
- `docs/specifications/storage/object-store.md`

# 1. Purpose

A Bundle is one immutable Capture identity and its authoritative Object graph. It is not a
container file. A Bundle Descriptor identifies one generated Bundle ID and references every
Artifact Object successfully preserved by that Capture.

# 2. Graph

```text
Bundle ID
  -> Bundle Descriptor Object
       -> Artifact Object(s)
            -> independently streamable encrypted wrapper
```

The Bundle ID is a stable generated entity ID. The Descriptor and Artifact IDs are protected
content digests. Re-encryption, storage relocation, hydration, and wrapper framing never replace
the Bundle ID.

# 3. Registration

The trusted Runtime fully prepares and verifies the Descriptor, Artifact Objects, mandatory
wrappers, and exact typed dependency closure before authoring Bundle Registered. That Event admits
the logical graph atomically while Replica Safety State atomically records each verified wrapper
representation. A mandatory acquisition failure produces no Event. An optional failure is an
authenticated Descriptor warning and absence, not an incomplete reference.

Bundle Registered directly depends on the Descriptor. The Descriptor's typed references reach the
Artifact Objects; Replica Safety State resolves their randomized wrappers. An Event does not
flatten the Object closure into redundant dependencies.

# 4. Immutability and lifecycle

Neither a Bundle nor any Object in its graph mutates. Delete, restore, Collection assignment,
Folder placement, Tags, Notes, search, and derived representations are Event-derived or local
state. A new capture of the same URL is a distinct Bundle.

# 5. Portability

Complete Export includes every reachable Descriptor, Artifact Object, and wrapper. Selective
Export follows its explicit closure contract. A package is a transfer artifact, not the canonical
Bundle representation. No filename, path, Host, Account, or Remote carries Bundle meaning.

# 6. Invariants

- One Bundle has one stable Bundle ID and one accepted Descriptor.
- Artifact payload bytes never live inside the Descriptor.
- Every accepted graph has complete authenticated mandatory dependencies.
- A missing expected local wrapper is unavailable or corrupt local state, not Bundle mutation.
- Derived Artifacts never silently replace preserved Artifacts.

# References

- `docs/specifications/event/event.md`
- `docs/specifications/vault/collection.md`
- `docs/specifications/portability/import-export.md`
