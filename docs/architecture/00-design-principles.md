# Design Principles

**Document:** `docs/architecture/00-design-principles.md`

**Status:** Normative

**Owner:** Architecture

---

# Purpose

These principles govern AWSM product and architecture decisions. They outrank implementation
convenience. The normative glossary owns terminology; formal specifications own exact contracts.

# 1. Preserve before interpreting

Capture the most faithful valid representation available before enrichment, extraction, ranking,
or summarization. A best-effort Capture records exact omissions and warnings rather than pretending
that unavailable representations were preserved.

Interpretation is additive. It never mutates an original Capture.

# 2. Authoritative data is immutable

Vault Records, Objects, Bundles, Artifacts, and their identifiers never change after acceptance.
Correction, deletion, restoration, organization, enrichment, authority changes, and lifecycle
changes create new signed facts.

Physical storage may repack, stream, compress, or relocate exact logical bytes without changing
their identity.

# 3. The client owns plaintext

Only trusted Client Installations decrypt Vault content, hold unwrapped Vault keys, derive semantic
state, run private Search, and author Vault Events. Plaintext, unwrapped keys, Recovery Phrases,
content-derived metadata, and Search Materializations never cross the opaque Replica Host boundary.

A remote AI Provider is a separate explicit plaintext disclosure, never an implicit consequence of
synchronization.

# 4. Hosts coordinate; they do not become Vault authority

A Replica Host may authenticate Channel Principals, enforce exact Grants, admit opaque bytes,
apply quotas, and manage its own lifecycle. It cannot determine Vault membership, portable
Administrator authority, semantic validity, causal history, conflict resolution, or safe Vault
reachability.

Account access, Replica Access Grants, and portable Vault authority remain separate. No Hosted
Replica is canonical merely because it is always online or acknowledges a write.

# 5. The Vault is logical and every Replica is optional

A Vault has no singular physical home, origin, or coordination attachment. It may have zero or more
local, direct, or Hosted Replicas. A Complete Export or Backup is a portability or recovery
artifact, not another live Replica.

Adding or losing a Replica must not change the Vault's identity or portable authority.

# 6. Local-first availability is the default

A trusted client continues every safe operation from locally available data during a network
partition. Captures and ordinary member work do not wait for a Coordination Server, another
Replica, or an Administrator unless that exact operation needs remote bytes or governance
authority.

Local success is reported as local success. It is never misrepresented as Remote acknowledgement,
global publication, or global durability.

# 7. Synchronization is requester-initiated pull

A Replica asks one configured Remote for opaque inventory and missing bytes, validates them
locally, and accepts only complete authenticated results. Publishing candidate ciphertext to a
Host is Host Storage Admission, not semantic synchronization acceptance. Wake Hints only prompt a
pull.

Correctness must not depend on push delivery, permanent connections, background timers, browser
lifecycle, or a singular server head.

# 8. Prefer availability with verified convergence

Network Partition tolerance is required. Ordinary Vault content favors local availability and
later deterministic convergence instead of a linearizable global view. Server-local Accounts,
sessions, Grants, quotas, and lifecycle changes favor consistency within that Host's policy plane.

The Vault Record DAG proves ancestry and exposes concurrency. Event-family reducers decide whether
accepted siblings combine, converge deterministically, or require explicit resolution.

# 9. Use causality, not clocks, for correctness

A descendant is causally later than its ancestors. Concurrent siblings have no intrinsic physical
order. Signed timestamps support provenance, audit, and approximate presentation only; they never
establish portable authority or select a conflict winner.

Host arrival order, Delivery Cursor, identifiers, and asserted time cannot manufacture causal
precedence.

# 10. Store causes; derive consequences

Portable state records the signed facts and cryptographic material from which membership,
Administrator authority, credential eligibility, Key Epoch state, lifecycle, conflicts, and
Future Protection are derived. Do not persist duplicate reason, status, eligibility, or workflow
flags that can disagree with those causes.

A user workflow may commit several causally ordered Events together without hiding them inside a
generic mutation list.

# 11. Fence narrowly

Start from the best coherent user experience. Fence only the smallest operation or authority
domain whose continuation would:

- reveal protected plaintext, keys, or metadata;
- accept invalid or ambiguous authority;
- commit corrupt, incomplete, or unsupported authoritative state;
- cause an undisclosed irreversible loss; or
- make a false security, synchronization, redundancy, or integrity claim.

An offline Administrator, unavailable Remote, conflict in another state family, incomplete
topology knowledge, or missing optimization does not by itself block unrelated valid work.

# 12. Preserve work when publication is unsafe

When a write capability is fenced, prefer a complete explicit pending result, later Event
Re-authoring, Fork, Complete Export, or another active Vault over silent loss. Pending work is not
authoritative and must never appear synchronized or accepted.

Authority transitions and destructive operations are never re-authored as ordinary content.

# 13. Treat informed users and Administrators as adults

Explain exact consequences before destructive, irreversible, privacy-reducing, or availability-
reducing operations. Show known conflicts, missing dependencies, unpublished branches, and
preservation choices. If the resulting transition remains valid, permit the informed user or
authorized Administrator to proceed.

Warnings do not become unverifiable guarantees. Storage Relief remains available after an
unconditional last-copy warning because no client can know global redundancy.

# 14. Membership and administration are portable

Every Vault is multi-member-capable. Every member has the same class of cryptographic access and an
independent Recovery Credential. Vault Administrator authority governs portable membership and
lifecycle decisions; it does not create a stronger decryption class.

Any one current Administrator may act independently. AWSM does not introduce a quorum merely to
protect adults from authority explicitly granted to them.

# 15. Historical access cannot be revoked retroactively

No system can make a former member forget plaintext or destroy independent keys, Replicas,
Exports, Forks, or screenshots. Member or Client Credential removal changes continuing authority.
A fresh Key Epoch provides only future cryptographic exclusion.

Product copy must state this boundary precisely.

# 16. Recovery is member-scoped and independent

Every member receives the same kind of Recovery Phrase and Recovery Credential. A Recovery Phrase
restores that member's currently valid portable authority; it does not recover an Account, another
Vault, ended membership, or revoked Administrator authority.

Recovery derivation cannot depend on a value available only after decrypting the Vault. Opaque
Hosts receive no recovery fingerprint or phrase oracle.

Phrase-only recovery after Vacuum must remain independently verifiable. Vacuum may flatten
discarded Content history, but it retains the compact signed Continuity Proof needed to establish
the successor Baseline's Administrator authorization from Genesis. A Host-provided Baseline is
never trusted merely because it decrypts.

# 17. Complete data is accepted atomically

AWSM never persists or advertises an incomplete authoritative Bundle, Baseline, authority
transition, dependency closure, or conflict resolution. Expensive preparation may be paged and
restartable, but activation validates the exact sealed result and commits the authoritative fact
and Replica Safety State atomically.

Prepared Data and Quarantine remain inert until their owning validation and promotion contract
succeeds.

# 18. Projections are disposable

Projections and Materializations never become Vault truth, synchronization input, Baseline content,
or Complete Export requirements. Their identity binds every source and algorithm choice affecting
the result. Changing Search or Projection semantics builds a new Materialization instead of
migrating authoritative data.

Vacuum Adoption invalidates predecessor-Generation Materializations.

# 19. Stable logical families outrank feature stores

Persistent data is classified by authority, trust, scope, durability, lifecycle, validation,
deletion safety, and transaction requirements. New features normally add typed namespaces inside
the existing Logical Storage Families rather than new physical stores.

There is no persistent miscellaneous family. A genuinely new trust or lifecycle boundary justifies
an explicit schema decision instead of hiding it.

# 20. Protocols are transport- and provider-neutral

Vault identity, synchronization, authority, encryption, and convergence semantics do not depend on
HTTP, WebSocket, Rails, a browser API, a cloud provider, or a particular database. Hosts and Drivers
adapt those mechanisms behind explicit interfaces.

Direct, hosted, local-socket, LAN, and future transports use the same semantic contracts.

# 21. Canonical encoding is singular and deterministic

