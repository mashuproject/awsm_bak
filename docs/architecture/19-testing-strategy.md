# Testing Strategy

**Document:** `architecture/19-testing-strategy.md`

**Status:** Draft

**Owner:** Engineering

**Depends On:**

- All architecture documents

---

# Purpose

This document defines the verification strategy for Archive Platform.

Testing is organized around architectural guarantees rather than implementation modules.

The objective is to continuously verify that the platform's core invariants remain true as the implementation evolves.

---

# Testing Philosophy

The platform relies on a small number of architectural guarantees.

Tests should verify these guarantees across every supported implementation.

Implementation details may change.

Architectural guarantees must not.

## Test-Driven Development

Implementation SHALL proceed through RED-GREEN-REFACTOR cycles:

1. add the smallest test for the next observable behavior;
2. run it and confirm that it fails for the expected missing behavior;
3. implement only enough production code to pass;
4. run the focused test;
5. refactor without changing behavior; and
6. run the affected suite.

Production behavior SHALL NOT precede its failing test. Every discovered defect SHALL receive a failing regression test before its fix.

Tests SHALL NOT be weakened, deleted, skipped, or rewritten merely to make a build green.

The first Chrome extension slice follows the task-level TDD gates in `docs/plans/02-chrome-extension-capture-vertical-slice.md`.

## Product design evidence

The root `DESIGN.md` and generated `@awsm/design-system` output form one tested contract. CI and
local linting validate its structure, accessibility contrast pairs, token references, deterministic
generation, licensed local font assets, and shared Rails/extension consumption.

Every text-bearing token and component SHALL meet WCAG 2.2 contrast. Normal text and control labels
have a hard `4.5:1` minimum. Paragraphs, explanatory copy, repeated metadata, notices, dialogs,
sidebars, and other extended-reading surfaces have a `7:1` minimum. Saturated graphic accents SHALL
NOT be used as text backgrounds unless an audited semantic text-bearing variant satisfies the
applicable threshold. Token generation SHALL reject invalid declared pairs, and rendered design E2E
tests SHALL inspect effective computed foreground and composited background colors on visible text.

Every visible Rails or extension change requires rendered evidence at representative primary and
narrow widths, including relevant resting, focus, validation, loading, disabled, success, error,
offline, locked, authentication-required, and destructive states. Automated DOM assertions do not
replace viewing captured screenshots. Reduced-motion runs must prove final-state equivalence without
travel, looping, stagger, parallax, or delayed access.

Public Rails tests prove a complete no-JavaScript landing, installation guide, trust pages, and
Account forms; Hotwire tests cover enhancement and cache restoration separately. Public pages must
make no remote font, script, image, analytics, or telemetry request. Production routing must not
recognize the development design gallery.

---

# Architectural Invariants

Workspace and multiple-Vault tests MUST prove:

- every Object, Event, Projection, Capture Job, outcome, generation, head, and Vacuum lease is
  isolated by an explicit Vault ID even when two Vaults use colliding local entity IDs;
- every Vault-scoped request rejects a stale expected Vault ID before plaintext work and again at
  its authoritative transaction boundary;
- Create, Select, and Rename expose either the complete predecessor state or the complete successor
  state and never a partial Workspace/Vault combination;
- switching locks both contexts, releases the previous Root Key only after commit, and never retains
  an inactive Root Key;
- Capture Jobs remain pinned to their accepted Vault and management is rejected while Capture or
  Vacuum is active;
- encrypted Vault names replay deterministically, remain visible from the encrypted Workspace cache
  while locked, rebuild after unlock, and survive Vacuum unchanged; and
- popup and Library observe the same global Active Vault while cross-Vault deep links require an
  explicit switch.

The following invariants are fundamental.

## Immutability

- Bundles are immutable.
- Events are immutable.
- Artifacts are immutable.

---

## Replay

- Replaying the same Event Log always produces identical Projections.
- Replay order is deterministic.
- Duplicate Events do not change state.

