# Canonical Serialization Specification

**Document:** `docs/specifications/core/serialization.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/architecture/00-design-principles.md`
- `docs/architecture/glossary.md`
- `docs/specifications/core/identifiers.md`

---

# 1. Purpose

This specification defines the one canonical semantic encoding, transcript framing, typed
dependency reference, extension container, and feature-manifest substrate used by AWSM Vault data.
It is independent of programming language, transport, database, and Host.

# 2. Canonical CBOR profile

Authoritative semantic structures MUST use deterministic CBOR as defined by RFC 8949 section 4.2.1
and the additional restrictions below.

Writers MUST emit and readers MUST require:

- definite-length byte strings, text strings, arrays, and maps;
- shortest-form integer and length encodings;
- map keys ordered by their deterministic encoded byte representation;
- no duplicate map key;
- no floating-point value;
- no CBOR tag;
- no `undefined` or simple value other than `false`, `true`, and `null` where the owning schema
  explicitly permits it;
- no trailing byte after the one complete top-level item; and
- exact field presence, type, range, and length from the owning schema.

A reader MUST reject a semantically equivalent but non-canonical representation. Canonicalization
after receipt MUST NOT turn invalid bytes into an accepted authoritative item.

Normative persisted structures use unsigned integer map keys. A schema MUST NOT change the meaning
of an assigned key. Unknown keys fail closed unless the exact field is the Advisory Extension map
defined below.

# 3. Primitive representations

| Value                         | Canonical representation                                                   |
| ----------------------------- | -------------------------------------------------------------------------- |
| Portable identifier or digest | byte string of the exact required length                                   |
| Public key                    | byte string in the owning algorithm's canonical raw encoding               |
| Signature                     | byte string in the owning algorithm's canonical raw encoding               |
| Encrypted bytes               | byte string unless the owning stream format places them outside CBOR       |
| Counter or revision           | nonnegative integer                                                        |
| Timestamp                     | signed integer milliseconds from the Unix epoch                            |
| Boolean                       | CBOR `false` or `true`                                                     |
| Optional scalar               | omitted unless the schema requires explicit `null` to distinguish clearing |
| Human-authored string         | UTF-8 text normalized to Unicode NFC before validation                     |
| Protocol or feature key       | canonical ASCII text under section 4                                       |

An asserted Event timestamp and a Capture's `capturedAt` are signed audit or provenance values.
Their integer representation does not grant them causal or authority meaning.

# 4. Canonical scoped keys

Feature keys, Advisory Extension keys, and Typed Storage Namespace keys MUST:

- contain 1 through 128 ASCII bytes;
- begin with a lower-case ASCII letter;
- contain only lower-case letters, digits, `.`, `_`, and `-`;
- end with a lower-case letter or digit;
- contain no adjacent separators and no empty dot-separated component; and
- be globally scoped by a project- or organization-controlled prefix.

AWSM-owned keys use the `awsm.` prefix. A third party SHOULD use a reverse-DNS prefix it controls.
Canonical comparison is bytewise ASCII comparison. Case folding and Unicode normalization are not
applied because non-ASCII and upper-case bytes are invalid.

# 5. Canonical sets and maps

When a schema describes a set, the encoded value MUST be an array sorted by bytewise comparison of
each element's complete canonical CBOR encoding. Duplicates are invalid. Order has no semantic
meaning beyond the canonical representation.

When a schema describes a scalar map whose keys are portable identifiers, entries MUST be encoded
as a sorted array of fixed-schema key/value tuples. A CBOR map with byte-string keys MUST NOT be
used unless the owning schema explicitly declares it, because tuple arrays make duplicate and
compound-key validation uniform.

# 6. Transcript framing

Except where a specification explicitly fixes an all-fixed-width construction, every AWSM hash,
signature prehash context, KDF context, proof, or authenticated-data transcript uses this framing:

