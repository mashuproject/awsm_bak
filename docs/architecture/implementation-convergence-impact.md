# Canonical Architecture Implementation Impact

**Status:** Active convergence scope and cold-start handoff

**Evidence scope:** repository checkout inspected through 2026-08-02

**Depends On:**

- `docs/plans/01-mvp-prd.md`
- `docs/architecture/consistency-review.md`
- all owning formal specifications

# 1. Purpose

This document tells an implementer starting cold what has converged, where the remaining
experimental implementation diverges from the reconciled canonical contract, and what must still
be replaced. It is an impact scope, not authorization to implement, deploy, reset an environment,
or change production.

# 2. Replacement rule

Implement one canonical design. Delete superseded fields, stores, tables, routes, readers, writers,
aliases, errors, tests, fixtures, UI, and documentation. Do not translate or preserve development,
test, prior release, or reference-staging experimental state. Ordinary framework migration files
may establish the clean schema, but contain no legacy conversion or dual-write logic.

Do not bump a protocol, format, database, or Object version merely to label the replacement as a
successor. Use the initial identifiers in the owning contracts. Required Vault Features handle
future semantic evolution, not compatibility with discarded experiments.

# 3. Browser Client impact

## 3.1 Domain contracts and codecs

The shipped central contracts now begin in:

- `apps/browser-extension/src/domain/canonical/`
- `apps/browser-extension/src/domain/cbor.ts`
- `apps/browser-extension/src/domain/hash.ts`
- `apps/browser-extension/src/domain/structured-content.ts`
- `apps/browser-extension/src/storage/opaque-envelope.ts`

They own restricted deterministic CBOR, typed 32-byte IDs, transcript framing, Vault Records,
Vault Objects, dependencies, Required Features, Event bodies, Baselines, causal and Authority
Parent Frontiers, Continuity Proofs, Content Baseline Cause mapping, Historical Attribution,
reducers, and opaque outer envelopes. The still-disconnected generic domain decoder residue remains
an audit target; it must not regain a route into a packaged Client or become a compatibility reader.
Generate golden fixtures shared by every Client implementation.

The disconnected Device/Recovery Kit/server-switch error and service tree is removed. Continue to
add precise local validation, authority conflict, unsupported feature, opaque Host, adoption, and
collision outcomes without reusing Host errors as Vault facts.

The disconnected generic Account HTTP, Account-session, Cable, synchronization coordinator,
generation-fence, server-switch, and transfer HTTP tree is also removed. It encoded retired
`VaultDevice` identity, semantic Vault routes, and an old server-switch model, and was reachable
only from its own obsolete tests. The strict Hosted Replica session and opaque HTTP adapters are
the one current Client channel foundation.

## 3.2 Cryptography

Current canonical code is concentrated in `src/crypto/`, `src/domain/canonical/`, and the canonical
Vault services. The superseded Root Key, Device-slot, Device certificate, and Recovery Kit service
tree is removed rather than retained as an unused reader. Complete the current cryptographic
contract with:

- independent random Key Epoch Keys and exact Key Epoch IDs;
- Ed25519 Client and Recovery signing keys;
- X25519 Recovery and Client wrapping keys;
- exact HPKE Key Envelopes with authenticated outer padding;
- exact compact and streaming XChaCha construction;
- BIP39 entropy-based Recovery derivation and phrase confirmation; and
- the canonical Complete Export package and key inventory.

Add mutation and cross-domain negative vectors. Never keep the current cryptographic readers as a
fallback.

## 3.3 Persistence

`apps/browser-extension/src/drivers/indexeddb/canonical-schema.ts` is the sole shipped IndexedDB
schema. It declares registry-backed namespaces in eleven logical storage families and explicit
Storage Realm scope; its canonical database driver performs the associated atomic commits. The old
feature-specific Device, Recovery Kit, server-switch, Vault-replacement, Job, and key-slot store
tree is removed with its repositories and decoders. Continue to complete:

- immutable Vault Record and Vault Object namespaces;
- Replica Safety State with accepted Generation, causal and Authority Frontiers, Continuity Proof
  roots, availability, resolution, preservation roots, adoption, and GC fences;
- separate Installation State and Trusted Secrets;
- typed Execution, Prepared Data, and Quarantine namespaces;
- identity-bound disposable Materializations;
- Managed Resource metadata; and
- crash-safe database/wrapper promotion.

