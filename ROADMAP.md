# AWSM Roadmap

This roadmap records unresolved future implementation and product initiatives. It is not an
architecture specification, implementation history, or authorization to build. The living
glossary, design principles, architecture, formal specifications, and PRD own decision-complete
direction. Historical numbered plans remain context and may be stale.

## Initiative statuses

- **Discovery:** the problem, feasibility, or major product choices remain open.
- **Candidate:** the direction is coherent, but scope, dependencies, or acceptance remain open.
- **Approved:** the user has explicitly approved conversion into a numbered implementation plan.

## Canonical Vault architecture convergence

**Status:** Candidate

Replace the current pre-release Device, Vault Root Key, Recovery Kit, semantic coordination-server,
one-synchronized-Vault Account, feature-specific persistence, retain-and-rewrite Vacuum, and old
organization experiments with the single canonical contract in the living docs.

The implementation scope includes:

- deterministic serialization, protected logical identities, randomized opaque envelopes, exact
  cryptographic vectors, and independent Key Epochs;
- Initial Baseline and Genesis, one signed Record DAG, its retained Authority Parent Continuity
  Proof, exhaustive Event codecs and reducers, Required Features, and scoped conflict handling;
- per-member Recovery Phrases, Client Credentials, Invitations, multi-member authority, Future
  Protection, resignation, removal, Closure, and former-member behavior;
- Vault, Replica, Client, Host, Account, Channel Principal, and Replica Access Grant separation;
- receiver-initiated opaque synchronization, Hosted Replica storage, On-demand availability,
  Storage Relief, hydration, and local Garbage Collection;
- eleven logical persistence families, Storage Realms, Prepared Data, Quarantine, safety state,
  streaming wrappers, and crash-safe physical mappings;
- Collections, causal tails, Folders, Tags, Notes, lifecycle, merge and N-way conflict UX;
- Vacuum successor Baselines with Content-cause remapping and retained authority continuity,
  Adoption, Fork Before Adoption, state-only Fork, Closure, historical view, Event Re-authoring,
  Complete Export, Backup, and Restore; and
- destructive replacement of development and explicitly authorized staging schemas and data,
  regenerated executable API contracts, rebuilt fixtures, real Client/Host fault proof, and updated
  public claims.

There is no compatibility reader, migration of discarded data, dual schema, old-client
negotiation, fallback, alias, or transition UI. Implementation begins with an approved cold plan
derived from the reconciliation impact record and must keep current marketing claims separate
until executable proof passes.

## Direct Replica synchronization

**Status:** Candidate

Add direct pull between authorized Client-managed Replicas without a managed Host in the data path.
Define pairing, endpoint authentication, capability preflight, bounded inventory and transfer,
Wake Hints, locked-context Quarantine, targeted hydration, authorization loss, and multi-Remote
status without peer inventory or global redundancy claims.

Promotion requires real local-socket or LAN and remote-hosted transports, malicious and stale
inventory tests, duplicate and interrupted delivery, offline multi-head convergence, and proof that
`origin` or `upstream` remains local preference rather than Vault authority.

## Optional former-member Recovery Snapshots

**Status:** Discovery

Explore an encrypted Host or user-managed snapshot that preserves a former member's exact readable
state after removal when no retained Replica or Complete Export remains. Define who creates,
authorizes, stores, discovers, pays for, expires, and proves availability of it without weakening
the core rule that removal stops future access and cannot erase prior possession. The base
architecture must continue to work without this service.

## Selective cross-Vault transfer

**Status:** Discovery

Define explicit selective transfer between independent Vaults or Forks beyond Complete Export and
state-only Fork. Resolve new identity, provenance, dependency closure, duplicate detection,
authorization, Key Epoch re-encryption, organization mapping, conflict behavior, streaming, and
whether transfer is one-way copy or a continuing relationship. Never silently merge two Vault
histories or reuse source authority.

## Traffic-metadata protection

**Status:** Discovery

