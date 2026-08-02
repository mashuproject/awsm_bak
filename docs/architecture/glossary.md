# Architecture Glossary

**Document:** `docs/architecture/glossary.md`

**Version:** 1.0

**Status:** Normative

---

# 1. Purpose

This document defines AWSM's canonical architectural vocabulary. Every living product,
architecture, and specification document SHALL use these meanings and spellings. When another
living document uses a foundational term differently, this glossary controls the terminology and
the formal specification that owns the affected behavior controls its exact contract.

Historical plans may contain superseded vocabulary. They are evidence of prior work, not aliases
for the terms below.

# 2. Terminology rules

- Capitalized terms name the architectural concepts defined here.
- Ordinary lower-case words keep their normal language meanings. For example, a physical device
  is not a portable AWSM authority identity.
- A Vault is logical and location-independent. A Replica is its concrete stored representation.
- Portable Vault authority, Host-local channel access, and local API access are separate domains.
- Authoritative data is never called a Projection or Materialization.
- Commands request work. Vault Events record accepted portable facts. Runtime Events coordinate
  local Services.
- Product workflows may combine several causally ordered facts without inventing another Event
  type or storing a consequence that can be derived.
- A failure or Conflict fences the narrowest unsafe capability. Unaffected valid work continues.

# 3. Vault identity and access

## Vault

The complete authoritative encrypted archive and its cryptographic boundary.

A Vault has a stable Vault ID and a unified authenticated history independent of any Account,
Client Installation, Client Credential, Replica, Replica Host, or Coordination Server. Zero or more
Replicas may represent the same Vault. No Replica is intrinsically canonical.

A Vault is logically complete: its active Vault Generation and accepted history identify the exact
authoritative data required to reconstruct it. A particular Replica may intentionally omit eligible
heavy wrappers, but loss of every copy makes that content unavailable rather than creating a valid
incomplete Vault.

Every Vault is multi-member-capable from creation.

## Vault ID

The stable 32-byte portable identity generated from cryptographically secure random bytes before
Genesis construction. Genesis authenticates the pre-generated ID. Vacuum retains it; Fork creates
a new one. An opaque Replica Host routes by a Host-local Hosted Replica handle and does not receive
the Vault ID.

## Vault Member

A durable cryptographic access identity within exactly one Vault.

Every Vault Member has the same class of content access and may have one independent Recovery
Credential plus one or more Client Credentials. Membership does not imply an Account or Vault
Administrator role.

## Active Membership

The current portable authority for a Vault Member to participate in the continuing Vault lineage.
It authorizes eligible Client Credentials to create ordinary member Events, receive future key
delivery, enroll replacement Client Credentials, use member recovery, and exercise separately
granted Vault Administrator authority.

## Historical Access

The practical ability to use plaintext, keys, Replicas, Complete Exports, or other copies already
obtained while authorized. Ending Active Membership cannot erase Historical Access. A later Key
Epoch can exclude a former member only from future encrypted content.

## Vault Identity Collision

The local reconciliation condition when a Client Installation is asked to join, Import, or install
a Vault whose Vault ID matches historical state it already retains. It is one logical Vault
identity, not permission to keep two active Workspace entries with the same ID.

The Runtime fast-forwards an ancestor in the same Generation, follows ordinary verified Vacuum
Adoption for a successor Generation, or preserves divergent and unpublished work through eligible
Capture recovery, Fork, Complete Export, or postponement. Historical local state is retired only
after every retained-access and unpublished-work consequence is accounted for. Incompatible
Genesis proofs are instead an integrity failure. There is no separate rejoining or reinstatement
authority primitive.

## Vault Administrator

A portable Vault governance authority held by a Vault Member and recognized through every Replica.

The first member is the first Vault Administrator. A Vault may have several equal Administrators.
Any one current Administrator may independently authorize membership invitations, member or
Client Credential removal, Administrator grants and ends, Key Epoch transitions, Tag merge,
Vacuum, and Closure. No quorum is required.

Administrator authority changes governance, not the member's class of cryptographic access. It
cannot recover as another member, replace another member's Recovery Credential, impersonate a
Client Credential, erase independently held data, or bypass Host-local policy.

## Membership End Event

The Authority Event that permanently ends one target member's Active Membership. When the active
target signs, the user-facing action is resignation. When another member's active Administrator
Client Credential signs, the action is removal. The semantic body stores only the target member
ID; signer, parents, and signature establish the distinction.

A self-signed resignation does not fence remaining members' writes. An Administrator removal does
fence protected writes until a descendant excluding Key Epoch Transition arrives. Ending the final
Administrator closes the Vault.

## Membership Resignation

The user-facing meaning of a Membership End Event signed by its active target member. It ends
Active Membership and every contributing Command immediately but does not claim immediate
cryptographic exclusion. The former member may continue pulling and displaying obtainable
old-Epoch Records on a best-effort basis until an Administrator changes the Key Epoch or a Host
ends channel access. The Runtime presents this as Historical Access, never an actively synchronized
membership, and offers Fork or Complete Export for deliberate continuation or preservation.

## Member Removal

The user-facing meaning of a Membership End Event signed by a different active Vault Administrator.
It ends the same portable membership and credential authority as resignation and additionally
fences protected writes until an excluding Key Epoch Transition establishes Future Protection.
Removal cannot erase Historical Access or independently held copies.

## Administrator Grant Event

The Authority Event by which any one current Administrator grants the same authority to an active
non-Administrator member. The target need not accept. Granting an existing Administrator is
invalid. The same Event resolves a concurrent role conflict by naming every current candidate
Record ID and selecting Administrator state.

## Administrator End Event

