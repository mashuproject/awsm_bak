# AWSM Product Requirements

**Document:** `docs/plans/01-mvp-prd.md`

**Status:** Living product contract

**Owner:** Product

**Last Updated:** 2026-08-01

# 1. Product summary

AWSM is a privacy-first, local-first knowledge-preservation platform. It captures faithful web
observations into immutable encrypted Bundles, keeps ordinary use available locally, supports
private search and optional AI assistance, and synchronizes through optional opaque Replicas
without making one service the Vault's owner.

The browser extension is the current public Client. The canonical product architecture also
supports future desktop, mobile, headless, API-driven, peer, and hosted deployments through the
same Vault contracts.

# 2. Evidence and scope

This PRD describes the canonical product direction. `README.md` documents behavior represented by
the current checkout and release artifacts; executable code and tests remain the evidence for what
works now. Architecture and specification documents define the target contract but are not proof
that the current extension, Rails service, staging, or production implements it.

The current pre-release has no compatibility obligation. Implementation convergence replaces
superseded experimental formats, schemas, data, API shapes, fixtures, and terminology with one
canonical design. Historical numbered plans remain evidence of earlier work, not living authority.

# 3. User problem

People need to preserve information even when pages change, URLs fail, providers close, or cloud
accounts become unavailable. Existing tools commonly preserve only links, reduce a page to partial
text, expose private content to centralized services, or make export and offline use secondary.

AWSM must preserve source evidence while making it useful to browse, organize, search, and
interpret without surrendering plaintext or continued access to a provider.

# 4. Product goals

1. **Faithful preservation:** retain an inert browser-independent observation and independent typed
   Artifacts.
2. **Local-first use:** permit Capture, Library, keyword Search, organization, and permitted work
   without a Remote.
3. **Opaque synchronization:** let Replicas converge through authenticated Channels whose Hosts do
   not need semantic Vault metadata or keys.
4. **Member-controlled recovery:** give every member an independent Recovery Phrase and equal
   cryptographic access class.
5. **Honest history:** preserve signed causality and conflicts; make Vacuum, Closure, Fork, Export,
   and destructive consequences explicit.
6. **Portability:** support Complete Export, Backup, Restore, and provider-independent storage.
7. **Replaceable intelligence:** keep search and generated indexes rebuildable; make remote
   plaintext processing separately explicit.

# 5. Non-goals

- cloud-first document editing or a plaintext web Vault;
- email identity, email recovery, marketing mail, or contact collection;
- server-side content indexing, search, rendering, or AI by default;
- a central peer inventory, last-copy detector, or durability guarantee;
- hidden last-writer-wins conflict resolution;
- real-time collaborative text editing in the base Note format; and
- backward compatibility for discarded pre-release experiments.

# 6. Current public-preview scope

Repository documentation and tests currently represent a browser extension that provides local
Vault creation, web Capture, Library views, multiple local Vaults, Collection grouping, delete and
restore, Vacuum, encrypted local keyword Search, optional semantic Search, Complete Export and
Import, and optional Account-based encrypted synchronization through the experimental Rails
coordination service. Chrome and a Mozilla-signed Firefox desktop-Linux beta are packaged.

The existing server and synchronization implementation still use earlier Device, Recovery Kit,
one-Account/one-Vault, Generation-aware Host, and semantic protocol concepts. Those are current
implementation details to be removed during convergence, not target requirements retained here.

# 7. Canonical actors and boundaries

- A **Vault** is a location-independent logical identity and authenticated state.
- A **Replica** is one stored materialization of a Vault.
- A **Client Installation** is trusted software that operates plaintext and keys.
- A **Client Credential** signs Vault Events for one Vault Member.
- A **Vault Administrator** governs portable shared state without receiving a different decryption
  class.
- A **Replica Host** exposes one or more Replicas under Host-local policy.
- An **Account** is an optional username-based Host Channel Principal. It has no email and no
  intrinsic Vault relationship.
- A **Complete Export** or **Backup** is static and does not synchronize.

# 8. Functional requirements

## 8.1 Capture and preservation

The trusted Client shall:

- capture supported HTTP and HTTPS pages through a bounded adapter;
- require one canonical inert AWSM page snapshot;
- preserve optional full screenshot, thumbnail, structured content, and extracted text when each
  succeeds;
