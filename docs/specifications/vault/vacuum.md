# Vault Vacuum Specification

**Document:** `docs/specifications/vault/vacuum.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/vault/vault.md`
- `docs/specifications/event/reducers.md`
- `docs/specifications/storage/object-store.md`

# 1. Purpose

Vacuum is an irreversible Vault History Rewrite. It makes the complete logical state at one exact
predecessor Frontier the new authoritative Baseline, omits eligible predecessor-only state, and
starts a fresh Generation. Garbage Collection is a separate local operation.

# 2. Authorization and preflight

Any Replica may prepare a Vacuum, but any one current Vault Administrator must sign its Vacuum
Event. No Host, Account, Replica, quorum, or ownership status adds authority.

Before signing, the trusted client MUST disclose every known conflict, divergent or unpublished
branch, unavailable required dependency, omitted Capture-scoped Note or Tag assignment, and other
irreversible consequence. It MUST offer only outcomes it can verify, including resolving first,
preserving through Fork or Complete Export, postponing, or knowingly selecting the successor.
Administrator choice cannot make an invalid transition valid.

# 3. Successor construction

The preparer MUST:

1. authenticate and replay the exact predecessor Frontier and dependency closure;
2. fail closed on unknown Required Features, state domains, or unavailable dependencies;
3. derive complete current content, authority, lifecycle, keys, and reachability;
4. omit Deleted Captures and state whose only remaining purpose is predecessor history;
5. retain every fact needed to identify, authenticate, interpret, reference, or reconstruct current
   state;
6. assign one fresh Baseline Cause ID to every distinct retained Content cause that later Content
   operations must name and use that mapping consistently across all checkpoint facts controlled by
   the same cause;
7. reuse unchanged immutable Objects where valid;
8. encode the canonical successor Baseline and compute its Record ID;
9. independently replay or decode it and prove state equivalence to the selected result;
10. construct the terminal predecessor Vacuum Event; and
11. retain the complete Continuity Proof rooted at that Event.

The Cause mapping is complete for every retained Content observed-remove target, reversible
redirect, scalar head, and unresolved Content Conflict candidate. It is protected inside the
successor Baseline but is not serialized as a source-to-destination lookup table. No predecessor
Content Record becomes a dependency merely because it supplied a retained fact.

The Continuity Proof is different: it retains exact Genesis, Authority, and Lifecycle Event bytes,
their signed Authority Parent subgraph, and every compact dependency required to validate that
subgraph. Ordinary Content parents named by those Events may remain unresolved. This is the minimum
portable proof that the Vacuum signer was authorized and that a fresh Recovery client is not
trusting a Host-provided self-asserted Baseline.

Search indexes and all other Materializations are absent. Adoption invalidates predecessor-scoped
Materializations and rebuilds them from successor state.

# 4. Vacuum Event body

Lifecycle family type `1` body:

```text
{
  0: predecessorGenerationId,
  1: predecessorFrontier,       // exact complete sorted Record ID set
  2: successorGenerationId,     // fresh random 32-byte ID
  3: successorBaselineId,       // dependency type 2
  4: predecessorStateDigest,    // section 5
  5: successorStateDigest,      // MUST equal selected retained state digest
  6: omissionDigest             // section 5
}
```

The Event's parents MUST equal `predecessorFrontier`; its Generation is the predecessor. Its only
dependency is the successor Baseline. It is accepted only when the signer is an unambiguous current
Administrator and the successor Baseline passes full verification.

Its Authority Parents MUST equal the predecessor's complete Authority Frontier. As a Lifecycle
Event it advances that Frontier and becomes the cross-Generation Authority Parent anchor for the
successor. The successor Baseline authority checkpoint MUST equal Authority State derived after the
Vacuum Event; Vacuum changes no membership, role, Credential, feature, Key Epoch, fence, or Closure
fact.

# 5. Digests

Each digest is:

```text
SHA-256(Transcript(domain, [canonicalCheckpointBytes]))
```

The domains are `awsm:vacuum-predecessor-state:v1`, `awsm:vacuum-successor-state:v1`, and
`awsm:vacuum-omission:v1`. A state checkpoint is the canonical map:

```text
{
  0: contentCheckpoint,
  1: authorityCheckpoint,
  2: lifecycleCheckpoint
}
```

The predecessor digest uses the exact selected current state with predecessor Cause IDs. The
successor digest uses the retained successor state after the complete fresh Baseline Cause mapping.
The two digests therefore need not match even when Vacuum omits no logical entity.

The omission checkpoint is:

```text
{
  0: 1,       // omission checkpoint format
  1: entries  // canonical set
}

entry = {
  0: logicalKind, // 1 Bundle, 2 Tag Assignment, 3 Note
  1: logicalId,
  2: reason       // 1 Deleted Capture, 2 Capture-scoped state of a Deleted Capture
}
```

Kind `1` uses reason `1`; kinds `2` and `3` use reason `2`. The checkpoint contains no plaintext
labels or content. It is decision evidence, not successor reachability. A future Required Feature
may add another typed omission class; the base format never encodes an untyped or free-form
omission bucket.

# 6. Adoption and divergence

Vacuum Adoption is local Replica Safety State, not an Event. A Replica adopts only after verifying
the Vacuum Event, successor Baseline, complete available closure, and replay equivalence.

A Replica with no incompatible predecessor work may switch Generations. A Replica with divergent
or unpublished work MUST NOT silently discard or union it. The user may Fork Before Adoption,
Complete Export, recover eligible Captures through Event Re-authoring, decline, or postpone.
Concurrent Vacuum successors are sibling choices and never auto-merge.

# 7. Garbage Collection and exports

Adoption changes recognized shared history but does not delete bytes. Replica Garbage Collection
may later remove items proven unreachable from every locally recognized Generation, preservation
root, pending workflow, and safety fence. Vacuum cannot erase offline copies or exports.

Complete Export may preserve the predecessor before Vacuum. A smaller-export flow may explicitly
Vacuum and adopt first, with the same disclosures. A state-only Fork is a distinct Vault and is not
a history-preserving export.

The Continuity Proof is a permanent preservation root even after Adoption. Garbage Collection MAY
remove discarded Content parents referenced only by signed causal-parent fields in that proof; it
MUST retain every Authority Parent Record and typed dependency needed to validate the proof from
Genesis to the current Vacuum Event.

# 8. Invariants

- Vault ID remains stable; Generation ID changes.
- The predecessor Event DAG is not reachable from the successor Baseline.
- Every retained predecessor Content fact that needs a continuing identity has one fresh Baseline
  Cause ID, consistently reused within that Baseline.
- The complete Continuity Proof remains portable and independently verifiable after Content history
  is reclaimed.
- The Vacuum Event is terminal in the predecessor; the Baseline roots the successor.
- No unsupported or unavailable authoritative state is guessed or dropped.
- No unsynchronized work is silently discarded or resurrected.
- Vacuum and Garbage Collection are different operations.
- Existing immutable Objects are never rewritten merely because Vacuum occurred.

# References

- `docs/specifications/vault/vault.md`
- `docs/specifications/vault/authority.md`
- `docs/specifications/vault/collection.md`
