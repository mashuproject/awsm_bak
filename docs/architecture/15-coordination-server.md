# Reference Replica Host Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/03-zero-knowledge.md`
- `docs/specifications/vault/replica.md`

# Purpose

The reference coordination server is one optional Account-supporting opaque Replica Host. It is not
the Vault, a privileged Replica, a member, an Event sequencer, or a required web Vault client.

# Reference responsibilities

The Rails service may provide:

- username/password Accounts with no email field;
- sessions and other Channel Authenticators;
- Hosted Replica creation and lifecycle;
- exact Replica Access Grants;
- opaque immutable item admission, inventory, reads, ranges, and Wake Hints;
- quotas, rate limits, abuse policy, billing, and operational support; and
- an Account and access-management dashboard.

The dashboard manages Host-local identity, authenticators, sessions, Grants, and storage. It does
not render Vault plaintext, duplicate the extension's local Vault, or equate a browser session with
a Vault Member.

# Opaque data model

Host Policy State relates Account or another Channel Principal to one Host-local Hosted Replica
handle through capability Grants. Stored Vault bytes are addressed only by randomized Opaque
Storage Item IDs plus outer class and length. Portable IDs and semantic graph shape stay encrypted.

# Concurrency

Immutable item writes are idempotent and cannot overwrite history. Database transactions and
conditional updates serialize Host-local Grant, quota, cursor, session, and lifecycle changes. No
Host-global Vault spinlock or Generation head is needed.

# Lifecycle and reaping

A Host may reject writes, enforce quota, suspend access, and reap a Hosted Replica under disclosed
local policy, including after no active Grant remains. These actions never change Vault membership
or erase other Replicas. The reference Host immediately fences a Replica when its final active
Grant is revoked, or when a manager explicitly requests reaping; it records durable reaping work
before deleting opaque bytes. A failed or undispatched standalone reaping job is periodically
redriven. Billing ownership, grace policy, and any automatic policy beyond final-Grant reaping
remain future Host concerns.

# Current implementation status

The repository Rails application now uses the destructive canonical Host Policy and opaque-storage
schema. It has no Device, Recovery Kit, Vault, Generation, Event, dependency, or semantic delivery
tables or routes. Its executable OpenAPI and request proofs cover Account sessions, the dashboard,
Hosted Replicas and Grant issue/revocation, opaque admission/inventory/read/range operations,
resumable Prepared Data, Wake Hints, and fenced asynchronous reaping. Multi-Host Client
synchronization and any named deployment require separate evidence.

# References

- `docs/architecture/16-opaque-replica-protocol.md`
- `docs/specifications/protocol/protocol.md`
- `docs/architecture/20-deployment-and-operations.md`
