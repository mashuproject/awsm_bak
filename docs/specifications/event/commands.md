# Command Specification

**Document:** `docs/specifications/event/commands.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/event/event.md`
- `docs/specifications/event/event-format.md`
- `docs/specifications/vault/authority.md`

# 1. Purpose

A Command is an ephemeral request to one trusted Client Runtime. Commands are local workflow
inputs, never Vault Records, and never synchronized. An accepted Command may atomically produce
Events, Objects, local state, or no change.

# 2. Context

A Vault-writing Command identifies the local Client Credential, exact Vault and Generation,
expected accepted Frontier, Command type, canonical input, and a Runtime-local idempotency key.
User-interface context, timestamps, Account sessions, and Remote selection are local fields and
MUST NOT become Event authority unless the owning Event schema explicitly requires a value.

# 3. Execution

The Runtime MUST:

1. resolve the selected Vault and make its keys available through the normal open flow;
2. validate input, Required Features, dependencies, authority, conflicts, and scoped fences;
3. prepare every immutable Object and exact Event body;
4. compare-and-swap the complete accepted Frontier at commit;
5. if the Frontier changed, discard unsigned or signed candidates and revalidate from step 2;
6. atomically commit every authoritative result and coupled Replica Safety update, or none; and
7. update disposable Materializations only in the same commit or by replay afterward.

Commands do not edit an Event, append to a partial parent set, or treat Host acceptance as Vault
acceptance.

# 4. Authorization

Ordinary content and organization Commands require one active member using an active Client
Credential. Authority, lifecycle, conflict-resolution, and rewrite Commands use their exact Event
rules. A Host-local Channel Principal or Replica Access Grant may permit transport but never
substitutes for portable Vault authorization.

# 5. Offline and fenced work

When protected writes are fenced or the author is no longer a member, the Runtime avoids knowingly
creating an invalid Event. It may keep a complete Capture result in Prepared Data, offer Fork or
Export, or later create a valid Event through the defined Event Re-authoring flow. Prepared output
is not authoritative and is never presented as synchronized Vault state.

# 6. Command families

The initial Runtime exposes Commands for:

- Vault creation, selection, label, Fork, Export, Vacuum, adoption, and Closure;
- Capture registration, deletion, restoration, Collection routing and organization;
- Folder, Tag, and Note creation and management;
- Invitation, membership, administration, Credential, recovery, Key Epoch, and feature workflows;
- synchronization, Storage Relief, retrieval, integrity checking, and local Garbage Collection.

The exact Event bodies are owned by `docs/specifications/vault/authority.md`,
`docs/specifications/vault/collection.md`, and `docs/specifications/vault/vacuum.md`. Runtime-only
Commands such as select, open, synchronize, retrieve, export, and collect need not produce Events.

# 7. Failure and idempotency

Validation failure produces no authoritative output. Stable workflow keys make retries safe, but
portable idempotency depends on authenticated logical identities and Event semantics rather than a
synchronized Command ID. Partial success is prohibited at every declared atomic boundary.

# 8. Invariants

- Commands are ephemeral and local.
- Only a Client Credential authors a Vault Event on behalf of a member.
- Every committed Event names the complete accepted causal and Authority Parent Frontiers.
- Projections never become authority through Command execution.
- No Command bypasses Required Feature, authority, or dependency validation.

# References

- `docs/specifications/vault/collection.md`
- `docs/specifications/vault/vacuum.md`
- `docs/specifications/runtime/runtime.md`