---

## Synchronization

- Synchronization is eventually consistent.
- Reordering of network delivery does not affect final state.
- Interrupted synchronization resumes safely.
- Duplicate uploads are harmless.

---

## Zero Knowledge

- Plaintext never leaves the trusted runtime.
- The Coordination Server never requires plaintext to operate.
- Search indexes never synchronize.
- OpenAPI request and response validation rejects unknown fields and undocumented resources.
- Independent clients converge through real HTTP, PostgreSQL, immutable byte storage, and Action
  Cable; a lost-notification variant converges through polling alone.
- Real Redis tests prove the Cable-ticket key/value/TTL representation, atomic `GETDEL` under two
  clients, replay rejection, sanitized outage mapping, and Redis-only degraded readiness. The
  retained proof issues through one Rails process, consumes and subscribes through another, and
  observes the primary broadcast across Redis Pub/Sub.
- A separate black-box Coordination Server E2E suite SHALL exercise interactions through public
  HTTP and WebSocket boundaries across two Rails processes, PostgreSQL, opaque byte storage, and
  Redis. Its outage-recovery scenario SHALL stop disposable Redis while Rails remains live, verify
  degraded HTTP 200 readiness, retryable Cable-ticket failure, and authoritative polling during the
  outage, then restart Redis and verify recovered ticket issuance and cross-process Cable delivery.
  This server suite SHALL remain distinct from packaged-extension browser E2E.
- Delivery Cursor order is tested independently from canonical Event replay order, including late
  offline Events.
- Generation tests cover paged reachability, dependency closure, predecessor/head races, explicit
  recovery, and stale-write rejection.
- Account tests cover password-derived authentication/key separation, normalized email privacy,
  rotating one-use refresh credentials, opaque 256-bit one-use Cable tickets stored only under
  digest keys, logout erasure, and filtered secret sentinels.
- Trusted Runtime tests cover existing/new Vault enrollment, remote bootstrap, snapshot-bounded
  pull, canonical replay independent of cursor order, malicious metadata rejection, Artifact
  streaming beyond 4 GiB, and polling-only convergence.
- Storage-relief tests prove exact active-membership/metadata checks, eligible-role selection,
  device-local availability invariants, cancellation, worker restart at every deletion/restoration
  boundary, ordinary synchronization preservation, quota fallback, multi-surface invalidation,
  keyboard cancellation, terminal focus restoration, and polite live-region announcements at
  desktop and narrow widths.
- Toolbar-popup navigation tests activate Open library and the recent-Capture preview through a
  packaged Chrome popup and prove that the destination tab is created before asynchronous preview
  dismissal can outlive the popup execution context.
- Complete Export tests source remote-only wrappers through active or Recovery Snapshot tickets
  without local rehydration. Chrome Download Host tests register completion observation before
  starting a download, reconcile already-terminal downloads, surface interruption as a typed
  failure, and prove a failed imported-Vault re-export can be retried successfully. Page-snapshot
  tests validate canonical members, manifest, streaming limits, Export/Import, and synchronization.
  MHTML Download Host tests inspect Chromium's completed derived output and prove the canonical
  `.mhtml` filename, `multipart/related` media type, sanitizer invariants, and deterministic bytes.
  Server-switch
  tests relay source-only wrappers, terminalize source authentication expiry, source corruption,
  and candidate upload interruption without changing source authority or availability, and clear
  availability only when a fully local candidate Replica is installed.
- Synchronized Vacuum tests prove server-first activation, journaled local resume, retention of
  reachable remote-only Objects, and cleanup of reclaimed availability. Stale-Replica tests prove
  read-only fencing, atomic server replacement without another Vault, rollback, and export-first
  explicit discard.
- Purge fault tests prove restart safety, ticket revocation, active/shared-byte retention, permanent
  tombstones, and verified absence before success.

---

## Trust