```text
Transcript(label, parts[]) =
  ascii(label) || 0x00 ||
  uint32be(partCount) ||
  concat(uint64be(byteLength(part)) || part)
```

Requirements:

- `label` MUST be the exact lower-case ASCII label assigned by the owning specification;
- labels MUST start with `awsm:` and end with `:v1` for the sole initial construction;
- `partCount` is the number of following parts;
- lengths count bytes, not characters or CBOR items;
- every integer is unsigned big-endian with the exact stated width; and
- a transcript MUST NOT silently omit an empty part or append an undocumented part.

The `0x00` separator prevents a label from being a prefix of transcript data. Length framing
prevents ambiguous concatenation. Domain labels are public constants, not salts or nonces.

# 7. Typed dependency reference

A protected reference from a Vault Record or Object to another immutable logical item is encoded
as:

```text
{
  0: dependencyType,  // unsigned integer from the dependency registry
  1: dependencyId     // 32-byte logical identifier
}
```

The initial dependency type registry is:

| Code | Type                     |
| ---: | ------------------------ |
|    1 | Vault Record             |
|    2 | Vault Baseline           |
|    3 | Vault Object             |
|    4 | Bundle Descriptor Object |
|    5 | Artifact Object          |
|    6 | Note Content Object      |
|    7 | Key Envelope             |
|    8 | Feature Manifest         |

Codes are semantic expected types, not storage classes. A validator MUST resolve the identifier,
recompute it under the expected type's domain, and reject substitution even when the bytes are
valid under another type.

Dependency arrays are sets under section 5. A parent reference is not encoded as a Typed
Dependency Reference; the Vault Record schema owns causal parent IDs separately.

# 8. Protected storage format identifiers

The sole initial self-describing format identifiers inside the protected Vault storage substrate
are:

| Field                   | Value | Owner                                          |
| ----------------------- | ----: | ---------------------------------------------- |
| `storageEnvelopeFormat` |     1 | opaque compact and streamable envelope grammar |
| `vaultRecordFormat`     |     1 | protected Vault Record envelope grammar        |
| `vaultObjectFormat`     |     1 | protected typed Vault Object envelope grammar  |

A format number changes only when its stable envelope grammar becomes incompatible. Event types do
not carry format numbers. Semantic evolution uses Required Vault Features. Transfer Artifacts and
Host-local APIs own their separate framing outside this registry. Readers MUST NOT negotiate a
different writer format, downgrade, or recognize discarded pre-release grammars.

# 9. Vault Object envelope

Every compact authoritative Object has this canonical inner CBOR map:

```text
{
  0: 1,                    // vaultObjectFormat
  1: vaultId,              // 32 bytes
  2: objectType,           // unsigned integer from an owning specification
  3: requiredFeatureSetId, // 32 bytes
  4: body,                 // exact owning-schema CBOR value
  5: advisoryExtensions    // canonical map; empty map when none
}
```

The entire map is authenticated inner Object bytes. The Object MUST NOT contain its own Object
Identifier. Object type codes are globally unique within the Vault Object registry; a Required
Vault Feature owns any added type and its body, Baseline, reachability, and validation rules.

The base Object type registry is:

| Code | Object type         |
| ---: | ------------------- |
|    1 | Bundle Descriptor   |
|    2 | Artifact Object     |
|    3 | Note Content Object |

The Object Identifier is:

```text
SHA-256(Transcript(
  "awsm:vault-object-id:v1",
  [vaultId, uint32be(objectType), canonicalVaultObjectBytes]
))
```

Vault and type are deliberately present both in the bytes and transcript. This prevents cross-
Vault and cross-type substitution, gives a verifier exact expected inputs before trusting decoded
content, and ensures a state-only Fork receives fresh Object identities.

# 10. Feature Manifest

A Feature Manifest is encoded as:

```text
{
  0: featureKey,          // canonical scoped key
  1: revision,            // nonnegative integer
  2: parameters,          // exact byte string; empty when none
  3: requiredManifestIds, // sorted set of 32-byte IDs
  4: incompatibleKeys     // sorted set of canonical scoped keys
}
```

