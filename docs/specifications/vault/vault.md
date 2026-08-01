# Vault Specification

**Document:** `docs/specifications/vault/vault.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/core/serialization.md`
- `docs/specifications/event/event-format.md`
- `docs/specifications/event/reducers.md`
- `docs/specifications/vault/authority.md`

# 1. Purpose

A Vault is AWSM's encrypted, location-independent logical body of authoritative Records and
Objects. It may be materialized by zero or more Replicas. A Replica, Client Installation, Host,
Account, export, projection, or database is never the Vault itself.

# 2. Identity and scope

A Vault has one random 32-byte Vault ID. The ID survives synchronization and Vacuum. A Fork has a
fresh Vault ID. Names, Accounts, members, Hosts, URLs, timestamps, and content do not determine the
ID.

A Vault is multi-member-capable from creation. The creator becomes its first Vault Member and
first Vault Administrator. Membership and administration are portable Authority State. Account
access and Host policy are not.

# 3. Generation and history

A Vault Generation is one continuous Record DAG rooted at exactly one Vault Baseline. Initial
creation uses an Initial Baseline authenticated by the parentless Genesis Event. Vacuum retains
the Vault ID, creates a fresh Generation ID and successor Baseline, and ends the predecessor
Generation.

Portable authority continuity crosses that causal reset through the signed Authority Parent
subgraph. Genesis is its initial root; each Vacuum Event becomes the Authority Parent anchor for
the successor Generation. The resulting Continuity Proof is part of the Vault's permanent
cryptographic identity evidence even though discarded Content history is not successor state.

The active Vault state is the deterministic reduction of one authenticated accepted causal Record
Frontier in one Generation plus its exact Authority Frontier and Continuity Proof. A timestamp,
arrival order, Host cursor, Replica, or Account never selects the state.

# 4. Baseline body

The `baselineBody` in `docs/specifications/event/event-format.md` is this exact canonical CBOR map:

```text
{
  0: 1,                    // baselineBodyFormat
  1: baselineKind,         // 1 Initial, 2 Vacuum successor
  2: contentCheckpoint,    // canonical map owned by vault/collection.md
  3: authorityCheckpoint,  // canonical map owned by vault/authority.md
  4: lifecycleCheckpoint,  // section 4.1
  5: predecessorCommitment // section 4.2; null for Initial
}
```

The enclosing Baseline supplies the Vault ID, Generation ID, Required Feature Set, Advisory
Extensions, and complete typed dependency roots. The body does not duplicate those fields.

Checkpoint codecs assign fresh Baseline Cause IDs to retained Content facts that later Content
Events may remove, revert, supersede, or resolve by name. A consistent mapping is reused when one
retained source cause controls several facts. These identifiers are authenticated state local to
this Baseline and Generation, not DAG parents, predecessor dependencies, or stable entity IDs.

Cause remapping applies only to Content facts whose source Content Events are discarded. Authority
and Lifecycle Event Record IDs remain exact in the Continuity Proof. The authority checkpoint MUST
equal state independently derived at the proof's Generation anchor.

## 4.1 Lifecycle checkpoint

```text
{
  0: lifecycleState // 1 Open; Closure is never a continuing Baseline state
}
```

A Closed Vault cannot be Vacuumed into an Open successor. Forking a Closed state creates a new
Vault and new authority rather than reopening it.

## 4.2 Predecessor commitment

For a Vacuum successor:

```text
{
  0: predecessorGenerationId,
  1: predecessorFrontier,       // sorted complete Record ID set
  2: predecessorStateDigest     // replay digest defined by vault/vacuum.md
}
```

This is an integrity commitment, not a dependency reference. It MUST NOT keep predecessor Records
reachable. The matching predecessor Vacuum Event authenticates the successor Baseline. Exact
Authority and Lifecycle Records remain separately preserved only through the Continuity Proof.

# 5. Initial Baseline and Genesis

Creation constructs and hashes the complete Initial Baseline before Genesis. It contains the empty
new-Vault content state, or the selected state-only Fork content, plus initial authority, key
delivery, label state, object closure, and Required Feature Set. Genesis then binds the Baseline
ID and independently proves the initial authority described by
`docs/specifications/vault/authority.md`.

Genesis is the first accepted Event Frontier. The Initial Baseline is its typed dependency and is
not its parent, avoiding a content-addressing cycle. A successor Baseline is itself the causal root
of its Generation; no second Genesis is created. Its authenticating predecessor Vacuum Event is
the Authority Parent anchor rather than a Baseline dependency, avoiding a content-addressing cycle.

For reducer causality, Genesis semantically follows the complete Initial Baseline that it
authenticates. The Runtime therefore treats the Initial Baseline and each of its Baseline Causes as
predecessors of Genesis without adding them to Genesis's signed Event-parent set. This semantic
edge lets a later post-Genesis Event supersede or exactly resolve Fork checkpoint state while
preserving Genesis's parentless wire format and avoiding a content-addressing cycle.

# 6. Authoritative and local state

Current portable state consists of authenticated Vault Records and Vault Objects reachable from the
current Baseline and later accepted Events. The Continuity Proof is separate portable
authentication evidence: its exact prior Authority and Lifecycle Records remain available, while
unrelated Content parents named in those signed Records need not. It grants no authority beyond the
state derived from its own signed subgraph. Replica Safety State records which state and proof a
local Replica recognizes; it does not create portable facts.

Materializations, search indexes, user-interface state, Commands, Jobs, pending Captures,
quarantine, local key wrappers, Remotes, Accounts, sessions, Replica Access Grants, quotas, logs,
and exports are outside Vault authority.

# 7. Closed Vaults

A Vault is Closed when the accepted authority reduction has no Administrator. A member may also
author an explicit Closure Event while at least one Administrator exists. Closure accepts no later
Events in that Vault. Retained members may still read, verify, export, and Fork the state available
to them. Closing never remotely erases a Replica.

Lifecycle family type `2`, explicit Closure, has the exact empty map body `{}`. Its signer MUST be
an unambiguous current Administrator. Derived Closure from a Membership End or Administrator End
that removes the final Administrator creates no synthetic Event; the signed cause is sufficient.

# 8. Invariants

- Every continuing Vault Generation has exactly one authenticated Baseline root.
- Every writable Vault has at least one Administrator.
- Every portable fact is derivable from Records, Objects, and the active Required Feature Set.
- The Baseline is authoritative state, not a cache or projection.
- Baseline Cause IDs preserve exact fact references without preserving predecessor reachability.
- Baselines never preserve Content transition history solely for compatibility or audit
  convenience.
- Continuity Proof retention is required for independent authority and Recovery verification, not
  audit convenience.
- Search and other rebuildable state never enter a Baseline.
- Host-local policy never enters Vault state.

# References

- `docs/specifications/vault/vacuum.md`
- `docs/specifications/vault/collection.md`
- `docs/specifications/vault/authority.md`
- `docs/specifications/vault/fork.md`
