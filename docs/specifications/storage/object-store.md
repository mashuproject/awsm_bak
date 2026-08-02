# Object Store Specification

**Document:** `docs/specifications/storage/object-store.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/core/identifiers.md`
- `docs/specifications/core/serialization.md`
- `docs/specifications/storage/opaque-envelope.md`
- `docs/specifications/vault/vault.md`

---

# 1. Purpose

The Object Store persists immutable authoritative Vault Records, Vault Objects, Key Envelopes,
Feature Manifests, and Artifact wrappers while keeping protected logical identity separate from
randomized physical storage representation.

# 2. Logical item classes

The store recognizes protected logical item types through exact typed specifications. It provides
two physical byte paths:

- Compact items for bounded canonical Records, Objects, Manifests, Envelopes, and local catalogs;
  and
- Streamable items for large encrypted Artifact wrappers.

An item may have one protected logical ID and several destination-specific Opaque Storage Item IDs.
The store MUST NOT treat an opaque ID as the logical reference used inside Vault data.

# 3. Immutability

For a logical content ID, exact canonical authenticated bytes are immutable. For an Opaque Storage
Item ID, exact outer bytes are immutable.

`put` has only these valid results:

- create the absent exact item;
- report idempotent success for byte-identical existing content; or
- reject an identifier collision.

No operation overwrites, patches, appends to, or reinterprets an accepted item. Multipart and
Prepared Data are outside the accepted store until final verification and promotion.

# 4. Trusted-client acceptance

A trusted client accepts an item only after:

1. verifying its outer envelope and Opaque Storage Item ID;
2. decrypting under an authorized Key Epoch or target wrapping key;
3. parsing exact canonical inner bytes;
4. recomputing the protected logical ID and expected type;
5. verifying signatures, authority, parents, Required Features, and typed dependencies where
   applicable;
6. proving the complete required closure; and
7. committing the item, active frontier change, and Replica Safety State atomically.

Host Storage Admission, download completion, or a matching outer digest is insufficient.

# 5. Resolution state

Each client Replica keeps protected Replica Safety State that maps exact protected logical IDs to
the local and Remote Opaque Storage Item IDs known to represent them. The mapping MAY include the
verified Key Epoch used to open an item.

The mapping is acceleration, not Vault truth. A client can rebuild it by enumerating one authorized
opaque inventory and decrypting and validating candidates. A Replica Host cannot create or
interpret it.

# 6. Artifact wrappers

The compact Artifact Object commits to the complete logical payload digest, plaintext length,
representation metadata, and stream integrity contract. Its Artifact ID is the compact Object's
Object Identifier.

The corresponding streamable wrapper MAY be Present or Evicted in one client Replica. Its absence
does not remove the Artifact from the authoritative inventory. A retrieved wrapper becomes Present
only after every frame and the complete logical payload contract verify.

Frames, multipart parts, pack files, ranges, and physical chunks never receive independent Vault
Object IDs or reachability semantics.

# 7. Replica-local availability

For every reachable eligible wrapper, one client Replica records exactly one:

- `Present`: complete verified wrapper exists locally;
- `Evicted`: intentional local absence with no claim that another copy exists; or
- `UnexpectedlyMissing`: bytes expected locally are absent or fail verification.

Availability is Replica Safety State and does not synchronize as portable Vault truth. Storage
Relief may change Present to Evicted only after the unconditional data-loss warning. Retrieval may
change Evicted to Present only after full verification.

# 8. Enumeration and retrieval

A trusted local Object Store MAY enumerate logical items by exact type and scope. An opaque Hosted
Replica enumerates only Opaque Storage Item IDs, storage class, ciphertext length and digest,
outer format, and Host-local cursor or admission token.

A Remote request uses opaque IDs resolved by trusted local state. Recovery may enumerate all
authorized compact opaque items and attempt private opening; the Host supplies no semantic filter.

# 9. Reachability

Trusted-client reachability traces:

- the active Vault Baseline and accepted Vault Record Frontier;
- causal parent references;
- Typed Dependency References;
- retained predecessor Generations;
- Recovery Snapshots;
- pending and Prepared operations;
- Complete Export or Backup construction roots while owned by the Runtime; and
- every explicit local preservation root.

