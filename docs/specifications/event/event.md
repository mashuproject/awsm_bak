# Vault Event Specification

**Document:** `docs/specifications/event/event.md`

**Version:** 1.0

**Status:** Draft

**Depends On:**

- `docs/specifications/event/event-format.md`
- `docs/specifications/event/reducers.md`
- `docs/specifications/vault/authority.md`
- `docs/specifications/vault/vault.md`

---

# 1. Purpose

This specification defines common Vault Event semantics, validation, authorship, causality,
timestamp meaning, equivocation, and the boundary between Event types and user workflows. Exact
authority bodies are owned by `docs/specifications/vault/authority.md`; content bodies are owned by
`docs/specifications/vault/collection.md` and the Bundle specifications; lifecycle bodies are owned
by `docs/specifications/vault/vacuum.md` and `docs/specifications/vault/vault.md`.

# 2. Accepted fact

A Vault Event is one immutable signed accepted fact. It is not a mutable record, arbitrary patch,
Command, Job, transport message, Host audit entry, or synchronization acknowledgement.

Every Event type defines:

- exact canonical body fields;
- authorization at the declared parents;
- parent-state preconditions;
- exact typed dependencies;
- the derived state transition;
- sibling reduction and conflict behavior;
- Baseline checkpoint representation; and
- applicable Required Vault Features.

An Event is either wholly valid or invalid. A body MUST NOT contain a generic list of independently
effective mutations.

# 3. Authorship

Every Vault Event is signed by exactly one Client Credential acting for exactly one Vault Member.
Ordinarily the credential MUST be active and eligible in Authority State derived at the Event's
exact Authority Parents.

The two bootstrap rules are:

- Genesis has no parents and is signed by the first Client Credential whose public material and
  creation proof it binds; and
- Recovery-authorized Client Credential Enrollment is signed by its proposed credential while one
  effective Recovery Credential at the Authority Frontier separately authorizes the exact
  Enrollment Proposal.

Recovery-authorized Enrollment relies on pre-existing recovery authority and is not
self-authorization. No other Event may be authored by an inactive credential.

A Runtime, Service, API Client, Account, Recovery Credential, Replica Host, or Synchronization
Session may initiate or service a workflow but cannot replace the Event signature.

# 4. Authority-Frontier authorization

Validation derives complete Vault Authority State from the Event's declared Authority Parent
Frontier before applying the Event's own transition. The Event cannot authorize itself or rely on
an Authority or Lifecycle sibling absent from that frontier.

An Event valid at its Authority Parents may remain valid as a concurrent sibling of another Event
that ends its signer. After the authority branches converge, the ended signer cannot authorize a
descendant. Eligible Capture work may be re-authored; stale authority transitions are never
replayed.

# 5. Causality

A parent relationship means the author had accepted that Record. A descendant is causally later
than its ancestors. Siblings that share parents and do not descend from one another are concurrent.

Synchronization creates no Event. Compatible multi-head frontiers may persist after Replicas
converge. A later substantive Event names every accepted maximal head and joins them. A
content-neutral Sync Event is prohibited.

Event parents always name reachable Vault Record IDs. When a body removes, reverts, supersedes, or
resolves an existing fact, its exact schema instead names Cause IDs. A current Cause ID is either a
fact-producing Content Event Record ID in this Generation or a fresh identity assigned to that fact
by the Generation's Baseline. A Baseline Cause ID never becomes a causal parent.

The Authority Parent subgraph is an authenticated projection of the same signed Record set, not a
second Event log. It contains Genesis and every Authority or Lifecycle Event needed to prove
current authority continuity while allowing discarded Content parents to remain unresolved after
Vacuum. Authority-specific concurrency and precedence use this subgraph; Content reduction uses the
complete causal DAG.

# 6. Timestamp

`assertedAt` is a signed author claim used for audit and approximate presentation. A Capture's
separate `capturedAt` is intrinsic provenance. Neither value proves physical creation time, causal
precedence, authority, or a conflict winner.

A client MAY warn about an implausible future or past assertion and preserve it as signed evidence.
Clock policy MUST NOT invalidate otherwise valid offline work merely because no trusted time source
is available.

# 7. Authority equivocation

