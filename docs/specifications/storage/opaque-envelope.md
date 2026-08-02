# Opaque Storage Envelope Specification

**Document:** `docs/specifications/storage/opaque-envelope.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/core/serialization.md`
- `docs/specifications/crypto/crypto.md`

---

# 1. Purpose

This specification defines the one Host-visible envelope grammar for encrypted compact items and
streamable Artifact wrappers. It gives a Replica Host enough information to admit, inventory,
transfer, range-read, and verify opaque bytes without revealing protected Vault semantics.

# 2. Storage classes

The initial storage classes are:

| Code | Name         | Meaning                                                               |
| ---: | ------------ | --------------------------------------------------------------------- |
|    1 | `Compact`    | one bounded ciphertext byte string                                    |
|    2 | `Streamable` | one ordered sequence of independently authenticated ciphertext frames |

The class reveals a coarse size and transfer distinction only. It never identifies a Vault
Record, Object, Key Envelope, Event, content type, or semantic dependency.

# 3. Binary envelope

Every envelope is exactly:

```text
magic[8]
headerLength:uint32be
header[headerLength]
payload[header.ciphertextLength]
```

The exact 8-byte magic is:

```text
41 57 53 4d 53 45 01 00  // "AWSMSE", initial grammar, reserved zero
```

`headerLength` MUST equal the following canonical CBOR header byte length and MUST be between 1 and 4096. The envelope MUST end after exactly `ciphertextLength` payload bytes.

# 4. Header

The canonical header map is:

```text
{
  0: 1,                    // storageEnvelopeFormat
  1: storageClass,         // 1 Compact, 2 Streamable
  2: protectionParameters, // exactly 64 bytes
  3: ciphertextLength,     // exact payload byte length
  4: ciphertextDigest,     // SHA-256 of exact payload bytes
  5: framePlaintextLimit   // 0 Compact; 1048576 Streamable
}
```

The Host validates every field but cannot assign semantic meaning to
`protectionParameters`. The 64-byte field is mode-oblivious:

- an epoch-encrypted compact item uses bytes 0 through 23 as its XChaCha20 base nonce and fills
  bytes 24 through 63 with fresh random padding;
- an HPKE Key Envelope uses bytes 0 through 31 as the RFC 9180 encapsulated public key and fills
  bytes 32 through 63 with fresh random padding; and
- a streamable Artifact wrapper uses bytes 0 through 23 as its XChaCha20 base nonce and fills bytes
  24 through 63 with fresh random padding.

Every padding byte is authenticated by the protected construction. A trusted client determines the
applicable mode from protected context and authorized key candidates; the Host receives no
algorithm or target-kind tag.

`ciphertextDigest` is the raw 32-byte SHA-256 digest of the exact payload bytes. It is an outer
transfer-integrity check, not a protected logical Object Identifier.

# 5. Compact payload

A Compact payload is one exact AEAD or HPKE ciphertext and authentication tag. Its length MUST be
at least 16 bytes and no greater than the Host's advertised compact-item ceiling. The portable base
ceiling is 16 MiB; a Host MAY advertise a smaller accepted ceiling but cannot change validity of an
already stored item.

The Host treats every Compact payload identically. Only a trusted client can decrypt it and learn
whether it contains a Vault Record, Object, Key Envelope, Feature Manifest, bootstrap catalog, or
other protected compact item.

# 6. Streamable payload

A Streamable payload is a concatenation of frames:

```text
frameIndex:uint32be
flags:uint8              // bit 0 Final; bits 1..7 zero
ciphertextLength:uint32be
ciphertext[ciphertextLength]
```

Requirements:

- indexes start at zero and increase by exactly one;
- every non-final frame decrypts to exactly 1,048,576 plaintext bytes;
- the final frame decrypts to between 0 and 1,048,576 bytes;
- exactly one frame has `Final = 1`, and it is the last frame;
- ciphertext length equals plaintext length plus the 16-byte Poly1305 tag;
- no frame ciphertext exceeds 1,048,592 bytes;
- the payload contains no trailing bytes after the final frame; and
- an empty logical Artifact uses one final frame whose plaintext length is zero.

The frame prefix is Host-visible transport structure. Each prefix and the wrapper context are also
bound in that frame's authenticated data by the object-encryption specification, preventing
reordering, substitution, truncation, duplication, and final-marker changes.

# 7. Opaque Storage Item ID

After the complete envelope is available, its ID is:

```text
SHA-256(Transcript(
  "awsm:storage-item-id:v1",
  [exactEnvelopeBytes]
))
```

The ID is not stored inside the envelope. A Host MUST recompute it at admission and exact retrieval
boundaries. An existing ID with byte-identical content is an idempotent retry. An existing ID with
different bytes is an integrity failure and MUST never overwrite the first item.

# 8. Host Storage Admission

A Replica Host MAY admit an item only after it verifies:

1. Channel Principal and exact Replica Access Grant capability;
2. magic, length framing, canonical header, known format, and known coarse class;
3. fixed protection-parameter and field sizes;
4. exact payload length and SHA-256 digest;
5. stream frame grammar when applicable;
6. the requested Opaque Storage Item ID;
7. immutable collision behavior, quota, conditional token, and idempotency policy; and
8. durable commit under that Host's local storage contract.

These checks establish Host Storage Admission only. The Host MUST NOT claim to validate the inner
Record, signature, authority, dependencies, feature set, or plaintext.

## 8.1 Hosted Replica opaque locator

A Hosted Replica creates one random 32-byte **locator salt** when the Host creates that Hosted
Replica. The salt is Host-local Remote metadata: every currently authorized Channel Principal may
read it for that Hosted Replica, and a Client stores it only with that Remote configuration. It is
not portable Vault state, an Account credential, or a Vault key.

For every admitted item, the Client supplies one 32-byte opaque locator:

```text
SHA-256(Transcript(
  "awsm:hosted-replica-item-locator:v1",
  [locatorSalt, logicalNamespaceCode, protectedLogicalID]
))
```

`logicalNamespaceCode` is a Client-only code for the protected logical identifier family. The
Host receives neither that code nor the protected logical ID. It stores and inventories the locator
as an opaque fixed-length value for **every** storage class, so its presence does not identify Key
Envelopes or any other item kind. Several immutable physical representations may have the same
locator.

The Host does not verify this derivation. After opening an item, a trusted Client recomputes the
locator from authenticated protected context before it accepts the representation. This lets a
Client resolve a signed Key Envelope dependency to one or more opaque physical representations
without attempting to decrypt an Envelope addressed to another recipient.

# 9. Range and resumable transfer

A Host MAY support byte ranges over a Streamable payload. A range response MUST identify the exact
Opaque Storage Item ID, total envelope length, inclusive byte range, and payload digest and MUST
return exact stored bytes. Range alignment to complete frames is preferred but not required for
transport; a trusted client buffers enough prefix and ciphertext to authenticate a complete frame
before releasing plaintext.

Multipart upload is Prepared Data at the Host until the complete envelope length, digest, and ID
verify. No part, frame, or upload session is a Vault Object, preservation root, or synchronization
identity.

# 10. Rewrapping and correlation

The trusted client creates fresh protection parameters and encryption for every independent
Hosted Replica destination. This produces a different outer envelope and ID while preserving the
protected logical item identity.

Blind Host-to-Host copying of exact bytes is valid only as explicitly correlated mirroring. It
preserves the Opaque Storage Item ID and therefore permits observers with both inventories to link
the item.

The locator salt differs for every Hosted Replica. Rewrapping the same protected logical item for
two Hosted Replicas therefore yields unrelated outer IDs and unrelated opaque locators. A locator
is linkable only within one Hosted Replica; it is not a global logical identifier.

# 11. Unknown formats and limits

An unknown `storageEnvelopeFormat`, storage class, header key, flag bit, or malformed length fails
Host Storage Admission. There is no downgrade or alternate grammar. A Host advertises size, range,
multipart, and quota capabilities operationally; those statements do not change Vault validity.

# 12. Invariants

- The outer envelope contains no protected logical identifier or semantic relationship.
- The Host-local opaque locator is outside the envelope, is present for every item, and cannot
  identify a logical namespace or protected logical ID without trusted Client context.
- Compact Key Envelopes and ordinary compact items have the same Host-visible grammar.
- Every stored representation is immutable and content-addressed by its exact outer bytes.
- Stream frames are physical transfer structure, not independent authoritative items.
- A complete outer item can still be malicious or semantically invalid until trusted-client
  validation succeeds.
- A Host-visible digest or ID never proves Vault reachability or global redundancy.

# References

- `docs/specifications/core/serialization.md`
- `docs/specifications/crypto/object-encryption.md`
- `docs/specifications/protocol/protocol.md`