Evaluate padding profiles, batching, delayed pulls, cover traffic, private inventory techniques,
and other measures beyond the mandatory opaque Host boundary. Quantify leakage, bandwidth,
latency, battery, denial-of-service, and self-hosting costs before making a claim. The base system
must continue to state honestly that timing, size, Account association, and access patterns remain
visible.

## Vault activity and member review

**Status:** Candidate

Build trusted-client history views that help members, especially Administrators, inspect signed
Events, attribution, causal parents, conflicts, timestamp assertions, and back-and-forth changes.
Abuse detection and penalties remain user or Client interpretation, not Vault semantics. Define
useful signals, retention after Vacuum, privacy, false-positive handling, and response workflows
only after collaboration experience provides concrete cases.

## Extended organization and Note features

**Status:** Discovery

Consider shared manual ordering, Note attachments, rich text, wiki links, collaborative text CRDTs,
member-private synchronized Notes, installation-local annotations, and dedicated Note merge only as
separate Required Features with proven need. Preserve stable IDs, safe rendering, no display-time
network fetch, N-way conflict recovery, Baseline and Vacuum rules, and compatibility with ordinary
whole-Note revisions.

## Automatic Replica storage profiles and pinning

**Status:** Candidate

Add persistent Full and On-demand profiles beyond manual Storage Relief: age, quota, least-recently-
used, storage-pressure and prefetch policy plus `Keep locally` controls. Policy remains Replica-
local, does not infer another copy, and never blocks manual or automatic relief after the universal
data-loss warning.

Prove On-demand bootstrap without hydrating every heavy wrapper, immediate new Capture, truthful
unavailable state, pinning, cancellation, restart, quota pressure, and interactions with Export,
Vacuum, Fork, Remotes, and Garbage Collection.

## URL-backed opaque Replica storage

**Status:** Discovery

Allow a Client's Storage Driver to place its encrypted Replica bytes behind an authenticated
loopback or HTTPS endpoint while keeping plaintext, Client Credential keys, Replica Safety State,
Materializations, and trusted processing local. Determine whether the ordinary opaque Hosted
Replica protocol is sufficient or whether a narrower single-Client storage contract is justified.

Cover immutable and conditional writes, restart-safe local safety advancement, multi-gigabyte
streaming, uncertain completion, rollback and omission detection, quota, relocation, revocation,
loopback impersonation, TLS, and unavailable-backend Prepared Data. Two independent Runtimes must
not co-own one Replica namespace; that becomes ordinary Replica synchronization.

## API-driven headless Client Installation

**Status:** Discovery

Define a full trusted headless Client with local Replicas, Client Credentials, and Runtime services
exposed through a protected API. API Grants are Client-local capabilities, not Vault membership or
Replica Access Grants. Web UIs, command-line tools, and automation act through the selected Client
Credential.

Resolve local versus network transport, bearer or stronger authentication, Vault selection,
unattended key availability, capability discovery, plaintext operator trust, audit attribution,
rate limits, browser security, and revocation. A third-party headless operator is trusted with any
plaintext it processes and is not zero knowledge relative to that operator.

## Zero-knowledge web Client

**Status:** Discovery

Evaluate whether a trusted browser web Client adds useful Library, Search, organization, Export,
Import, and Vault-management access beyond the browser extension. This is a Client that stores keys
and a local Replica in that browser, not the Account dashboard and not an opaque Host feature.
Capture may remain extension-only.

Before promotion, justify the product need and resolve browser storage clearing, local persistence,
Recovery, supported browsers, selective transfer, lifecycle, accessibility, multi-tab concurrency,
and the threat model. Reuse the canonical Runtime rather than duplicating Vault data in a server
database or inventing another key model.

## Static archived-page viewer

**Status:** Discovery

Define a sandboxed viewer for the canonical page snapshot inside AWSM. Resolve complete network
prohibition, script and service-worker isolation, form behavior, missing resources, frames,
accessibility, safe external navigation, and archive-first links. MHTML remains a derivative and
captured scripts do not execute.

