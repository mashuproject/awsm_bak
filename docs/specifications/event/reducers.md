# Vault Event Reducer Specification

**Document:** `docs/specifications/event/reducers.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/event/event.md`
- `docs/specifications/event/event-format.md`
- `docs/specifications/vault/authority.md`
- `docs/specifications/vault/collection.md`
- `docs/specifications/vault/vacuum.md`

---

# 1. Purpose

This specification defines deterministic reduction of accepted concurrent Vault Events. It is the
exhaustive base sibling matrix. Each sibling is first validated independently at its causal and
Authority Parents; reduction never makes an invalid Event valid.

# 2. Reduction classes

The base classes are:

1. additive union;
2. causal scalar;
3. observed remove;
4. graph validation;
5. N-way authored-content conflict;
6. authority-specific reduction; and
7. Generation/lifecycle choice.

Events over disjoint identities commute unless one changes the authority, active Key Epoch,
Required Feature Set, Generation, or Closed state needed to interpret the other.

Content reduction uses the causal parent DAG. Authority and Lifecycle reduction uses the signed
Authority Parent subgraph. Both are authenticated fields of the same Event Records; arrival order
cannot bridge or reorder either graph.

# 3. Causal scalar algorithm

For one scalar state key:

1. collect every accepted candidate Event affecting that key;
2. remove a candidate when it is an ancestor of another candidate in the set;
3. if one causally maximal candidate remains, use its value;
4. otherwise sort maximal candidates by raw 32-byte `recordId` ascending and use the first; and
5. retain every Event as immutable history.

A Baseline initializes the reducer with its checkpointed effective value and fresh Baseline Cause
IDs. Every accepted Event in that Generation descends from the Baseline and therefore causally
follows the whole checkpoint for the state keys it changes. A Baseline Cause ID is not a reachable
Record and is never compared against a post-Baseline Event as a sibling. It remains usable only
where an exact Event schema asks the author to name an observed cause or unresolved candidate.

Baseline Cause IDs stored in one Baseline have no invented ancestry among themselves. An owning
checkpoint codec stores any current winner whose pre-Vacuum causal selection must survive, such as
Collection Tail. A later operation that combines previously separate checkpoint values uses that
type's explicit Baseline-sibling rule rather than guessing discarded history.

The comparator is a convergence function only. It does not claim newer time, stronger authority,
fairness, or resistance to identifier grinding. A later valid descendant may intentionally
supersede the derived value.

# 4. Base content matrix

| State or Event family              | Reducer                             | Conflict or fence                  |
| ---------------------------------- | ----------------------------------- | ---------------------------------- |
| Distinct Bundle registrations      | additive union                      | stable-ID collision only           |
| Vault label                        | causal scalar                       | none                               |
| Client Credential label            | causal scalar                       | none; never authority equivocation |
| Capture Active/Deleted             | causal scalar                       | none                               |
| Capture Collection assignment      | causal scalar                       | none                               |
| Collection title                   | causal scalar                       | none                               |
| Collection redirect edges          | graph validation                    | Collection Merge Conflict          |
| Collection Folder placement        | causal scalar                       | none                               |
| Folder creation                    | additive union                      | stable-ID collision only           |
| Folder name                        | causal scalar                       | none                               |
| Folder parent                      | scalar edges, then graph validation | Folder Conflict on cycle           |
| Folder Active/Deleted              | causal scalar                       | none                               |
| Tag creation                       | additive union                      | stable-ID collision only           |
| Tag name                           | causal scalar                       | none                               |
| Tag assignment                     | additive union                      | visually deduplicated only         |
| Tag removal                        | observed remove/add-wins            | none                               |
| Tag Active/Deleted                 | causal scalar                       | none                               |
| Tag redirect edges                 | graph validation                    | Tag Merge Conflict                 |
| Note creation                      | additive union                      | stable-ID collision only           |
| Note revision or revision/deletion | N-way authored-content              | Note Conflict                      |
| Concurrent Note deletions          | convergent deletion                 | none                               |

Duplicate display names and matching URLs never create identity conflicts or automatic merges.