- Only trusted devices may decrypt Vault data.
- Revoked devices cannot receive future wrapped keys.
- Authentication and trust remain separate concepts.

---

## Canonical Input Handling

- Inputs outside the current canonical Event and protocol specifications are rejected safely.
- Tests do not retain fixtures or expectations from discarded pre-release designs.

---

# Test Pyramid

```
Property Tests

↓

Unit Tests

↓

Integration Tests

↓

System Tests

↓

Cross-Version Tests
```

Every layer contributes different confidence.

---

# Property-Based Testing

Property tests verify invariants rather than examples.

Examples:

- Replay is deterministic.
- Event ordering is stable.
- Serialization is reversible.
- Encryption round-trips correctly.
- Projection rebuilding is idempotent.

---

# Unit Tests

Every public component should have focused unit tests.

Examples:

- Event validation
- Bundle serialization
- Projection reducers
- Command validation
- Key derivation
- Search tokenization

---

# Integration Tests

Integration tests verify collaboration between components.

Examples:

- Capture → Bundle
- Bundle → Encryption
- Event → Projection
- Synchronization → Replay
- Processing → Artifact

---

# System Tests

System tests execute complete user workflows.

Examples:

Capture page

↓

Synchronize

↓

Restore on second device

Vault Vacuum tests MUST cover delete/restore replay, retained offline Bundle authentication, actual storage reclamation, transaction failure before activation, restart after activation where collection is asynchronous, unknown dependency failure, and stale-generation resurrection prevention.

Collection-management tests MUST begin with failing tests and cover exact fragmentless URL routing, query-sensitive automatic grouping, deterministic tie-breaking, merge redirects and cycles, Move/Extract assignment, compensating Undo, stale-state rejection, atomic Event/Projection commits, Projection rebuild, and Vacuum preservation. Packaged-browser tests MUST exercise accessible controls and native drag and drop, including Deleted-member behavior, known URLs, tail visit-original routing, and the ten-second single-operation Undo presentation.

Multiple-Vault tests MUST begin with failing tests and cover independent Root Keys, Vault-prefixed storage isolation, stale-context rejection, atomic Create/Select/Rename, automatic locking on selection, Vault-scoped Capture Jobs and recovery, encrypted locked-name caches, deterministic name replay, duplicate-name disambiguation, Projection rebuild, Vacuum isolation, and packaged-browser keyboard workflows across popup and Library. The shipped interface does not expose a manual Lock action.

Long-lived UI tests MUST keep multiple surfaces open and prove that successful mutations reconcile
every affected surface without reload. Coverage MUST include lock/unlock, active Vault and name
changes, long-running busy/completion state, and content changes. Reconciliation tests MUST prove
that invalidation is payload-free, canonical state is refetched, bursts cannot render stale responses,
and context-bound plaintext is discarded before a potentially locking change is resolved.

↓

Verify identical state

---

# Client-Service Contract Tests

Before the first release, tests verify the one canonical client and Service contract.

Examples:

Current Client ↔ Current Service

Mixed Event Versions

Mixed Bundle Versions

Mixed Protocol Versions

---

# Failure Injection

The runtime should be tested under failure conditions.

Examples:

- interrupted uploads
- interrupted downloads
- corrupted blocks
- duplicate events
- missing events
- clock skew
- network partitions
- storage exhaustion

Recovery should preserve architectural invariants.

---

# Cryptographic Testing

Verify:

- authenticated encryption
- key wrapping
- key rotation
- signature verification
- ciphertext integrity

Cryptographic test vectors should be retained across releases.

---

# Replay Verification

Given an Event Log:

```
Replay

↓

Projection A
```

Deleting all Projections and replaying again must produce an equivalent Projection.

---

# Projection Testing

Every Projection should support:

- empty replay
- incremental replay
- rebuild
- checkpoint restore (if implemented)

---

# Synchronization Testing

Multiple simulated devices should verify:

- concurrent updates
- duplicate uploads
- reconnect behavior
- conflict handling
- eventual convergence

---

# Performance Testing

Representative targets:

- replay throughput
- synchronization latency
- indexing throughput
- capture throughput
- memory usage
- startup time

Performance regressions should be tracked continuously.

---

# Security Testing

Security verification should include:

- authorization checks
- protocol validation
- malformed payloads
- capability enforcement
- extension sandboxing

---

# Browser Testing

The Capture Adapter should be tested across supported browsers.

Examples:

- Chrome
- Firefox

Tests should account for browser-specific API differences.
Capture Adapter coverage should include a script-heavy page that remains loading while extraction
runs and prove structured content and normalized text complete without a producer-disconnect
warning.

---

# Canonical Format Coverage

Before the first release, tests cover only the current canonical:

- protocol
- Bundle format
- Event format
- extension API
- cryptographic formats

Tests and fixtures for discarded pre-release representations must be removed.

Artifact graph coverage SHALL include descriptor/Event exact closure, Role and warning invariants,
canonical structured-content vectors, adversarial frame parsing, empty/final frames, wrapper and
plaintext checksum failures, Artifact Store orphan reconciliation, rollback at every authoritative
write, Projection rebuild, and Vault Vacuum reachability.

Vault Package coverage SHALL independently recover Complete packages, validate permitted Selective
omissions, reject compact-Artifact omission and false coverage, force ZIP64 on small fixtures, and
exercise counters beyond 4 GiB without proportional memory use. Browser tests SHALL keep at least
two surfaces open for invalidation and visually inspect Artifact resting, loading, success, failure,
focus, and narrow states. Library-detail coverage SHALL prove that the current `bundleId` route,
loaded screenshot, and non-collapsed text selection survive a state invalidation; after selection
collapses, the deferred reconciliation SHALL complete from the same detail route.

The packaged-Chrome Account proof SHALL include one cold first-use journey through the real
self-hosted Coordination Server. Through visible extension controls it SHALL choose the server,
open Rails signup, log in, create and confirm a Recovery Phrase, capture and organize content,
bootstrap a second browser profile with the same Account and phrase, prove live
cross-profile Collection convergence, disconnect that profile before a remote Generation change,
delete and Vacuum from the authoritative profile, resolve the resulting stale Replica with
the export-first warning and explicit overwrite confirmations, preserve its prior state as a fresh
local-only Vault, and install the server-authoritative Replica. The dedicated Vault Package suite
owns Export-to-Import portability because headless Chrome cannot complete the native save-as Host
boundary. Test harness accommodations for headless Chrome MAY grant permissions only in a
disposable packaged copy; the release-manifest verifier remains authoritative for shipped
permissions.

The packaged recovery interaction suite SHALL use real release builds and the public Coordination
Server contract to prove fresh Chrome from Chrome, fresh Firefox from Firefox, Chrome from Firefox,
and Firefox from Chrome. Each direction SHALL compare the exact active Event/Object closure,
Generation, Head, Delivery Cursor, and encrypted Artifact bytes after bidirectional convergence.
The suite SHALL also prove returning-Device restart, ordinary Device removal, Future Protection,
concurrent Recovery Generation compare-and-swap loss, offline unpublished old-epoch replay, and
rejection of removed Devices and old Recovery Phrases.

Vault replacement interaction coverage SHALL require a verified Complete Export, fail the network
request immediately before activation and prove the source remains authoritative, retry through
atomic promotion and asynchronous source purge, prove stale source Devices retain old downloaded
content but cannot synchronize, reject the old phrase, recover a fresh Device with the replacement
phrase, and compare the exact resulting encrypted Replica.

The proof SHALL also show that state reads do not create synchronization work, a visible Retry can
rediscover a server-superseded Generation without reauthentication, and a stable synchronized
Vault remains UpToDate after Vacuum. Focused tests SHALL prove wake coalescing, retention of the
final mutation wake, maintenance exclusion while Vacuum activates a Generation, preservation of
same-Generation predecessor metadata, and rejection of remote reconciliation when either the local
Head or the server's coverage of locally appended authority changes.