The Authority Event that ends one target's Administrator authority without ending membership. A
target signer steps down; another Administrator revokes the role. Ending a non-Administrator is
invalid. The same Event resolves a concurrent role conflict by naming every current candidate
Record ID and selecting non-Administrator state. If no Administrator remains, the Vault closes.

## Account

An optional authenticated Channel Principal defined by one Account-supporting Client or Replica
Host. It may use a private username and password, but it is not an email address, global identity,
Vault Member, Client Credential, Recovery Phrase, or source of Vault authority.

Account identity and usernames are local to their issuer. A Replica Access Grant may authorize an
Account to use one Hosted Replica. Deleting an Account ends that issuer's sessions and grants and
applies its Host-local retention policy; it does not delete or close a Vault, end membership,
rotate keys, or affect another Replica.

## Account Session

An authenticated session scoped to one Account at its issuing Client or Host. It can operate only
within the issuer's policy and carries no Vault decryption key or portable Vault authority.

## Client Installation

One isolated trusted local data container operated by an AWSM Host. A browser profile, desktop
application data profile, mobile sandbox, or headless installation may each be a Client
Installation. One installation may hold several Vault Replicas and distinct Client Credentials.

A Client Installation may be client-only, may also implement the Replica Host role, or may be
headless and expose a protected Runtime API. It is a product and storage boundary, not portable
Vault authority.

## Client Credential

A Vault-scoped cryptographic credential held by one Client Installation and authorized to act for
exactly one Vault Member in exactly one Vault.

It has independent Ed25519 signing and X25519 wrapping keys. Every Vault Event is authored and
signed by exactly one Client Credential. The authenticated authority state at the Event's exact
parents determines whether that credential may perform the Event. An Account, API Client,
Recovery Credential, Replica, or Host cannot substitute for its signature.

## Client Credential Certificate

The portable statement binding one Client Credential ID and its public signing and wrapping keys
to one Vault ID and Vault Member ID. Mutable labels and Host-local permissions are excluded.

## Client Credential Enrollment

The ceremony that activates a newly generated Client Credential for an existing member and
delivers every Key Epoch that member may read. Either an existing active same-member Client
Credential or the member's effective Recovery Credential authorizes one exact Enrollment Proposal.
Both paths produce the same Client Credential Enrollment Event and authority state.

## Client Credential End Event

The Authority Event that permanently ends one Client Credential. A same-member signer retires it
without a global write fence. A different-member Administrator signer revokes it and fences
protected writes until an excluding Key Epoch Transition arrives. The Event stores only the target
credential ID.

## Client Credential Equivocation

Cryptographic proof that one Client Credential signed distinct Authority Events from the identical
Authority Parent frontier. Every Event remains evidence; the credential becomes ineligible and
protected writes fence until an excluding Key Epoch Transition. Type-specific reducers still
determine the effects of the signed Events.

## Client Credential Label Event

An encrypted Content Event that sets or clears the presentation label of one Client Credential.
It changes no cryptographic identity or authority and is visible only inside trusted clients.

## Historical Attribution

Non-authoritative presentation provenance recording the origin Vault ID, Vault Member ID, Client
Credential ID, and signed asserted timestamp for a retained Capture registration or Note version.
It never grants membership, Credential authority, ownership, or causal ancestry.

Vacuum retains same-Vault attribution even when the member or Credential is inactive. A state-only
Fork may retain the source tuple without copying source authority; a later Fork preserves the
original origin rather than claiming the intermediate forker authored the content.

## Recovery Phrase

The 12-word English BIP39 representation of 128 bits of client-generated entropy and its checksum
for one Vault Member. It is a sensitive root credential: possession is possession of that member's
recoverable Vault access.

A phrase is member- and Vault-specific after its derived public keys are authenticated against the
Vault history, but its key derivation does not require a Vault ID, member ID, Account, Host, or
post-decryption value. A Client generates a fresh phrase for every member and Vault and warns
against deliberate reuse. It never crosses the trusted-client boundary and is not an everyday
unlock credential or Account password.

## Recovery Credential

The member-scoped authority derived from a Recovery Phrase. Independent purpose-separated
derivations produce an Ed25519 recovery signing key and an RFC 9180 X25519 HPKE wrapping key.
Authenticated Authority Events bind their public keys to the member and revision.

## Recovery Credential Revision

An ancestry-derived member-local ordinal. The initial Recovery Credential is revision zero. A
Replacement Event joins all effective parent recovery heads and creates a revision one greater
than their maximum. Numbers describe ancestry and never choose between concurrent candidates.

## Recovery Credential Replacement Event

The Authority Event used for ordinary Recovery Phrase rotation and recovery-conflict resolution.
An active same-member Client Credential creates fresh Recovery public material and the complete
Recovery Envelope set. It closes every effective recovery head at its Authority Parents and
derives a Recovery Fence without changing membership, other credentials, or the content Key Epoch.

## Recovery Fence

The member-scoped cutoff derived from a Recovery Credential Replacement Event. Recovery actions
that do not descend from the applicable Fence are stale. Concurrent replacements create a
recovery-only Authority Conflict and are resolved by another all-head Replacement Event.

## Invitation

A non-expiring, single-use, cancellable-before-acceptance authorization containing an immutable set
of typed capabilities. Portable `awsm.vault.join` and optional `awsm.vault.administrator`
capabilities are authorized by a Vault Administrator. Host-local capabilities are authorized
independently.

An Invitation contains distinct Redemption and Cancellation Capabilities. It requires a named
Invitation Redemption Authority to serialize its one use; it does not use email, public username
search, or a trusted global clock.