Replica Garbage Collection may delete an item only after a complete current trace proves it is not
reachable from any root. A predecessor commitment in a successor Baseline is audit linkage, not a
reachability edge.

The trusted client authenticates the active Replica before tracing. An adopted successor retains
Genesis, the signed Authority Parent graph, every authority-validation dependency, the current
Baseline, and current causal state. It does not retain Genesis's Initial Baseline commitment or a
Continuity Event's unrelated causal Content parents unless another recognized Generation or local
preservation root reaches them. Any active Garbage Collection fence blocks the trace.

An opaque Replica Host cannot run semantic Garbage Collection. It may delete exact opaque items
when instructed by an authorized trusted client, apply disclosed non-semantic Host policy, or reap
an entire Hosted Replica. None proves global unreachability.

# 10. Transaction boundary

Authoritative compact metadata and large wrapper bytes may use different Persistence Backends. A
Runtime uses Prepared Data, Execution State, and Replica Safety State to make cross-backend work
restart-safe.

An operation that cannot atomically commit all physical parts MUST use a sealed candidate protocol:

1. prepare immutable bytes under a stable Job identity;
2. persist exact counts, lengths, and digests;
3. verify every part after durable write;
4. atomically publish the logical item and Safety State; and
5. reclaim abandoned Prepared Data after the outcome is known.

No incomplete Bundle, Baseline, Artifact, or authority dependency becomes reachable.

Garbage Collection applies the same boundary in reverse. Compact items, their protected local
resolutions, and Key Epoch Secrets made unused by that exact deletion commit together against the
prior Replica Safety State. A streamable wrapper remains Present with its resolution and required
Epoch Secret until a durable cleanup Job owns its exact Opaque Storage Item ID, holds the narrow
maintenance lease, revalidates that no current resolution retains it, removes it idempotently, and
then retires the obsolete resolution and any newly unused secret. Merely reporting a wrapper as a
cleanup candidate is not successful reclamation.

When an unreachable Artifact resolution shares a wrapper with a reachable logical Artifact,
Garbage Collection retains the physical bytes but may remove the unreachable alias resolution in
the compact transaction. Every local resolution of one wrapper must agree on its Key Epoch,
regardless of reachability; disagreement is corrupt local safety state and fails closed.

The cleanup Job persists before removal and binds each physical candidate to its logical Artifact
and Key Epoch. Exact Artifact/Storage Item pairs are also installed as Replica Safety State fences
in the same transaction that performs compact reclamation. Trusted promotion paths reject either
the same logical Artifact or same physical Storage Item; a Replica-state compare-and-swap closes the
race when a fence is installed after preparation. The final transaction conditionally replaces the
leased Job with one Succeeded record carrying the complete stable outcome and removes the candidate
resolutions, newly unused secrets, and fences. If the Runtime stops after physical removal, another
worker repeats the idempotent removal after the lease expires and completes that same transaction.
The latest terminal Job remains local until the next heavy cleanup conditionally retires it while
installing its own Job and fences. Unrelated state discovered on resume is not added to the Job's
deletion scope and retains any required Key Epoch Secret until a later trace.

# 11. Import and synchronization

External bytes enter Quarantine. Trusted local preparation enters Prepared Data. The two states
MUST NOT share validation, promotion, or cleanup assumptions.

Synchronization is requester-initiated pull. A received item is not accepted merely because a
Remote stored it. Import and Restore apply the same identifier, type, closure, and atomicity checks
as ordinary local construction.

# 12. Unknown types and features

Unknown protected logical types or Required Vault Features remain bounded Quarantine and fail
semantic acceptance. When the outer envelope is understood, a client MAY preserve and relay exact
opaque bytes without advancing its trusted frontier or reclaiming related data.

Unknown derived or Materialization namespaces are disposable under their registry contract and
never become authoritative through persistence.

# 13. Invariants

- Accepted logical and outer items are immutable.
- Protected logical references never depend on one Host's opaque IDs.
- Absence is intentional only when exact Replica Safety State says Evicted.
- No client claims another copy exists or is durable.
- No Host infers semantic reachability from opaque inventory.
- Complete validation precedes authoritative promotion.
- Physical layout changes do not change logical identity.

# References

- `docs/specifications/storage/opaque-envelope.md`
- `docs/specifications/runtime/storage.md`
- `docs/specifications/vault/vacuum.md`
