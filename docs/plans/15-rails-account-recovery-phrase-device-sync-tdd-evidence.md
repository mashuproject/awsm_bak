# Rails Account, Recovery-Phrase Device Sync, and Revocation TDD Evidence

**Document:** `docs/plans/15-rails-account-recovery-phrase-device-sync-tdd-evidence.md`

**Status:** In progress

**Owner:** Engineering

**Last Updated:** 2026-07-25

**Implements:** `docs/plans/15-rails-account-recovery-phrase-device-sync.md`

---

# 1. Baseline

- Branch: `agent/redis-coordination`
- Starting commit: `630a349`
- Starting tracked worktree: clean
- Pre-existing ignored state: local agent overlay, dependency/build output, browser test output, Rails
  logs, and local opaque-storage bytes; none is part of this implementation.
- Plan 15 and this evidence document began as untracked documentation on the starting branch.
- Hosted Coordination Server inspection or mutation: not performed.
- Delegation: not used.

# 2. Initial Gap Inventory

The starting implementation contradicted Plan 15 in these material ways:

- Rails stored `authentication_secret_digest` plus Account KDF, Account Encryption Key envelope,
  and Account Vault slot metadata instead of a conventional `password_digest`.
- `/api/accounts` and `/api/authentication-parameters` implemented extension-owned signup and
  password-derived client authentication.
- Rails had no `/sign_up`, browser login/logout, Account page, `BrowserSession`, or password-change
  surface.
- bearer sessions had no Account versus VaultDevice scope.
- extension login derived Account cryptographic keys and extension signup created the Account.
- synchronized bootstrap depended on an Account Encryption Key and Account Vault slot.
- no BIP39 Recovery Phrase, Recovery Kit, Device certificate, Device challenge, per-Device key
  envelope, key epoch, revocation, or full re-encryption implementation existed.
- current architecture and specifications described the superseded Account-key design.

The initial stale-contract search matched current Rails, extension, proof, test, architecture, and
specification files. Historical plans are intentionally retained and will receive concise
superseded notices rather than body rewrites.

# 3. Dependency and License Record

| Dependency                | Selected version | License    | Purpose                                       |
| ------------------------- | ---------------- | ---------- | --------------------------------------------- |
| `@scure/bip39`            | `2.2.0`          | MIT        | BIP39 checksum, entropy, and English words    |
| `libsodium-wrappers-sumo` | `0.8.4`          | MIT        | Existing Ed25519/X25519/XChaCha/wipe boundary |
| `cbor`                    | `0.5.10.3`       | Apache-2.0 | Canonical CBOR decoding and re-encoding       |

No GPL/AGPL wallet or recovery implementation is copied, linked, or adapted.

# 4. RED → GREEN → REFACTOR Log

This section is append-only while implementation proceeds. Each slice records the failing
expectation before its implementation and the exact focused verification after it becomes green.

## 4.1 Rails Account identity boundary

RED command:

```text
docker compose run --rm -e RAILS_ENV=test coordination-server \
  bundle exec rspec spec/requests/plan15_account_authentication_spec.rb
```

RED result: 6 examples, 6 failures.

The failures proved that the starting application lacked every asserted boundary: `Account` had no
conventional `password`, both discarded API routes still existed, server discovery lacked
registration/Device capabilities, `/sign_up` did not exist, and neither `BrowserSession` nor
`ApiSession` password-change revocation was available.

GREEN command: the same focused command after canonical schema recreation.

GREEN result: 6 examples, 0 failures.

Implemented:

- conventional `Account#password_digest` authentication;
- distinct `BrowserSession` and scoped `ApiSession` records;
- raw-password Account API login with no Account cryptographic payload;
- removal of both extension-owned Account API routes;
- configurable registration discovery;
- Rails signup/login/logout/Account/password-change routes and views; and
- password-change revocation of every browser/API credential.

## 4.2 Recovery Phrase and encrypted Recovery Kit

RED command:

```text
corepack pnpm --filter @awsm/browser-extension exec vitest run \
  tests/unit/recovery-kit.test.ts
```

RED result: suite failed to load because the recovery modules did not exist.

GREEN result: 1 test file, 4 tests passed.

