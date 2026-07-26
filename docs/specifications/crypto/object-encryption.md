# Object Encryption Specification

**Document:** `specifications/crypto/object-encryption.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- crypto.md
- bundle/bundle.md
- event/event-format.md

---

# 1. Purpose

This specification defines the canonical encrypted representation of persisted Objects.

Compact encrypted Objects SHALL use the common envelope format. Artifact payloads SHALL use the
chunk-framed format in section 15 so large payloads never require whole-Object buffering.

---

# 2. Design Goals

The encrypted object format MUST provide:

- confidentiality
- integrity
- algorithm agility
- deterministic parsing
- canonical format validation

---

# 3. Encrypted Object Layout

Conceptually:

```

Encrypted Object

├── Header
├── Nonce
├── Ciphertext
└── Authentication Tag

```

The Header is plaintext.

All remaining fields are protected by authenticated encryption.

---

# 4. Header

The Header SHALL contain:

- Format Version
- Object Type
- Encryption Algorithm Identifier
- Object Identifier
- Key Epoch ID

Optional fields MAY include:

- Compression Algorithm Identifier
- Payload Length

The Header MUST NOT contain user content.

---

# 5. Payload

The Payload contains the serialized plaintext object.

Examples include:

- Bundle
- Event Segment
- Projection Snapshot
- Wrapped Key

Payload serialization is defined by the relevant specification.

---

# 6. Compression

Compression SHALL occur before encryption.

Compression metadata SHALL be recorded in the Header.

---

# 7. Encryption

Encryption SHALL use:

- XChaCha20-Poly1305

The complete Payload SHALL be encrypted.

---

# 8. Associated Data

The Header SHALL be supplied as Additional Authenticated Data (AAD).

Any modification of the Header SHALL invalidate authentication.

---

# 9. Nonce

Every encrypted object SHALL contain a unique nonce.

Nonce reuse with the same key is prohibited.

---

# 10. Integrity

Integrity SHALL be provided by the authenticated encryption algorithm.

Separate integrity mechanisms are optional.

---

# 11. Decryption

Decryption SHALL verify authentication before exposing plaintext.

Authentication failure MUST abort processing.

---

# 12. Unknown Versions

Readers SHALL reject unsupported format versions.

---

# 13. Canonical Encryption Format

Exactly one encryption algorithm defined by this specification is canonical before the first release.

Objects SHALL indicate that encryption format explicitly. Alternate algorithm readers are not implemented.

---

# 14. Invariants

Every encrypted object has one envelope.

Headers are plaintext.

Payloads are encrypted.

Authentication precedes decryption.

# 15. Artifact Wrapper Format

An Artifact wrapper SHALL begin with ASCII magic `AWSMART1`, a big-endian 32-bit canonical-CBOR
header length, and a canonical-CBOR header containing exactly the wrapper version, encryption
algorithm, Artifact Object ID, Key Epoch ID, MIME type, chunk size, base nonce, and plaintext
checksum algorithm. The initial chunk size is 1 MiB and the algorithm is XChaCha20-Poly1305.

The header bytes are authenticated by every frame. Each frame SHALL encode its monotonically
increasing index, final flag, plaintext length, ciphertext, and 16-byte authentication tag. Frame
nonces and AAD SHALL be derived deterministically from the authenticated header and frame index;
nonce reuse is prohibited. An empty Artifact has one authenticated final frame with zero plaintext
bytes.

Readers SHALL reject unknown fields/versions, non-canonical headers, unexpected indices, invalid
frame sizes, missing or repeated final frames, trailing bytes, authentication failure, and any
mismatch in expected plaintext length/checksum or wrapper length/checksum. They SHALL expose no
successful completion until all checks pass. Implementations SHALL stream with memory bounded to a
small constant number of chunks.

---

# References

crypto.md

bundle/bundle.md

event/event-format.md