Delete the existing database in development and tests. A browser upgrade path is intentionally
absent.

## 3.4 Runtime services

Continue or substantially rewrite:

- `src/runtime/vault/` for Initial Baseline, Genesis, selected context, Frontiers, Fork, Closure,
  Historical View, and Key Epochs;
- canonical Vault recovery services for member Recovery Credentials, invitations, enrollment,
  replacement, resignation, removal, roles, conflicts, and Future Protection;
- `src/runtime/synchronization/` for multi-Remote receiver pull, Quarantine, opaque inventory,
  randomized destination rewrapping, DAG convergence, and Vacuum discovery;
- `src/runtime/library/` for all 31 Content Events, exhaustive reducers, Folders, Tags, Notes, and
  scoped conflicts;
- `src/runtime/export/` and `src/runtime/import/` for canonical Complete Export and collision rules;
- `src/runtime/storage-relief/` for unconditional warning and local-only availability knowledge;
  and
- `src/runtime/search/` for Generation/corpus/algorithm-bound Materialization identity and
  predecessor invalidation.

Preserve useful browser-independent page-snapshot behavior under `runtime/page-snapshot/` only
after adapting its identifiers, Descriptor, Artifact, and Object contracts. Capture modules under
`runtime/capture/` must use full causal- and Authority-Frontier compare-and-swap and explicit
pending Prepared Data.

## 3.5 Client and browser surfaces

The active WXT background, popup, and Library use the strict canonical application boundary.
Browser adapters submit canonical Commands rather than author Events. The superseded
`src/app/background.ts`, `src/app/client.ts`, and `src/app/protocol.ts` boundary is removed; it is
not retained as an adapter or fallback route.

Update popup, Library, Vault-management, synchronization, Search, and Storage Relief views plus
accessible status helpers. Add trusted Client surfaces for:

- member, Administrator, Client Credential, Recovery, and Invitation management;
- scoped Conflict inspection and resolution;
- On-demand availability without redundancy claims;
- Vacuum disclosure, Adoption, Fork Before Adoption, Export, Closure, and historical views; and
- unsupported Required Feature and pending Capture state.

Physical-device labels may remain ordinary presentation when describing a browser session, but
must not become portable Vault authority.

## 3.6 Current browser convergence evidence

The repository now contains an executable canonical substrate for codecs, identifiers,
cryptography, opaque protection, IndexedDB namespaces, Initial Baseline and Genesis, signed Record
and Authority replay, retained Continuity Proof dependencies, local creation and Capture, core
content projection, keyword Search, Storage Relief foundations, Vacuum, Closure, state-only Fork,
Invitations, Client and Recovery Credential Events, Key Epoch transitions, Key Delivery, and
Feature Activation. This is repository evidence from the focused and full browser test suites; it
does not establish packaged UI behavior or deployed state.

Member Recovery currently covers the selected readable-Replica path: an effective phrase opens the
exact authenticated Recovery Envelope set, enrolls a fresh same-member Client in one Frontier-CAS
mutation, protects the recovered local keyring, and immediately supports confirmation-gated
all-head Recovery replacement. Unit crypto/replay proof and a real Chromium IndexedDB restart prove
the retired phrase, one effective replacement head, fresh local Client authority, and subsequent
authorship. The unscoped Host-inventory primitive now scans bounded opaque Compact items and retains
only phrase-openable Recovery Envelope candidates. Its in-memory closure verifier then re-reads one
source Host snapshot, checks outer metadata and locators, derives every phrase-owned Epoch, assigns
every reachable Record, Object, Feature Manifest, and Key Envelope to its authenticated Epoch,
selects the current Baseline from its signed Vacuum chain, and verifies every reachable Streamable
Artifact frame before matching the phrase keys to an effective Recovery Credential. It retains no
local Replica state and does not activate a Vault. Fresh-Client activation, withholding/freshness
proof across Remotes, multi-Client conflict journeys, and full multi-member management remain target
work.

The Complete Import substrate now has the separate atomic activation primitive that a future Hosted
recovery ceremony will use: after revalidating an exact complete closure, it prepares the fresh
Client enrollment and commits the authenticated closure, enrollment Event, Client Envelopes, and
installation-wrapped secrets in one initial local transaction. An incorrect phrase reaches no local
Vault commit. This is repository-only substrate, not yet a Hosted recovery command or user-facing
flow.