## Invitation Redemption Capability

The high-entropy bearer secret delivered to the invitee. Its bound non-bearer-equivalent public
verifier permits one exact redemption proof but reveals no Vault key and creates no membership by
itself.

## Invitation Cancellation Capability

The independent high-entropy bearer secret retained or deliberately delegated for cancelling one
Invitation. The secret is absent from the recipient link and portable Vault history; its
non-bearer public verifier is bound by Invitation Creation. Losing every secret copy and management
delegation makes an unused Invitation non-cancellable.

## Invitation Redemption Authority

The one Host or Client Installation named by an Invitation to atomically serialize `Active`,
`Reserved`, `Consumed`, and `Cancelled` states for that Invitation only. Its signed receipt is
serialization evidence, not portable membership authority. Incompatible receipts are detectable
equivocation and create an Invitation Conflict.

## Invitation Conflict

The invitation-scoped Authority Conflict caused by incompatible terminal receipts from one
Invitation Redemption Authority. Any consumed candidate may already have keys, so protected writes
fence pending resolution. At the merged conflict frontier, disputed membership, Client Credential,
Recovery, and Administrator authority is conditional and cannot authorize a new Event. Events
validly authored on an acceptance-only branch remain valid at their exact Authority Parents.

## Invitation Conflict Resolution Event

The Authority Event by which an unambiguously authorized pre-existing Administrator selects one
consumed candidate or cancels all candidates. Rejected consumed candidates require a descendant
excluding Key Epoch Transition before protected writes resume.

# 4. Vault history and lifecycle

## Vault Record

One immutable content-addressed node in the Vault Record DAG. Vault Event and Vault Baseline are
the only Vault Record kinds. Objects and other typed immutable dependencies use the same general
content-addressed storage but are not causal history nodes.

## Vault Record DAG

The authenticated hash-linked directed acyclic graph of a Vault's Events and Baselines. Event
causal parents record the exact accepted Frontier observed by the author. A separately signed
Authority Parent Frontier projects Genesis, Authority, and Lifecycle ancestry from those same
Records and crosses Vacuum boundaries. Typed dependencies identify other immutable data required
to authenticate, interpret, or reconstruct a Record.

The DAG proves ancestry and exposes concurrency without a trusted clock or server sequencer.

## Vault Record Frontier

The sorted set of causally maximal Vault Record IDs representing one Replica's exact authenticated,
semantically validated, and accepted state in its active Generation. It is complete local
knowledge, not a claim of global latest state.

## Authority Frontier

The sorted set of causally maximal Genesis, Authority, and Lifecycle Event Record IDs in one
author's accepted authority ancestry. Every Event signs this Frontier separately from its complete
causal Vault Record Frontier. Content Events do not advance it.

Authority State, authorization, Required Features, and Open or Closed lifecycle reduce over this
authenticated subgraph of the one Vault Record DAG. It is not a second Event log. A predecessor
Vacuum Event is the exact cross-Generation Authority anchor for its successor Baseline.

## Continuity Proof

The compact portable proof graph containing Genesis and every Authority or Lifecycle Event and
required compact dependency needed to authenticate the current Baseline and Authority State. It
follows signed Authority Parent Frontiers and may leave unrelated Content parents unresolved even
though their IDs remain signed into exact Event bytes.

Vacuum must retain this proof so a fresh Client with only a Recovery Phrase and authorized Replica
access can verify current authority without trusting a Host. This deliberately reopens the earlier
assumption that Vacuum could discard all authority history: content history is flattened, but the
minimum cryptographic authority chain is not.

## Baseline Cause ID

A fresh random 32-byte identity assigned by one Baseline to a retained Content fact after its source
Content Event history is no longer reachable. The same retained source cause maps consistently
wherever it controls several facts. A later Content Event's Record ID is its fact's Cause ID.
Remove, revert, supersession, and resolution bodies name Cause IDs, while causal and Authority
Parent fields always name Vault Record IDs. Authority and Lifecycle Record IDs remain exact in the
Continuity Proof and are not remapped.

## Vault Event

An immutable signed accepted fact in the Vault Record DAG. Every Event has exactly one Authority,
Content, or Lifecycle family and one semantic type. Every non-Genesis Event names the complete
causal Frontier and Authority Parent Frontier observed by its author and is authorized against
state derived from the latter.

An Event's signed asserted timestamp supports audit and approximate presentation only. It does not
prove causality, authority, or the winner of concurrent work.

## Authority Event

A Vault Event whose fact changes or resolves portable Vault Authority State. Authority is derived
from the complete authenticated Authority Parent subgraph and type-specific reducers, never Host
arrival order or a server-local head.

## Content Event

A Vault Event whose fact changes Capture, organization, label, or other non-governance Vault state.
Compatible Content Events converge through their type-specific reducers.

## Lifecycle Event

A Vault Event that closes a lineage or authorizes a successor Vault Generation. Closure Event and
Vacuum Event are the base Lifecycle Event types.

## Genesis Event

The sole parentless and self-authorizing Authority Event. The trusted Runtime creates the Vault ID,
first member, first Administrator, first Client Credential, first Recovery Credential, first Key
Epoch, required envelopes, and Initial Vault Baseline before Genesis. The first Client Credential
signs one self-contained creation proof binding that state.

Genesis is the first frontier of the initial Generation. A Vacuum successor begins from its
authenticated Baseline and does not create another Genesis Event.

## Vault Authority State

The deterministic portable governance and cryptographic state derived from Authority Events or a
Baseline checkpoint at one exact frontier. It contains members, Administrators, Client and Recovery
Credentials, Invitations, Key Epoch state, feature requirements, and lifecycle state, but no
Accounts or Replica Access Grants.

