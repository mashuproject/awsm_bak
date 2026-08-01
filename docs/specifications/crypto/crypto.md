# Cryptography Specification

**Document:** `docs/specifications/crypto/crypto.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/core/serialization.md`

---

# 1. Purpose

This specification fixes AWSM's canonical initial algorithms, key roles, randomness, signature,
key-delivery, and failure rules. It does not permit ambient algorithm negotiation or a portable
global Vault root secret.

# 2. Canonical algorithms

| Purpose                                 | Algorithm                                    |
| --------------------------------------- | -------------------------------------------- |
| Content digest and identifiers          | SHA-256                                      |
| Event and recovery signatures           | Ed25519                                      |
| Content KDF                             | HKDF-SHA256                                  |
| Compact and streamable Vault encryption | XChaCha20-Poly1305                           |
| Key Envelope recipient encryption       | RFC 9180 HPKE Base mode                      |
| HPKE KEM                                | DHKEM(X25519, HKDF-SHA256), KEM ID `0x0020`  |
| HPKE KDF                                | HKDF-SHA256, KDF ID `0x0001`                 |
| HPKE AEAD                               | ChaCha20-Poly1305, AEAD ID `0x0003`          |
| Recovery Phrase                         | BIP39 English, 128-bit entropy, 12 words     |
| Export passphrase KDF                   | Argon2id under the portability specification |

No algorithm identifier appears in ordinary base Vault items because the Required Vault Feature
Set fixes these algorithms. Another algorithm requires an explicit Required Vault Feature and any
necessary new stable envelope format. Unknown algorithms fail closed.

# 3. Key roles

AWSM uses:

- one independent random Key Epoch Key per Key Epoch;
- independent Client Credential Ed25519 signing and X25519 wrapping keys;
- independent Recovery Credential Ed25519 signing and X25519 wrapping keys derived from one
  member-scoped Recovery Phrase;
- ephemeral per-item and per-wrapper XChaCha20 keys derived from one applicable Key Epoch Key;
- optional Client-Installation-local Installation Wrapping Keys; and
- independent random Export keys for portability packages.

AWSM has no portable global Vault Root Key. Possession of one Key Epoch Key cannot derive another.

# 4. Randomness

A trusted client MUST use a cryptographically secure operating-system or browser random source for:

- every generated 32-byte entity ID;
- every 32-byte Key Epoch Key;
- Recovery Phrase entropy;
- every 24-byte XChaCha20 nonce or base nonce;
- every 64-byte outer protection-parameter field's unused random padding;
- HPKE sender randomness through the conforming HPKE implementation;
- Invitation bearer secrets; and
- Export keys, salts, and nonces.

Random generation failure aborts the operation before authoritative commit. An implementation MUST
NOT substitute timestamps, counters, identifiers, usernames, or deterministic pseudorandom output.

# 5. Key Epoch ID

The 32-byte Key Epoch ID is the fixed-width construction:

```text
SHA-256(
  ascii("awsm:key-epoch:v1") || 0x00 ||
  vaultId[32] ||
  keyEpochKey[32]
)
```

The recipient recomputes the ID after opening every Key Envelope. Reusing an old Key Epoch Key
reproduces its ID and is invalid as a new Epoch. The ID commits to the key, not its causal parents
or authority; the signed Key Epoch Transition Event binds those facts.

# 6. Vault Event signatures

Vault Events use Ed25519 exactly as specified by RFC 8032 with 32-byte raw public keys and 64-byte
signatures. The message is the transcript in `docs/specifications/event/event-format.md`; AWSM does
not prehash it separately or use Ed25519ph.

Verification MUST reject:

- a non-canonical public key or signature length;
- an invalid Ed25519 encoding or small-order public key under the selected conforming library;
- a signature over non-canonical Event bytes;
- a signer not authorized at the exact Authority Frontier; or
- a signature valid for another domain transcript.

# 7. Key Envelopes

Recovery and Client Credential Key Envelopes use HPKE Base mode. They have no sender authentication
inside HPKE; the signed Authority Event that binds the exact protected logical Key Envelope ID
provides sender authorization and portable integrity.

Before sealing, the client generates the fresh 32-byte padding that will occupy the second half of
the outer protection-parameter field. The HPKE `info` value is one of:

```text
Transcript("awsm:recovery-key-envelope-hpke:v1", [outerPadding])
Transcript("awsm:client-key-envelope-hpke:v1", [outerPadding])
```

The HPKE associated-data value is empty. The public outer padding does not require prior Vault
knowledge, so private Recovery discovery remains possible before the recovering client knows the
Vault, member, or Epoch. The `info` value cryptographically binds that padding; HPKE itself binds
the encapsulated public key. The encrypted canonical plaintext binds all semantic values, and the
Authority Event binds its logical ID and relationship.

