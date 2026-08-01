# Key Derivation Specification

**Document:** `docs/specifications/crypto/key-derivation.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/core/serialization.md`
- `docs/specifications/crypto/crypto.md`

---

# 1. Purpose

This specification defines the exact Recovery Credential and per-item key derivations. It does not
derive one Key Epoch from another and does not define a portable Vault Root Key.

# 2. HKDF conventions

All HKDF operations use SHA-256. `HKDF-Extract(salt, IKM)` produces the 32-byte pseudorandom key
from RFC 5869. `HKDF-Expand(PRK, info, L)` uses the exact `info` bytes and output length.

An implementation MUST pass exact byte strings and MUST NOT substitute text encoding, hexadecimal,
base64, platform objects, or an omitted salt where this specification supplies one.

# 3. Recovery Phrase decoding

The canonical Recovery Phrase is the BIP39 English encoding of exactly 128 bits of fresh entropy
and its 4-bit checksum, yielding exactly 12 words.

A client MUST:

1. normalize user input as Unicode NFKD for BIP39 word matching;
2. require exactly 12 words from the canonical English word list;
3. reconstruct the exact 16-byte entropy and verify the checksum;
4. reject user-selected, malformed, ambiguous, or checksum-invalid input; and
5. use the recovered entropy directly rather than the BIP39 PBKDF2 seed construction.

AWSM does not support the optional BIP39 passphrase.

A Client MUST generate independent fresh entropy for every member and Vault and warn against
deliberate Recovery Phrase reuse. Reuse is not made into a remote oracle or a second accepted
derivation; it would reproduce the same public key material before authenticated Vault binding.

# 4. Recovery root extraction

Define:

```text
recoverySalt = SHA-256(ascii("awsm:recovery-root:v1"))
recoveryPrk = HKDF-Extract(recoverySalt, entropy[16])
```

Then derive:

```text
recoverySigningSeed = HKDF-Expand(
  recoveryPrk,
  Transcript("awsm:recovery-signing-key:v1", []),
  32
)

recoveryWrappingInput = HKDF-Expand(
  recoveryPrk,
  Transcript("awsm:recovery-wrapping-key:v1", []),
  32
)
```

`recoverySigningSeed` is the 32-byte Ed25519 private seed. `recoveryWrappingInput` is interpreted as
an X25519 private scalar and clamped by the standard X25519 operation. The corresponding public keys
use the canonical 32-byte raw encodings.

Vault ID, member ID, Account, Host, and Recovery revision are deliberately absent. Authenticated
Authority State binds the resulting public keys to those contexts after private discovery.

# 5. Recovery public fingerprint

A trusted client MAY calculate:

```text
SHA-256(Transcript(
  "awsm:recovery-public-fingerprint:v1",
  [recoveryWrappingPublicKey]
))
```

only for local candidate matching. It MUST NOT send the fingerprint to a Replica Host, persist it
in Host Policy State, use it as a remote lookup key, or expose it as a phrase oracle.

# 6. Key Epoch item PRK

For one Vault and Key Epoch:

```text
epochSalt = SHA-256(Transcript(
  "awsm:key-epoch-extract:v1",
  [vaultId, keyEpochId]
))

epochPrk = HKDF-Extract(epochSalt, keyEpochKey)
```

Before derivation, the client MUST recompute and verify `keyEpochId` from the Key Epoch Key and
Vault ID.

# 7. Compact item key

For a compact epoch-encrypted item:

```text
compactKey = HKDF-Expand(
  epochPrk,
  Transcript(
    "awsm:compact-item-key:v1",
    [
      vaultId,
      keyEpochId,
      uint8(storageClass),
      protectionParameters[64]
    ]
  ),
  32
)
```

`storageClass` MUST be `1`. Bytes 0 through 23 of `protectionParameters` are the XChaCha20 nonce;
the remaining 40 bytes are fresh authenticated random padding. Reusing the same complete
protection field under the same Epoch is prohibited.

# 8. Artifact wrapper key

For a streamable Artifact wrapper:

```text
wrapperKey = HKDF-Expand(
  epochPrk,
  Transcript(
    "awsm:artifact-wrapper-key:v1",
    [
      vaultId,
      keyEpochId,
      artifactId,
      uint8(2),
      protectionParameters[64]
    ]
  ),
  32
)
```

Bytes 0 through 23 are the random base nonce. The Artifact ID is known from the compact Artifact
Object before wrapper construction and binds the key to one logical payload contract.

# 9. Frame nonces

For frame index `i` in the unsigned 32-bit range:

```text
frameNonce = baseNonce[0..15] || uint64be(i)
```

The first 16 bytes supply a random per-wrapper prefix; the index supplies guaranteed uniqueness
under one wrapper key. All 24 base-nonce bytes remain inputs to wrapper-key derivation, so changing
any base-nonce byte changes the key.

No wrapper may contain more than `2^32` frames. A resumed writer MUST retain the exact base nonce,
wrapper key context, frame index, and already committed frame bytes; it MUST NOT restart frame
numbering under the same key.

# 10. No other portable derivations

Bundle, Event, Artifact, metadata, Projection, member, or credential keys are not independently
derived from a root. Compact authoritative items use the applicable Epoch-derived item key.
Materializations MAY use local keys derived or generated inside the Installation Wrapping Key
boundary, but those derivations are non-portable and MUST NOT affect Vault identity.

# 11. Test vectors

The implementation convergence MUST add immutable golden vectors covering:

- BIP39 entropy-to-words and words-to-entropy;
- checksum rejection and NFKD handling;
- Recovery Ed25519 and X25519 public keys;
- Key Epoch ID;
- epoch PRK, compact key, wrapper key, and frame nonces;
- wrong Vault, Epoch, Artifact, class, or protection-parameter divergence; and
- maximum frame index and resume behavior.

Vectors MUST publish only intentionally non-secret fixture material.

# 12. Invariants

- Recovery derivation works before Vault discovery.
- Recovery signing and wrapping keys are independently domain-separated.
- One Key Epoch cannot derive another.
- Key Epoch Keys are never direct AEAD keys.
- Per-item randomness contributes to key separation.
- Frame nonces are unique under one wrapper key.
- Search and Projection keys have no portable semantic role.

# References

- RFC 5869
- RFC 7748
- RFC 8032
- BIP39
