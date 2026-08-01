# Vault History Rewrite Architecture

**Status:** Draft target architecture

**Depends On:**

- `docs/architecture/09-event-model.md`
- `docs/specifications/vault/vacuum.md`

# Purpose

AWSM normally preserves additive immutable history. Vacuum is the explicit exception: an informed
Administrator makes the current state at one exact Frontier the new Baseline of a successor
Generation.

# Transition

```text
predecessor Baseline -> Record DAG -> exact Frontier -> signed Vacuum Event
                                                |
                                      successor Baseline
                                                |
                                      successor Event DAG
```

The Vacuum Event is terminal in the predecessor and authenticates the already content-addressed
successor Baseline. The Baseline has no causal parents and only a non-reachability commitment to
the old Frontier, avoiding a content-addressing cycle and keeping old history out of successor
reachability.

The Vacuum Event also advances the signed Authority Parent Frontier and becomes the successor's
cross-Generation authority anchor. The compact Continuity Proof retains Genesis and the Authority
and Lifecycle subgraph needed to prove that transition. It does not retain unrelated causal Content
parents merely because their IDs remain signed into those Event bytes.

# Inclusion rule

The Baseline retains every fact needed to identify, authenticate, interpret, reference, or
reconstruct current state. It omits facts whose only remaining purpose is to describe predecessor
transition history or superseded state. Every future Required Feature must provide its own
Baseline codec and equivalence proof.

Retained Capture provenance, effective organization, members, Administrators, active Credentials,
Recovery state, required Key Epochs and Envelopes, features, conflicts, and dependencies survive.
Deleted Captures selected for omission and their Capture-scoped Tags and Notes do not. Search and
other Materializations never enter the Baseline.

The successor assigns fresh Baseline Cause IDs to every retained Content fact that later Content
Events may need to name. It reuses one mapping wherever the same predecessor cause controls several
checkpoint facts. These identities preserve exact state operations without retaining source
Content Event identity, reachability, or invented ancestry. Authority and Lifecycle identities are
not remapped because the Continuity Proof must remain independently verifiable.

# Adult Administrator decision

Before signature, the Client surfaces every known conflict, divergent or unpublished branch,
unavailable dependency, omission, and consequence. It offers only valid options. One current
Administrator chooses; there is no quorum or forced delay. Invalid or incomplete source state still
fails closed.

# Replica adoption

Another Replica may adopt only after full verification. It may first Fork the predecessor, create
a Complete Export, recover eligible captures, decline, or postpone. Concurrent successor
Generations remain siblings. No Replica can force deletion of independently retained history.
The adopting Client switches its Directory, Replica Safety State, local resolutions, idempotent
outcome, and Materialization invalidation in one atomic commit; predecessor authoritative bytes
remain available until a separate Garbage Collection decision.

# Fork distinction

Fork is state copying into a new Vault: fresh identities, keys, authority, Objects, Baseline, and
Genesis, with no source Event graph. Complete Export is a static package that may retain the exact
source graph. Historical View derives old state without moving the writable Frontier backward.

# Garbage Collection

Vacuum changes accepted shared history; local Garbage Collection reclaims bytes afterward. It
traces every locally recognized Generation, Continuity Proof, and preservation root. This
distinction is essential because an offline Replica, Backup, or export may retain predecessor data
indefinitely.

# References

- `docs/specifications/vault/vault.md`
- `docs/specifications/portability/import-export.md`
- `docs/architecture/10-projection-engine.md`