A conforming Client Credential serializes its Authority Events. Two distinct Authority Events
signed by the same credential from an identical Authority Parent frontier prove Client Credential
Equivocation. Exact retransmission of identical authenticated bytes and `recordId` is an idempotent
retry.

At a frontier containing proven equivocation:

- every signed Event remains evidence;
- compatible type-specific effects still apply;
- incompatible effects use their ordinary type-specific Conflict rule;
- the signing credential becomes ineligible for descendants; and
- protected writes fence until an Administrator activates a Key Epoch excluding that credential.

No synthetic Client Credential End Event, compromise flag, penalty Event, or universal winner is
created. Same-parent Content Events do not invoke this rule and follow their Content reducer.

# 8. Workflows versus facts

The following are Commands, ceremonies, derived outcomes, or local operations rather than Event
types:

- resign membership;
- remove a member and establish Future Protection;
- recover or enroll a Client Credential;
- recover captures;
- delete a Collection;
- extract Captures;
- move to Unfiled;
- keep Note versions as separate Notes;
- Vacuum Adoption;
- Fork and Fork Before Adoption;
- Complete Export, Backup, Restore, and Import;
- Replica Garbage Collection and Storage Relief;
- Hosted Replica reaping; and
- synchronize now.

A workflow MAY commit causally ordered Events in one local transaction, but each remains
independently valid. A Command MAY produce one homogeneous batch Event when one decision applies
atomically to several exact targets and partial application would misrepresent it.

# 9. Content Events

Content Events record Captures, labels, organization, and reversible lifecycle facts. Ordinary
member authority is sufficient unless a type explicitly requires Administrator authority, as Tag
merge does.

Independent facts combine. Causal scalar facts converge deterministically. Graph and authored-
content conflicts fence only the affected identities. Same-parent Content Events signed by one
credential are not authority equivocation.

# 10. Authority Events

Authority Events record Genesis, membership and Administrator changes, Invitations, Client and
Recovery Credentials, Key Epoch state and delivery, and Required Feature activation.

Their bodies store cryptographic causes, exact targets, and dependencies, not redundant statuses or
reasons. Type-specific reduction over the Authority Parent subgraph may accumulate effects,
dominate stale authority, derive Closure, or require explicit resolution.

# 11. Lifecycle Events

Closure Event irreversibly ends writable history. Vacuum Event terminates one predecessor
Generation and authenticates a successor Baseline. Neither behaves as ordinary additive content or
receives a scalar winner.

# 12. Event Re-authoring

The base re-authoring eligibility set is only Bundle Registered Event. A currently authorized
Client Credential creates a new Event with current parents, authority, Key Epoch, and an
authenticated source `recordId`. The new Event preserves intrinsic Capture provenance but receives
a new signature and Record ID.

Organization, Authority, conflict-resolution, Lifecycle, Feature Activation, and Key Epoch Events
MUST NOT be re-authored. Future eligibility requires a Required Vault Feature with exact safety and
idempotency semantics.

# 13. Validation and rejection

A verifier rejects an Event for any of these reasons:

- non-canonical or unknown envelope, family, type, field, or Required Feature;
- mismatched Record ID, Vault, Generation, parent, signer, signature, or dependency;
- incomplete current causal or dependency closure or incomplete Continuity Proof;
- inactive, ineligible, ambiguous, or unauthorized signer;
- false body precondition or invalid target state;
- Event whose parents are Closed;
- unsupported or conflicting state whose type rule requires a fence; or
- failure of the exact type-specific reducer or Baseline contract.

Rejection is deterministic and local. A Host admission or another Replica's acceptance cannot make
an invalid Event valid.

# 14. Invariants

- Accepted Events never mutate or disappear through convergence.
- All authorization is Authority-Frontier authorization.
- Causal ancestry, not timestamps, determines precedence.
- Synchronization transports Events and never authors them.
- Consequences are derived from typed facts.
- Conflicts are type-scoped and preserve every source Event.
- The Runtime never emits a knowingly invalid Event while an applicable capability is fenced.

# References

- `docs/specifications/event/event-format.md`
- `docs/specifications/event/reducers.md`
- `docs/specifications/event/commands.md`