The shipped background, popup, and Library now use only the canonical application boundary. They
support local Vault creation and selection, Recovery Phrase confirmation and selected-replica
recovery, page Capture, a current recent-Capture view, Recovery Phrase replacement, Fork, Vacuum,
Closure, and a live selected-Vault Capture projection. A packaged Chromium journey builds those
actual entrypoints and proves the local ceremony, a Library opened through the popup, Capture
appearing in that already-open Library without reload, live second-popup reconciliation, management
disclosures, and retained readable Capture after Closure.

Search, export/import, synchronization, availability, member and invitation management, Capture
detail, and conflict-resolution surfaces still require canonical replacements. The obsolete
synchronization-setup entrypoint is removed rather than left as a broken compatibility route. The
retired direct application protocol, its Library-preferences and direct popup/Library view helpers,
and their sole-contract tests are also removed. The offscreen entrypoint now contains only
canonical screenshot stitching; its retired export and MHTML-download message protocols are
removed. The unshipped old Search request/permission surface and old Storage Relief request/view
surface are removed with their sole-contract tests. Remaining disconnected experimental source and
browser journeys, including old Search and synchronization paths, require a separate audit and
canonical replacement or deletion before v0.3 is complete.

The first closed removal audit eliminated every unreachable dependency of the superseded
Device/Recovery Kit/replacement/server-switch tree: its 111 implementation files, 69 sole-contract
tests, old IndexedDB schema and repositories, and old Account/session, export/import, Search,
Storage Relief, and synchronization helpers. A fresh static import walk from every packaged
entrypoint now reaches only the canonical application graph. This is checkout evidence; the
remaining disconnected canonical Remote foundations are retained for activation, while all other
residue needs the same dependency-led audit rather than a filename-only deletion.

# 4. Replica Host impact

## 4.1 Database replacement

The current Rails schema is generated from
`apps/coordination-server/db/migrate/20260719000000_create_coordination_schema.rb` and
`db/schema.rb`. It is the clean Host Policy and opaque-storage schema and contains:

- username-only Accounts and separately typed Channel Principals/Authenticators;
- sessions without a `VaultDevice` semantic scope;
- Host-local Hosted Replica handles;
- immutable capability-based Replica Access Grants;
- opaque item metadata, per-Hosted-Replica locator salt and opaque locators, compact/streamable
  admission, resumable upload and parts;
- inventory and Wake Hint cursors with no Vault semantics;
- quotas and exact Host-local lifecycle Jobs; and
- independently modeled lifecycle and recurring cleanup Jobs.

The semantic `vault_replicas`, `vault_generations`, memberships, reachability pages, Event commits,
dependencies, recovery generations, key epochs, Vault Devices, Device Key Envelopes, recovery,
purge, and delivery structures are absent rather than migrated or retained.

Retain Account fields only where they satisfy the target Host policy. Do not infer a one-Vault
limit or add email. Account deletion reaps only Host-local resources and opaque bytes under clear
policy; it cannot describe deletion of the Vault elsewhere.

## 4.2 Models, services, Jobs, and Channels

The semantic models and services named by the superseded experiment are removed.
`Coordination::DiskStore` now sits behind exact bounded opaque item and Prepared-Data operations;
Account authentication, sessions, deletion, serializers, service policy, and notification cursors
use Channel Principals and Grants. Wake Hints remain polling-safe advisory cursors and are never
required for correctness. Disposable real-time delivery adapters remain optional future work.

## 4.3 Routes and generated API

`apps/coordination-server/config/routes.rb` exposes only the opaque operations in
`specifications/protocol/` plus Host-local Account, session, Grant, quota, lifecycle, and Hosted
Replica management. No Vault, Device, Recovery, Event, Generation, purge, or semantic Record route
remains.

