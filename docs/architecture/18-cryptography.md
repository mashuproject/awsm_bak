# Cryptography Specification

**Document:** `architecture/18-cryptography.md`

**Status:** Draft

**Owner:** Engineering

**Depends On:**

- architecture/03-zero-knowledge.md
- architecture/04-security-model.md
- architecture/14-trust-and-device-management.md
- architecture/16-archive-protocol.md

---

# Purpose

This document specifies the cryptographic architecture used throughout Archive Platform.

The goal is to protect Vault contents while allowing an untrusted Coordination Server to synchronize encrypted data.

This document defines cryptographic responsibilities and key relationships.

Formal cryptographic specifications own the exact canonical algorithms and vectors. This document
owns responsibilities and relationships and must remain consistent with those specifications.

---

# Design Goals

The cryptographic architecture must provide:

- zero-knowledge storage
- authenticated encryption
- explicit canonical algorithms
- key rotation
- device enrollment
- algorithm agility
- deterministic key derivation where appropriate

---

# Philosophy

The client owns plaintext.

The server owns ciphertext.

Encryption occurs before synchronization.

Decryption occurs only on trusted devices.

---

# Trust Boundary

```
Plaintext

↓

Client Runtime

↓

Encryption Boundary

↓

Ciphertext

↓

Coordination Server

↓

Object Storage
```

Plaintext never crosses the encryption boundary.

---

# Key Hierarchy

```
Recovery Phrase entropy

├── Recovery Kit wrapping key
└── Recovery administrator seed
        ↓
  encrypted Recovery Kit
        ↓
  key-epoch root keys

Certified Device wrapping key
        ↓
  signed Device key envelopes
        ↓
  key-epoch root keys

Active key-epoch root key

├── Bundle Key
├── Event Key
├── Artifact Key
├── Metadata Key
└── Future Keys
```

Keys should be derived rather than randomly generated independently where appropriate.

The Account password is an identity credential and never participates in Vault cryptography.
Local-only Vaults use their mandatory local Device slot. A synchronized Vault uses Recovery
Generation authority and certified Device envelopes. Each encrypted Object binds the Key Epoch whose
root key derives its encryption key.

---

# Key Responsibilities

## Account Password

Rails receives the password over TLS, verifies it against the Account password digest, and never
returns it to the extension. Password change revokes Account and VaultDevice sessions but does not
rotate or recover Vault keys.

## Recovery Phrase

The 12-word Recovery Phrase encodes 128 bits of client-generated entropy. Domain-separated
derivation produces a Recovery Kit wrapping key and recovery administrator signing seed. The phrase,
entropy, and derived secrets never cross the server boundary or persist after a ceremony.

---

## Vault Root Key

Root of the Vault's cryptographic hierarchy.

Used to derive subordinate keys.

---

## Bundle Key

Protects immutable Bundle contents.

---

## Event Key

Protects encrypted Event payloads.

---

## Artifact Key

Protects derived Artifacts.

---

## Metadata Key

Protects synchronized encrypted metadata.

---

# Device Keys

Each trusted device possesses:

- Device Private Key
- Device Public Key

Private keys remain on the device.

Public keys are synchronized.

---

# Wrapped Keys

Key-epoch root keys are wrapped individually for each certified Device. Each envelope is signed by
the active recovery administrator and bound to the Device certificate, Recovery Generation, Vault,
and Key Epoch. The Coordination Server stores wrapped keys only.

The initial browser Host uses a non-exportable device key to wrap the Vault Root Key locally. Local-only Vaults do not persist a passphrase wrapper. A passphrase-derived wrapper exists only inside a user-created Vault Package and is independent of local unlock state.

Bundle Descriptor, Artifact, Event, and Projection keys are context-derived and are not stored as
individually wrapped keys in the initial implementation.

---

# Encryption Pipeline

```
Compact Object

↓ canonical serialize and encrypt

Inline encrypted record

Artifact stream

↓ chunk-frame and encrypt

External immutable wrapper
```

Encryption precedes synchronization.

Large Artifact encryption and hashing are incremental and bounded-memory.

---

# Event Encryption

Only Event payloads require confidentiality.

Routing information required for synchronization may remain unencrypted if necessary.

Sensitive metadata should remain encrypted whenever practical.

---

# Artifact Encryption

Artifacts remain immutable and are encrypted independently before storage. Each Artifact key uses
domain `vault:artifact:v1` and its Artifact Object UUID as context. The authenticated wrapper binds
the header and every monotonically indexed frame, including a final empty frame when the plaintext
is empty. Readers validate wrapper and plaintext length/checksum before successful completion.

---

# Metadata Protection

User-visible synchronized metadata should be encrypted.

Examples include:

- archive titles
- notes
- tags
- AI summaries (if synchronized)

Operational metadata required for coordination may remain plaintext.

Examples include:

- protocol version
- block identifiers
- timestamps required for synchronization
- device identifiers

---

# Authentication

Every encrypted object should provide integrity protection.

Tampered ciphertext must be detected before use.

---

# Key Rotation

The platform supports independent rotation of:

- Vault Root Key
- Device Keys

Future versions may support independent rotation of subordinate keys.

Rotation procedures should minimize unnecessary data re-encryption.

---

# Algorithm Agility

Cryptographic algorithms must be versioned.

Encrypted objects should record:

- algorithm identifier
- key version
- object format version

Before the first release, these identifiers describe only the canonical current formats and do not authorize alternate readers.

---

# Randomness

All cryptographic randomness must originate from the host platform's cryptographically secure random number generator.

---

# Secure Storage

Long-lived secrets should use platform secure storage where available.

Examples:

- WebCrypto non-exportable keys
- macOS Keychain
- Windows DPAPI / Credential Manager
- Linux Secret Service

An adapter that cannot meet the secure-storage contract must report the capability as unavailable rather than weakening storage.

---

# Synchronization

The Coordination Server stores only:

- ciphertext
- wrapped keys
- encrypted Event payloads
- encrypted Blocks

The server never derives plaintext.

---

# Cryptographic Versioning

Every encrypted object records:

- format version
- key version
- algorithm version

Only objects using the canonical current cryptographic formats are readable before the first release.

---

# Future Extensions

The architecture should support:

- post-quantum cryptography after an explicit future design decision
- hardware-backed keys
- threshold recovery
- shared Vaults
- delegated decryption
- tenant-managed keys

These should not require redesigning the key hierarchy.

---

# Design Decisions

## Why a Key Hierarchy?

Derived keys isolate cryptographic domains and simplify future rotation.

---

## Why Wrapped Keys?

Each certified Device receives independent key-epoch access without exposing an unwrapped key to
the server.

---

## Why Algorithm Agility?

Cryptographic algorithms evolve. Object formats should accommodate future replacement.

---

## Why Encrypt Before Synchronization?

The server should never observe plaintext application data.

---

# Open Questions

Should Metadata Keys be derived directly from the Vault Root Key or through an intermediate key hierarchy?

Should Vault Root Key rotation be automatic after device revocation?

What explicit release policy should govern any future cryptographic format change?

How should shared Vaults derive participant-specific keys?

---

# References

- `docs/architecture/19-testing-strategy.md`
- `docs/specifications/bundle/bundle.md`
- `docs/specifications/event/event.md`
- `docs/specifications/protocol/protocol.md`
