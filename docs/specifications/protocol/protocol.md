# Opaque Replica Protocol Specification

**Document:** `docs/specifications/protocol/protocol.md`

**Version:** 1.0

**Status:** Draft target contract

**Depends On:**

- `docs/specifications/storage/opaque-envelope.md`
- `docs/specifications/vault/replica.md`

# 1. Authority and implementation status

This document defines the canonical semantics for access to an opaque Hosted Replica. The
checked-in `http-api.openapi.yaml` is the executable initial HTTP adapter for this contract. The
reference Rails Host implements Account sessions, Hosted Replicas and Grants, Compact admission,
snapshot inventory, exact full and ranged reads, Wake Hints, resumable Streamable admission, and
durable Hosted Replica reaping.
That repository evidence does not by itself prove a deployed environment, a second Host
implementation, or Client synchronization.

# 2. Trust boundary

The Host authenticates a Channel Principal and evaluates Host-local Replica Access Grants. It
stores and transfers exact Opaque Storage Items. It does not validate Vault IDs, Generations,
Events, parents, dependencies, members, Credentials, Key Epochs, or content. Trusted Clients do all
semantic validation after pull.

# 3. Base operations

An implementation exposes these operations under one strict wire contract:

| Operation                     | Required capability           | Semantics                          |
| ----------------------------- | ----------------------------- | ---------------------------------- |
| Read service policy           | authenticated principal       | bounded transfer and paging limits |
| List granted Replicas         | authenticated principal       | Host-local handles only            |
| Create Hosted Replica         | authenticated principal       | new Host-local handle and Grant    |
| Issue or revoke Replica Grant | `awsm.replica.manage`         | Host-local access lifecycle        |
| Reap Hosted Replica           | `awsm.replica.manage`         | fence then delete opaque Host data |
| Enumerate opaque items        | `awsm.replica.inventory.read` | snapshot-bounded pages             |
| Read opaque item or range     | `awsm.replica.item.read`      | exact immutable bytes              |
| Admit opaque item             | `awsm.replica.item.write`     | immutable verified outer bytes     |
| Read or wait for Wake Hint    | `awsm.replica.hint.read`      | advisory cursor only               |
| Publish Wake Hint             | `awsm.replica.hint.write`     | advisory cursor advancement        |

Accounts, usernames, passwords, bearer tokens, sessions, quotas, and Grant management use the
Host's owning API. No email field is part of the reference Account model. Revoking the final
active Grant fences the Hosted Replica for reaping. An authorized explicit reap revokes every
active Grant, fences the Hosted Replica, and returns a Host-local durable job identifier before
opaque bytes are removed.

# 4. Item admission

The client supplies one complete Compact item or one resumable Streamable item. The Host validates
the exact outer envelope, limits, ciphertext digest, and domain-separated Opaque Storage Item ID
without interpreting protected semantics.

Admission is immutable:

- absent ID plus valid exact bytes stores one item;
- existing ID plus identical bytes is idempotent success;
- existing ID plus different bytes is an integrity conflict; and
- an incomplete stream is invisible to inventory until final verification and atomic promotion.

Resumable transfer uses Host-local opaque upload IDs and exact byte offsets. Tickets and upload IDs
never enter Vault state. Preparation creates independently expiring Prepared Data plus a shorter-
lived bearer transfer capability. The same Account Channel Principal may rotate that capability
while the upload remains staged; the old bearer becomes ineffective immediately. A Host may reject
admission for quota, policy, or rate limits.

# 5. Inventory

Inventory pages contain only Opaque Storage Item ID, storage class, exact total byte length, and a
Host-local immutable-item cursor. A request fixes a snapshot cursor. Following pages return items
after the caller's position and no later than that snapshot. Ordering is bytewise Opaque Storage
Item ID or another exact Host-documented stable opaque order and has no Vault meaning.

The Host MUST NOT expose another Hosted Replica's inventory. The client treats the page as an
untrusted availability claim and verifies every downloaded item.

# 6. Reads and ranges

Compact items are read in full. Streamable items permit exact byte ranges aligned or expanded under
the outer framing contract. Responses bind item ID, complete length, returned range, and outer
digest metadata. A partial response is never interpreted as a complete Artifact.

# 7. Wake Hints

A successful item admission may advance an opaque per-Hosted-Replica hint cursor. A Client may wait
for or poll that cursor, then performs ordinary inventory pull. Hints contain no Vault ID, Record
ID, type, member, or semantic change and may be duplicated, delayed, coalesced, or lost.

# 8. Concurrency and consistency

Opaque items are additive and immutable, so concurrent admission cannot overwrite Vault history.
The Host uses ordinary strongly consistent transactions for Grants, quotas, item promotion, cursor
advancement, and reaping. Conditional writes protect those Host-local rows. The Host does not
implement a portable Vault spinlock, Generation head, or Event sequencer.

# 9. Privacy

The Host minimizes logs and responses. Cross-principal existence is non-disclosing. Transfer
capabilities, authenticators, session data, inventory, identifiers, and operational IDs are
sensitive. Diagnostic text never includes item bytes, secrets, or protected guesses.

# 10. Strictness

The one initial protocol rejects unknown required fields, duplicate fields, malformed base64url,
unsafe integers, unsupported methods, and invalid outer envelopes. There is no pre-release
compatibility reader, alternate old schema, field alias, or downgrade. Required Vault Feature
evolution occurs inside encrypted items and is invisible to the Host.

# References

- `docs/specifications/protocol/messages.md`
- `docs/specifications/protocol/errors.md`
- `docs/specifications/runtime/synchronization.md`
