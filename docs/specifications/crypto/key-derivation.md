# Key Derivation Specification

**Document:** `docs/specifications/crypto/key-derivation.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- crypto.md
- object-encryption.md
- vault/vault.md

---

# 1. Purpose

This specification defines how Archive Platform derives cryptographic keys from Vault-level secrets.

Key derivation provides domain separation, algorithm agility, and deterministic reconstruction of subordinate keys on trusted devices.

---

# 2. Design Goals

Key derivation MUST provide:

- domain separation
- deterministic output for identical inputs
- algorithm versioning
- Vault isolation
- support for key rotation
- zero-knowledge server operation

---

# 3. Primitive

The initial key derivation primitive SHALL be:

```text
HKDF-SHA256
```

Future derivation algorithms MAY be introduced with new algorithm identifiers.

---

# 4. Key Hierarchy

Conceptually:

```text
Master Secret

↓

Vault Root Key

├── Bundle Descriptor Key Domain
├── Event Key Domain
├── Artifact Key Domain
├── Metadata Key Domain
└── Wrapping Key Domain
```

The Vault Root Key is the root secret for one Vault only.

---

# 5. Inputs

Every derivation SHALL include:

- parent key material
- algorithm identifier
- domain label
- Vault ID
- key version
- context identifier where applicable

Context identifiers MAY include Bundle ID, Event ID, Artifact ID, Device ID, or Object Identifier depending on the derived key's purpose.

---

# 6. Domain Labels

Initial domain labels include:

```text
vault:bundle-descriptor:v1
vault:event:v1
vault:artifact:v1
vault:metadata:v1
vault:projection:v1
vault:device-wrap:v1
vault:object:v1
```

Domain labels MUST NOT be reused for different semantics.

---

# 7. Bundle Descriptor Keys

Bundle Descriptor keys protect compact serialized Bundle Descriptors.

The derivation context SHALL include:

- Vault ID
- Bundle ID
- Bundle Descriptor key version

The initial implementation SHALL derive Bundle Descriptor keys with HKDF-SHA256. It SHALL NOT
generate or persist a separate random wrapped key.

---

# 8. Event Keys

Event keys protect Event payloads.

The derivation context SHALL include:

- Vault ID
- Event domain or Event type
- Event key version

Event headers required for ordering and routing MAY remain outside the encrypted payload.

The initial implementation SHALL derive one Event key per Event ID.

---

# 9. Artifact Keys

Artifact keys protect independently framed Artifact payloads.

The derivation context SHALL include:

- Vault ID
- Artifact Object ID
- Artifact key version

---

# 10. Metadata Keys

Metadata keys protect synchronized user-visible metadata.

The derivation context SHALL include:

- Vault ID
- metadata domain
- metadata key version

Operational metadata required for coordination is not protected by this key unless explicitly specified.

---

# 11. Projection Keys

Projection keys protect local derived state such as encrypted Search Projection Materializations and projection snapshots.

The derivation context SHALL include:

- Vault ID
- projection type
- projection key version

Projection keys protect rebuildable local state and SHALL NOT become authoritative Vault history.

The initial implementation SHALL derive one Projection-row key using the projection type and referenced Bundle ID as context.

---

# 12. Device Wrapping Keys

Device wrapping keys protect Vault Root Keys or subordinate key material for trusted devices.

The derivation or wrapping context SHALL include:

- Vault ID
- Device ID
- wrapping key version

The Coordination Server stores wrapped keys only.

## 12.1 Recovery Phrase Derivation

The Recovery Phrase is the BIP39 encoding of 16 random bytes. After canonical phrase validation, the
trusted client decodes the same entropy and derives two independent 32-byte values with
HKDF-SHA256, using the raw Vault UUID bytes as salt:

```text
awsm:recovery-kit-wrapping:v1
awsm:recovery-administrator-ed25519-seed:v1
```

The first value encrypts and authenticates the Recovery Kit with XChaCha20-Poly1305. The second is
the deterministic seed for the recovery administrator Ed25519 key. The encrypted Recovery Kit
contains every readable key-epoch root key and its ordinal. Its associated data binds the Vault ID,
Recovery Generation ID, active Key Epoch ID, algorithms, nonce, and ciphertext length.

The phrase, entropy, derived wrapping key, administrator seed, and unwrapped epoch keys MUST remain
inside trusted client memory and MUST be wiped after initial attach, Device enrollment, Future
Protection, or failure. The Coordination Server receives only the encrypted Recovery Kit, public
administrator key, signed Device certificates, and signed Device key envelopes.

## 12.2 Device Key Envelopes

Each Device owns independent Ed25519 signing and X25519 wrapping key pairs. The active recovery
administrator signs the Device certificate and one XChaCha20-Poly1305 envelope for every key epoch
the Device may read. Envelope derivation and associated data bind the Vault, Recovery Generation,
Device certificate, Key Epoch, wrapping public key, algorithms, and nonce.

---

# 13. Rotation

Key rotation increments the relevant key version.

Only the canonical current pre-release derivation format is implemented. Any post-release retention or format-evolution policy requires an explicit user decision.

Rotation of one domain SHOULD NOT require immediate re-encryption of unrelated domains.

---

# 14. Algorithm Agility

Derived keys SHALL record enough metadata to identify:

- derivation algorithm
- domain label
- key version
- parent key version

Unsupported derivation algorithms MUST cause decryption or derivation to fail safely.

---

# 15. Server Constraints

The Coordination Server MUST NOT:

- derive keys
- receive parent key material
- receive unwrapped Vault Root Keys
- influence derivation output

All derivation occurs inside trusted clients.

---

# 16. Invariants

- Derived keys are domain-separated.
- Key derivation is deterministic for identical inputs.
- Key versions are explicit.
- Vault Root Keys never cross the trust boundary unwrapped.
- The server cannot derive or unwrap Vault contents.

---

# References

- crypto.md
- object-encryption.md
- `docs/architecture/18-cryptography.md`
