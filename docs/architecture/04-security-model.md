# Security Model

**Document:** `architecture/04-security-model.md`

**Status:** Draft

**Owner:** Engineering

**Depends On:**

- architecture/03-zero-knowledge.md

---

# Purpose

This document defines the security architecture of Archive Platform.

It specifies:

- trust relationships
- cryptographic ownership
- key hierarchy
- device authorization
- vault access
- revocation strategy

It intentionally does **not** specify cryptographic algorithms. Those are defined in the Cryptography document.

---

# Security Goals

The platform must ensure:

1. Only trusted devices can decrypt vault contents.
2. The backend cannot decrypt user data.
3. Compromising one device should not permanently compromise a vault.
4. Multiple devices can safely share a vault.
5. Devices can be revoked.
6. Cryptographic material can evolve without redesigning the platform.

---

# Security Domains

There are three logical trust domains.

```text
                User

                  │

        Trusted Devices

        Chrome
        Firefox
        Desktop
        Mobile

                  │

         Encrypted Transport

                  │

        Coordination Server

                  │

         Object Storage
```

Only trusted devices possess plaintext vault keys.

---

# Identity

A user account represents an authenticated identity.

The account is **not** the cryptographic owner of archived content.

Instead:

```text
Account

↓

Vault
```

One Account owns at most one synchronized Vault directly. A future separately approved
authorization model may add:

- shared vaults
- organization vaults
- delegated access

Account authentication does not establish Device trust or by itself grant cryptographic Vault
access. Rails receives the Account password over TLS and verifies its digest. The extension then
uses a certified Device and locally protected key envelopes to access Vault content. The server
never receives a Recovery Phrase or unwrapped Vault key. The isolated black-box proof creates and
authenticates an ordinary test Account through the same public Account/session contract as clients;
there is no alternate credential path.

---

# Key Hierarchy

Every key has exactly one responsibility.

```text
Master Secret

↓

Vault Root Key

├── Bundle Key
├── Event Key
├── Artifact Key
└── Metadata Key
```

No key should serve multiple purposes.

---

# Identity Key

The Identity Key uniquely identifies or authenticates a user account.

Responsibilities:

- authenticate vault membership
- establish trust
- sign authorization requests

It does **not** encrypt archive content.

---

# Device Key

Every trusted device generates its own key pair during registration.

The private key never leaves the device.

Responsibilities:

- authenticate the device
- receive encrypted vault keys
- sign synchronization requests

Compromising one device should not expose private keys from other devices.

---

# Vault Root Key

The Vault Root Key is the root encryption key for a Vault.

Responsibilities:

- authorize access to vault contents
- derive or wrap subordinate keys
- enable new devices to access the vault

The Vault Root Key is never stored unencrypted.

---

# Bundle Key

Every Bundle receives its own context-specific encryption key derived from the Vault Root Key using the Bundle ID, Vault ID, domain label, and key version.

Responsibilities:

- encrypt the immutable bundle
- isolate compromise
- enable future key rotation

Bundle Keys are not persisted in the initial implementation. Trusted clients reconstruct them deterministically according to the Key Derivation Specification.

The same pattern applies to Event and Projection keys with distinct domain labels and contexts.

---

# Object Encryption

Bundles are encrypted first.

Only then are they serialized into storage Objects or Blocks.

The storage layer never interprets cryptographic semantics.

Instead:

```text
Bundle

↓

Encrypt

↓

Ciphertext

↓

Store As Objects / Blocks
```

This keeps the storage layer unaware of plaintext semantics.

---

# Device Enrollment

Adding a new Device requires the Account password and the current 12-word Recovery Phrase. It does
not require another Device to be online.

```text
New Device

↓

Generate Device Key Pair

↓

Request Access

↓

Enter And Confirm Recovery Phrase

↓

Recovery Authority Certifies Device And Wraps Key Epochs

↓

Synchronization Begins
```