`docs/specifications/protocol/http-api.openapi.yaml`, its initializer, Committee validation,
`spec/contracts/openapi_spec.rb`, and Rails request specs now form one executable contract. Browser
synchronization now has a strict Hosted HTTP adapter that creates and lists Host-local Hosted
Replicas, admits locally verified Compact outer items with only their opaque locators, and combines
with Installation-wrapped Remote credentials, durable snapshot inventory/Quarantine, Host-locator
retention, and local Compact classification. The browser can strictly exchange a transient
username/password for the reference Host's installation-wrapped rotating session credential and
conditionally replace it after local access expiry; it does not retain the password or derive Vault
authority from that session. A Runtime setup service now signs in, creates one Host-local Hosted
Replica, requires the current pull/materialization capabilities, and atomically records its local
Remote configuration plus rotated session without retaining the password. It validates the local
Remote configuration before Host access, preventing malformed input from prompting for an unrelated
Host or leaving a Host-side Replica. The shipped popup now lists non-secret local Remote summaries
and creates a Hosted Replica only after an explicit Host permission request; that creation does not
yet synchronize data. Remote editing, disable/delete controls, and general multi-Remote
convergence remain unfinished.
For a non-adopted current Generation, it also validates one complete same-Generation Content DAG
branch and its newly required Vault Object closure, then atomically promotes only those newly
accepted Compact items with the exact pull Job and Replica state. A repository-tested Runtime
foundation can now hydrate one known Streamable Artifact by scanning every enabled Remote's opaque
inventory with its derived locator, fully verifying a candidate under a local Key Epoch, and
conditionally publishing the local Artifact Resolution. It skips unavailable or invalid Remotes
without giving them semantic authority. The browser background now composes it with the same OPFS
Artifact Store used for Capture, and the Library offers explicit retrieval for a known locally
unavailable Capture. That direct action requests enabled configured Host origins before its channel
work; Library reads recompute Artifact availability from the current local Resolution and wrapper
presence rather than trusting a cached Materialization. A real Chromium IndexedDB/OPFS restart
proof uses the actual protected Remote configuration service. Authority, Key-Epoch,
Required-Feature, Vacuum/adoption, Remote-management UI, and general multi-Remote convergence
remain Quarantined or unfinished. Retryable opaque-Host transport failures now checkpoint bounded local retries
without changing Vault state. One local coordinator pulls configured Remotes sequentially and
isolates an individual Remote failure, while rejecting corrupt local Remote scope/identity before a
channel call. The Runtime can now authenticate its local accepted Generation and materialize the
entire reachable Compact closure to one writable Hosted Replica through independently randomized
outer items and the durable Remote Materialization Ledger. It re-wraps Key Envelopes only to their
authoritative Credential targets, preserves their logical IDs, retries an ambiguous admission with
the same prepared bytes, and deliberately leaves Streamable Artifact wrappers sparse for explicit
hydration. The shipped popup now offers explicit per-Remote Compact materialization after a
Host-permission gesture; it is deliberately named and implemented separately from pull
synchronization. It also exposes an explicit receiver-initiated check of every enabled Remote,
obtaining all needed Host permissions in one direct gesture before the serial local pull
coordinator runs. Remote editing, disable/delete controls, and general multi-Remote convergence
remain unfinished.

## 4.4 Account dashboard and public pages

The current Rails dashboard under `app/views/accounts/` manages Host-local Account identity,
authenticators, browser/API sessions, password replacement, and deletion; it displays Hosted
Replica access, Grants, quota, and opaque storage facts. It renders no Device or Vault content and
does not imply Vault membership. Remaining dashboard management mutations must continue through
the same Host-local policy boundary already used by the executable Grant and reaping API.

Keep username/password and no-email behavior. Update landing, privacy, security, layout, and
dashboard copy only after shipped behavior changes. Replace `home/glossary.html.erb` with safe
deterministic rendering from `docs/architecture/glossary.md` under the separate Roadmap initiative
or the convergence plan if explicitly included.

# 5. Test replacement

## 5.1 Browser tests

The Chromium IndexedDB integration suite and its harness execute only the twelve canonical storage,
Recovery, Capture, Content, Complete Import, Hosted-pull, Artifact-hydration, and restart
journeys. Old Device, Recovery Kit, Generation, server replacement, remote-proof, Search, Storage
Relief, and compatibility scenarios are removed rather than compiled as unreachable release
evidence.

The packaged Chrome design and ceremony lanes likewise cover only current visible behavior. The
design lane renders local-Vault creation, phrase confirmation, ready, Vault settings, and the
empty Library at wide and narrow sizes, alongside the Account dashboard and public surfaces. The
Chrome E2E entry point runs the canonical packaged ceremony: local creation, Recovery Phrase
confirmation, capture, Library projection, settings, phrase replacement, Fork, Vacuum, and
Closure. The superseded Device/Generation/server-switch E2E files and their Search, Storage Relief,
semantic Host, and synchronization-setup snapshots are removed; they are not retained as skipped
release evidence.