## Authority Conflict

A state in which accepted concurrent Authority Events cannot reduce to one unambiguous writable
authority result. Every source Event remains evidence. Only the affected authority or protected
write capability is fenced until the type-specific resolution transition, Fork, or Closure.

## Sibling Reduction

Deterministic combination of Events that were independently valid at their declared parents. The
base reduction classes are additive union, causal scalar, observed remove, graph validation, N-way
authored-content conflict, authority-specific reduction, and Generation/lifecycle choice.

## Content Convergence

Derivation of one current state from compatible Content Events. Causal descendants supersede
ancestors. For a scalar with several causally maximal concurrent candidates, the canonical rule
selects the lexicographically smallest `recordId`. This is deterministic, not chronological,
authoritative, fair, or abuse-resistant.

## Conflict

A type-scoped state for accepted concurrent facts whose combined meaning cannot safely derive one
continuing result. A multi-head frontier, timestamp anomaly, different display value, or temporary
Replica divergence is not automatically a Conflict.

## Vault Generation

One authoritative epoch of a stable Vault: one Vault Baseline, the compatible Vault Events accepted
above it, and their reachable authoritative dependencies. A successor Generation retains the Vault
ID but does not accept predecessor Events as append targets.

## Vault Baseline

An immutable authoritative Vault Record encoding the complete current content, authority,
lifecycle, cryptographic, Required Feature, and dependency state at one exact frontier. It is the
root of one Generation and is not a Projection, Materialization, Snapshot, Backup, or Export.

## Initial Vault Baseline

The Baseline constructed before Genesis. An ordinary new Vault starts with empty content; a Fork
starts with the selected complete logical source state under fresh identities and keys. Genesis
authenticates the Baseline without a circular reference.

## Vault History Rewrite

The verified construction and authorization of a successor Generation whose Baseline represents
the chosen complete predecessor state without requiring predecessor Content history. The compact
Continuity Proof remains required. Every Replica adopts the successor independently.

## Vault Vacuum

The irreversible Vault History Rewrite that authenticates one exact predecessor frontier, omits
Deleted Captures and state existing only for omitted content, checkpoints the complete retained
state in a successor Baseline, and starts fresh history for the same Vault ID.

Vacuum remaps continuing Content causes and retains the exact Authority/Lifecycle Continuity Proof;
it does not claim that a successor Baseline can authenticate its own Administrator.

Any one unambiguously authorized Administrator may approve Vacuum after informed disclosure.
Vacuum cannot erase independently retained copies, silently absorb an unnamed sibling, or discard
unpublished local work.

## Vacuum Event

The terminal Lifecycle Event in the predecessor Generation that binds its exact frontier to one
content-addressed successor Baseline and Generation. The Baseline is constructed first and does not
refer back to the Event.

## Vacuum Adoption

One Replica's verified local switch to the successor Generation. Receipt or opaque storage of a
Vacuum Event is not Adoption. Adoption invalidates predecessor-scoped Materializations, including
Search indexes.

## Fork Before Adoption

The user choice to preserve a divergent predecessor state as a separate Fork before adopting a
Vacuum successor for the original Vault.

## Closed Vault

An irreversibly non-writable Vault lineage. It accepts no new Event, Vacuum, or governance
transition and cannot reopen. Historical Access, reading available content, Complete Export, and
Fork remain possible.

## Vault Closure

The terminal portable state caused either by an explicit Closure Event or by deterministic
authority reduction leaving no Administrator. Closure creates no new Generation, key destruction,
Vacuum, or global deletion promise.

Valid Events authored concurrently from an earlier open frontier may later join the known Closed
history, but no descendant may extend that combined Closed frontier.

## Closure Event

The empty-body Lifecycle Event by which any one current Administrator explicitly closes a Vault.
The ordinary Event envelope supplies all authorization and ancestry. Derived no-Administrator
Closure creates no synthetic Event.

## Historical View

A rebuildable read-only Projection of one authenticated historical frontier. It changes no active
Replica pointer or authoring context. Current-lineage Captures may continue while the view remains
pinned.

## Fork

A new independent Vault whose Initial Vault Baseline represents the complete logical state at one
authenticated source frontier. It creates fresh Vault, Generation, Event, Object, key, member,
Administrator, and Client Credential identities and copies no source Event or authority history.

Every retained Content fact cause receives a fresh Baseline Cause ID. Source author identifiers may
remain only as Historical Attribution, where they are opaque non-authoritative provenance.

The source remains unchanged. Any person with sufficient Historical Access may Fork because Vault
governance cannot prevent independent copying.

## Event Re-authoring

Creation of a new eligible Event on the continuing lineage from verified content on a stale or
non-continuing branch. The source Event remains immutable. The base eligibility set contains only
Bundle Registered Event, exposed to users as `Recover captures`.

The recovered Bundle ID is deterministically derived from the target Vault ID and source
`recordId`, making retries idempotent.

## Replica Garbage Collection

A trusted-client-local operation that reclaims bytes proven unreachable from every active or
retained Generation, Continuity Proof, Recovery Snapshot, pending operation, predecessor state, or
other local preservation root. It is not a Vault Event. An opaque Host cannot infer semantic
reachability. Cross-backend Artifact cleanup persists one local Job and exact logical Artifact plus
Opaque Storage Item fence pairs before physical deletion; interruption retains the Job, protected
resolution, and required Key Epoch until idempotent cleanup resumes and one final safety-state
transaction retires the obsolete safety state and records a stable terminal Job outcome. The latest
terminal Job remains local until a later heavy cleanup replaces it.