The coordination server relays encrypted messages but cannot read them.

## Initial Local Browser Slot

Before multi-device enrollment exists, the browser Host stores one mandatory local device wrapper for the Vault Root Key using a non-exportable device key. Local onboarding does not create or retain a passphrase wrapper.

Export passphrases protect individual Vault Packages. They are not local unlock credentials, recovery settings, or persistent Vault state.

---

# Device Revocation

Revocation prevents future synchronization.

Revoking a device:

- invalidates its registration
- prevents receiving new vault updates
- prevents uploading new bundles

Revocation **does not** erase previously synchronized local data.

If a Device is believed to be compromised, ordinary removal blocks future server access. Future
Protection additionally creates a new Recovery Generation, Recovery Phrase, and Key Epoch so the
removed Device cannot decrypt subsequently accepted content.

---

# Key Rotation

The architecture supports independent rotation.

Possible rotations:

- Identity Key
- Device Key
- Vault Root Key
- Bundle Keys

Rotating one key should minimize impact on unrelated components.

For example, rotating a Vault Root Key should **not** require re-encrypting every Bundle immediately. Subordinate keys can be rewrapped or rederived gradually according to the cryptography specification.

---

# Authentication vs Encryption

Authentication proves identity.

Encryption protects data.

These are separate concerns.

Examples:

| Action          | Authentication | Encryption |
| --------------- | -------------- | ---------- |
| Login           | ✓              | ✗          |
| Upload Bundle   | ✓              | ✓          |
| Download Bundle | ✓              | ✓          |
| Billing         | ✓              | ✗          |

---

# Forward Secrecy

Future versions may support stronger forward secrecy for device-to-device communication.

This is outside the MVP.

---

# Account Recovery and Stale-Replica Discard

Archive Platform deliberately separates:

- account recovery
- vault recovery

Losing Account credentials does not erase an already enrolled Device's local access because its
Device material remains sufficient. AWSM collects no email address and provides no Account password
reset. No administrator or server-side Account action can derive a Recovery Phrase or Vault key. A
fresh installation can recover the synchronized Vault with the Account password and current
Recovery Phrase even when no enrolled Device remains.

Stale-Replica discard is different: it keeps the stale Vault read-only, offers a Complete Export,
requires explicit loss acknowledgement, verifies the complete active server Replica, and atomically
replaces the original synchronized Vault without creating another Vault.

Vault replacement is the explicit response when Recovery Phrase authority may be compromised. It
requires a verified Complete Export, rewrites the exact active Vault closure under a new Vault
identity and keys, atomically promotes that candidate, revokes the source Devices, and purges the
old synchronized ciphertext. It cannot erase an adversary's independent copies.

---

# Security Events

The system should record security events, including:

- device enrollment
- device revocation
- vault key rotation
- failed authentication
- recovery attempts

Security logs should avoid exposing private archive metadata.

---

# Security Assumptions

The platform assumes:

- operating systems enforce local permissions
- TLS protects transport
- browsers implement WebCrypto correctly
- users protect their devices with OS-level authentication

Compromise of a trusted client falls outside the zero-knowledge guarantees.

---

# Vault Package Import Security

The Export passphrase, passphrase-derived key, and recovered raw Root Key are confined to the
trusted Runtime and never persisted or logged. The raw Root Key exists only in a scoped callback
long enough to create a fresh local slot and verifier and is wiped on exit. Authentication errors
are deliberately indistinguishable. Complete validation precedes destination writes, and identity
collisions fail closed without modifying or cleaning the existing Vault.

# Open Questions

Should vault access require approval from one device or multiple devices?

Should enterprise vaults support hardware-backed keys?

Should users be able to export wrapped vault keys?

Should hardware security modules be supported?

These questions are deferred until enterprise features are designed.

---

# References

- architecture/05-local-storage.md
- architecture/06-bundle-format.md
- architecture/08-synchronization.md