`featureManifestId` is:

```text
SHA-256(Transcript(
  "awsm:feature-manifest-id:v1",
  [canonicalFeatureManifestBytes]
))
```

One Required Vault Feature Set contains no more than one Manifest for a `featureKey`. Its canonical
representation is the sorted duplicate-free array of complete canonical Feature Manifest bytes,
ordered by their computed Manifest IDs. Including complete bytes lets a Baseline remain
self-describing; Event dependencies MAY also address the same Manifests individually.

`requiredFeatureSetId` is:

```text
SHA-256(Transcript(
  "awsm:required-feature-set-id:v1",
  [concat(sortedFeatureManifestIds)]
))
```

The empty set hashes an empty single part. A validator recomputes every Manifest ID, verifies
requirements and incompatibilities, and then recomputes the Set ID.

# 11. Advisory Extension map

The Advisory Extension container is a CBOR map from canonical scoped text keys to exact byte
strings. Keys are unique through ordinary CBOR map rules and canonical order. The base limits are:

- at most 32 entries;
- at most 16 KiB per value; and
- at most 64 KiB for the complete canonical map.

The containing Record or Object authenticates the complete map. Unknown entries are preserved
byte-for-byte whenever the containing item is preserved and MAY be ignored. An extension MUST NOT
change authority, state, validation, parents, dependencies, Baseline content, Export, reachability,
Garbage Collection, rendering, or security. A validator MUST reject an item whose behavior depends
on an Advisory Extension.

# 12. Identifier transcripts

This specification assigns the common content-addressed constructions:

```text
recordId = SHA-256(Transcript(
  "awsm:vault-record-id:v1",
  [canonicalAuthenticatedVaultRecordBytes]
))

objectId = SHA-256(Transcript(
  "awsm:vault-object-id:v1",
  [vaultId, uint32be(objectType), canonicalAuthenticatedVaultObjectBytes]
))

keyEnvelopeId = SHA-256(Transcript(
  "awsm:key-envelope-id:v1",
  [canonicalProtectedKeyEnvelopePlaintext]
))

storageItemId = SHA-256(Transcript(
  "awsm:storage-item-id:v1",
  [canonicalOpaqueStorageEnvelopeBytes]
))

recoveredBundleId = SHA-256(Transcript(
  "awsm:recovered-bundle:v1",
  [targetVaultId, sourceRecordId]
))
```

The Key Epoch ID uses its all-fixed-width construction from the cryptography specification. No
identifier appears inside the exact bytes from which that same identifier is derived.

# 13. Strict validation order

A trusted reader MUST:

1. enforce outer byte and size limits;
2. parse exactly one canonical CBOR item;
3. reject unknown or duplicate fields and invalid primitive encodings;
4. validate format, type, feature, and dependency registries;
5. recompute the item's logical identifier;
6. verify cryptographic authentication and signatures;
7. resolve and verify the exact current causal closure, typed dependency closure, and Continuity
   Proof required by the owning type;
8. apply type-specific authority, precondition, and reducer validation; and
9. atomically promote the complete result with required Replica Safety State.

Failure at any step leaves input in bounded Quarantine or rejects it. A reader MUST NOT expose a
partially parsed authoritative value.

# 14. Invariants

- One semantic value has one authoritative byte representation.
- Equivalent non-canonical bytes are invalid, not alternative encodings.
- All content identifiers are non-self-referential and domain-separated.
- Set order is deterministic and has no hidden precedence meaning.
- Unknown correctness semantics fail closed.
- Advisory Extensions cannot smuggle correctness semantics.
- JSON, database rows, transport framing, and generated language types never define Vault identity.

# References

- RFC 8949, Concise Binary Object Representation
- `docs/specifications/core/identifiers.md`
- `docs/specifications/event/event-format.md`
- `docs/specifications/storage/opaque-envelope.md`
