# Testing Strategy

**Status:** Draft target assurance contract

**Depends On:**

- `docs/architecture/00-design-principles.md`
- all owning formal specifications

# Purpose

AWSM verifies deterministic portable contracts at several boundaries: pure codecs and reducers,
transactional storage, adversarial synchronization, real Client surfaces, and black-box Hosts.
Passing one layer never substitutes for evidence at another.

# Canonical vectors

Golden fixtures cover deterministic CBOR rejection and encoding, every transcript and ID, Event
signature, Baseline authentication, Feature Set, HKDF derivation, Ed25519, HPKE envelopes,
XChaCha compact and stream frames, opaque envelope parsing, BIP39 recovery, and Complete Export.
Vectors include single-byte mutation, truncation, duplicate keys, noncanonical order, wrong domains,
cross-type substitution, nonce misuse, padding mutation, unsafe lengths, and unknown features.
Baseline fixtures additionally prove fresh unique Cause IDs, consistent same-cause mapping, no
source Content Record dependency, and exact post-Baseline remove, revert, supersession, and
resolution. Continuity fixtures prove Authority Parent completeness, cross-Generation Vacuum
anchors, exact authority reduction with unrelated Content parents absent, and rejection of a
self-asserted successor Baseline.

# Reducer model tests

Property and model tests generate arbitrary DAG topologies and input arrival orders. Every
permutation must produce identical accepted state, conflicts, and fences. Coverage includes all 14
Authority, 31 Content, and 2 Lifecycle base Event types plus:

- compatible and incompatible multi-head reduction on more than three Replicas;
- exact observed-remove behavior;
- N-way Note conflicts and atomic split resolution;
- Collection and Tag redirect graphs, reversal, and conflict resolution;
- Folder cycles created only by concurrent valid moves;
- timestamp skew, far-future timestamps, and Record ID tie rules;
- Client Credential equivocation and scoped quarantine; and
- unknown Required Features stopping semantic progress without byte loss.

# Authority ceremony tests

Tests exercise Genesis, independent recovery from phrase plus opaque inventory, existing-Credential
enrollment, one-use Invitation redemption, cancellation races, concurrent redemption candidates,
member resignation, Administrator removal, role changes, own and adversarial Credential end,
Recovery replacement conflicts, Key Epoch target completeness, Key Delivery, and Feature
Activation.

Recovery in particular proves discovery without prior Vault/member IDs, complete Frontier closure,
Continuity Proof verification after any number of Vacuums, enrollment by each effective candidate
in a multi-head recovery conflict, rejection of a closed ancestor phrase, descendant all-head
replacement, partial synchronization between ceremony Events, concurrent candidate recoveries, and
inability to claim global freshness from one withholding Replica.

The readable-Replica recovery path additionally proves that a wrong but valid phrase and an
incomplete or duplicate authenticated Envelope slot set cause no phrase-authorized opaque read;
every opened Envelope is bound to its exact Vault, Epoch, Credential, revision, and ID; Enrollment,
local secrets, selection, logical resolutions, and Replica Safety State commit under one Frontier
compare-and-swap; and a real storage restart can replay and author with the fresh Client. The next
ceremony proves full fresh-phrase confirmation, all-head Replacement, rejection of the retired
phrase, retry after phrase mismatch, consumption after cancellation or failed commit, and one
effective Recovery head after restart.

# Replica and Host tests

At least two independent Client implementations or profiles and two isolated Hosts exercise:

- pull-only discovery, duplicate/delayed/lost Wake Hints, and cursor reset;
- randomized destination rewrapping and exact-byte mirror correlation;
- immutable admission, ambiguous retry, range reads, resume, quotas, and races;
- explicit local Remote retirement: atomic credential/configuration and pending-work cleanup,
  in-flight channel fencing, no Host request, live multi-surface update, and retained Host bytes
  recoverable by another Client;