Implemented:

- exact 16-byte entropy to 12-word English BIP39 encoding and strict normalized decoding;
- domain-separated HKDF-SHA256 vectors for Recovery Kit wrapping and recovery-administrator seed;
- canonical multi-epoch keyring validation;
- XChaCha20-Poly1305 Recovery Kit encryption with authenticated public metadata;
- Ed25519 recovery-administrator public-key derivation;
- ciphertext length/SHA-256 validation and tamper rejection; and
- strict `AWSMREC1` self-describing `.awsm-recovery` file encoding/decoding.

## 4.3 Certified Device identity and key envelope

RED command:

```text
corepack pnpm --filter @awsm/browser-extension exec vitest run \
  tests/unit/device-identity.test.ts
```

RED result: suite failed to load because the Device identity module did not exist.

GREEN result with recovery regression coverage: 2 test files, 6 tests passed. Extension TypeScript
typecheck also passed.

Implemented:

- deterministic or securely random Ed25519 signing and X25519 wrapping Device identities;
- canonical Device certificate content and recovery-administrator Ed25519 signatures;
- Device enrollment proof bound to certificate bytes, administrator signature, and Account
  ApiSession;
- X25519 shared-secret derivation with low-order/all-zero failure handling;
- epoch/device-bound HKDF-SHA256 plus XChaCha20-Poly1305 Device key envelopes;
- recovery-administrator signatures over envelope metadata/ciphertext; and
- wrong-Device and authenticated-metadata tamper rejection.

## 4.4 Rails Device-certificate trust boundary

RED command:

```text
docker compose run --rm -e RAILS_ENV=test coordination-server \
  bundle exec rspec spec/services/coordination/device_certificate_spec.rb
```

RED result: suite failed to load because `Coordination::DeviceCertificate` did not exist.

GREEN result: 2 examples, 0 failures.

Implemented:

- Apache-2.0 `cbor` `0.5.10.3` as a direct Rails dependency;
- independent deterministic CBOR re-encoding and canonical-byte enforcement;
- exact Device-certificate field, UUID, algorithm, key-length, display, client-kind, Vault,
  recovery-generation, and issuance-time validation;
- Ed25519 verification through OpenSSL against the expected active recovery public key; and
- one generic `DEVICE_ENROLLMENT_INVALID` failure for malformed, noncanonical, wrong-authority,
  future, unknown-field, and tampered certificates.

## 4.5 Canonical Rails authority schema

The pre-release schema was reset from the one canonical initial migration:

```text
docker compose run --rm -e RAILS_ENV=test coordination-server bin/rails db:migrate:reset
docker compose run --rm -e RAILS_ENV=test coordination-server bin/rails db:schema:dump
```

The resulting schema contains `recovery_generations`, `vault_key_epochs`, `vault_devices`, and
`device_key_envelopes`, binds every opaque record to a key epoch, and contains none of the
discarded Account key, Account slot, or signup-registration fields. The combined Account and
Device-certificate focused regression command passed 8 examples with 0 failures against the
regenerated schema.

## 4.6 Rails recovery and Device-envelope validation

RED command:

```text
docker compose run --rm -e RAILS_ENV=test coordination-server bundle exec rspec \
  spec/services/coordination/recovery_kit_spec.rb \
  spec/services/coordination/device_key_envelope_spec.rb \
  spec/services/coordination/device_enrollment_proof_spec.rb
```

RED result: all three suites failed to load because their server validators did not exist.

GREEN result: 5 examples, 0 failures.

Implemented:

- exact Recovery Kit JSON fields, algorithms, identifiers, byte lengths, ciphertext length, and
  SHA-256 validation;
- canonical-CBOR Device-envelope metadata, exact Vault/generation/epoch/Device binding, fixed
  epoch-root ciphertext shape, and checksum validation;
- recovery-administrator Ed25519 verification over exact signed envelope metadata; and
- certified Device proof-of-possession bound to the current Account `ApiSession` identifier.

## 4.7 Atomic initial attach and Account enrollment discovery

RED request coverage was added before the endpoints and authority transaction existed:

```text
spec/requests/plan15_initial_attach_spec.rb
spec/requests/plan15_vault_enrollment_discovery_spec.rb
```

