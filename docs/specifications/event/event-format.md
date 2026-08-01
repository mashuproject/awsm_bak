# Vault Record Serialization Specification

**Document:** `docs/specifications/event/event-format.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/core/identifiers.md`
- `docs/specifications/core/serialization.md`
- `docs/specifications/event/event.md`
- `docs/specifications/crypto/crypto.md`

---

# 1. Purpose

This specification defines the sole canonical protected Vault Record envelope, Vault Event
signature transcript, Record ID, Record-kind registry, Event-family registry, and base Event-type
registry.

# 2. Vault Record kinds

| Code | Kind           |
| ---: | -------------- |
|    1 | Vault Event    |
|    2 | Vault Baseline |

Objects, Key Envelopes, Feature Manifests, Bundle Descriptors, Artifact wrappers, and other typed
dependencies are not Vault Record kinds and never appear in the causal parent DAG.

# 3. Canonical Vault Event map

Every Vault Event is the following canonical CBOR map:

```text
{
  0: 1,                    // vaultRecordFormat
  1: vaultId,              // 32 bytes
  2: generationId,         // 32 bytes
  3: parentRecordIds,          // complete causal Frontier
  4: authorityParentRecordIds, // complete Authority Frontier; section 10.1
  5: dependencyRefs,           // canonical Typed Dependency Reference set
  6: 1,                        // recordKind = Vault Event
  7: requiredFeatureSetId,     // derived at the Authority Frontier
  8: advisoryExtensions,       // canonical Advisory Extension map
  9: eventFamily,              // section 5
  10: eventType,               // family-local type code
  11: signerCredentialId,      // 32 bytes
  12: assertedAt,              // signed integer Unix milliseconds
  13: body,                    // exact family/type schema
  14: signature                // 64-byte Ed25519 signature
}
```

No field is optional. An empty causal parent set, Authority Parent set, dependency set, or extension
map is encoded as an empty container. Only Genesis has both parent sets empty. A first Event in a
Vacuum successor Generation names that Generation's Baseline ID as its causal parent and the
predecessor Vacuum Event as its Authority Parent.

`requiredFeatureSetId` is the set effective at the Event's Authority Parents, before applying the Event.
Feature Activation's body also binds the resulting set.

# 4. Signature and Record ID

The unsigned Event is the exact map above with key `14` omitted. The signature is:

```text
Ed25519.Sign(
  signerPrivateKey,
  Transcript(
    "awsm:vault-event-signature:v1",
    [canonicalUnsignedEventBytes]
  )
)
```

After inserting the 64-byte signature and re-encoding the complete canonical map:

```text
recordId = SHA-256(Transcript(
  "awsm:vault-record-id:v1",
  [canonicalAuthenticatedEventBytes]
))
```

The Event contains neither its signature transcript nor its Record ID. Ed25519 verification MUST
use the public key bound to `signerCredentialId` by the Authority State at the exact Authority
Parents, except for the Genesis and Recovery-authorized Enrollment rules in the authority
specification.

# 5. Event families

| Code | Family    |
| ---: | --------- |
|    1 | Authority |
|    2 | Content   |
|    3 | Lifecycle |

The pair `(eventFamily, eventType)` is the complete base Event type. A type code has meaning only in
its family. No Event carries an independent type version.

# 6. Authority Event type codes

| Code | Type                                  |
| ---: | ------------------------------------- |
|    1 | Genesis Event                         |
|    2 | Membership End Event                  |
|    3 | Administrator Grant Event             |
|    4 | Administrator End Event               |
|    5 | Invitation Creation Event             |
|    6 | Invitation Acceptance Event           |
|    7 | Invitation Cancellation Event         |
|    8 | Invitation Conflict Resolution Event  |
|    9 | Client Credential Enrollment Event    |
|   10 | Client Credential End Event           |
|   11 | Recovery Credential Replacement Event |
|   12 | Key Epoch Transition Event            |
|   13 | Key Delivery Event                    |
|   14 | Feature Activation Event              |

# 7. Content Event type codes

| Code | Type                                       |
| ---: | ------------------------------------------ |
|    1 | Vault Label Event                          |
|    2 | Client Credential Label Event              |
|    3 | Bundle Registered Event                    |
|    4 | Captures Deleted Event                     |
|    5 | Captures Restored Event                    |
|    6 | Captures Moved Event                       |
|    7 | Collection Title Event                     |
|    8 | Collections Merged Event                   |
|    9 | Collection Merge Reverted Event            |
|   10 | Collection Merge Conflict Resolution Event |
|   11 | Collection Folder Placement Event          |
|   12 | Folder Created Event                       |
|   13 | Folder Renamed Event                       |
|   14 | Folder Parent Placement Event              |
|   15 | Folder Deleted Event                       |
|   16 | Folder Restored Event                      |
|   17 | Folder Conflict Resolution Event           |
|   18 | Tag Created Event                          |
|   19 | Tag Renamed Event                          |
|   20 | Tag Assigned Event                         |
|   21 | Tag Removed Event                          |
|   22 | Tag Deleted Event                          |
|   23 | Tag Restored Event                         |
|   24 | Tags Merged Event                          |
|   25 | Tag Merge Reverted Event                   |
|   26 | Tag Merge Conflict Resolution Event        |
|   27 | Note Created Event                         |
|   28 | Note Revised Event                         |
|   29 | Note Deleted Event                         |
|   30 | Note Restored Event                        |
|   31 | Note Conflict Resolution Event             |

# 8. Lifecycle Event type codes

| Code | Type          |
| ---: | ------------- |
|    1 | Vacuum Event  |
|    2 | Closure Event |

# 9. Canonical Vault Baseline map