# 5. Cryptography and feature evolution

## Domain Separation

Use of fixed public purpose labels and unambiguous length framing so bytes, identifiers,
signatures, derived keys, and authenticated data from one role cannot be substituted into another.
It is not a secret salt, nonce, timestamp, or equality-hiding mechanism.

## Key Epoch

A forward-only content-encryption authority inside one Vault. Each Epoch has one independent random
32-byte Key Epoch Key and a Vault-scoped SHA-256 commitment as its ID. It names its causal parent
Epoch or Epochs through the signed transition that activates it.

Concurrent sibling Epochs create a write fence. A combined Key Epoch Transition names every
effective head and creates a fresh independent key. Old Epochs remain readable where retained
content requires them but never become active again.

Key Epoch IDs are random-key commitments, not monotonic identifiers. A display number is one more
than the maximum parent display number and may be equal across concurrent siblings; it describes
ancestry for people and never selects an Epoch.

## Key Epoch Key

The independent random secret belonging to one Key Epoch. Clients derive per-item keys with
HKDF-SHA256 and never use the Epoch key directly as an XChaCha20-Poly1305 key.

## Key Epoch Transition Event

The Administrator-authorized Authority Event that creates and activates one new Key Epoch for
ordinary rotation or all-head conflict reconciliation. It binds the parent Epochs and exact
required Key Envelope dependencies, but does not change membership or store a reason.

## Key Envelope

One RFC 9180 HPKE Base-mode delivery of one exact Key Epoch Key to one exact Recovery Credential or
Client Credential wrapping key. Recovery Envelope and Client Credential Key Envelope are
target-specific uses of the same construction. A signed Authority Event authorizes the typed
dependency; the Envelope needs no second authority signature.

## Recovery Envelope

A Key Envelope targeted to one exact Recovery Credential revision. A fresh client privately scans
authorized compact opaque inventory, opens candidates locally, and trusts a candidate only after
verifying the Continuity Proof, complete authenticated authority, and current dependency closure.

## Client Credential Key Envelope

A Key Envelope targeted to one exact Client Credential wrapping key.

## Key Delivery Event

An additive Authority Event that supplies a missing Key Envelope for an already-authorized target
and existing Key Epoch. It grants no authority, changes no Epoch, and cannot resolve an Epoch
conflict. A missing delivery fences only the affected target's operations.

## Future Protection

The user-facing ceremony and outcome in which member or Client Credential exclusion is followed by
an excluding Key Epoch Transition. It is not a Vault Event, stored flag, or claim that historical
plaintext was revoked.

## Installation Wrapping Key

A Client-Installation-local key that protects cached Client Credential private keys, Key Epoch
Keys, or secure-store references. It is not synchronized, recovered by a Recovery Phrase, or
portable Vault authority.

## Vault Event Signature

The Ed25519 signature by one Client Credential over the domain-separated canonical unsigned Event
transcript. The signature is included in the authenticated Event bytes from which `recordId` is
derived.

## Vault Data Encryption

Client-side XChaCha20-Poly1305 encryption of compact Vault items and framed large Artifact wrappers
under HKDF-SHA256 keys derived from the applicable Key Epoch Key and fresh nonce context. Key
delivery uses HPKE because an Epoch key cannot encrypt its own delivery.

## Protocol Format Identifier

A small integer identifying one incompatible stable envelope grammar. The initial canonical values
are `storageEnvelopeFormat = 1`, `vaultRecordFormat = 1`, and `vaultObjectFormat = 1`. New semantic
features do not increment these identifiers.

## Required Vault Feature

An exact semantic or cryptographic feature a trusted client must understand to validate, derive,
extend, Vacuum, or safely reclaim affected authoritative Vault state. Unsupported requirements are
preserved opaquely when safe but stop semantic acceptance and authoring at the last understood
frontier.

## Feature Manifest

The immutable core-readable descriptor of one exact Required Vault Feature: one globally scoped
feature key, exact revision, canonical parameters, required Manifest IDs, and incompatible feature
keys. Its ID is the domain-separated SHA-256 digest of its canonical bytes.

## Required Vault Feature Set

The complete set of Feature Manifests active at one frontier. Genesis establishes it and Feature
Activation Events add to it. Every Event signature binds the Set ID derived at its Authority
Parents.

## Supported Vault Feature Set

The operational set one trusted Client Installation currently implements. A software upgrade may
change it without changing a Vault.

## Feature Activation Event

The Administrator-authorized Authority Event that adds exact Feature Manifests to a Vault's
Required Feature Set. The first feature-dependent Event is separate and descends from the
activation. Installing software never activates a feature automatically.

## Advisory Extension

Opaque authenticated inline data that cannot affect authority, logical state, validation,
dependencies, Baselines, Export, reachability, rendering, or security. Unknown entries may be
preserved and ignored. Any data requiring a correctness effect is a Required Vault Feature.

# 6. Replicas, Hosts, and synchronization

## Replica

One independently stored synchronization participant representing a Vault. Replicas share Vault
identity and verify compatible history but may hold different accepted frontiers or wrapper
availability. A Replica is authoritative storage, not a Materialization.

## Full Replica

A client Replica with every encrypted Object wrapper reachable from its active Generation present
and verified locally.

## On-demand Replica

A logically complete client Replica that retains authoritative inventory, compact operational
records, history, keys, and Replica Safety State while intentionally leaving eligible heavy
Artifact wrappers Evicted for retrieval when needed.

## Hosted Replica

A Replica made available through authenticated Synchronization Channels by a Replica Host. Hosting
does not make it canonical or grant its Host Vault keys or portable authority.

## Replica Host