# 5. Observed remove

A Tag Removed Event names the exact active Tag Assigned Cause IDs observed for one Tag and typed
target. It deactivates those facts only. A concurrent unseen assignment survives. A later remove
that observes the surviving fact removes it normally.

Removal lists are canonical sets and MUST be non-empty, belong to the exact relation, and be active
at the remover's parents. Extra, unknown, or already inactive facts make the Event invalid rather
than a no-op.

# 6. Graph validation

Collection and Tag redirects compose when:

- each source has at most one effective destination; and
- the transitive graph is acyclic.

Several sources may share one destination and compatible chains resolve transitively. Multiple
effective destinations for one source or a cycle creates the type-specific scoped Conflict. No
scalar comparator chooses an edge.

Folder parent candidates first use causal scalar reduction per Folder. The resulting effective
edges MUST form one acyclic forest. A cycle creates a Folder Conflict over every member of the
cycle and its ambiguous structural dependents.

Resolution Events MUST name every known conflicting maximal Cause ID and establish one exact valid
replacement graph. Before Vacuum these causes are Event Record IDs; after Vacuum they may include
Baseline Cause IDs. The Resolution Event is itself the reversible controlling redirect fact. A
later unseen head creates another Conflict. Its causal-parent state MUST expose the named
candidates; Baseline Cause IDs are never added to either Event parent frontier.

# 7. N-way Note conflict

For one Note ID, collect causally maximal Note Revised, Note Deleted, and applicable Note Restored
heads. More than one incompatible revision or revision/deletion choice creates an arbitrary N-way
Note Conflict. Concurrent deletions represent the same deleted choice and converge.

Resolution names every known maximal Cause ID and atomically chooses one of:

- retain one revision under the original Note ID;
- create a new merged whole-Note revision;
- abandon selected logical versions; or
- retain one selected version under the original ID and create fresh Note IDs for every other kept
  version.

No timestamp or `recordId` comparator hides Note content. Missing source content prevents
destructive resolution of that Note only.

# 8. Membership and Administrator matrix

- Distinct member additions from valid Invitation Acceptances are additive.
- Membership End Events accumulate and make the target inactive.
- Membership End dominates concurrent Administrator Grant or End, Client Credential Enrollment or
  End, Recovery Credential Replacement, and labels for continuing authority of that target.
- Self-resignation and Administrator removal of one target converge to inactive; the presence of
  any valid Administrator removal derives the excluding-Key write fence.
- Concurrent Administrator Grants for one active target converge.
- Concurrent Administrator Ends for one target converge.
- Concurrent Grant versus End for one target creates an Administrator Authority Conflict.
- Membership End dominates that role Conflict.
- Concurrent removals that leave no Administrator derive Closure.

The Administrator role Conflict fences governance whose validity depends on the disputed role.
Ordinary content continues. Resolution is a Grant or End whose complete Authority Parent Frontier
descends from every role head and whose signer is an independently unambiguous Administrator.

# 9. Client and Recovery Credential matrix

- Distinct Client Credential Enrollments for one active member are additive.
- Client Credential End Events for one credential converge and dominate its future eligibility.
- Recovery Credential Replacements for different members commute.
- Concurrent Replacements for one member create a recovery-only Authority Conflict.
- A descendant Replacement joins every effective recovery head and creates one fresh credential.
- A Recovery Fence dominates a concurrent Enrollment authorized by a closed recovery head.
- Proven same-credential Authority equivocation overlays the type-specific result, makes the
  credential ineligible, and fences protected writes pending an excluding Key Epoch.

Existing eligible Client Credentials and unrelated Vault work continue during a recovery-only
Conflict.

# 10. Invitation matrix

Distinct Invitation Creations are additive. One Invitation Redemption Authority serializes
ordinary consumption and cancellation for its Invitation. Same-outcome receipts for the same
candidate are idempotent evidence.

Incompatible receipts create an Invitation Conflict. An unambiguous pre-existing Administrator
resolves it by selecting one consumed candidate or cancelling all. A disputed candidate cannot use
its conditional Administrator grant to resolve itself. Any rejected consumed candidate requires
an excluding Key Epoch before protected writes continue.