Firefox Stable and ESR execute the same packaged local-Vault ceremony through their real Firefox
hosts: Recovery Phrase confirmation, page capture, Library rendering, and persisted reopening after
a background restart. The cross-browser command composes the current Chrome and Firefox ceremonies.
It proves each packaged Host's current local behavior; it must not be represented as Client-to-Client
or Client-to-Host synchronization proof until the opaque Remote path is shipped and independently
proven.

Start with the target golden, reducer, authority, recovery, Host, storage, Vacuum, Fork, and
divergence matrix in `19-testing-strategy.md`. Preserve page-snapshot, Capture, browser permission,
Search, accessibility, and visual tests only after their fixtures use the canonical substrate.
Golden tests must prove Cause-ID remapping across Vacuum and Fork, post-Baseline fact references,
attribution preservation without copied authority, and phrase-only Recovery through retained
Continuity Proofs after discarded Content history.

## 5.2 Rails tests

Replace Plan 15 Device and recovery request/service specs, semantic event/generation/replica tests,
old sync proof, purges, and Cable payload assertions. Retain Account username, password, public
cache, dashboard layout, health/readiness, and deletion behaviors only where target Host semantics
still match.

Build black-box tests exclusively through the new public API. Prove cross-Grant isolation, opaque
metadata limits, immutable retry, range/resume, withholding, corruption, quota, Account deletion,
and two isolated Hosts. Add database constraints for every Host-local invariant.

The two heavyweight local proofs now exercise the current opaque boundary rather than semantic
Vault fixtures. `corepack pnpm test:sync-proof` signs up Host-local Accounts, rotates a session,
creates one Hosted Replica, proves no-access before a bounded Grant, admits one verified compact
envelope, reads its opaque inventory and bytes through a second Host process, rejects an
unauthorized hint write, and proves immediate revocation. `corepack pnpm test:e2e:coordination`
admits an opaque item through one Host process, reads it through another, stops the first process,
then restarts it and proves the same session can still obtain the same inventory. Neither proof
introduces Vault IDs, Device authority, Recovery, Generation, Cable, or semantic content at the
Host boundary. They are local repository evidence, not evidence of a named deployment or complete
Client synchronization.

# 6. Tooling, packaging, and operations

Update fixtures, release validators, browser manifest permissions where target Channels change,
Compose health/readiness, Rails seeds, sync-proof scripts, and CI commands. Keep Node and package
manager versions repository-pinned through `corepack pnpm`.

Local development and test data is disposable and must be reset. Any reference-staging reset and
deployment occurs only in a later explicitly authorized operation after reinspection and exact
rollback decisions. Production, its data, its ingress, and the frozen upstream repository are out
of scope.

# 7. Recommended implementation slices

1. Canonical codec, ID, crypto, envelope, reducer, and conformance fixtures.
2. Clean Client persistence substrate and local single-member Vault creation/Capture/replay.
3. Complete content organization, search rebuilding, Vacuum, Fork, Closure, and portability.
4. Multi-member authority, Recovery, Invitation, Credential, Key Epoch, and conflict ceremonies.
5. Clean opaque Host schema, Account/Grant dashboard, strict protocol, and generated OpenAPI.
6. Multi-Remote pull synchronization, locator-derived dependency resolution, On-demand hydration,
   Host switching, and adversarial proof.
7. Packaged Chrome/Firefox journeys, public-copy reconciliation, destructive authorized staging
   establishment, and release proof.

Each slice begins with failing target tests and removes superseded code in its owned area. No slice
lands a parallel legacy path.

# 8. Verification commands

Current repository entry points are:

```text
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:e2e
corepack pnpm test:e2e:cross-browser
corepack pnpm test:e2e:coordination
corepack pnpm test:sync-proof
corepack pnpm build
```

Rails unit and request verification runs through the coordination-server container. The approved
implementation plan must add target conformance commands and decide which heavy black-box gates run
locally versus CI. Documentation-only success today does not make these target tests pass.

# 9. Completion gate

Implementation convergence is complete only when source searches find old terminology solely in
historical plans, migration history explicitly retained by framework policy, or factual current-
history notes; every target codec and reducer has executable proof; generated API matches routes;
real Clients and Hosts pass fault scenarios; no compatibility code remains; and public pages claim
only newly proven behavior.