A database-like role that stores or exposes Hosted Replicas through Replica Endpoints. It chooses
Channel Authenticators and enforces its own Grants, quotas, rate limits, conditional writes, and
lifecycle policy.

A standalone opaque Replica Host has no trusted Runtime, Vault keys, or Client Credentials. A
Client Installation may also implement the role; co-location does not merge Host-local and portable
authority.

## Coordination Server

An untrusted Replica Host that may additionally provide Accounts, relay, discovery, Wake Hints, and
other coordination conveniences. It is authoritative only for its own policy and admitted opaque
bytes, never for Vault semantics.

## Replica Endpoint

A local or network interface exposed by a Replica Host for establishing Synchronization Channels.

## Replica Remote

One Replica's local configuration for reaching another Replica. Its name, endpoint, credentials,
retry state, and policies are Installation State. Names such as `origin` and `upstream` have no
Vault-wide meaning.

## Channel Principal

The Host-local subject authenticated by a Channel Authenticator. It may be an Account, bearer-token
holder, Client Credential proof, or another identity recognized by that Host.

## Channel Authenticator

A mechanism accepted by one Replica Endpoint to authenticate a Channel Principal. It protects Host
access and does not replace Vault cryptographic verification.

## Replica Access Grant

An immutable Host-local authorization binding one Channel Principal and Hosted Replica to an exact
Replica Access Capability set and optional delegation ceiling. Replacing authority revokes the old
Grant and issues a new one. A Grant is not membership or portable Vault authority.

## Replica Access Capability

A typed Host-local action. The initial capability keys are
`awsm.replica.inventory.read`, `awsm.replica.item.read`, `awsm.replica.item.write`,
`awsm.replica.hint.read`, `awsm.replica.hint.write`, and `awsm.replica.manage`. Capabilities are
independent, exact, scoped to one Host and Hosted Replica, and fail closed when unknown.

## Host Storage Admission

One Replica Host's acceptance of an opaque item after channel, Grant, quota, outer-format,
identifier, length, digest, immutability, conditional-write, and idempotency checks. It is not
decryption, semantic validation, or acceptance into a trusted Vault frontier.

## Opaque Host Metadata Boundary

The maximum semantic visibility of a standalone opaque Replica Host. It may observe only its local
Hosted Replica handle, randomized Opaque Storage Item ID, compact-or-streamable storage class,
ciphertext length and digest, outer format and fixed randomized protection parameters, Host-local
cursors and conditional state, and unavoidable traffic or operational metadata.

Portable Vault, Generation, Record, Object, parent, dependency, Event, member, credential, Key
Epoch, feature, content-type, URL, title, and Capture semantics remain protected.

## Opaque Recovery Discovery

Recovery through ordinary `awsm.replica.inventory.read` and `awsm.replica.item.read` access without
a Host-visible recovery index,
fingerprint, member selector, Epoch hint, or phrase-verification oracle. Candidate opening and all
authority verification occur inside the trusted client.

## Synchronization Channel

An authenticated communication path through which Replicas exchange opaque storage items. Channel
authentication and transport security are separate from portable Vault authorization and content
encryption.

## Synchronization Session

A communication session containing one or more reconciliation cycles. It transfers existing data
and creates no Vault Event.

## Synchronization Cycle

One requester-initiated pull reconciliation pass between one local Replica and one Replica Remote.

## Direct Replica Synchronization

A Session between authorized client Replicas without a Coordination Server in the data path. The
same identity, validation, authority, and convergence rules apply through every transport.

## Replica Divergence

The valid temporary state in which Replicas of one Vault have different accepted Records or
frontiers. It is not corruption or necessarily a Conflict.

## Convergence

The verified process and result in which Replicas incorporate the same compatible Vault Records
and derive the same logical state. They may retain a multi-head frontier until a later substantive
Event names every compatible head.

## Delivery Cursor

A Replica-Host-local monotonic sequence used to discover newly admitted opaque items. It is not
portable Event order, causality, or a canonical Vault head.

## Wake Hint

An untrusted item of Ephemeral Coordination State prompting a client to pull. It carries no
authoritative state and is never a correctness requirement.

## Synchronization Policy

Replica-local Installation State selecting automatic, manual-only, or paused synchronization and
its Host-specific resource controls.

## Ciphertext-only Synchronization

Transfer while the local Vault context has no usable unwrapped content key. Previously accepted
outgoing ciphertext may publish. Incoming items remain bounded Quarantine and cannot advance the
trusted frontier until opening, decryption, and complete validation.

## Host Storage Reaping

Host-local deletion of one Hosted Replica after that Host's Grants and lifecycle obligations permit
it. Reaping is not Vault deletion, Closure, Vacuum, member removal, or a Vault Event.

## Storage Relief

A Replica-local operation that intentionally evicts eligible heavy Artifact wrappers to reduce
local storage. It requires an unconditional warning that the bytes may become permanently
unavailable, but no peer inventory, redundancy count, retention promise, or last-copy detector.

## Evicted Artifact

An Artifact whose compact authoritative Object remains in one client Replica while its heavy
encrypted wrapper is intentionally absent. Evicted is local availability state and makes no claim
that another copy exists.

## Replica Wrapper Availability

The local state of one wrapper: `Present`, intentionally `Evicted`, or `Unexpectedly Missing`.
Only `Present` asserts verified local bytes. This state is not synchronized as Vault truth.

# 7. Content and organization

## Capture

An immutable observation of information at a specific moment. Every successful Capture has exactly
one stable Bundle ID and Bundle graph. Later observations create new Captures.

## Bundle