- Accounts and other Channel Principals separated from Vault members;
- several Accounts granted to one Hosted Replica and one Account granted to several;
- a local peer or headless Host with no Account model;
- Host ignorance of portable IDs, types, DAG shape, and semantic errors;
- withholding, reordering, replay, corruption, truncation, and cross-Replica disclosure attempts;
  and
- Host-local transaction isolation without a portable Vault sequencer.

Black-box Host tests use only public executable APIs and inspect storage/log output for forbidden
plaintext and semantic metadata. The checked-in executable OpenAPI must match implemented routes
exactly.

# Storage and crash tests

Failure injection covers every boundary between Prepared Data, database commit, wrapper promotion,
Replica Safety update, cursor advancement, projection update, and cleanup. Restart must expose one
complete valid state. Garbage Collection tests trace every Generation, dependency, preservation
root, pending workflow, and fence before deletion.

Complete Import tests mutate Genesis possession, descendant signatures, Continuity and Vacuum
anchors, Baseline checkpoints, wrapper identities, Key Epoch authority, and exact dependency
closure. Unknown-Vault activation proves Artifact promotion before one initial-Replica commit,
authoring-free restart through the ordinary open path, collision atomicity, and cleanup or
reconciliation of preparation-owned state after every failure boundary.

Known-Vault Import tests classify both causal and Authority DAGs, including equal, ancestor,
descendant, sibling, and mixed-direction pairs. Same-Generation fast-forward tests cover opaque
reprotection of an existing logical item, active local authoring retention and recipient Key
Envelope verification, exact Replica-state compare-and-swap, restart, and non-mutation for ancestor
or divergent input.

Cross-Generation Import tests prove a unique authenticated Vacuum chain to the incoming Baseline,
inclusion of both local predecessor Frontiers at the first boundary, non-mutation when either local
Frontier is omitted, and non-rewind when the incoming package is a Generation ancestor. Successful
adoption tests reopen the successor through the ordinary Vault path, invalidate predecessor Library
and Search Materializations in the same compare-and-swap transaction, preserve local safety roots,
and leave predecessor authoritative bytes available to separate Garbage Collection.

Backup tests require exact destination readback before manifest-last Snapshot publication, complete
package and semantic validation, no committed Snapshot after write, readback, protection,
authentication, or commit failure, and cleanup of Prepared Data and Key Epoch copies. Restore tests
bind the encrypted package length and digest to the Snapshot, reject Manifest substitution before
Replica mutation, activate an unknown Vault as authoring-free, route a known Vault through ordinary
Import collision rules, and prove restart in real browser storage. Retention tests trace every
manifest-to-package dependency, reject missing, duplicate, foreign, or concurrently changed
inventory, and remove only explicitly selected Snapshots plus package entries unreachable from the
retained set. Exact package publication is idempotent at the same digest and Snapshot ID; the
initial format does not claim independent inner-entry deduplication between different packages.

Replica Garbage Collection tests authenticate the current Replica before tracing, retain active and
explicitly preserved causal branches, retain only Authority Parents and typed dependencies for the
Continuity Proof, and reclaim an adopted successor's Initial Baseline only when no other root needs
it. Transaction tests require exact prior-Replica compare-and-swap for compact bytes, resolutions,
and unused Epoch Secrets; active fences cause no mutation. Heavy-wrapper tests preserve the cleanup
identity across interruption and exclude every Storage Item retained through physical
deduplication. Real-browser proof deletes predecessor compact state after Vacuum Adoption and then
reopens the successor through the ordinary authority path. It also creates a real unreachable
streamable wrapper, interrupts after OPFS removal, proves the Job, fence, resolution, and Epoch
safety state survive, expires and reacquires the lease, repeats deletion idempotently, and proves
the final conditional transaction removes the fence and resolution, retains one Succeeded Job with
the exact whole-operation outcome, and leaves the wrapper absent before ordinary restart. A later
heavy-cleanup proof conditionally retires the prior terminal Job when it installs the next Job and
fences. Concurrent promotion tests reject either the exact fenced Artifact ID or Storage Item ID
while permitting unrelated pairs. Resume tests also inject newly unreachable compact state under a
candidate Epoch and prove that the bounded Job leaves both for the next collection.

