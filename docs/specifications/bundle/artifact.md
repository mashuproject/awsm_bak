# Artifact Specification

**Document:** `docs/specifications/bundle/artifact.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/core/serialization.md`
- `docs/specifications/crypto/object-encryption.md`
- `docs/specifications/storage/opaque-envelope.md`

# 1. Purpose

An Artifact is an immutable logical payload described by compact Vault Object type `2` and carried
by an independently streamable encrypted wrapper. Its Artifact ID is the Artifact Object ID.

# 2. Artifact Object body

```text
{
  0: 1,                    // artifactObjectFormat
  1: kind,                 // canonical scoped key
  2: mediaType,            // canonical lower-case media type
  3: representationKey,    // canonical scoped key
  4: plaintextLength,      // nonnegative integer
  5: plaintextDigest,      // 32-byte protected digest
  6: wrapperContract,      // section 3
  7: intrinsicMetadata     // exact representation-owned canonical bytes
}
```

The Required Feature Set is protected by the Vault Object envelope. The applicable Key Epoch is
bound by the encrypted representation and may change without changing the Artifact ID.
`plaintextDigest` is:

```text
SHA-256(Transcript("awsm:artifact-payload:v1", [exactPlaintextBytes]))
```

# 3. Wrapper contract

```text
{
  0: 1,       // wrapperContractFormat
  1: 1048576, // framePlaintextLimit
  2: 16,      // XChaCha20-Poly1305 tag length
  3: plaintextLength,
  4: plaintextDigest
}
```

Wrapper-contract keys 3 and 4 MUST exactly equal Artifact-body keys 4 and 5. The duplication binds
the generic streaming contract explicitly and never permits two payload claims.

The Streamable outer envelope and per-frame authentication are exact in
`docs/specifications/crypto/object-encryption.md`. Random nonces, outer padding, physical frames,
opaque item IDs, pack files, and range transport do not change the Artifact ID.

# 4. Base web Capture roles

| Role key                           | Kind key                   | Media type                          | Requirement |
| ---------------------------------- | -------------------------- | ----------------------------------- | ----------- |
| `awsm.artifact.primary`            | `awsm.artifact.capture`    | `application/vnd.awsm.web-page+zip` | mandatory   |
| `awsm.artifact.screenshot-full`    | `awsm.artifact.image`      | `image/webp`                        | optional    |
| `awsm.artifact.thumbnail`          | `awsm.artifact.image`      | `image/webp`                        | optional    |
| `awsm.artifact.text-extracted`     | `awsm.artifact.text`       | `text/plain;charset=utf-8`          | optional    |
| `awsm.artifact.content-structured` | `awsm.artifact.structured` | `application/cbor-seq`              | optional    |

The active Capture Required Feature owns accepted combinations. Unknown roles or representation
codecs fail closed rather than being guessed.

# 5. Availability and hydration

Every authoritative Artifact Object remains in the dependency graph even when its heavy wrapper is
not locally present. Protected Replica Safety State distinguishes verified local, remotely
resolvable, expected but unavailable, and corrupt. A Runtime retrieves from any configured Remote,
verifies every frame plus final digest and length, and exposes no successful result before complete
verification.

# 6. Derived Artifacts

A processor result becomes shared Vault content only through an explicit Content Event and a
Required Feature that owns its representation and provenance. Search indexes, embeddings, OCR
caches, previews, and temporary conversions remain Materializations unless explicitly preserved.

# 7. Invariants

- Equal payload bytes may still produce different Artifact IDs when authoritative metadata differs.
- Wrapper re-encryption never changes the Artifact ID.
- A wrapper cannot be trusted from its outer digest alone.
- Storage Relief changes local availability, not Vault content.
- No Artifact metadata leaks to an opaque Host.

# References

- `docs/specifications/bundle/manifest.md`
- `docs/specifications/storage/object-store.md`
- `docs/specifications/runtime/storage.md`