- exclude credentials, file-input bodies, executable replay, and inaccessible protected content;
- stream large acquisition and encryption with bounded memory;
- construct one immutable Bundle Descriptor and independently encrypted Artifact Objects;
- admit a Bundle only after complete mandatory graph verification; and
- record intrinsic source URL, final URL, Capture timestamp, profile, adapter, warnings, and typed
  provenance.

Ordinary network partition or organization conflict shall not block Capture. If a security fence
prevents valid Event authoring, the result may remain explicit Prepared Data for later recovery,
Fork, Export, or valid commit.

## 8.2 Library and organization

The Library shall derive:

- Collections grouping Captures of one subject;
- automatic Collection routing by exact normalized fragmentless URL with query significance;
- automatic title and representative state from the causally selected Collection Tail;
- optional explicit Collection titles;
- a Folder tree containing Collections and a derived Unfiled view;
- Tags assigned many-to-many to Collections or Captures; and
- Notes targeting exactly one Collection or Capture.

Names and titles are non-unique. Identity comes from stable IDs. Merges are explicit and
reversible. Concurrent incompatible Collection, Folder, Tag, or Note work creates a scoped Conflict
without blocking unrelated Capture or silently losing a version.

## 8.3 Search and processing

Keyword Search shall remain private, local, deterministic, and useful offline. Optional semantic
Search may use an explicitly downloaded integrity-pinned local model. A remote provider requires
separate disclosure and exact origin permission for bounded passages and queries.

Every Search index binds exact Vault Generation, corpus revision, tokenizer, model, vector,
quantization, and ranking identity. A better implementation rebuilds a new Materialization and
discards the old. Search indexes never synchronize, enter Baselines, or survive Vacuum merely as
legacy data.

OCR, summaries, embeddings, and other processor results remain local Materializations unless the
user explicitly preserves them through a Required Vault Feature.

## 8.4 Vault history

Authoritative history shall use one canonical signed hash-linked Vault Record DAG with Content,
Authority, and Lifecycle Event families. Parent ancestry determines causality. Timestamps remain
signed audit and provenance values but never determine authority, invitation expiry, or conflict
winners.

Clients shall accept compatible multi-head work deterministically and surface semantic conflicts.
A new Event names the author's complete accepted causal Frontier and Authority Parent Frontier.
The latter is a signed subgraph of the same Record set, not a second log. Unknown Required Features
stop semantic processing at the last understood Frontier while preserving exact bytes safely.

## 8.5 Membership, credentials, and recovery

A Vault shall be multi-member-capable from creation. Its creator is the first member and first
Administrator. Every active member may read, Capture, organize, enroll or retire own Client
Credentials, replace own Recovery Phrase, Export, and Fork.

Any one current Administrator may authorize Invitation creation, remove members, change
Administrator roles, end another member's Client Credential, authorize Future Protection Key
Epochs, resolve defined governance operations, Vacuum, and close the Vault. Cancelling an
Invitation requires its separately retained or delegated Cancellation Capability. The interface
discloses each authority before the user relies on it.

Each member receives a 12-word Recovery Phrase. Recovery with a sufficiently complete Replica can
discover that member's authority privately, verify the Continuity Proof after Vacuum, and enroll a
fresh Client Credential without another online Client. Invitation redemption is one-use,
cancellable rather than time-expiring, and requires a live transfer path between two Replicas.

Revocation prevents valid future participation but cannot erase already held plaintext, keys,
exports, Replicas, or Forks. A resigned or removed member retains readable historical state they
possess and may Fork it, but cannot author later Vault state without a new Invitation and identity.
After self-resignation, continued receipt and decryption of obtainable old-Epoch updates is
best-effort only until an Administrator changes the Key Epoch or Host access ends; it never restores
Active Membership or creates a delivery promise.

## 8.6 Replicas and synchronization

A Vault may have zero or more local, peer, headless, or Hosted Replicas and zero or more locally
configured Remotes. No Remote is an origin or privileged truth.

Synchronization shall be receiver-initiated pull. Clients retrieve opaque inventory into
Quarantine, authenticate and decrypt locally, validate complete current causal and dependency
closure plus the Continuity Proof, and then promote. Wake Hints may trigger a pull but carry no
truth. Valid concurrent Events converge by DAG reduction rather than Host receipt order.

An On-demand Replica may omit heavy wrappers and retrieve them from any authorized Remote. Storage
Relief is always available after an unconditional non-blocking warning that no other usable copy
may exist. The Client tracks only its own availability and cannot claim global redundancy.

## 8.7 Account and dashboard

The reference Host Account shall use a private username and password, with no email field or email
workflow. The signed-in dashboard may manage:

- username and password actions supported by that Host;
- active Account sessions and Channel Authenticators;
- Hosted Replica access, quotas, and exact Grants;
- safe storage and synchronization status visible to that Host; and
- Account deletion and Host-local lifecycle consequences.

The dashboard must not duplicate local Vault content, present Account access as Vault membership,
list portable Client Credentials as browser devices, or imply that the Host can recover plaintext.
A client-only installation need not implement Accounts or this dashboard.

## 8.8 Vacuum, Closure, Fork, and historical view

Vacuum shall make complete current state at one exact Frontier the authenticated Baseline of a new
Generation. One Administrator chooses after the Client discloses known conflict, divergence,
unavailable dependencies, omissions, and irreversible consequences. Garbage Collection remains a
separate local operation.

Vacuum may discard predecessor Content history but shall retain the compact Genesis-to-current
Authority and Lifecycle Continuity Proof needed for independent Administrator and Recovery
verification. A decrypted successor Baseline is not self-authenticating.

A Replica may adopt, Fork Before Adoption, Complete Export, recover eligible work, decline, or
postpone. No choice forces deletion on another Replica. Closure accepts no later Events but leaves
retained state readable, exportable, and Forkable.

Historical View derives an old Frontier without moving the writable pointer. Fork from any fully
available authenticated Frontier creates a new Vault with fresh identity, authority, keys, Objects,
Initial Baseline, and Genesis while retaining selected logical state rather than source history.

## 8.9 Portability

Complete Export shall include the selected Generation's complete Record and Object closure, every
required wrapper, and protected Key Epoch access. It is passphrase-protected, static, and fully
verified before success. Import is all-or-nothing and follows explicit Vault-ID collision rules.

Backup shall preserve independently verified Snapshots outside synchronization. Restore never
silently rewinds or overwrites a known Vault. Selective cross-Vault import is deferred.

# 9. Non-functional requirements

## Privacy and security

- Plaintext, private keys, Recovery Phrases, search data, and semantic identifiers do not reach an
  opaque Host.
- Cryptographic construction uses the exact canonical algorithms and transcripts in the specs.
- Public and authenticated web surfaces have separate cache policy.
- Remote AI is an explicit privacy exception.
- Logs and diagnostics exclude secrets and protected content.

## Reliability

- Interrupted multi-store operations expose one complete old or new state.
- Immutable admission and workflow identities make ambiguous retries safe.
- Synchronization failure never corrupts accepted local state.
- Garbage Collection fails closed around unknown reachability or safety state.

## Performance

- Capture, transfer, export, import, and large Artifact handling use bounded streaming.
- Keyword Search targets sub-100-millisecond local queries on the defined 10,000-Capture corpus.
- Background Jobs yield to user interaction and survive declared restart boundaries.

## Accessibility and surfaces

Browser and web interfaces support keyboard use, clear focus, semantic controls, narrow viewports,
honest progress, and non-color-only state. Conflict and destructive workflows explain consequences
before confirmation.

# 10. Acceptance gate for architecture convergence

The canonical implementation is ready only when:

1. superseded Device, Root Key, Recovery Kit, semantic Host, one-Vault Account, and old Generation
   schemas are removed rather than migrated;
2. canonical codec and crypto golden vectors pass across supported Clients;
3. DAG reducers converge under randomized order and N-way conflict tests;
4. per-member Recovery, Invitation, removal, resignation, and Key Epoch ceremonies pass real
   multi-Client fault scenarios;
5. opaque Hosts cannot observe portable semantic metadata and public OpenAPI matches code;
6. local, peer or headless, and hosted Replica pull paths pass convergence and withholding tests;
7. Vacuum, Adoption, Fork, Closure, Export, Restore, and Garbage Collection pass crash and
   divergence tests;
8. the Account dashboard remains Host-local, username-only, private, and non-duplicative; and
9. README and public pages claim only behavior demonstrated by current code and real surface proof.

# 11. Deferred product candidates

The Roadmap owns timing and promotion for direct transport adapters, richer shared generated
content, metadata-obscuring techniques, abuse-review tooling, selective cross-Fork transfer,
automatic storage profiles, alternative Account authentication, billing, production Host
hardening, and additional Clients. Foundations above must support them without speculative base
fields.

# References

- `VISION.md`
- `ROADMAP.md`
- `docs/architecture/00-design-principles.md`
- `docs/architecture/glossary.md`
- `docs/architecture/consistency-review.md`