The immutable logical Capture package consisting of one Bundle Descriptor Object and its referenced
Artifact Objects and wrappers.

## Bundle Descriptor

The compact authoritative Object binding one Bundle ID, immutable Capture metadata, exact Artifact
references, warnings, and preservation provenance.

## Artifact

An immutable authoritative payload represented by one compact Artifact Object and, when applicable,
one independently streamable encrypted wrapper. Artifact is the canonical term; transport frames
and physical chunks are not separate Artifacts or Objects.

## Object

The smallest authoritative immutable typed storage unit. Its Object Identifier commits to exact
canonical authenticated inner bytes and type namespace.

## Manifest

Structured metadata describing another logical entity, such as a Bundle Descriptor, Export
Manifest, or Snapshot Manifest. A Manifest does not replace the authoritative data it describes.

## Collection

A stable logical identity grouping Captures that the user considers versions of one page or
continuing subject. A Collection is derived from Events rather than stored as a mutable container.
It has no separate creation or deletion lifecycle.

## Collection Tail

The effective active Capture used for automatic Collection presentation and routing. Causal
descendants win; concurrent maximal candidates use the scalar `recordId` rule. Asserted Capture
time is not the Tail selector.

## Collection Merge Conflict

The scoped state in which concurrent Collection redirects cannot form one acyclic graph with at
most one destination per source. Capture continues; ambiguous graph-dependent organization is
fenced until any active member resolves it.

## Folder

A stable navigational identity organizing Collections. A Folder has zero or one parent Folder,
forming an acyclic tree. A Collection has zero or one effective Folder. Duplicate Folder names are
valid and never merge identities automatically.

## Unfiled

A derived Library bucket for Collections with no effective Folder. It has no Folder ID and creates
no authoritative Record.

## Folder Conflict

The scoped state in which individually valid concurrent parent moves collectively form a cycle.
Resolution explicitly reparents affected Folders while unrelated Vault work continues.

## Tag

A stable reusable user-defined label assignable many-to-many to an exact typed Collection or
Capture target. Tag identity is independent of its non-unique display name.

## Tag Assignment

An immutable add fact for one Tag and exact target. Removal names the observed add facts;
concurrent unseen additions survive under observed-remove/add-wins semantics.

## Tag Merge

An explicit reversible Administrator-authorized redirect from exact source Tag IDs to one
destination Tag ID. Name equality never merges Tags automatically. Original assignments remain
immutable so reversing the merge restores source identities honestly.

## Tag Merge Conflict

The scoped state in which concurrent redirects send one Tag source to incompatible destinations or
form an invalid graph. An Administrator resolves it explicitly.

## Note

A stable shared commentary identity targeting exactly one Collection or one Capture. Any active
member may revise, delete, restore, or resolve it. Creator attribution remains historical but gives
no special ownership right. Titles are non-unique and targets are immutable.

## Note Content Object

An immutable encrypted Object containing one complete optional title and canonical UTF-8 Markdown
body under the specified safe CommonMark-compatible dialect. Raw HTML, executable content, and
automatic remote fetches are prohibited.

## Note Revision

One immutable whole-Note version selected by a Note Created or Note Revised Event. Title and body
do not converge independently.

## Note Conflict

An arbitrary N-way set of incompatible causally maximal Note revisions or revision/deletion heads.
No timestamp or scalar rule hides authored content. Any active member may resolve all known heads
by keeping, merging, abandoning, or atomically splitting versions.

## Reversible Lifecycle State

The derived `Active` or `Deleted` state of a Capture, Folder, or Tag before Vacuum. Causal
descendants supersede ancestors; concurrent opposite states use the scalar `recordId` rule. Note
revision versus deletion is the explicit N-way-conflict exception.

## Deleted

The reversible pre-Vacuum state in which an entity is absent from ordinary views but remains
retained and restorable. It never means physical erasure.

## Library

The rebuildable user-facing Projection used to browse and manage Captures and Collections. It is
not an authoritative container.

# 8. Runtime and persistence

## Runtime

The platform-independent application that owns business logic, validates Commands, operates
Services and Jobs, derives Projections, and coordinates Hosts and Drivers.

## Host

A platform integration layer supplying user interface, lifecycle, permission, network, secure
storage, and other platform capabilities without owning portable business rules.

## Service

A bounded Runtime component. Services communicate through defined Commands, Runtime Events, and
interfaces rather than sharing internal mutable state.

## Runtime API

The transport-independent trusted-client interface through which an authorized API Client reads
Runtime state and submits Commands to one Client Installation. It may expose plaintext and is not
the opaque Replica protocol.

## API Client

A user interface, command-line tool, automation process, or integration invoking a Runtime API. It
acts through a Client Installation and its Client Credentials rather than becoming a Replica or
Vault Member by itself.

## API Grant

A revocable local authorization from a Client Installation to one API Client. It limits Runtime
operations and selected Client Credentials but cannot exceed their portable authority. It is not a
Replica Access Grant.

## Projection

A rebuildable logical representation derived from authoritative data. It is never authoritative.

## Materialization

A concrete local implementation of a Projection, such as an inverted index or vector index.
Materializations are disposable, unsynchronized, absent from Baselines and Complete Exports, and
rebuilt when their definition or source scope changes.

## Search Projection Materialization

A local encrypted Search index whose identity binds the exact Vault Generation and corpus scope
plus every tokenizer, passage, model, vector, quantization, ranking, and format parameter affecting
results. Vacuum Adoption invalidates predecessor-Generation Search Materializations.

## Storage Service

The Runtime Service providing logical persistent operations through Storage Drivers.

## Storage Driver

A platform-specific adapter implementing the Storage Service's logical contracts.

