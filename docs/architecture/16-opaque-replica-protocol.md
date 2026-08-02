# Opaque Replica Protocol Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/08-synchronization.md`
- `docs/architecture/15-coordination-server.md`

# Purpose

The Replica protocol exposes a strict database-like authenticated Channel for opaque immutable
items. It deliberately knows less than the Vault synchronization logic running in trusted Clients.

# Resources

- service limits and authenticated principal state;
- Host-local Hosted Replica handles and exact capabilities;
- snapshot-bounded opaque inventory pages;
- immutable Compact and resumable Streamable item admission;
- exact full or ranged reads; and
- advisory Wake Hint cursors.

Account, session, password, token, and Grant resources belong to Host policy. Vault members,
Credentials, Records, parents, dependencies, Generations, and conflicts never appear as Host
protocol resources.

# Strict wire evolution

The base target has one exact schema with rejected unknown fields. There is no compatibility
reader, downgrade, dual protocol, or legacy alias. Vault semantic evolution stays inside encrypted
Required Features and does not require the Host to understand it.

# Pull relationship

The receiving Client initiates inventory and reads and validates locally. A separate destination-
write workflow may create fresh destination-specific opaque representations at the same or another
authorized Remote. Wake Hints only cause another pull. Cursor order is delivery convenience, not
causal order.

# Executable contract

The checked-in OpenAPI is the canonical executable HTTP adapter and is validated on every matching
Rails request and response. The reference Host now implements the opaque transport resources in
this document; no semantic Vault route remains. Current focused proof covers Host opacity,
capability isolation, immutable retries, bounded envelope verification, snapshot inventory, exact
ranges, resumable promotion and cleanup, quota fencing, and Wake Hints. Multi-Replica Client pull
and independent black-box Host implementations remain separate convergence work.

# References

- `docs/specifications/protocol/messages.md`
- `docs/specifications/protocol/errors.md`
- `docs/specifications/storage/opaque-envelope.md`
