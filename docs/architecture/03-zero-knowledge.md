# Zero-Knowledge Architecture

**Document:** `docs/architecture/03-zero-knowledge.md`

**Status:** Draft

**Owner:** Architecture

**Depends On:**

- `docs/architecture/00-design-principles.md`
- `docs/architecture/01-system-overview.md`
- `docs/architecture/02-domain-model.md`
- `docs/architecture/glossary.md`

---

# Purpose

This document defines the zero-knowledge boundary for Archive Platform.

Zero knowledge means the Coordination Server and storage providers can coordinate synchronization, authentication, authorization, billing, and operations without access to plaintext Vault contents or the keys required to decrypt them.

---

# Trust Boundary

```text
Plaintext Vault data

↓

Trusted Host + Runtime

↓

Encryption boundary

↓

Encrypted Objects, Events, and wrapped keys

↓

Coordination Server and Object Storage
```

Plaintext exists only inside trusted client environments.

---

# Trusted Components

Trusted components include:

- Runtime
- Host integrations that expose platform capabilities
- Storage Service while operating on local encrypted Objects
- Capture, Search, AI, Projection, Event, Synchronization, and Trust Services running inside the trusted Runtime

Trusted components may access plaintext only when the active Vault is unlocked.

---

# Untrusted Components

Untrusted components include:

- Coordination Server
- PostgreSQL or other server metadata stores
- Object storage providers
- Redis, queues, logs, metrics, and observability infrastructure
- CDNs and reverse proxies

These components must operate on ciphertext, opaque identifiers, wrapped keys, protocol messages, and coordination metadata only.

---

# Server-Visible Data

The Coordination Server may store or observe:

- Account and Vault operational identifiers;
- broad Object type, ciphertext length, ciphertext SHA-256, and encrypted Object ID;
- Event ordering timestamp and exact declared dependency Object IDs;
- Vault Generation identity, number, predecessor, complete retained membership, and recovery deadline;
- upload, ticket-digest, idempotency, Delivery Cursor, and Purge Job state; and
- safe operational counters and outcomes.

The reference ephemeral-coordination adapter stores a namespaced Cable-ticket SHA-256 key, its
Account UUID value, and a TTL in Redis. Redis also observes content-free Action Cable channel
names and `{vaultId, latestCursor}` wake-up payloads. It receives no raw Cable ticket, Vault
plaintext, ciphertext payload, key material, URL, title, or semantic metadata.

Complete retained membership leaks encrypted graph shape and recovery size. This bounded leak is
accepted to prevent unsafe remote deletion. Production promotion requires an explicit traffic-analysis
and metadata-budget review.

This data exists to coordinate replicas. It must not be sufficient to reconstruct Vault contents.

---

# Server-Hidden Data

The server must not receive:

- plaintext Bundle contents
- plaintext Artifact payloads
- plaintext Event payloads that reveal Vault semantics
- Vault Root Keys or unwrapped subordinate keys
- Search Projection Materializations
- AI prompts, summaries, embeddings, OCR, notes, tags, or titles in plaintext
- decrypted archive rendering data

---

# Client Responsibilities

The Runtime is responsible for:

- decrypting Vault data after local authorization
- creating Bundles
- creating and validating Events
- encrypting Objects before synchronization
- wrapping keys for trusted devices
- rebuilding Projections and Search Projection Materializations locally
- executing AI processing locally unless the user explicitly enables a remote provider

---

# Server Responsibilities

The Coordination Server is responsible for email/password Account authentication without receiving
the password, one-Vault Account authorization, opaque Account/Vault key envelopes, opaque byte
durability, exact declared Event closure publication, independent per-Vault Delivery Cursors,
Generation fencing, explicit recovery retention, safe purge, and advisory notifications. Device
authorization, Account Recovery Keys, quotas, abuse controls, and shared Vault authority remain
deferred.

The server never reconstructs Vault state from plaintext. It may validate protocol structure, signatures, permissions, quotas, and object integrity metadata.

---

# Metadata Policy

Metadata is classified by necessity.

Operational metadata may remain plaintext when required for coordination:

- Vault ID
- Device ID
- protocol version
- Object Identifier
- Object Type
- object size
- Delivery Cursor

User-visible metadata must be encrypted before synchronization:

- titles
- URLs where not required for transport or explicit user-visible sharing
- notes
- tags
- summaries
- extracted text
- OCR
- embeddings
- folder names

When uncertain, metadata is treated as private.

---

# AI and Remote Providers

AI is a trusted Runtime capability by default.

Remote AI providers are incompatible with zero knowledge unless the user explicitly opts in for a specific provider, capability, and scope. Opt-in remote processing is an exception to the default trust boundary and must be visible to the user.

Remote provider outputs that become part of the Vault are stored as encrypted Artifacts and recorded by Events.

---

# Device Trust

Access to a Vault is granted by wrapping Vault key material for trusted devices.

The server may store wrapped keys but cannot unwrap them. Revocation prevents a device from receiving future wrapped keys or synchronization updates, but it cannot erase data already synchronized to that device.

---

# Invariants

- Plaintext does not leave trusted client environments by default.
- The Coordination Server never possesses unwrapped Vault keys.
- Search, AI, rendering, and Projection rebuilding do not require backend plaintext access.
- Synchronization operates on encrypted Objects, encrypted Event payloads, wrapped keys, and coordination metadata.
- Operational metadata is minimized and never treated as authoritative Vault content.

---

# References

- `docs/architecture/04-security-model.md`
- `docs/architecture/14-trust-and-device-management.md`
- `docs/architecture/18-cryptography.md`
- `docs/specifications/crypto/crypto.md`
- `docs/specifications/protocol/protocol.md`