Physical-deduplication tests retain a wrapper reached by any logical Artifact, reclaim unreachable
alias resolutions without scheduling physical deletion, and reject conflicting Key Epoch claims
for one exact wrapper.

Storage Relief always displays the non-blocking last-copy warning, records only local eviction,
works with zero Remotes, and treats later absence or corrupt hydration honestly. On-demand Replicas
can Capture without first hydrating unrelated wrappers. Library proofs delete a local wrapper after
its Frontier-bound Materialization is cached, then require a fresh Library read to show that exact
Capture unavailable and expose only its explicit retrieval action at primary and narrow widths.

# Vacuum, Fork, Closure, and history

Vacuum tests cover complete preflight disclosure, unknown-state failure, unresolved conflicts,
unavailable wrappers, exact successor state equivalence, omission inventory, terminal predecessor
Event, non-reachability of old history, Materialization invalidation, sibling successors, adoption,
decline, Fork Before Adoption, Complete Export, Event Re-authoring eligibility, retained minimal
Continuity Proof with discarded Content parents absent, fresh Recovery verification, malicious
Baseline substitution, and no silent loss of unpublished work.

Fork tests prove fresh IDs, authority, credentials, keys, Objects, Initial Baseline, and Genesis;
preservation of selected current logical state and Deleted content; omission of source Event and
member authority history or source Continuity Proof; preservation of non-authoritative Historical
Attribution; fresh remapped Baseline Cause IDs; and unchanged source bytes. Closure tests cover
explicit and last-Administrator paths, rejection of later Events, and continued View, Export,
Recovery where applicable, and Fork.

# Product-surface tests

Packaged Chrome and Mozilla-signed Firefox proof uses real browser storage, worker restarts,
permissions, multi-Vault selection, capture, import/export, local search, Account dashboard, Host
authentication, and cross-profile synchronization. UI tests verify conflict and destructive-action
consequences rather than only hidden state.

Public pages and dashboard tests separate cacheable unauthenticated content from private no-store
Account state. They must never imply that logging in grants Vault decryption or that the website is
a duplicate web Vault host.

# Current-versus-target evidence

Implemented suites prove only the exact code paths and boundaries they execute; target documents
are never test evidence by themselves. Convergence work begins with failing target vectors and
black-box scenarios, removes superseded fixtures and compatibility expectations, and updates public
claims only after real proof. The current local opaque-Host proofs cover session rotation, bounded
Grant isolation and revocation, verified compact-envelope admission, cross-process opaque reads,
and process stop/restart continuity. The packaged Chromium Hosted-recovery proof additionally creates
one disposable Host Account and Vault, explicitly materializes the authenticated Compact closure,
and recovers it through the real HTTPS Host adapter into a fresh browser profile. It proves the
recovered Client can immediately Capture and that recovery does not configure a Remote. The same
lane uses a second isolated Host to prove a later Capture is withheld by the first Host, directly
recoverable from the second, absent from the fresh Client before attachment, and accepted after an
explicit existing-Hosted-Replica attachment and pull. It also proves local Remote rename and
pause/resume after real setup and materialization, including that a paused Remote no longer offers
materialization. The rendered design lane verifies the management and attachment/selection surfaces
at primary and narrow widths for contrast, interactive target size, and snapshot regression. Two
concurrently open popups prove a local pause reconciles through the ordinary invalidation path
without either popup reloading. The loopback TLS terminator is test-only. These are repository
evidence, not evidence of a named deployment, Firefox behavior, full Authority-branch
synchronization, or global freshness.

# Invariants

- Tests never seed authoritative rows behind public boundaries for an end-to-end proof.
- Determinism is checked across order, restart, process, and implementation.
- Confidential fixtures and credentials never enter tracked evidence.
- Destructive staging tests use isolated disposable data and explicit authorization.

# References

- `docs/architecture/consistency-review.md`
- `docs/specifications/runtime/jobs.md`
- `docs/specifications/vault/authority.md`