## Recorded web-application Capture and replay

**Status:** Discovery

Evaluate an explicit high-fidelity mode that records permitted response traffic and replays an
interactive application in a controlled environment. Resolve stronger permissions, authenticated
and non-GET traffic, credential exclusion, browser storage, service workers, determinism, bounded
storage, script isolation, and time-relative link resolution without weakening the ordinary static
profile.

## Incognito Capture contract

**Status:** Discovery

Decide whether Incognito Capture persists into a confirmed regular Vault or an isolated temporary
Storage Realm. Evaluate Chrome spanning and split modes, separate workers and storage, key access,
window closure, permanent-persistence consent, normal-window routing, Export or promotion, and
failure cleanup. Until implemented and proven, Incognito remains explicitly unsupported.

## Retrieval-grounded Vault answers with Gemma 4

**Status:** Discovery

Evaluate an optional trusted-client answer experience over bounded locally retrieved passages with
citations to exact Captures. Select an exact permissively licensed Gemma 4 model and inference stack
only after measuring download, memory, latency, battery, supported hardware, quantization,
cancellation, prompt injection, and citation validation. Search remains useful without generation.

Define user initiation, model integrity, prompt and model provenance, context bounds, and whether an
answer may be explicitly preserved under a Required Feature. The model never scans the Vault
independently or communicates with a Replica Host.

## Chrome built-in Prompt API adapter

**Status:** Discovery

Evaluate Chrome's browser-managed prompt model as an adapter for the same retrieval-grounded
capability. Keep retrieval, citations, validation, and failure semantics provider-neutral. Prove
capability absence, model download, language and hardware limits, model updates, cancellation,
memory clearing, accessibility, and no silent remote fallback. Firefox and unsupported Chrome must
retain complete Library and Search behavior.

## Canonical public glossary rendering

**Status:** Discovery

Make `docs/architecture/glossary.md` the single source for the public `/glossary` page. Replace the
independently authored ERB definitions with deterministic safe rendering or generated output while
preserving stable anchors, selected public sections, sanitization, anonymous cache safety,
accessible navigation, and the current design system.

Choose build-time or request-time rendering, package source availability, stale-output detection,
link checks, and primary plus narrow visual proof. Do not create another editable glossary source.

## Executable OpenAPI contract generation

**Status:** Candidate

After the target opaque Host routes are defined, make executable Rails contract specs the source
for exact HTTP paths, authentication scopes, request and response bodies, headers, strict errors,
and Host capabilities. Generate and commit `http-api.openapi.yaml`; prohibit manual edits; validate
real traffic with the artifact; and generate Client wire types where useful without creating a
second domain model.

This is a cold replacement of the old semantic API, not preservation of it. CI must fail for stale
generation, undeclared Rails routes, uncovered declared operations, missing error evidence,
unknown-field acceptance, or implementation divergence.

## Repository implementation and impact map

**Status:** Candidate

Maintain a navigational map from product areas to implementation, tests, formal contracts,
generated artifacts, verification commands, and operational entry points. Include Account and Host
policy, Vault Records and Objects, Capture, Library, Search, authority and Recovery,
synchronization, storage, public surfaces, release automation, and reference deployment.

Add an affected-files plan template, subsystem command table, generated-file ownership, terminology-
to-code map, dependency links, and a lightweight `script/impact-map <area>` command. The map never
overrides owning docs or proves completeness from filenames. Acceptance includes cold-agent
exercises, stale-map CI, link checks, and an explicit update trigger.

## Native download-boundary journey proof

**Status:** Candidate

Add a test-only download adapter for native save-file interactions that packaged headless browsers
cannot automate. Use production package construction and validation to prove successful Complete
Export and fresh Import without granting shipped builds broader permissions or bypassing Runtime
cryptography.

## Coordinated browser-store release

**Status:** Candidate