The packaged proof SHALL expire authentication during synchronized Vacuum and verify retained
deleted content, SignedOut plus AuthenticationRequired state, visible recovery guidance, successful
reauthentication, and later Vacuum completion. It SHALL terminate the extension Worker at every
stale-recovery preparation and activation checkpoint and prove restart returns pre-commit stages to
Conflict while the post-commit stage retains the complete activated result. It SHALL also replace
the server while a pull is paused immediately before reconciliation and prove the prior context
cannot commit after replacement. Browser integration tests SHALL independently close and reopen
IndexedDB at each persisted recovery stage. Test-only fault controls MUST be absent from release
artifacts, and release verification SHALL inspect emitted JavaScript for their namespace.

Coordination Server switching SHALL have five independent, serial, packaged-Chrome journeys against
two real Coordination Servers with separate databases and opaque stores: publishing to an empty
candidate, fast-forwarding a candidate from an exact recovered predecessor, fast-forwarding a stale
local Replica from a candidate successor, unioning independent same-Generation append tails, and
rejecting sibling successor Generations. Each journey uses fresh Accounts and browser profiles and
MUST NOT seed authoritative client or server rows.

The fast-forward journeys SHALL terminate the Worker after remote activation and before local
activation respectively, then prove idempotent startup convergence. The union journey SHALL pause
after classification, lock the Vault during application, inspect `WaitingForUnlock`, unlock, and
finish the same Job. Supporting packaged tests SHALL cover wrong password, unknown Account, another
Vault ID, and candidate reauthentication before writes and after remote activation while proving the
source context remains live. A separate packaged race proof SHALL pause after the first
candidate-accepted Union Event, rewrite the candidate Generation through its independent browser,
render the truthful concurrent-change conflict, and prove a later source mutation still
synchronizes. Browser integration SHALL inject failure at every Account-plus-Replica promotion write
and prove complete rollback. Exact encrypted Artifact preparation replay SHALL be idempotent so
restart cannot turn verified staging into a false collision.

Rendered evidence SHALL include candidate authentication, all four applying directions, locked,
conflict, terminal failure, and success states at desktop and materially different narrow widths.
Visible state assertions include geometry and accessibility names where relevant; DOM existence is
not visual proof. Production builds MUST exclude the fault-control namespace and disposable E2E host
permissions.

Complete Import coverage SHALL prove cold-Workspace Export-to-Import portability, wrong-passphrase
retry without restaging, stable Vault/Generation/Event/Object identities, fresh non-exportable local
credentials, exact encrypted Artifact wrapper copying, prepared-wrapper rollback, collision safety,
atomic activation, cancellation and restart cleanup, and the Workspace-wide mutation lease. Rendered
tests SHALL inspect first-launch entry, Select, Acquire, Authenticate, authentication error,
execution progress, cancellation, terminal failure, Success, focus, and materially different narrow
layouts.

---

# Continuous Integration

Every change should execute:

- formatting
- static analysis
- unit tests
- property tests
- integration tests
- system tests

Long-running performance suites may execute separately.

---

# Design Decisions

## Why Test Invariants?

Architectural guarantees define correctness more clearly than implementation details.

---

## Why Property-Based Testing?

Many synchronization and replay bugs are exposed more effectively by generated inputs than by fixed examples.

---

## Why Contract Testing?

Contract tests prove that the current client and Service implement the same canonical protocol.

---

# Future Extensions

Future testing capabilities may include:

- deterministic network simulation
- fuzz testing
- protocol conformance suites
- third-party implementation certification

---

# References

- `docs/architecture/20-deployment-and-operations.md`
- `docs/specifications/bundle/bundle.md`
- `docs/specifications/event/event.md`
- `docs/specifications/protocol/protocol.md`