Invitation Acceptance concurrent with unrelated authority work remains valid at its own Authority
Parents; Key Delivery repairs any target-specific envelope gap. Acceptance concurrent with Closure
grants at most Historical Access to the resulting Closed Vault.

# 11. Key Epoch and delivery matrix

Distinct sibling Key Epoch Transitions never receive a scalar winner. They create a Key Epoch
Conflict and fence protected writes. Resolution is one Administrator-authorized Transition that:

- names every effective Epoch head;
- creates a fresh independent Key Epoch Key;
- provides one parent-key bootstrap representation per head; and
- binds the complete retained-target Key Envelope set.

Key Delivery is additive availability repair for an already-authorized target. Correct duplicate
deliveries project as one usable slot. A malformed delivery cannot suppress a later correct one.
Key Delivery never activates or chooses an Epoch.

# 12. Feature activation matrix

Feature Activations form a set when their exact Manifests and declared requirements and
incompatibilities permit the combined Required Vault Feature Set. Activating the same Manifest
twice has one derived effect.

Concurrent incompatible revisions or mutually incompatible Manifests fence semantic acceptance and
authoring at their joined frontier. There is no generic feature-deactivation or feature-conflict
Event. Resolution requires a verified Vacuum Baseline that retains one supportable state only when
no retained fact depends on the rejected feature, or a state-only Fork.

# 13. Closure and Vacuum matrix

Closure dominates every concurrent branch in its predecessor Generation. Valid siblings remain
historical evidence, but no descendant may extend the Closed frontier. A sibling Vacuum successor
cannot be adopted as the continuing Generation after Closure is known; it may be preserved only as
a Fork with a fresh Vault ID.

A Vacuum Event includes exactly the predecessor frontier it names. It never absorbs an unnamed
sibling. Eligible Capture content may be re-authored to the successor; authority or lifecycle facts
are not replayed.

Several Vacuum successors from one predecessor form a Generation Conflict. No timestamp,
`recordId`, Host, or arrival order selects one. A Replica chooses one successor for the original
Vault and Forks any alternative it preserves. Replicas that choose different successors do not
pretend to be synchronized.

# 14. Stable-ID collision

Two incompatible creation facts claiming one generated entity ID are not an ordinary reducer
race. The affected identity and its dependent operations are quarantined as an integrity collision.
Unrelated Vault work continues. Eligible content may be re-authored under a fresh identity.

# 15. Narrow fencing

| Condition                                             | Minimum fence                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| Recovery Conflict for one member                      | that member's recovery actions                                   |
| Missing Key Delivery                                  | that target's operations needing the Epoch                       |
| Administrator role Conflict                           | governance depending on that role                                |
| Folder Conflict                                       | affected hierarchy mutations                                     |
| Collection Merge Conflict                             | affected graph-dependent organization                            |
| Tag Merge Conflict                                    | affected merge and redirect operations                           |
| Note Conflict                                         | edits and destructive resolution of that Note                    |
| Key Epoch Conflict                                    | protected writes                                                 |
| Involuntary member or credential removal before rekey | protected writes                                                 |
| Credential equivocation                               | protected writes pending exclusion                               |
| Invitation conflict with consumed candidate           | protected writes pending outcome/exclusion                       |
| Unknown Required Feature                              | semantic acceptance and authoring after last understood frontier |
| Generation Conflict                                   | adoption/synchronization across selected successors              |
| Closure                                               | all new Events in that Vault lineage                             |

# 16. Invariants

- Validation occurs before reduction.
- A multi-head frontier is not itself a Conflict.
- Reducers never use Host arrival order, Delivery Cursor, or asserted time.
- Scalar convergence never applies to unique authored Note content or authority choices.
- Resolution names every known relevant head and preserves immutable evidence.
- A later unseen head may reopen only its type-scoped Conflict.
- Unaffected valid work remains available.

# References

- `docs/specifications/vault/authority.md`
- `docs/specifications/vault/collection.md`
- `docs/specifications/vault/vacuum.md`