Prepare compatible public Firefox AMO and Chrome Web Store listings, then announce only after both
are live. Complete macOS and Windows Firefox proof, privacy and permission disclosures, listing
assets, review handling, signed update delivery, monitoring, and rollback. Retain verified GitHub
artifacts until store delivery is proven.

## Hosted Redis coordination rollout

**Status:** Candidate

Reinspect the mutable reference topology, provision private Redis networking and protected
credentials, select exact application and Redis revisions, and define deployment and rollback.
Prove degraded Wake Hint behavior and recovery, monitor capacity and failures, and expose no Redis
port or credential publicly. Redis remains disposable Ephemeral Coordination State.

## Highly available ephemeral coordination

**Status:** Discovery

Choose Sentinel, managed service, or another topology and define failover, split brain, connection
discovery, TLS, acceptable hint/ticket loss, multi-host subscriptions, capacity, fault injection,
alerting, and incident response. No choice may turn ephemeral state into Vault authority.

## S3-backed opaque byte storage

**Status:** Candidate

Replace Rails-local opaque storage with one provider-independent S3 Driver. Bundle permissively
licensed VersityGW for ordinary single-host self-hosting and use managed S3-compatible storage for
hosted production. Rails and tests depend only on the shared immutable Compact/Streamable item
contract.

Preserve bounded resumable writes, exact outer-envelope and Opaque Storage Item ID verification,
immutable promotion, full and ranged reads, scoped Grants, verified deletion, and opaque metadata.
Define private bucket provisioning, least privilege, readiness, incomplete-part cleanup, key
layout, conditional operations, quota, coordinated Host-policy and byte backup, corruption,
omission, and restart evidence.

VersityGW is deliberately single-host and non-HA. Validate the exact AWSM operation subset against
it and a managed S3 service without provider-specific notifications or lifecycle semantics.
SeaweedFS remains an advanced candidate; RustFS needs maturity review. MinIO and Garage remain
excluded from the default stack while their strong-copyleft or licensing terms conflict with
commercial relicensing flexibility absent a new explicit decision.

## Production Replica Host hardening

**Status:** Candidate

Add production quotas, abuse controls, shared opaque storage and Job infrastructure, multi-host
deployment, backup and restore exercises, alerting, incident response, and independent security
review. Define signup and rate controls, Host-local reaping and grace, traffic-analysis disclosure,
recovery objectives, corruption and omission evidence, and safe Account deletion without claiming
knowledge of other Replicas.

Hosted Redis, highly available coordination, S3 storage, billing, and browser-store delivery remain
separate initiatives.

## Alternative Account authentication and reset

**Status:** Discovery

Consider passkeys, WebAuthn, OAuth, SSO, and privacy-preserving password reset without introducing
email identity. Account reset remains Host-local and cannot recover a Vault, obtain a Recovery
Phrase, or silently enroll a Client Credential.

## Hosted plans, billing, and preview waitlist

**Status:** Discovery

Define plans, quota presentation, billing provider boundaries, subscriptions, abuse responsibility,
support, legal copy, self-hosted differentiation, and whether a waitlist justifies collecting any
visitor data. Until implemented, public pages show no pricing teaser or contact collection.

Choose the Host-local resource-responsibility entity for quota, billing, storage defaults, and
reaping. Compare Account, per-Replica, and transferable tenant models without deriving responsibility
from Vault membership or Administrator role. Cover management Grants, transfer, final-manager loss,
Account deletion, suspension, and grace before freezing the Host schema.

## Authentic product-screenshot marketing

**Status:** Candidate

Use reproducible fixture-backed screenshots only after relevant interfaces are stable. Capture real
primary and narrow states, exclude user data and secrets, define refresh triggers, and prevent
images from promising unavailable features.

## Public repository repointing

**Status:** Candidate

After the repository freeze is explicitly lifted and the active fork is reconciled into the
canonical upstream, repoint website, installation, release, documentation, license, and source
links from `mashuproject/awsm_bak` to `parasquid/awsm`. Verify every target and artifact first; do
not add dual-link compatibility.