Every authoritative semantic item has one canonical deterministic CBOR representation. Compact
and streamable ciphertext use one defined outer envelope family. JSON is an API or human-readable
view and never participates in authoritative identity, signatures, or encryption authentication.

Content identifiers are domain-separated, non-self-referential digests of exact canonical bytes.
Physical framing and randomized Host-specific wrapping do not change protected logical identity.

# 22. Extension points have explicit safety classes

A Required Vault Feature may add correctness-relevant semantics only through explicit
Administrator activation and exact Feature Manifests. A client that lacks support preserves safe
opaque bytes but stops semantic acceptance and authoring at the last understood frontier.

An Advisory Extension may be ignored only because the stable envelope forbids it from affecting
authority, state, dependencies, validation, Baselines, reachability, rendering, or security.

# 23. Unknown correctness semantics fail closed

Unknown formats, Event types, Required Features, authoritative namespaces, dependency types, and
cryptographic requirements never receive guessed meaning. Safe opaque preservation is allowed; a
fallback interpretation is not.

Unknown optional operational capabilities may disable that operation without invalidating
unrelated local Vault use.

# 24. Pre-release designs are replaced, not migrated

Until the user establishes a compatibility obligation, AWSM has one canonical current design.
Superseded formats, readers, writers, aliases, fallbacks, dual schemas, migration paths, and old
development data have no standing. Framework-required schema migrations express only the current
schema and do not imply preservation.

Self-describing persisted boundaries use their appropriate initial format number. They do not
advertise discarded experiments as prior public versions.

# 25. Portability artifacts retain honest boundaries

Complete Export, Backup, Restore, Import, Fork, Replica, and Historical View are distinct. Export
does not synchronize. Backup is not interchange. Restore reconstructs from Backup. Fork creates a
fresh Vault. Historical View moves no writable pointer.

Vacuum may make a smaller later Export possible only through an explicit destructive Vault
transition with its normal informed-choice rules.

# 26. Security claims require evidence

Cryptographic transcripts, identifier construction, reducer behavior, omission resistance,
equivocation, recovery, partition convergence, Vacuum, Closure, and opaque-Host metadata boundaries
require deterministic vectors, property tests, adversarial tests, and end-to-end proof at the
applicable Client Installation surface.

A successful response, stored ciphertext, or single passing path proves only that narrow result.

# Architectural review checklist

Before accepting a design, verify:

1. Which data is authoritative, derived, local operational, Host policy, or ephemeral?
2. Which Client, Host, Replica, member, credential, and Generation scopes apply?
3. Can an opaque Host learn a protected identity, relationship, type, or content-derived fact?
4. Does the operation remain safe while offline or partitioned?
5. What exact signed cause authorizes the transition at its Authority Frontier?
6. How do every possible concurrent sibling and stale branch reduce?
7. Is any timestamp, Host cursor, or arrival order being asked to prove causality?
8. Are dependencies complete and atomically accepted before authority advances?
9. Is a fence narrower than the failure it protects against?
10. Does the user receive exact consequences and realizable preservation choices?
11. Can the design honestly know redundancy, freshness, deletion, or delivery, or must it avoid the
    claim?
12. Does a new persisted field duplicate a derivable consequence?
13. Does a new feature fit an existing namespace and Required Feature boundary?
14. Can Projections and indexes be deleted and rebuilt?
15. Do Complete Export, Backup, Restore, Fork, and Replica semantics remain distinct?
16. Does the design introduce compatibility support that has not been authorized?
17. Which deterministic, adversarial, multi-Replica, and rendered-product evidence proves it?

# Non-goals

AWSM does not attempt to provide:

- server-side plaintext Search or content interpretation;
- a global user or username identity;
- a canonical Hosted Replica, server head, or global transaction;
- proof that a Replica holds the last copy or that another copy will survive;
- retroactive revocation of learned plaintext or historical keys;
- trusted global time for Vault authority;
- automatic abuse detection or moral judgment in portable Vault semantics;
- automatic identity merging from matching names or URLs;
- arbitrary code execution through Advisory Extensions; or
- compatibility with discarded pre-release experiments.

# References

- `docs/architecture/glossary.md`
- `docs/specifications/`
- `VISION.md`