The 32-byte HPKE encapsulated public key occupies bytes 0 through 31 of the outer fixed 64-byte
protection-parameter field. The already-bound padding occupies bytes 32 through 63. The complete
field is therefore authenticated by the protected construction: HPKE binds its encapsulated key
and the `info` transcript binds the padding.

# 8. Key Envelope protected plaintext

The canonical plaintext map is:

```text
{
  0: 1,                  // keyEnvelopeFormat
  1: vaultId,            // 32 bytes
  2: keyEpochId,         // 32 bytes
  3: keyEpochKey,        // 32 bytes
  4: targetKind,         // 1 Recovery Credential, 2 Client Credential
  5: targetCredentialId, // 32 bytes
  6: targetRevision      // Recovery revision; null for Client Credential
}
```

The Key Envelope logical ID is the domain-separated digest of these exact canonical bytes. After
opening, the target MUST verify every field, recompute `keyEpochId`, recompute the logical Envelope
ID, and verify that a valid Authority Event binds the expected dependency slot. An independently
valid HPKE opening without that Event context is an untrusted candidate.

# 9. Recovery Credential derivation

Recovery derivation is owned by `key-derivation.md`. It consumes only the 16-byte entropy recovered
from a valid BIP39 phrase and fixed public domains. It does not require a Vault ID, member ID,
Account, Host, or value available only after decryption.

The public Recovery signing and wrapping keys are bound to one member and revision by authenticated
Authority State. The phrase and private keys never leave the trusted client.

# 10. Content encryption

Compact Records and Objects and large Artifact wrappers use XChaCha20-Poly1305 with per-item keys
derived by `key-derivation.md`. Every independent wrapper uses a fresh 24-byte nonce or base nonce.
The Key Epoch Key is never passed directly to the AEAD.

AEAD associated data binds the Vault, Key Epoch, purpose, storage class, complete 64-byte outer
protection parameters, exact plaintext or frame context, and lengths defined by
`docs/specifications/crypto/object-encryption.md`.

# 11. Installation Wrapping Key

An Installation Wrapping Key is an adapter-owned local protection mechanism for cached Client
Credential private keys and Key Epoch Keys. It MAY be non-exportable or backed by an operating-
system secure store.

Its algorithm and user-presence policy are not portable Vault fields. The Runtime MUST bind wrapped
secret records to the exact Client Installation, Vault, credential, purpose, and local schema and
MUST verify successful unwrap before use. Losing the key requires Recovery or Client Credential
Enrollment; the Recovery Phrase does not reconstruct it.

# 12. Key lifecycle

Private keys and unwrapped Key Epoch Keys MUST:

- exist only inside trusted-client memory and protected local secret storage;
- be discarded from memory when the Vault context locks or changes;
- never enter logs, diagnostics, crash reports, Quarantine, or Host Policy State;
- never be copied into Projections or Materializations; and
- be excluded from synchronization, Complete Export, and Backup unless the exact portability
  specification supplies an independent encrypted key-delivery contract.

Historical Key Epoch Keys remain available to authorized members while retained content requires
them. Future Protection does not destroy historical keys.

# 13. Failure behavior

Authentication failure, wrong key, wrong target, wrong Vault, wrong Epoch, malformed canonical
bytes, missing dependency, nonce reuse detection, invalid signature, or unsupported Required
Feature fails closed. A client MUST NOT return partial plaintext, reinterpret a key, fall back to a
predecessor Epoch for new writes, or accept an unbound HPKE candidate.

Operational diagnostics use stable non-secret outcome identifiers and MUST NOT include ciphertext
contents, plaintext, keys, bearer secrets, public recovery fingerprints, or sensitive transcript
bytes.

# 14. Forward protection boundary

Removing a member or Client Credential changes portable authority immediately according to its
Event rule. Cryptographic exclusion requires a fresh Key Epoch whose target set omits the ended
authority. Historical data is not re-encrypted and learned keys cannot be revoked.

A key compromise or Client Credential equivocation fences protected writes until the excluding
transition. The product MUST distinguish this state from completed Future Protection.

# 15. Invariants

- The server never receives plaintext, unwrapped keys, Recovery Phrases, or private credentials.
- There is no portable global Vault root secret.
- Every Key Epoch key is independent random material.
- Every AEAD nonce is unique for its derived key.
- Every Key Envelope is target- and Epoch-specific and Authority-bound.
- Every signature and digest uses an exact domain-separated transcript.
- Algorithm changes require explicit Required Feature governance.

# References

- RFC 8032, Ed25519
- RFC 9180, Hybrid Public Key Encryption
- RFC 5869, HKDF
- BIP39
- `docs/specifications/crypto/key-derivation.md`
- `docs/specifications/crypto/object-encryption.md`