Every Vault Baseline is the following canonical CBOR map:

```text
{
  0: 1,                    // vaultRecordFormat
  1: vaultId,              // 32 bytes
  2: generationId,         // 32 bytes
  3: [],                   // Baselines have no causal parents
  4: [],                   // Baselines do not advance the Authority Frontier
  5: dependencyRefs,       // complete retained typed dependency roots
  6: 2,                    // recordKind = Vault Baseline
  7: requiredFeatureSetId, // 32 bytes
  8: advisoryExtensions,   // canonical Advisory Extension map
  9: baselineBody          // exact Vault Baseline schema
}
```

A Baseline has no signer or signature field. Its content-addressed bytes are authenticated by:

- the Genesis Event that binds an Initial Vault Baseline ID and matching bootstrap summary; or
- the predecessor Vacuum Event that binds the successor Baseline ID, Generation, and exact
  predecessor frontier.

A Baseline received without one of those verified proofs is an untrusted candidate. Its
`recordId` uses the same `awsm:vault-record-id:v1` construction over its complete canonical bytes.
For a Vacuum successor, verification includes the Continuity Proof that establishes the Vacuum
signer's Administrator authority; a matching signature from a Certificate asserted only inside the
candidate Baseline is insufficient.

# 10. Parent frontier encoding

`parentRecordIds` encodes the author's complete accepted Vault Record Frontier as a canonical set.
It MUST contain every causally maximal Record the local Replica had authenticated, semantically
validated, and accepted in the active Generation when authoring began.

The Runtime MUST compare-and-swap the frontier at local commit. If it changed, the Runtime discards
the signature and rebuilds and re-signs against the new complete frontier.

An Event MUST NOT name a parent from another Vault or Generation, quarantined input, an unadopted
successor Generation, or a non-maximal subset intended to hide accepted local knowledge.

## 10.1 Authority Parent frontier

`authorityParentRecordIds` is the complete canonical set of causally maximal Genesis, Authority,
and Lifecycle Event Records in the author's accepted authority ancestry. Content Events never
advance this frontier. It is the sole ancestry used to derive portable Authority State,
authorization, Required Features, and Open or Closed lifecycle for an Event.

In an initial Generation, every Authority Parent is Genesis or an Authority/Lifecycle descendant
linked through this field. After Vacuum, the predecessor Vacuum Event is the cross-Generation
Authority Parent anchor authenticated with the successor Baseline. Apart from that exact boundary,
Authority Parents belong to the Event's Generation.

For ordinary authoring, each Authority Parent MUST be an accepted causal ancestor of the complete
`parentRecordIds` frontier. At the Vacuum boundary, the matching verified predecessor Vacuum Event
MUST bind the causal Baseline parent. Authority and Lifecycle Events advance the Authority Frontier;
Content Events preserve it unchanged.

The Runtime compare-and-swaps both frontiers at commit. A change to either discards the signature
and rebuilds the Event. A Continuity Proof may verify the Authority Parent subgraph without
resolving unrelated causal Content parents; that exception proves authority continuity only and
does not reconstruct discarded content state.

# 11. Dependency encoding

`dependencyRefs` is the canonical set of every immutable external item required by the exact Event
or Baseline body. The owning type schema states which dependencies are required and how body fields
map to their IDs. Extra dependencies are invalid; a dependency set is part of the signed fact, not
an open prefetch list.

Causal and Authority Parents are not duplicated as dependencies. A Baseline MAY reference retained
Vault Objects, Key Envelopes, and Feature Manifests, but predecessor Records are not reachable
merely because the Baseline contains a predecessor commitment.

Cause IDs encoded by an owning Content Event body are semantic references to current facts, not
parent, Authority Parent, or Typed Dependency References. A Baseline Cause ID therefore MUST NOT
appear in `parentRecordIds`, `authorityParentRecordIds`, or `dependencyRefs`.

# 12. Required Feature behavior

The base registries above are understood under the initial core Required Feature Set. A future
Event type or changed body requires an activated Required Vault Feature with its own exact type code
and reducer. It MUST NOT reinterpret a base type code or add unknown fields to a base body.

A client that does not implement the effective Required Feature Set MAY preserve the exact outer
item in Quarantine but MUST NOT semantically accept the Record, author a descendant, Vacuum affected
state, or Garbage Collect potentially reachable data.

# 13. Validation order

For an Event, a trusted Runtime MUST:

1. verify canonical encoding and exact base envelope;
2. recompute `recordId`;
3. validate Vault, Generation, causal and Authority Parent sets, dependency types, and Required
   Feature Set;
4. obtain and verify the complete current causal and dependency closure plus the applicable
   Continuity Proof;
5. derive Authority State and Closed state at the exact Authority Parents;
6. resolve the signing public key or the explicit bootstrap/recovery exception;
7. verify the Ed25519 signature;
8. apply the type's authorization, preconditions, body schema, and sibling rules; and
9. atomically accept the Event and update Replica Safety State.

For a Baseline, the Runtime additionally verifies the exact Genesis or Vacuum authentication proof,
complete state codec, dependency reachability, and replay equivalence where applicable.

# 14. Invariants

- Every Event has one family and one semantic type.
- Every non-Genesis Event has at least one parent.
- Every signature binds the complete causal parent, Authority Parent, and dependency sets.
- A timestamp never determines authorization or reduction.
- No Host-local identifier or policy appears in a Vault Record.
- No Vault Record ID, signature, or Baseline proof is circular.
- Unknown fields and base type codes fail closed.

# References

- `docs/specifications/event/event.md`
- `docs/specifications/event/reducers.md`
- `docs/specifications/vault/authority.md`
