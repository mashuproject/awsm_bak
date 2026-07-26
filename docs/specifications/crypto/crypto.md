# Cryptography Specification

**Document:** `specifications/crypto/crypto.md`

**Version:** 1.0

**Status:** Draft

---

# 1. Purpose

This specification defines the cryptographic primitives, formats, and rules used by the Archive Platform.

It defines how data is encrypted, authenticated, and verified across all system components.

---

# 2. Design Goals

Cryptography MUST provide:

- confidentiality
- integrity
- authenticity
- forward secrecy (where applicable)
- key separation
- algorithm agility
- zero-knowledge server model

---

# 3. Non-Goals

This specification does NOT define:

- user authentication UI
- identity management UX
- password policies
- transport security (TLS is assumed separately)

---

# 4. Cryptographic Primitives

The platform SHALL use the following primitives:

## 4.1 Encryption

- Algorithm: XChaCha20-Poly1305
- Purpose: symmetric authenticated encryption
- Mode: AEAD

## 4.2 Hashing

- Algorithm: SHA-256

## 4.3 Key Derivation

- Algorithm: HKDF-SHA256

## 4.4 Export Passphrase KDF

- Algorithm: Argon2id

## 4.5 Local Device Key Wrapping

- Algorithm: AES-KW with a 256-bit non-exportable Web Crypto key
- Purpose: wrap the Vault Root Key for the local browser device slot

AES-KW is limited to local device key slots. It is not an Object encryption algorithm and SHALL NOT be used to encrypt Bundle, Event, Projection, or synchronized payload bytes.

## 4.6 Digital Signatures

- Algorithm: Ed25519

---

# 5. Algorithm Identifiers

All cryptographic operations MUST be tagged with algorithm identifiers.

Examples:

```
enc:xchacha20poly1305:v1
hash:sha256:v1
kdf:hkdf-sha256:v1
sig:ed25519:v1
wrap:aes-kw-256:device:v1
wrap:xchacha20poly1305:passphrase:v1
```

---

# 6. Encryption Model

All sensitive data MUST be encrypted before leaving trusted client environments.

Encryption is applied to:

- Bundles
- Event Segments
- Wrapped Keys
- Optional metadata blobs

---

# 7. Nonce Requirements

Nonces MUST be:

- unique per key
- 24 bytes (for XChaCha20-Poly1305)
- generated using a cryptographically secure RNG

Nonce reuse under the same key is strictly prohibited.

---

# 8. Key Model

The system uses a hierarchical key structure:

```
Master Secret
    ↓
Vault Root Key
    ↓
Domain Keys
    ↓
Object or Context Keys
```

Each level is derived or wrapped using HKDF or authenticated wrapping.

---

# 9. Key Derivation

HKDF-SHA256 is used for deterministic derivation of keys.

Inputs include:

- salt
- context string
- parent key

Derived keys MUST be domain-separated.

---

# 10. Key Wrapping

Keys MAY be wrapped using:

- XChaCha20-Poly1305
- AES-KW with a non-exportable 256-bit local device key

Wrapped keys include:

- wrapped key material
- nonce
- associated metadata

The initial browser implementation SHALL store one mandatory local device slot and SHALL NOT store a local passphrase slot.

The device slot SHALL use `wrap:aes-kw-256:device:v1`. Because AES-KW does not accept AAD, a client SHALL authenticate the Vault ID, Device ID, slot ID, wrapping algorithm, and slot version through a Vault verifier derived from the unwrapped Vault Root Key before treating the Vault as unlocked.

Each Vault Package SHALL derive a 32-byte wrapping key from its export passphrase with Argon2id using a random 16-byte salt, 64 MiB memory, and three iterations, then wrap the Vault Root Key using `wrap:xchacha20poly1305:passphrase:v1` and a random 24-byte nonce.

The export key-envelope version, package identifier, Vault identifier, algorithm identifiers, KDF parameters, and Manifest hash SHALL be authenticated as XChaCha20-Poly1305 AAD. This envelope SHALL exist only in the Vault Package and SHALL NOT become a local Vault key slot.

---

# 11. Zero-Knowledge Constraint

The server MUST NOT:

- derive encryption keys
- decrypt any payload
- access plaintext data
- influence key generation

All cryptographic operations occur in trusted clients.

---

# 12. Integrity Model

Integrity is provided by:

- AEAD authentication tags
- SHA-256 checksums (for storage verification)
- optional signatures (for device trust)

---

# 13. Randomness Requirements

All cryptographic randomness MUST be generated using a cryptographically secure RNG provided by the host environment.

---

# 14. Algorithm Agility

All cryptographic components MUST include version identifiers.

The system MUST support coexistence of multiple algorithm versions.

---

# 15. Key Rotation

Keys MAY be rotated.

Rotation MUST NOT invalidate historical data.

Old keys remain valid for decryption of existing objects.

---

# 16. Device Trust

Every synchronized Device SHALL have independent signing and wrapping key pairs and a certificate
signed by the active recovery administrator.

Every readable Key Epoch SHALL be delivered in a signed envelope bound to that Device certificate.

Revoked Devices MUST lose server authorization. Future Protection MUST withhold the new Key Epoch
from removed Devices while retained Devices keep historical epoch access.

---

# 17. Forward Secrecy (Optional)

Forward secrecy MAY be achieved through periodic key rotation.

---

# 18. Failure Modes

Cryptographic failures MUST result in:

- rejection of the object
- termination of the operation
- logged diagnostic event (if possible)

No partial decryption is permitted.

---

# 19. Invariants

- Plaintext never leaves trusted clients
- Keys are never transmitted in raw form
- Nonces are never reused per key
- All encrypted data is authenticated
- Algorithms are versioned

---

# 20. References

key-derivation.md

object-encryption.md

protocol/protocol.md

event/event-format.md
