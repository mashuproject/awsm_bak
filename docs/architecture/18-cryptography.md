# Cryptographic Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/04-security-model.md`
- `docs/specifications/crypto/crypto.md`

# Purpose

Cryptography protects semantic identity, authorship, content confidentiality, Key Epoch delivery,
and opaque storage representations without tying the Vault to one Host or Account.

# Canonical primitives

- deterministic restricted CBOR for protected semantic structures;
- SHA-256 for domain-separated logical and outer identifiers;
- Ed25519 for Vault Event and possession signatures;
- HKDF-SHA256 for domain-separated symmetric derivation;
- XChaCha20-Poly1305 for compact and streamable content encryption; and
- HPKE Base mode with X25519, HKDF-SHA256, and ChaCha20-Poly1305 for Key Envelopes.

The exact transcripts and codecs live in the formal specifications and require golden vectors.

# Key Epoch model

There is no Vault Root Key. Each Epoch Key is independently random, and its ID commits to that key.
Content keys derive within one Epoch and cannot derive another Epoch. Retained history may require
several readable Epochs; one effective Epoch receives new protected content.

# Credential delivery

Each eligible Client and Recovery Credential receives an HPKE Key Envelope for every required
Epoch. Signed Authority Events bind exact logical Envelope IDs and recipient sets. The opaque outer
envelope hides target kind and semantic identity from Hosts.

# Recovery

Fresh 128-bit entropy becomes a 12-word English BIP39 phrase. AWSM derives independent recovery
signing and wrapping keys directly from the recovered entropy using fixed domains. It does not use
an optional BIP39 passphrase or bind derivation to an Account, Host, Vault ID, or value discoverable
only after decryption.

# Content and storage encryption

Canonical inner Records and Objects retain stable logical IDs. Each Replica destination uses fresh
outer nonce and padding, producing a different Opaque Storage Item ID. Every nonce, padding byte,
header, context, frame position, final flag, plaintext length, and payload digest required by the
construction is authenticated.

# Limitations and erasure

Key rotation protects future writes but does not revoke old keys or plaintext already possessed.
Vacuum changes accepted history but cannot erase offline copies. Secure deletion claims are limited
to exact locally verified bytes and platform guarantees.

# References

- `docs/specifications/crypto/key-derivation.md`
- `docs/specifications/crypto/object-encryption.md`
- `docs/specifications/storage/opaque-envelope.md`