GREEN focused result: 7 examples, 0 failures.

Implemented:

- one Account-scoped, idempotent transaction creating the provisional Vault, Recovery Generation,
  epoch zero, first certified Device, Device envelope, Generation upload, and VaultDevice session;
- rollback of the complete authority graph when Device possession proof fails;
- exact empty-versus-attached discovery responses; and
- discovery of only the active encrypted Recovery Kit and its public metadata.

## 4.8 Device challenge sessions, recovered enrollment, and removal

RED request coverage:

```text
spec/requests/plan15_device_sessions_spec.rb
spec/requests/plan15_device_enrollment_spec.rb
spec/requests/plan15_device_management_spec.rb
```

GREEN combined Rails result with initial attach and discovery: 15 examples, 0 failures.

Implemented:

- Redis-backed, SHA-256-namespaced, 60-second, one-use Device challenges;
- Device challenge signatures bound to Account session, Vault, Device, and challenge;
- Account-plus-Recovery-Phrase enrollment with an exact envelope for every epoch;
- VaultDevice-scoped session issuance;
- public Device listing and current-Device identification; and
- active-Device removal with immediate API-session and transfer-ticket revocation.

## 4.9 First-Device and fresh-Device Runtime ceremonies

RED coverage introduced the missing two-step initial ceremony and recovered Device flow:

```text
tests/unit/initial-vault-attachment.test.ts
tests/unit/recovered-device-enrollment.test.ts
```

GREEN recovery/Device result: 4 test files, 9 tests passed.

Implemented:

- generated 12-word phrase reveal plus `.awsm-recovery` bytes;
- no network attach before a complete second phrase entry;
- atomic signed attach package and Device-session transition;
- explicit cancellation and wipe-on-success/failure/cancellation behavior;
- fresh-Device Recovery Kit decryption and all-epoch Device-envelope creation; and
- protected Device identity, epoch keys, Recovery Kit, and VaultDevice session persistence.

The extension Account signup entrypoint and Account key/envelope/slot cryptography were deleted.
The synchronization setup surface now links to Rails `/sign_up`, logs in, reveals/downloads/confirms
the phrase for first attach, and accepts two complete phrase entries for a fresh Device.

## 4.10 Canonical extension storage and regression gate

The IndexedDB graph was reset to `DATABASE_VERSION = 1` under the new `awsm-client` database name.
Account sessions contain identity credentials only; Device sessions, protected Device keys,
Recovery Kits, epoch keys, and synchronization state have distinct stores.

Verification:

```text
corepack pnpm --filter @awsm/browser-extension test
corepack pnpm --filter @awsm/browser-extension typecheck
```

Result: 82 test files and 388 Vitest tests passed; 29 release-workflow tests passed; TypeScript
typecheck passed.

The browser IndexedDB integration run initially exposed two stale hard-coded `account_vault` store
names. After replacing them with the sole canonical `vault_sync_state` store, the complete
Chromium-backed run passed all 45 scenarios.

## 4.11 Future-content protection and renewed Device authority

Rails request coverage now proves that the signed compare-and-swap Future Protection request
rotates the Recovery Generation and active key epoch atomically, retires the old Recovery Kit
ciphertext and epoch, removes the target with `FutureProtection`, deletes old-generation Device
envelopes, revokes every old Device session, and rejects stale authority or changed Device public
facts without mutation. Remaining Devices are validated as an exact set, independent of array
order.

`GET /api/vaults/{vaultId}/device-authority` returns only the authenticated Device's renewed
certificate and active-epoch envelope after Device proof. Cable tickets are bound to an active
VaultDevice session and stop working after revocation.

The extension now has separate persisted Account and VaultDevice session managers. Account login
can prove an existing Device signing key, fetch and validate renewed authority, unwrap the next
epoch, and atomically install the renewed certificate, epoch key, and Device refresh credential.
The Future Protection surface prepares without remote mutation, reveals a new 12-word phrase,
requires a new `.awsm-recovery` download and full phrase re-entry, submits one idempotent
compare-and-swap, reauthenticates the initiator, validates installed authority, and wipes transient
secret bytes. Ordinary other-Device removal and explicit current-Device removal are separate
warning and confirmation flows.

