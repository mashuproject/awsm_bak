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
Remote, Realm, inventory snapshot and page position, retry state, Quarantine references and their
opaque locators, and safe aggregate progress. A Hosted Replica Remote retains that Host's random
locator salt in Installation State. A Job checkpoint is local resumption state, never a delivery
acknowledgement or portable Frontier.

Only a classified retryable Host transport failure may move an active pull Job to local Waiting
state. The first automatic retry uses a locally jittered 0.5 to 1.5 second delay; each later delay
doubles, is bounded at five minutes, and a valid Host retry delay may lengthen it only within that
same bound. Local operational time and jitter have no Vault or cross-Replica meaning. After eight
automatic attempts, the Job is terminal Failed but retains its exact snapshot, page position,
Quarantine references, and safe progress. Automatic triggers leave that state intact; an explicit
refresh restarts the same Job at attempt zero. A non-retryable Host outcome and local validation or
storage failure do not enter this retry path. Retrying never drops Quarantine, changes a Host
snapshot, creates a new opaque representation, or changes accepted Vault state.

# 3. Pull pipeline

For each configured source Remote, the Client:

1. authenticates its Channel Principal under that Host's policy;
2. reads bounded opaque inventory or set-difference pages using a Host-local cursor;
3. fetches unknown immutable outer items into Quarantine;
4. verifies outer framing and Opaque Storage Item IDs;
5. attempts authorized decryption without leaking semantic guesses to the Host, recomputes the
   Remote-specific opaque locator from authenticated protected context, and rejects a mismatch;
6. authenticates canonical inner IDs, signatures, causal and Authority Parents, dependencies,
   Required Features, and exact Event semantics;
7. promotes valid items and advances accepted local Frontier and availability atomically.

Ciphertext that has no locally usable Key Epoch remains Quarantine rather than becoming a rejected
or accepted Vault item. A known signed dependency may still locate its matching retained physical
representations through the Remote-specific opaque locator; recipient-only inner plaintext is not a
condition of that lookup.

For a Key Envelope that the receiving Client cannot open as its recipient, that lookup does not
authenticate the envelope plaintext or its logical identity. A locator match, signed dependency
reference, and valid outer envelope MUST NOT by themselves promote the representation. The Client
MUST retain it in Quarantine until recipient-verifiable proof exists. The initial current Runtime
does not define a recipient-independent proof, so it does not accept an Authority branch that
depends on such an unverified representation.

After complete semantic validation, promotion is one local conditional transaction: it compares the
exact prior Replica Safety State and pull Job bytes; persists only the validated immutable Compact
items and their protected local resolutions; replaces the Job checkpoint; and removes exactly the
Remote-scoped Quarantine entries consumed by that checkpoint. The transaction cannot add or rewrite
Quarantine references, change the completed inventory snapshot, or remove unreadable ciphertext.
It invalidates Frontier-bound Library and Search Materializations in that same transaction. The
transport checkpoint is not semantic proof; Authority, dependency, DAG, Feature, and Event
validation must finish before this transaction begins.

A Replica becomes current by pulling and validating what it lacks. Separately, a Client may
materialize randomized opaque representations at a writable Replica Host through immutable item
admission. That destination-write workflow is not Synchronization, creates no origin, and does not
advance the writing Client's accepted Frontier.

For one logical item and destination, the Client prepares and durably records one fresh outer
representation before admission. Ambiguous failures retry those exact bytes and ID; confirmed
presence prevents another rewrap. A different Hosted Replica destination receives independently
randomized bytes so inventories are not correlated by avoidable equality.

The durable record is a local Remote Materialization Ledger entry. It binds the protected logical
item and Key Epoch context to the Remote-local locator, exact destination Storage Item ID, byte
length, digest, and `Prepared` or `Confirmed` state; the exact opaque bytes remain local Prepared
Data only while `Prepared`. The Client may mark it `Confirmed` only after an exact `stored` or
`already_present` admission receipt, then retires those Prepared bytes. A confirmed ledger prevents
automatic rewrapping but does not prove that the Host retains data, that another Replica exists, or
that a Remote is fresh.

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

Compact Records and Objects synchronize independently from heavy wrappers. For a known Artifact,
the Client derives that Remote's Artifact locator from the Remote-local salt and the protected
Artifact ID, scans ordinary opaque inventory, and retrieves a matching complete Streamable item.
The locator is only a query hint: a Host can return no item, an unrelated item, or invalid bytes.

The Client prepares the complete wrapper locally, verifies its outer identity and every encrypted
frame against the authenticated Artifact Object under a locally held Key Epoch, and only then
conditionally publishes one local Artifact Resolution. That publication compares the exact prior
Replica Safety State and the prior Resolution bytes (or its absence), so a concurrent local
representation change cannot be overwritten. An unavailable Remote or an invalid candidate cannot
change local Resolution state; a later configured Remote remains eligible to supply the Artifact.
Prepared or promoted physical residue without that publication is unreachable local state and is
eligible for ordinary reconciliation. No inventory response proves another durable copy.

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
