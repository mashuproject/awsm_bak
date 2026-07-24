# Artifact Specification

**Document:** `specifications/bundle/artifact.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `bundle.md`
- `manifest.md`
- `../crypto/object-encryption.md`

---

# 1. Purpose

An Artifact is an immutable authoritative payload referenced by a Bundle Descriptor. Every Artifact
is independently identifiable, encrypted, stored, streamed, and verifiable.

# 2. Canonical Initial Roles

| Role                 | Kind                 | MIME type                           | Requirement |
| -------------------- | -------------------- | ----------------------------------- | ----------- |
| `PRIMARY`            | `CAPTURE`            | `application/vnd.awsm.web-page+zip` | mandatory   |
| `SCREENSHOT_FULL`    | `IMAGE`              | `image/webp`                        | best effort |
| `THUMBNAIL`          | `IMAGE`              | `image/webp`                        | best effort |
| `TEXT_EXTRACTED`     | `TEXT`               | `text/plain;charset=utf-8`          | best effort |
| `CONTENT_STRUCTURED` | `STRUCTURED_CONTENT` | `application/cbor-seq`              | best effort |

Readers SHALL reject any other Kind, Role, or Role/MIME pairing in the initial format. Roles SHALL
be unique within a Bundle.

# 3. Artifact Reference

Each descriptor Artifact reference SHALL contain only:

- `artifactVersion: 1`;
- `artifactObjectId`, a fresh canonical UUID that is also the Artifact identifier;
- Kind, Role, and exact MIME type;
- canonical acquisition timestamp;
- safe non-negative plaintext byte length;
- checksum algorithm `hash:sha256:v1`; and
- the exact 32-byte plaintext SHA-256 checksum.

References SHALL be sorted by Artifact Object ID. They SHALL NOT contain filenames, storage paths,
wrapper lengths, wrapper checksums, compression settings, or local availability state.

# 4. Artifact Object and Wrapper

The authoritative IndexedDB Object record binds the Artifact Object ID to `objectType: Artifact`
and the immutable wrapper byte length and SHA-256 checksum. It contains no plaintext payload and no
local path. The Artifact Store derives a Vault-scoped path from validated UUIDs.

The wrapper uses the chunked Artifact encryption format in the Object Encryption Specification.
Readers SHALL authenticate every frame and verify final plaintext length/checksum plus wrapper
length/checksum before exposing successful completion. A missing, truncated, corrupt, or
checksum-mismatched referenced wrapper is corruption, not an optional or unavailable Artifact.

For a synchronized Vault, a device MAY intentionally omit a `PRIMARY` or `SCREENSHOT_FULL` wrapper
only when its separate local storage contract records the Artifact as remote-only after exact active
server proof. In that state, the reference and Object record remain present and immutable. Readers
MUST route through the Runtime resolver, which retrieves and verifies the exact wrapper; unexplained
absence remains corruption. `THUMBNAIL`, `TEXT_EXTRACTED`, and `CONTENT_STRUCTURED` wrappers are not
eligible for manual storage relief.

# 5. Structured and Text Artifacts

`CONTENT_STRUCTURED` is a canonical CBOR sequence with one versioned header followed by ordered
semantic blocks. The initial block union is Heading, Paragraph, Quote, ListItem, Preformatted, and
Table. Links SHALL be canonical absolute HTTP(S) URLs. Unknown fields and block variants are
rejected.

`TEXT_EXTRACTED` is deterministic NFC UTF-8 text derived from the same ordered block stream. Empty
structured content may produce an empty text Artifact. Text and structured Artifacts are compact
and SHALL NOT be intentionally omitted from a Selective package.

# 6. Invariants

- Artifact identifiers are globally unique canonical UUIDs, never Bundle-local sequence labels.
- Equal payloads are not deduplicated and do not reuse identifiers.
- Artifact bytes never mutate in place.
- Derived Artifacts never replace preserved Artifacts.
- The coordination boundary never receives plaintext checksums or semantic metadata outside opaque
  encrypted Objects.

# References

- `bundle.md`
- `manifest.md`
- `page-snapshot.md`
- `../crypto/object-encryption.md`
- `../runtime/capture.md`
