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
or erase other Replicas. Exact responsibility for billing ownership, final manager loss, grace, and
automatic reaping remains in the corresponding Roadmap initiative before server schema freeze.

# Current implementation status

The existing Rails application implements an earlier Account, Device, Recovery Kit, and Generation-
aware synchronization experiment. Its generated OpenAPI remains evidence of that current code.
Converging it to this opaque target requires a destructive pre-release schema and API replacement,
not a compatibility layer. Production remains outside any documentation-only change.

# References

- `docs/architecture/16-opaque-replica-protocol.md`
- `docs/specifications/protocol/protocol.md`
- `docs/architecture/20-deployment-and-operations.md`
