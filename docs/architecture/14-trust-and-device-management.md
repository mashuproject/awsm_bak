# Trust & Device Management

**Document:** `architecture/14-trust-and-device-management.md`

**Status:** Draft

**Owner:** Engineering

**Depends On:**

- architecture/03-zero-knowledge.md
- architecture/04-security-model.md
- architecture/08-synchronization.md

---

# Purpose

This document defines how devices are trusted, authorized, and revoked within Archive Platform.

The platform follows a zero-knowledge model.

The Coordination Server authenticates devices but cannot decrypt Vault contents.

---

# Design Goals

The trust model must provide:

- secure device enrollment
- secure key distribution
- device revocation
- device auditing
- offline operation after enrollment
- extensibility for future enterprise features

---

# Philosophy

A Vault belongs to a user.

Access to a Vault is granted through trusted devices.

Trust is established cryptographically rather than by server-side access to plaintext data.

---

# Domain Model

```
Vault

↓

Trusted Devices

↓

Wrapped Vault Root Keys

↓

Events
```

The Vault owns the encryption keys.

Devices receive wrapped copies.

---

# Device Identity

Every device has a stable identity.

Properties include:

- Device ID
- Public Key
- Device Name
- Device Type
- Platform
- Client Version
- First Enrollment Time
- Last Seen Time

Private keys never leave the device.

---

# Device States

Devices may exist in one of the following states:

Pending

Trusted

Revoked

Expired (future)

Disabled (future)

Only current certified Devices receive key envelopes for synchronized Vault contents.

---

# Enrollment

Enrollment establishes trust.

Typical flow:

```
New Device

↓

Generate Key Pair

↓

Authenticate User

↓

Enter And Confirm Current Recovery Phrase

↓

Recovery Administrator Certifies Device

↓

Upload Signed Key-Epoch Envelopes

↓

Synchronization Begins
```

The Coordination Server never receives plaintext Vault Root Keys.

---

# Enrollment Authority

The extension decrypts the current Recovery Kit with the 12-word Recovery Phrase, creates a fresh
Device signing/wrapping identity, signs its certificate and key-epoch envelopes with the recovery
administrator key, and proves possession of the Device signing key. A second Device is not required
to approve or relay enrollment.

---

# Device Key Envelopes

Each current certified Device receives its own signed encrypted envelope for every readable Key
Epoch. Every envelope is bound to one Device certificate, Recovery Generation, and Key Epoch.
Compromise of one Device wrapping secret does not reveal another Device's secret.

---

# Device Revocation

Revocation blocks future server access.

```
Revoke Device

↓

Revoke Device Sessions And Reject New Synchronization
```

Revocation cannot erase previously downloaded content. Future Protection rotates recovery authority
and the active Key Epoch when future-content protection is required.

---

# Future Protection

Typical sequence:

```
Select Devices To Retain

↓

Generate New Recovery Phrase And Recovery Generation

↓

Create New Key Epoch And Retained-Device Envelopes

↓

Compare-And-Swap Server Authority
```

Historical Objects remain encrypted under their original Key Epoch. Authorized retained Devices
receive the complete readable epoch set; removed Devices receive no new-epoch envelope.

---

# Device Capabilities

The model supports future capability restrictions.

Examples:

- Read-only
- Capture disabled
- Processing disabled
- Synchronization disabled
- Administrative

The MVP grants identical capabilities to all trusted devices.

---

# Lost Device Recovery

If a certified Device is lost:

1. Remove the Device to revoke its future server access.
2. Use Future Protection if it may possess compromised key material.
3. Recover a fresh installation with the Account password and current Recovery Phrase when needed.

The lost Device cannot receive new synchronization responses or new Key Epoch envelopes.

---

# Offline Behavior

Once enrolled, a Device may use already downloaded content offline. Synchronization resumes when
connectivity returns. Offline unpublished work created under a stale Key Epoch is re-authored under
the active epoch before publication.

---

# Server Responsibilities

The Coordination Server stores:

- Device metadata
- Public keys
- Device certificates and revocation state
- Encrypted Recovery Kits
- Signed Device key envelopes
- Recovery Generation and Key Epoch metadata

The server cannot decrypt Vault data.

---

# Client Responsibilities

The Client Runtime:

- Generates device keys.
- Stores private keys securely.
- Derives recovery authority only during an explicit phrase ceremony.
- Creates and verifies Device certificates and key envelopes.
- Enrolls, removes, and future-protects Devices.
- Wipes phrase and recovery private material after every ceremony.

---

# Security Considerations

Private keys should use platform secure storage where available.

Examples:

- WebCrypto non-exportable keys
- macOS Keychain
- Windows Credential Manager / DPAPI
- Linux Secret Service (where available)

Fallback mechanisms must be clearly identified to users.

---

# Future Extensions

Potential enhancements include:

- Multiple users per Vault
- Shared Vaults
- Organization-managed Vaults
- Hardware-backed attestation
- Threshold recovery
- Emergency access
- Device health checks

These should extend the trust model without changing the core synchronization architecture.

---

# Design Decisions

## Why Device Keys?

Each device has an independent cryptographic identity, enabling selective trust and revocation.

---

## Why Device Key Envelopes?

Key Epochs preserve historical readability while allowing each certified Device independent access
and selective future exclusion.

---

## Why Recovery Phrase Enrollment?

A fresh installation can recover with user-held authority when no other Device remains online,
without granting the Coordination Server decryption power.

---

## Why Transport-Independent Enrollment?

The trust model should support browsers, desktop applications, and future mobile clients without redesign.

---

# Deferred Policy

Automatic inactive-Device expiry, restricted Device capabilities, and enterprise policy require
separate contracts. They do not alter the current Recovery Phrase, certificate, revocation, or
Future Protection model.

---

# References

- `docs/architecture/15-coordination-server.md`
- `docs/architecture/16-archive-protocol.md`
- `docs/architecture/18-cryptography.md`