Verification:

```text
docker compose exec -T -e RAILS_ENV=test coordination-server bundle exec rspec
corepack pnpm --filter @awsm/browser-extension test
corepack pnpm --filter @awsm/browser-extension typecheck
```

Result: 79 Rails examples passed; 85 Vitest files and 392 tests passed; 29 release-workflow tests
passed; TypeScript typecheck passed.

## 4.12 Offline stale-epoch semantic replay

The upload boundary now refreshes public Vault authority before transferring local records. When
unpublished capture work names a retired epoch, the Runtime decrypts and validates the old capture
graph, streams each Artifact plaintext into a fresh active-epoch wrapper, creates fresh Bundle,
Object, Command, and Event identifiers, and verifies that plaintext length and checksum remain
unchanged.

One IndexedDB transaction replaces the reachable head and Library Projection with the replayed
graph. The old immutable records remain unreachable until normal Vacuum; a failure leaves the old
head intact and removes newly prepared Artifact files. Unsupported semantic Events stop with an
export-first synchronization conflict.

Verification:

```text
corepack pnpm --filter @awsm/browser-extension typecheck
corepack pnpm --filter @awsm/browser-extension lint
corepack pnpm --filter @awsm/browser-extension test
corepack pnpm --filter @awsm/browser-extension test:integration
```

Result: 86 Vitest files and 394 tests passed; 29 release-workflow tests passed; TypeScript
typecheck passed; all 46 Chromium-backed IndexedDB scenarios passed.

## 4.13 Full-replacement server staging and activation boundary

Request coverage now exercises a source VaultDevice staging a cryptographically independent
provisional Vault, completing its initial Generation without displacing the source, and activating
it through an exact source/head/Generation compare-and-swap. The activation transaction marks the
source `Replaced`, promotes exactly one replacement to `Active`, revokes every source Device and
session with `VaultReencrypted`, and schedules a dedicated `VaultReplacement` purge beginning at
`Detach` rather than Recovery Snapshot creation.

The replacement purge rechecks that the source remains replaced and that source records are not
referenced elsewhere. It deletes source bytes and authoritative record/Generation membership,
Recovery Kit ciphertext, Device envelopes, delivery state, and transfer authority while retaining
only sanitized purge progress and revoked public Device facts.

Verification:

```text
docker compose exec -T coordination-server env RAILS_ENV=test bundle exec rspec
docker compose exec -T coordination-server bin/rubocop \
  app/controllers/api/vaults_controller.rb \
  app/controllers/api/replacement_candidates_controller.rb \
  app/jobs/purge_generation_job.rb \
  app/services/coordination/vault_attachment.rb \
  spec/requests/plan15_initial_attach_spec.rb
corepack pnpm exec prettier --check docs/specifications/protocol/http-api.openapi.yaml
```

Result: all 80 Rails examples passed; RuboCop reported no offenses in the five affected Ruby
files; the OpenAPI contract is formatted.

## 4.14 Full-replacement trusted rewrite and Export gate

The production Export Job now records a successful replacement prerequisite only after immediate
package read-back, native download invocation, a final source-head compare, and confirmation that
coverage is `Complete`. The recorded evidence binds the exact Vault, Generation, Generation
number, and appended Object/Event tails. The replacement gate rejects stale, Selective, failed, or
unconfirmed Export evidence.

The trusted replacement rewriter now:

- traverses the exact active source Generation plus head closure;
- assigns fresh Vault, Bundle, Object, Artifact, Event, Command, Collection, Device, epoch, and
  Generation identities;
- preserves canonical Event order even when multiple Events share a timestamp;
- streams and checksum-validates Artifact plaintext into independent target-epoch wrappers;
- rewrites every reference in all canonical name, capture, lifecycle, move, merge, and merge-revert
  Event types;
- prepares a fresh initial Generation and target head;
- rebuilds source and replacement Projections through the production reducer; and
- compares the complete identifier-normalized user-visible models before accepting the rewrite.

Any failure removes newly prepared target Artifact files. The old Vault remains authoritative and
unchanged.

Verification:

```text
corepack pnpm --filter @awsm/browser-extension typecheck
corepack pnpm --filter @awsm/browser-extension test
corepack pnpm --filter @awsm/browser-extension test:integration
```

Result: 88 Vitest files and 396 tests passed; 29 release-workflow tests passed; TypeScript
typecheck passed; all 46 Chromium-backed IndexedDB scenarios passed.

## 4.15 Restart-safe replacement Job and authority preparation

The replacement repository now persists a strict source-fenced Job and an authenticated encrypted
checkpoint under a nonextractable local key. Checkpoints bind Job, source Vault, and replacement
Vault identities in AES-GCM additional data. Restart restores the checkpoint, stale compare-and-swap
writes fail, ciphertext tampering fails authentication, and terminal cleanup removes both
checkpoint ciphertext and its key. Recovery Phrase entropy is never part of this persistence
contract.

The trusted authority preparation creates fresh target Recovery, Device, and epoch-zero authority
from the independently prepared replacement Vault. Tests jointly verify the 12-word phrase,
Recovery Kit file, Device certificate, Account-session enrollment proof, Device key envelope,
full-phrase confirmation, wrong-phrase rejection, and mutable-secret wiping.

Verification:

```text
corepack pnpm --filter @awsm/browser-extension test:integration
corepack pnpm --filter @awsm/browser-extension typecheck
corepack pnpm --filter @awsm/browser-extension exec vitest run \
  tests/unit/replacement-authority.test.ts
```

Result: all 47 Chromium-backed IndexedDB scenarios passed; TypeScript typecheck passed; both
replacement-authority tests passed.

## 4.16 Provisional replacement graph and credential handoff

The server now permits the authenticated replacement Device to upload, commit, list, and download
the provisional replacement's encrypted graph after its initial Generation completes. This does
not promote the candidate: request coverage proves the source Vault and source head remain
authoritative throughout staging. The replacement becomes Active only through the existing exact
source Generation/head compare-and-swap.

The client replacement remote boundary creates the candidate under the source Device credential,
validates the returned Vault and replacement Device session, uploads the initial Generation in
bounded parts, switches to replacement Device authority, completes the provisional Vault, and
validates the activation and sanitized no-snapshot purge response. Changed server authority fails
closed.

Verification:

```text
docker compose exec -T coordination-server env RAILS_ENV=test bundle exec rspec \
  spec/requests/plan15_initial_attach_spec.rb \
  spec/requests/event_commits_spec.rb \
  spec/requests/replica_reads_spec.rb
docker compose exec -T coordination-server bundle exec rubocop \
  app/controllers/api/commits_controller.rb \
  app/controllers/api/records_controller.rb \
  spec/requests/plan15_initial_attach_spec.rb
corepack pnpm --filter @awsm/browser-extension typecheck
corepack pnpm --filter @awsm/browser-extension exec vitest run \
  tests/unit/replacement-authority.test.ts \
  tests/unit/replacement-remote.test.ts \
  tests/unit/replacement-rewrite.test.ts
```

Result: all 15 focused Rails examples passed; RuboCop reported no offenses in the three affected
Ruby files; TypeScript typecheck passed; all five focused replacement tests passed.

## 4.17 Hidden local staging and resumable graph upload

The rewritten replacement is now installed in one hidden IndexedDB transaction before remote
activation. The transaction fences the exact replacement Job and active source Workspace, rejects
every target-store collision, and installs target Vault records, immutable Objects and Events, and
rebuildable Projections without adding a Vault-directory entry, changing the active Workspace, or
changing Account synchronization registration. Restart can recover and validate this hidden
target. A pre-activation discard transaction removes only target-scoped staged records and normal
upload checkpoints; it cannot remove a visible or activated replacement.

Replacement graph transfer reuses the production bounded Object/Event uploader and its durable
per-record checkpoints. It starts from the hidden target, streams Artifact ciphertext from the
target namespace, commits every Event closure against the provisional Generation, verifies that
every target Object is durable and every target Event committed, and performs no network work when
restarted with completed checkpoints.

Verification:

```text
corepack pnpm --filter @awsm/browser-extension typecheck
corepack pnpm --filter @awsm/browser-extension test:integration
corepack pnpm --filter @awsm/browser-extension exec vitest run \
  tests/unit/replacement-upload.test.ts \
  tests/unit/replacement-remote.test.ts
```

Result: TypeScript typecheck passed; all 48 Chromium-backed IndexedDB scenarios passed; all three
focused replacement upload/remote tests passed. The hidden-stage scenario separately passed after
normal upload-checkpoint cleanup was added.

## 4.18 Atomic replacement promotion and source-local retirement

After remote activation, one IndexedDB transaction now verifies the exact source head, persisted
replacement Job, target Generation/head, target upload checkpoints, replacement Device identity,
active epoch, encrypted Vault-name Projection, and server-reported target cursor. It then:

- installs the replacement Device identity under nonextractable wrapping/session keys;
- stores the replacement refresh credential, epoch-zero key, Recovery Kit, and synchronization
  registration;
- makes the replacement the sole visible and active Workspace Vault;
- removes source Vault records, keys, Device/session authority, Recovery Kit, Projections, Jobs,
  checkpoints, and caches; and
- advances the replacement Job to source-purge tracking without deleting its sanitized purge ID.

The source Artifact namespace is reconciled to empty after the transaction. This cleanup is
idempotent and restartable without replacement secrets; sensitive mapping/checkpoint state is
removed only after Artifact cleanup succeeds. The Job becomes terminal only after the server
reports that its no-snapshot source purge succeeded.

Verification:

```text
corepack pnpm --filter @awsm/browser-extension typecheck
corepack pnpm --filter @awsm/browser-extension test:integration
corepack pnpm --filter @awsm/browser-extension exec vitest run \
  tests/unit/replacement-promotion.test.ts \
  tests/unit/replacement-remote.test.ts \
  tests/unit/replacement-upload.test.ts
```

Result: TypeScript typecheck passed; all 49 Chromium-backed IndexedDB scenarios passed; the focused
atomic replacement-promotion browser scenario passed after restart; all five focused promotion,
remote, and upload tests passed.

## 4.19 Restart-safe replacement authority and orchestration

The replacement ceremony now persists four distinct remote idempotency keys in the Job and seals
only post-confirmation authority in an authenticated local checkpoint. The checkpoint contains the
replacement root/Device authority, certificate, envelope, Recovery Kit, Account-session binding,
Device proof, and identifier map; it never contains the Recovery Phrase, phrase entropy, recovery
wrapping key, or recovery administrator seed. A mistyped phrase remains retryable in memory, while
source drift after correct confirmation terminally fails without exposing a target Vault.

The restart runner advances the persisted state machine through candidate creation, normal bounded
graph upload, independent remote-record validation, activation, atomic local promotion, and
source-purge monitoring. Candidate and activation retries reuse their exact persisted idempotency
keys. Local promotion deliberately erases the sensitive checkpoint; subsequent purge retries use
the installed replacement Device session instead of requiring deleted replacement secrets.
Interrupted pre-confirmation ceremonies can be cancelled after service-worker restart.

Verification:

```text
corepack pnpm --filter @awsm/browser-extension typecheck
corepack pnpm --filter @awsm/browser-extension exec vitest run \
  tests/unit/replacement-checkpoint.test.ts \
  tests/unit/replacement-service.test.ts \
  tests/unit/replacement-runner.test.ts \
  tests/unit/replacement-remote.test.ts \
  tests/unit/replacement-upload.test.ts \
  tests/unit/replacement-promotion.test.ts
```

Result: TypeScript typecheck passed; all 12 focused checkpoint, ceremony, runner, remote, upload,
and promotion tests passed.

## 4.20 Production background and cross-browser ceremony

The production background Runtime now owns replacement preparation, confirmation, restart,
retry, progress, and promotion. It requires the current synchronized Account/Vault authority,
complete locally available active closure, an idle mutation boundary, and the exact latest
verified Complete Export. Once preparation begins, ordinary synchronization and Vault mutations
are fenced so the exported source head remains authoritative. Service-worker startup resumes a
running Job before ordinary synchronization.

