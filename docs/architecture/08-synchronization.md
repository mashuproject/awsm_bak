# Synchronization Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/07-content-storage.md`
- `docs/specifications/vault/replica.md`

# Purpose

Synchronization is receiver-initiated pull between Replicas. It transfers opaque immutable items;
the receiving trusted Client reconstructs and validates Vault semantics.

# Topology

A Vault may configure zero or more Remotes. A Remote can reach a hosted opaque Replica, peer
Client, local socket, removable medium adapter, or future transport. No Remote is a canonical
origin or global source of truth.

# Flow

```text
Wake Hint or local trigger
        -> read bounded opaque inventory
        -> fetch unknown items and their inventory locators into Quarantine
        -> verify outer envelope and opaque ID
        -> decrypt and verify logical IDs, Host-local opaque locators, signatures, DAG, dependencies
        -> promote and reduce locally
```

Every Hosted Replica has its own non-portable locator salt. A Client derives one opaque locator per
logical item for that Remote and receives locators for all inventory items. This maps a signed
dependency, including a Key Envelope encrypted for another recipient, to physical candidates
without exposing a global logical identifier or changing the pull-only relationship.

The durable pull Job binds each Quarantined outer item to the exact locator from the Host inventory.
That Host assertion remains untrusted until the Client opens the item, derives its authenticated
logical identity, and recomputes the Remote-specific locator before promotion.

A Client may separately materialize logical items at an authorized Remote by creating fresh
destination-specific opaque representations. That transport write does not make Synchronization a
semantic push or grant the Host authority.

# Convergence

Valid immutable Records and Objects union safely. Concurrent Event heads remain visible. Compatible
facts reduce automatically; conflicts are scoped and explicit. A later Event authored against the
complete accepted Frontier causally joins every head the member observed.

# Generation divergence

A Vacuum successor and its Continuity Proof are verified before local Adoption. Predecessor work is
never automatically discarded or unioned into it. Fork Before Adoption, Complete Export, eligible
Event Re-authoring, decline, and postponement preserve adult user choice.

# CAP choice

Vault content favors availability and partition tolerance with eventual deterministic convergence.
The system does not claim linearizable global Vault state. A Host can separately use strong local
consistency for Accounts, Grants, quotas, immutable admission, and cursors.

# Completeness limits

A Client can prove closure for an observed Frontier, not that no later branch exists elsewhere. It
does not claim global freshness, redundancy, or last-copy safety without evidence unavailable in a
decentralized topology.

# References

- `docs/specifications/runtime/synchronization.md`
- `docs/specifications/protocol/protocol.md`
- `docs/architecture/15-coordination-server.md`
