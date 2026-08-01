# Vault Item Encryption Specification

**Document:** `docs/specifications/crypto/object-encryption.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/core/serialization.md`
- `docs/specifications/crypto/crypto.md`
- `docs/specifications/crypto/key-derivation.md`
- `docs/specifications/storage/opaque-envelope.md`

---

# 1. Purpose

This specification defines protected compact plaintext, compact XChaCha20-Poly1305 encryption,
HPKE Key Envelope storage, and authenticated framed Artifact wrappers.

# 2. Protected compact payload

An epoch-encrypted Compact item plaintext is:

```text
{
  0: keyEpochId, // 32 bytes
  1: payloadType,
  2: payloadBytes
}
```

The initial payload type registry is:

| Code | Payload                                   |
| ---: | ----------------------------------------- |
|    1 | Vault Record canonical bytes              |
|    2 | Vault Object canonical bytes              |
|    3 | Feature Manifest canonical bytes          |
|    4 | encrypted Replica-local bootstrap catalog |

`payloadBytes` is a byte string containing the exact canonical inner bytes. After authenticated
decryption, the client verifies the Key Epoch ID, parses the exact expected type, computes its
logical ID, and validates its authority and dependency context. A bootstrap catalog is disposable
Replica-local acceleration and never authoritative.

# 3. Compact encryption

The client:

1. generates a fresh 64-byte protection-parameter field;
2. treats bytes 0 through 23 as the XChaCha20 nonce and bytes 24 through 63 as random padding;
3. derives `compactKey` through `key-derivation.md`;
4. constructs the canonical protected compact plaintext;
5. computes the expected ciphertext length as plaintext length plus 16;
6. constructs the associated data below;
7. seals with XChaCha20-Poly1305;
8. constructs the outer header and payload digest; and
9. computes the Opaque Storage Item ID over the complete envelope.

The compact associated data is:

```text
Transcript(
  "awsm:compact-item-aad:v1",
  [
    vaultId,
    keyEpochId,
    uint8(1),
    protectionParameters[64],
    uint64be(plaintextLength),
    uint64be(ciphertextLength)
  ]
)
```

The Host does not know the Vault or Epoch values in the associated data.

# 4. Compact decryption

When protected local resolution state does not identify an item's Epoch, the client MAY try its
readable Key Epoch Keys in a bounded operation. For each candidate it derives the exact key and
associated data and attempts authenticated opening.

After one succeeds, the client MUST verify the protected `keyEpochId`, payload type, canonical inner
bytes, logical ID, signature or Object authentication, and complete context. It then MAY cache the
`storageItemId -> keyEpochId` mapping in protected Replica Safety State.

No plaintext is returned before every applicable check succeeds. Several successful openings under
different keys are an integrity failure.

# 5. Key Envelope storage

A Key Envelope plaintext uses `crypto.md`. Before sealing, the client generates 32 random padding
bytes and includes them in the exact target-kind-specific HPKE `info` transcript; associated data
is empty. The returned 32-byte encapsulated key occupies protection-parameter bytes 0 through 31,
and the authenticated padding occupies bytes 32 through 63. The HPKE ciphertext is the Compact
outer payload.

The outer envelope exposes no algorithm or target-kind tag. A recovering client attempts the
Recovery HPKE context with its phrase-derived private key. A Client Credential attempts its own
HPKE context. Opening yields only an untrusted candidate until the logical Envelope ID and binding
Authority Event validate.

# 6. Artifact wrapper plaintext contract

The compact Artifact Object commits to:

- Vault ID, Artifact ID, and Object type;
- exact logical plaintext payload length;
- SHA-256 digest of the complete logical plaintext payload under the Artifact payload domain;
- media and representation metadata;
- frame plaintext limit of 1,048,576 bytes;
- XChaCha20-Poly1305 tag length of 16.

The applicable Key Epoch belongs to the encrypted representation, not the logical Artifact Object.
Re-encrypting the Object and wrapper under another readable Epoch preserves the Artifact ID.

The wrapper encrypts the exact logical plaintext bytes in order. Compression, if a future Required
Feature permits it, occurs before this contract and its algorithm and uncompressed integrity become
authoritative Artifact metadata. The base wrapper performs no compression.

# 7. Artifact payload digest

The complete plaintext digest is:

```text
SHA-256(Transcript(
  "awsm:artifact-payload:v1",
  [exactLogicalPayloadBytes]
))
```

Streaming implementations compute it incrementally while preserving the exact transcript framing:
the transcript prefix, single part length, and bytes are hashed in that order.

# 8. Frame encryption

The client generates a fresh 64-byte protection field, derives the wrapper key, and splits the
logical payload into frames defined by `docs/specifications/storage/opaque-envelope.md`.

For each frame, associated data is:

```text
Transcript(
  "awsm:artifact-frame-aad:v1",
  [
    vaultId,
    keyEpochId,
    artifactId,
    protectionParameters[64],
    uint64be(totalPlaintextLength),
    uint32be(frameIndex),
    uint8(finalFlag),
    uint32be(framePlaintextLength),
    uint32be(frameCiphertextLength)
  ]
)
```

The frame nonce is derived from the base nonce and index by `key-derivation.md`. The outer frame
prefix MUST exactly match the authenticated index, flag, and ciphertext length.

# 9. Frame validation and release

A reader MUST:

1. verify outer envelope and frame grammar;
2. verify each frame prefix and derived nonce;
3. authenticate a complete frame before releasing its plaintext to the next trusted streaming
   consumer;
4. enforce exact index, final marker, and length rules;
5. compute the complete logical payload digest and length;
6. compare them with the compact Artifact Object; and
7. report completion only after the final frame and complete digest validate.

A consumer may process authenticated frames incrementally but MUST treat the overall Artifact as
failed if the final contract does not validate. A Capture, Import, Export, or Restore MUST NOT make
the wrapper authoritative before that complete result.

# 10. Key Epoch Transition representations

One canonical Key Epoch Transition Event may have several compact outer representations. An
ordinary transition is encrypted under its one parent Epoch. A combined transition is independently
encrypted under every conflicting parent Epoch using fresh protection parameters.

Every representation decrypts to the identical canonical authenticated Event and therefore the
same `recordId`. A new-Epoch-only representation cannot bootstrap access and is not sufficient.

# 11. Size and resource limits

Clients MUST enforce configured bounds before allocation, use streaming APIs for Artifact wrappers,
and keep untrusted incoming data in bounded Quarantine. An oversized item, frame count beyond
`2^32`, length overflow, truncated stream, or resource-limit failure rejects or pauses the exact
operation without weakening validation.

# 12. Invariants

- Fresh randomness is used for every independent outer representation.
- The outer Host learns no Key Epoch ID or semantic payload type.
- Authentication precedes plaintext release.
- Complete Artifact integrity is checked after frame authentication.
- Key Envelope opening is never sufficient without Authority binding.
- Several parent-key wrappers never create several logical Events.
- Compression and physical chunking cannot silently change Artifact identity.

# References

- `docs/specifications/storage/opaque-envelope.md`
- `docs/specifications/bundle/artifact.md`
- `docs/specifications/event/event-format.md`
