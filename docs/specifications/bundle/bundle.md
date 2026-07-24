# Bundle Specification

**Document:** `specifications/bundle/bundle.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `artifact.md`
- `manifest.md`
- `../storage/object-store.md`

---

# 1. Purpose

A Bundle is an immutable Capture package represented by Object semantics. It is a logical graph,
not a container file: one compact Bundle Descriptor Object describes the Capture and references one
independently encrypted Artifact Object for each successfully produced payload.

# 2. Graph

Every Bundle SHALL contain exactly one Bundle Descriptor and one or more Artifact references. The
initial `WebPageSnapshot-v1` Capture Profile requires `PRIMARY` and permits `SCREENSHOT_FULL`,
`THUMBNAIL`, `TEXT_EXTRACTED`, and `CONTENT_STRUCTURED`.

The descriptor Object ID is independent of the Bundle ID. Each Artifact ID is its Object ID. All
identifiers are fresh canonical UUIDs and SHALL NOT be derived from content. Artifact references
SHALL be ordered by Artifact Object ID.

# 3. Completeness and Registration

`BundleRegistered` SHALL reference the Bundle Descriptor Object and every Artifact Object directly.
Its Object closure SHALL exactly equal the descriptor plus the descriptor's Artifact references.
The Runtime SHALL validate and atomically commit that complete closure before the Bundle becomes
visible. No incomplete Bundle may be authoritative.

Optional Artifact acquisition failure does not make the committed graph incomplete: the descriptor
omits the Artifact and `BundleRegistered` records the corresponding typed warning. `PRIMARY`
failure rejects the Capture.

# 4. Persistence and Portability

The descriptor is a compact inline encrypted Object. Artifact payloads are independently framed,
encrypted, and stored through the Artifact Store. Bundle semantics do not assign filenames or
container paths to Artifacts.

Export packages carry the descriptor Object record, Artifact Object records, and Artifact wrappers
as separate entries. Package coverage may be Complete or Selective as defined by the Import and
Export Specification. Export is not the canonical representation of a Bundle.

# 5. Validation and Invariants

Readers SHALL reject unknown fields, versions, Kinds, Roles, duplicate Object IDs, duplicate Roles,
invalid MIME contracts, closure mismatches, warning mismatches, or checksum/length failures.

- Bundles and their identifiers never mutate.
- Artifact payloads never live inside the descriptor.
- Filenames and storage paths carry no Bundle semantics.
- Checksums verify bytes but do not determine identity.
- Projections and caches are not part of the Bundle graph.

# References

- `artifact.md`
- `manifest.md`
- `page-snapshot.md`
- `../event/event.md`
- `../storage/object-store.md`
- `../portability/import-export.md`
