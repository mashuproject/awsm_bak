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

Current central contracts begin in:

- `apps/browser-extension/src/domain/contracts.ts`
- `apps/browser-extension/src/domain/cbor.ts`
- `apps/browser-extension/src/domain/hash.ts`
- `apps/browser-extension/src/domain/artifact-graph.ts`
- `apps/browser-extension/src/domain/decode*.ts`

They currently expose string/UUID-style IDs, `issuingDeviceId`, a broad semantic
`EncryptedEnvelopeV1`, linear Event and Generation assumptions, and old error identifiers. Replace
them with small owning modules for restricted deterministic CBOR, typed 32-byte IDs, transcript
framing, Vault Records, Vault Objects, dependencies, Required Features, exhaustive Event bodies,
Baselines, dual causal and Authority Parent Frontiers, retained Continuity Proofs, fresh Content
Baseline Cause mapping, Historical Attribution, reducers, and opaque outer envelopes. Generate
golden fixtures shared by every Client implementation.

Remove old `DEVICE_*`, `RECOVERY_GENERATION_*`, semantic server-Generation, selective-package, and
server-replacement errors. Add precise local validation, authority conflict, unsupported feature,
opaque Host, adoption, and collision outcomes without reusing Host errors as Vault facts.

## 3.2 Cryptography

Current code is concentrated in `src/crypto/`, `runtime/vault/keyring.ts`, `runtime/vault/slots.ts`,
`runtime/recovery/`, and `runtime/export/`. Replace Root Key and Device-slot derivation with:

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

`apps/browser-extension/src/drivers/indexeddb/schema.ts` currently declares one version-1 database
with feature-specific stores for Devices, Recovery Kits, server switch, Vault replacement,
Generations, projections, Jobs, and key slots. Replace the whole database with registry-backed
namespaces in the eleven logical families and explicit Storage Realm scope.

Update `database.ts`, `driver.ts`, repositories and decoders under `drivers/indexeddb/`, plus the
shared Artifact Store adapters under `src/hosts/shared/`. Introduce:

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

Replace or substantially rewrite:

- `src/runtime/vault/` for Initial Baseline, Genesis, selected context, Frontiers, Fork, Closure,
  Historical View, and Key Epochs;
- `src/runtime/recovery/` for member Recovery Credentials, invitations, enrollment, replacement,
  resignation, removal, roles, conflicts, and Future Protection;
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

`src/app/background.ts`, `src/app/client.ts`, `src/app/protocol.ts`, Chrome and Firefox Host
adapters, and WXT entrypoints carry current messages and workflow orchestration. Replace all old
wire shapes and ensure adapters submit Commands rather than author Events.

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
authorship. Unscoped discovery from Host inventory, withholding/freshness proof across Remotes,
multi-Client conflict journeys, and full multi-member management remain target work.

The shipped background, popup, and Library now use only the canonical application boundary. They
support local Vault creation and selection, Recovery Phrase confirmation and selected-replica
recovery, page Capture, a current recent-Capture view, Recovery Phrase replacement, Fork, Vacuum,
Closure, and a live selected-Vault Capture projection. A packaged Chromium journey builds those
actual entrypoints and proves the local ceremony, a Library opened through the popup, Capture
appearing in that already-open Library without reload, live second-popup reconciliation, management
disclosures, and retained readable Capture after Closure.

Search, export/import, synchronization, availability, member and invitation management, Capture
detail, and conflict-resolution surfaces still require canonical replacements. The remaining old
synchronization setup page is a dangling superseded surface, not a supported compatibility path;
remove or replace it together with its old orchestration and tests before v0.3 is complete.

# 4. Replica Host impact

## 4.1 Database replacement

The current Rails schema is generated from
`apps/coordination-server/db/migrate/20260719000000_create_coordination_schema.rb` and
`db/schema.rb`. It is the clean Host Policy and opaque-storage schema and contains:

- username-only Accounts and separately typed Channel Principals/Authenticators;
- sessions without a `VaultDevice` semantic scope;
- Host-local Hosted Replica handles;
- immutable capability-based Replica Access Grants;
- opaque item metadata, compact/streamable admission, resumable upload and parts;
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
synchronization HTTP clients have not yet switched to it and remain the next consumer to reconcile.

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

Existing unit tests under `apps/browser-extension/tests/unit/`, IndexedDB integration tests,
packaged browser E2E, cross-browser synchronization, server-switch scenarios, and design snapshots
encode current formats and flows. Delete tests whose sole purpose is old Device, Recovery Kit,
Generation, server replacement, remote-proof, or compatibility behavior. Do not mechanically rename
them.

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
6. Multi-Remote pull synchronization, On-demand hydration, Host switching, and adversarial proof.
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
