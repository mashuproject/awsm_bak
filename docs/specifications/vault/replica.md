# Replica and Host Boundary Specification

**Document:** `docs/specifications/vault/replica.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/storage/opaque-envelope.md`
- `docs/specifications/vault/vault.md`

# 1. Purpose

This specification separates portable Vault state from its materializations and from the local
access policy of a service that stores one. It defines semantic boundaries; an executable Host API
owns its current wire schema.

# 2. Replica

A Replica is one materialization of one Vault at one Client- or Host-managed storage location. It
may be complete, sparse, stale, offline, or converged. A Vault may have zero or more Replicas.

A Replica has no portable Replica ID. Local storage may use an implementation identifier, and a
Host uses a Host-local Hosted Replica handle, but neither enters Vault Records or changes Vault
identity.

# 3. Client Installation and Host

A Client Installation is a trusted software boundary that operates on Vault plaintext and private
keys. It may manage zero or more Replicas and Client Credentials. Browser, desktop, mobile,
headless, and thin clients are deployment forms, not authority classes.

A Replica Host exposes storage or synchronization access to a Replica. It need not decrypt the
Vault or author Events. One installation may be both a trusted Client and a Replica Host. A thin
implementation may be only a Client; an opaque storage service may be only a Replica Host.

# 4. Account and channel policy

An Account is an optional Host-local Channel Principal. It identifies a user to that Host through
one or more Channel Authenticators, such as username/password, bearer token, SSH key, or another
Host-defined mechanism. Accounts are local to their Host, like accounts on a federated server.

A Replica Access Grant binds one Host, Hosted Replica handle, Channel Principal, exact capability
set, and lifecycle. The initial semantic capabilities are:

```text
awsm.replica.inventory.read
awsm.replica.item.read
awsm.replica.item.write
awsm.replica.hint.read
awsm.replica.hint.write
awsm.replica.manage
```

An executable API may give these numeric or route-specific encodings but MUST preserve their
scope. Named Host roles may be presentation shortcuts only. Grant deletion, Account deletion, and
session expiry never alter Vault membership or decryptability of copies already possessed.

# 5. Opaque Host knowledge

An opaque Replica Host may know:

- its local Hosted Replica handle;
- the Channel Principals and Grants permitted to use that handle;
- Opaque Storage Item IDs, per-Hosted-Replica opaque locators, byte lengths, storage classes,
  admission state, and cursors;
- quota, billing, rate-limit, operational, and abuse-policy state; and
- ephemeral Wake Hints without portable semantic meaning.

It MUST NOT require plaintext Vault IDs, member IDs, Credential IDs, Record kinds, Event types,
parent links, logical dependency IDs, labels, URLs, content, Key Epoch IDs, or search terms. A
trusted Client privately reconstructs those relationships after retrieval and decryption.

Each Hosted Replica also has one Host-local 32-byte locator salt that authorized Clients use to
derive opaque item locators. It is Remote configuration, not portable Vault state or a credential.
The salt differs between Hosted Replicas, so a Host-visible locator never correlates the same
logical item across Hosts.

# 6. Remotes and synchronization

A Remote is Client Installation configuration describing how one local Replica can access another
Replica through a Channel. A Vault may have zero or more Remotes. Remotes are local configuration,
not Vault membership and not synchronized Vault state.

The Remote's endpoint, name, Hosted Replica handle, locator salt, and local pull policy are
Installation State. Its Channel Authenticator is a separate installation-wrapped Trusted Secret.
For the reference Host, a username and password are transient sign-in input only; the Client may
retain a rotated access/refresh session pair without retaining the password. Session expiry and
refresh are Host-local channel policy, not Vault time, membership, or authority.

The current reference-Host setup flow signs in with those transient credentials, creates one
Host-local Hosted Replica, requires inventory-read, item-read, and item-write capabilities, then
atomically records the local Remote configuration and rotating session pair. It sends no Vault or
protected logical identity during setup. It validates the complete local Remote configuration before
requesting Host access or contacting the Host, so malformed local input cannot create an unused
Hosted Replica or prompt for an unrelated Host. A missing required capability leaves no local Remote
configuration. User-facing Remote management is an
independent Client workflow. The current popup lists only non-secret local Remote summaries and
offers this setup flow after an explicit Host-permission gesture. Creating a Hosted Replica does not
itself synchronize or materialize Vault data.

Synchronization is initiated as a pull by the receiving Client. A Host may send an untrusted Wake
Hint that causes a Client to pull, but does not push authoritative Vault state. Pull may occur on
open, explicit refresh, a local schedule, network reconnection, or after a hint. No Remote is an
origin or single source of truth.

# 7. Sparse Replicas and Storage Relief

An On-demand Replica retains the complete Continuity Proof, enough authoritative compact state,
protected resolution state, and retrieval configuration to discover and request missing wrappers.
Missing local bytes remain part of the Vault when another reachable Replica can supply them; the
local Replica does not pretend they are present.

Storage Relief may remove a locally available heavy wrapper after a clear warning. A Client cannot
prove global redundancy without centralized peer inventory and therefore neither blocks relief nor
claims safety. The user is responsible for keeping another usable Replica or export when desired.

# 8. Host lifecycle

A Host may enforce quotas, reject writes, suspend Grants, collect opaque unreachable items under an
explicit Host policy, or reap a Hosted Replica after it has no active Grants. These are Host
operations, not Vault Events. A Host failure or deletion cannot make retained copies cease to be
the same Vault.

# 9. Invariants

- Portable Vault authority never depends on an Account or Host.
- A Host credential grants channel access, not Vault membership.
- A Hosted Replica is another Replica, not the Vault's owner or sequencer.
- Clients synchronize; Hosts store and expose according to local policy.
- No client claims complete redundancy or global freshness it cannot prove.
- Peer inventory is not part of the base architecture.

# References

- `docs/specifications/protocol/protocol.md`
- `docs/specifications/runtime/synchronization.md`
- `docs/specifications/storage/object-store.md`
