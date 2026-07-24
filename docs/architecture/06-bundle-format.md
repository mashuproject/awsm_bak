# Bundle Graph Architecture

**Document:** `architecture/06-bundle-format.md`

**Status:** Draft

**Version:** 1.0

**Owner:** Engineering

**Depends On:**

- `architecture/02-domain-model.md`
- `architecture/04-security-model.md`
- `architecture/05-client-runtime.md`

---

# Purpose

A Bundle is the immutable logical preservation package created by one Capture. Its canonical shape
is an Object graph: one compact encrypted Bundle Descriptor references independently encrypted
Artifact Objects. It is not a directory, archive file, or monolithic byte stream.

# Lifecycle

```text
Capture acquisition
  → prepare PRIMARY and best-effort Artifact wrappers
  → validate Artifact records and checksums
  → create and encrypt Bundle Descriptor
  → prove exact Event/Object dependency closure
  → atomically register descriptor, Artifacts, Event, and Projection
```

Only a fully validated graph becomes authoritative. `PRIMARY` is mandatory. Optional failures omit
the relevant Artifact reference and create a typed warning; they never create a dangling reference.

# Descriptor and Artifacts

The descriptor contains Capture metadata plus sorted references. Each reference records a fresh
Artifact Object UUID, Kind, Role, MIME type, acquisition time, plaintext length, and SHA-256
checksum. It contains no payloads, filenames, storage paths, availability, or Export state.

The initial web Capture graph supports:

- mandatory canonical AWSM page-snapshot `PRIMARY`;
- best-effort full WebP screenshot and 640×360 WebP `THUMBNAIL`;
- best-effort canonical semantic `CONTENT_STRUCTURED`; and
- normalized UTF-8 `TEXT_EXTRACTED` derived from the same semantic stream.

Artifact wrappers use authenticated chunk framing and are stored independently. This permits
bounded-memory capture, verification, viewing, Vacuum accounting, synchronization, and Export,
including payloads beyond 4 GiB.

# Identity, Immutability, and Validation

Bundle IDs, descriptor Object IDs, and Artifact Object IDs are distinct fresh UUIDs. Hashes verify
bytes and never assign identity. Equal content is not deduplicated. Every Object and Artifact is
immutable; corrections or enrichment create additive Objects and Events.

Readers fail closed on non-canonical encoding, unknown fields or variants, invalid Role/Kind/MIME
contracts, duplicate Roles/IDs, missing mandatory content, dependency-closure mismatches, warning
mismatches, or any wrapper/plaintext integrity failure.

# Storage and Portability

Compact descriptor and Artifact records are authoritative persistence records. External encrypted
Artifact wrappers are part of their Artifact Objects; the Artifact Store owns path derivation and
streaming. Projection thumbnails and indexes remain rebuildable.

A Vault Package is an interchange container around a captured Vault Generation, not a Bundle
serialization. Complete packages contain every wrapper. Selective packages may contain
authenticated omissions only where the Import and Export Specification permits them.

# Design Consequences

- Page snapshots, screenshots, thumbnails, and text can be fetched or exported independently.
- A server or local selective replica can coordinate opaque Artifact availability without learning
  semantic content.
- Vacuum follows descriptor-to-Artifact reachability and can reclaim exact wrapper bytes.
- Structured content can feed local Search without decrypting full snapshots or screenshots.

# References

- `docs/specifications/bundle/bundle.md`
- `docs/specifications/bundle/manifest.md`
- `docs/specifications/bundle/artifact.md`
- `docs/specifications/crypto/object-encryption.md`
- `docs/specifications/portability/import-export.md`