The Chrome and Firefox synchronization-setup page now exposes the maximum-security ceremony with
the required consequences, verified-Export safe-storage acknowledgement, replacement Recovery
Phrase and file download, exact phrase re-entry, interruption guidance, live progress, and manual
retry. App-state invalidations and focus/visibility reconciliation keep the page current. Rendered
desktop and narrow states were inspected for the preflight, phrase, and progress surfaces.

The replacement Device can now read the sanitized purge progress of the Replaced source Vault,
while normal Device/Vault scoping remains enforced. Both production browser builds pass their
manifest and static-security verifiers.

Verification:

```text
docker compose exec -T coordination-server env RAILS_ENV=test bundle exec rspec \
  spec/requests/plan15_initial_attach_spec.rb
docker compose exec -T coordination-server bundle exec rubocop \
  app/controllers/api/purges_controller.rb \
  spec/requests/plan15_initial_attach_spec.rb
corepack pnpm --filter @awsm/browser-extension build:chrome
corepack pnpm --filter @awsm/browser-extension build:firefox
corepack pnpm --filter @awsm/browser-extension exec biome check \
  entrypoints/sync-setup src/app/background.ts src/app/protocol.ts \
  src/runtime/recovery src/drivers/indexeddb/vault-replacement-repository.ts
```

Result: all five focused Rails request examples passed; RuboCop reported no offenses; Chrome and
Firefox production builds and static release checks passed; affected extension sources passed
Biome and TypeScript typecheck.

## 4.21 Canonical server switching, stale quarantine, and authenticated resumption

Server switching now keeps Account and VaultDevice authority distinct throughout candidate
comparison and promotion. A Device that is certified for the Vault but unknown to the candidate
server is enrolled there through its existing certificate, complete key-envelope set, and an
Account-session-bound Device enrollment proof before a candidate Device session is established.
Candidate Device credentials are persisted separately and promoted atomically with candidate
Account and Replica authority.

Generation transfer uses the full immutable closure after Vacuum instead of mistaking the active
head's appended tail for complete reachability. A `VAULT_GENERATION_SUPERSEDED` response records
the server's opaque successor Generation and cursor atomically with a `Conflict` Job. The client
then obtains and verifies the successor's predecessor identifier from current Vault authority,
quarantines the stale local Replica, and requires the existing export-first replacement ceremony.
It never retries stale history as an automatic merge. Account re-login refreshes Device authority
and resumes genuine authentication-blocked synchronization, while a Vacuum authentication failure
does not rewrite an already terminal synchronization checkpoint.

All packaged server-switch paths now create Accounts through Rails `/sign_up`; the extension
supports candidate login only. The browser tests and helpers use the sole canonical `awsm-client`
database and no longer create the discarded pre-release database.

Verification:

```text
corepack pnpm --filter @awsm/browser-extension typecheck
corepack pnpm --filter @awsm/browser-extension test
corepack pnpm --filter @awsm/browser-extension test:integration
corepack pnpm --filter @awsm/browser-extension test:e2e:chrome
corepack pnpm test:e2e:cross-browser
docker compose exec -T coordination-server env RAILS_ENV=test bundle exec rspec
docker compose exec -T coordination-server bundle exec rubocop
corepack pnpm test:e2e:coordination
corepack pnpm test:sync-proof
```

Result: TypeScript typecheck passed; all 95 extension unit files (414 tests) and 29 release checks
passed; extension lint passed without warnings; all 49 browser integration scenarios passed; all
23 packaged Chrome scenarios passed across the broad run and corrected focused rerun, including a
fresh rerun of the complete first-time journey. All eight Chrome/Firefox recovery and
synchronization scenarios passed. All 80 Rails examples passed and all 137 Rails files passed
RuboCop. Both coordination proof scripts passed.

# 5. Final Verification

Plan 15's implementation and proof matrix are complete. Rendered packaged-browser inspection
covered desktop and narrow candidate login and publish progress, authentication-required and
up-to-date synchronization, offline retry, stale conflict, and the export-first stale replacement
surface. The extension remains login-only, Rails owns Account creation, Account passwords never
derive Vault keys, and all Vault recovery, Device enrollment, revocation, and replacement
authority remains client-held and zero-knowledge to the Coordination Server.