## Persistence Backend

The physical database, filesystem, object store, secure store, or other technology used by a
Storage Driver.

## Logical Storage Family

A semantic persistence class sharing authority, trust, scope, durability, lifecycle, validation,
deletion-safety, and transaction requirements. The durable families are Vault Records, Vault
Objects, Replica Safety State, Installation State, Trusted Secrets, Execution State, Prepared Data,
Quarantine, Materializations, Managed Resources, and Host Policy State.

## Typed Storage Namespace

A stable namespaced contract inside one Logical Storage Family. Its registry entry owns scope,
identity, validation, encryption, synchronization, Export and Backup inclusion, retention,
deletion, transaction partners, schema revision, and unknown-namespace behavior. Physical Drivers
may map it differently without changing semantics.

## Replica Safety State

Trusted non-portable state whose integrity prevents a Replica from accepting false authority or
losing required data. It includes the active Generation, causal and Authority Frontiers,
Continuity Proof roots, Vacuum Adoption, wrapper availability, preservation roots, and Garbage
Collection fences. It fails closed and is not a cache.

## Installation State

Non-portable configuration and presentation state for one Client Installation, including Workspace,
Active Vault, Replica Remotes, Synchronization Policies, and preferences.

## Trusted Secrets

Client- or Host-local secret material such as Client Credential private keys, wrapped Key Epoch
Keys, Channel Authenticators, and secure-store handles.

## Execution State

Durable non-authoritative Commands, Jobs, outcomes, checkpoints, leases, retries, and idempotency
records used to execute and resume Runtime work.

## Prepared Data

Trusted locally produced but not-yet-authoritative transactional output. It remains inert until
the owning commit contract promotes it.

## Quarantine

Bounded untrusted input awaiting complete structural, cryptographic, authority, dependency, and
semantic validation. Quarantine never advances a trusted frontier.

## Managed Resource

A non-Vault tool asset, such as a model or OCR pack, managed under independent integrity,
licensing, compatibility, and eviction rules.

## Host Policy State

Durable Accounts, Channel Principals, Replica Access Grants, sessions, quotas, billing references,
and lifecycle rules belonging to one Replica Host. It is neither portable authority nor Vault data.

## Storage Realm

A cross-cutting isolation boundary—such as normal, Incognito, temporary, or testing—applied to the
applicable Logical Storage Families. It is not another family.

## Ephemeral Coordination State

Non-authoritative Wake Hints, presence, subscriptions, tickets, or routing state whose loss affects
efficiency or connectivity but not Vault correctness.

## Transfer Artifact

A user-owned or externally supplied Complete Export, Backup, import package, or download outside
active Runtime persistence. During construction or validation it is Prepared Data or Quarantine.

## Observability State

Logs, metrics, security audit records, and incident evidence governed by explicit privacy,
redaction, access, and lifecycle policy. It never contains prohibited plaintext or becomes Vault
truth.

## Ephemeral Scratch

Bounded disposable non-authoritative temporary data. It is never required after restart,
synchronized, exported, backed up, or used to justify accepting or deleting another record.

## Job

A durable unit of long-running Runtime work with restart, cancellation, retry, checkpoint, and
outcome semantics.

## Scheduler

The Runtime component that schedules Jobs under declared resource and dependency constraints.

## Worker

A Runtime component that executes Job work without owning the Job's durable contract.

# 9. Capture, Search, and AI

## Capture Request

A request to preserve a resource under one exact Capture Profile.

## Capture Job

The Runtime Job that validates capabilities, freezes input, constructs one complete Capture result,
and commits its Bundle and Bundle Registered Event atomically.

## Capture Result

The complete trusted prepared output of a Capture Job before authoritative Bundle commit.

## Capture Profile

A versioned configuration specifying the representations and Artifacts a Capture attempts and the
rules for permitted omissions and warnings.

## Capability

A logical AI function requested independently of a model, such as OCR, summarization, embedding,
or translation. This term is confined to AI; Vault feature requirements and access permissions use
their explicit names.

## AI Provider

A component capable of executing AI Capabilities locally or, under explicit policy, remotely.

## Model

A concrete implementation selected by an AI Provider.

## Derived Artifact

An immutable generated Object deliberately preserved as Vault content through an explicit product
operation and Vault Event. Search-only embeddings, tokens, passages, and indexes are
Materializations, not Derived Artifacts.

# 10. Portability

## Complete Export

A standalone portable artifact containing one authenticated Vault Generation's complete
authoritative inventory and every referenced Artifact wrapper. It excludes local secrets,
operational state, and rebuildable Materializations and does not synchronize or receive later
changes.

A history-preserving Export contains the Generation's exact retained history. A smaller Export may
follow an explicitly authorized Vacuum and exports only the successor Generation; Vacuum is not an
export compression flag.

## Snapshot

An immutable logical view of a Vault at one authenticated state.

## Backup

A durable recovery copy derived from a Snapshot. Backup is recovery-oriented and is not a live
Replica or interchange-oriented Complete Export.

## Recovery Plan

A validated execution plan describing how Restore reconstructs and verifies a Vault Replica from
one or more Backups.

## Recovery Snapshot

An optional exact retained Generation made available to one former member for bounded Historical
Access. It may support hydration, Complete Export, or Fork but never restores Active Membership or
guarantees future availability.

## Snapshot Access Grant

A Host-local authorization for one former member to retrieve one exact Recovery Snapshot during
that Host's stated period. It is separate from Replica Access Grant and portable Vault authority.

## Runtime Event

A local message exchanged among Runtime Services. Runtime Events are not authoritative Vault
history and do not synchronize.
