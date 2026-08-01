# Runtime Synchronization Specification

**Document:** `docs/specifications/runtime/synchronization.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/protocol/protocol.md`
- `docs/specifications/vault/replica.md`
- `docs/specifications/event/event.md`

# 1. Purpose

Synchronization lets a receiving Client pull opaque items from an authorized source Replica,
authenticate them locally, and converge its Replica without granting the source semantic authority.
There is no distinguished origin, server, or global sequence.

# 2. Triggers

A Client may pull on explicit refresh, Vault open, local schedule, network reconnection, or an
untrusted Wake Hint. Hints contain no authoritative fact and merely cause another pull. Background
frequency is installation policy and may respect power, data, and privacy settings.

Each bounded pull cycle runs as a durable pull-synchronization Job. Its Execution State owns the
Remote, Realm, inventory snapshot and page position, retry state, Quarantine references, and safe
aggregate progress. A Job checkpoint is local resumption state, never a delivery acknowledgement or
portable Frontier.

# 3. Pull pipeline

For each configured source Remote, the Client:

1. authenticates its Channel Principal under that Host's policy;
2. reads bounded opaque inventory or set-difference pages using a Host-local cursor;
3. fetches unknown immutable outer items into Quarantine;
4. verifies outer framing and Opaque Storage Item IDs;
5. attempts authorized decryption without leaking semantic guesses to the Host;
6. authenticates canonical inner IDs, signatures, causal and Authority Parents, dependencies,
   Required Features, and exact Event semantics;
7. promotes valid items and advances accepted local Frontier and availability atomically.

A Replica becomes current by pulling and validating what it lacks. Separately, a Client may
materialize randomized opaque representations at a writable Replica Host through immutable item
admission. That destination-write workflow is not Synchronization, creates no origin, and does not
advance the writing Client's accepted Frontier.

For one logical item and destination, the Client prepares and durably records one fresh outer
representation before admission. Ambiguous failures retry those exact bytes and ID; confirmed
presence prevents another rewrap. A different Hosted Replica destination receives independently
randomized bytes so inventories are not correlated by avoidable equality.

# 4. DAG convergence

Synchronization unions valid immutable Records and Objects. Concurrent Events remain sibling DAG
heads. Reducers compose compatible facts, preserve scoped conflicts, and never choose by arrival or
Host cursor. A new local Event names the complete accepted Frontier, naturally joining all heads
the author observed.

Captures may continue during ordinary disconnection. A security fence may keep a completed Capture
in Prepared Data until a valid Event can be authored. Transport failure never deletes or rolls back
already accepted local work.

# 5. Generation transitions

A discovered Vacuum successor remains an untrusted candidate until full verification, including
the Continuity Proof from Genesis through its predecessor Vacuum Event. A Client with no
incompatible predecessor work may offer adoption. Divergent work requires Fork Before Adoption,
eligible Event Re-authoring, Export, decline, or postponement. Synchronization never silently unions
predecessor work into a successor or discards it.

# 6. Completeness and freshness

A Client proves completeness only relative to a selected observed Frontier, its complete current
causal and dependency closure, and its complete Continuity Proof. Content parents named only by
retained Continuity Events need not remain available. A source may hide a later internally complete
branch. Without another Replica, trusted sequencer, trusted time, or retained checkpoint, global
freshness is not provable and MUST NOT be claimed.

# 7. Sparse wrappers

Compact Records and Objects synchronize independently from heavy wrappers. The Client hydrates a
wrapper from any authorized Remote that can supply exact bytes, verifies every frame and final
contract, and may later perform Storage Relief. No inventory response proves another durable copy.

# 8. CAP and consistency

The portable Vault is availability- and partition-tolerant: disconnected members may author valid
work, then converge through deterministic DAG reduction. It does not promise immediate global
consistency. A Host's Account, Grant, quota, and cursor updates may use ordinary strongly
consistent database transactions because they are local policy, not Vault causality.

# 9. Invariants

- Synchronization is pull-oriented and receiver-validated.
- Opaque inventory order has no semantic meaning.
- A Host cursor is not a Vault clock.
- No Remote is mandatory or privileged.
- Valid unknown Required Features are preserved but not semantically accepted.
- Local accepted work survives temporary inability to synchronize.

# References

- `docs/specifications/event/reducers.md`
- `docs/specifications/vault/vacuum.md`
- `docs/specifications/storage/opaque-envelope.md`
