# Username Account and Devices Dashboard — TDD Evidence

**Document:** `docs/plans/20-username-account-and-devices-dashboard-tdd-evidence.md`

**Status:** Complete

**Owner:** Engineering

**Last Updated:** 2026-07-28

**Implements:** `docs/plans/20-username-account-and-devices-dashboard.md`

---

# 1. Purpose

This record captures the real test-driven implementation, rendered inspection, release proof, and
staging evidence for AWSM `0.2.0`. It begins before production-code changes. Entries are appended
as the work occurs; a command is recorded as passing only when its current output proves that
result.

# 2. Starting State

| Evidence                        | Observed state                                                          |
| ------------------------------- | ----------------------------------------------------------------------- |
| Branch                          | `main`                                                                  |
| Starting commit                 | `f8053b5` (`docs(release): close Firefox signing plan`)                 |
| Initial tracked/untracked scope | Plan 20 was the only worktree addition                                  |
| Compatibility                   | No compatibility, conversion, alias, fallback, or old-data preservation |
| Production                      | Frozen and out of scope                                                 |
| Staging                         | No inspection or mutation performed at implementation start             |
| Agent workflow                  | Single agent; no branch switch and no delegation                        |

# 3. Evidence Conventions

For each task, record:

1. the exact focused RED command and why its failure proves missing planned behavior;
2. the implementation scope;
3. the exact focused GREEN command;
4. the affected regression/refactor command;
5. any remaining failure without relabeling it as success; and
6. artifact paths and visual observations for user-visible work.

Timestamps are UTC. Test output containing credentials, user data, or confidential operational
values must not be copied into this record.

# 4. Baseline

On 2026-07-27, the first host-side baseline attempt could not start because no local PostgreSQL
socket existed. The repository's isolated Docker Compose development PostgreSQL and Redis services
were then started, and the untouched focused Rails baseline ran inside the repository development
image:

```bash
docker compose run --rm -e RAILS_ENV=test coordination-server \
  bash -lc 'bin/rails db:prepare && bundle exec rspec \
    spec/models/account_spec.rb \
    spec/requests/plan15_account_authentication_spec.rb'
```

Result: **8 examples, 0 failures**. This proves the pre-change email Account behavior was green
before Task 1 tests replaced its expectations.

# 5. Task 1 — Canonical Username Schema

## RED

Tests were changed first to require:

- normalized, private `username`;
- canonical username shape and normalized uniqueness;
- `Active` Account lifecycle state and `last_activity_at`;
- complete absence of the `email` column;
- coarse BrowserSession `client_family` and `last_activity_at`; and
- complete absence of BrowserSession IP/raw-user-agent columns.

The focused RED command and result are recorded immediately below after execution.

```bash
docker compose run --rm -e RAILS_ENV=test coordination-server \
  bash -lc 'bundle exec rspec \
    spec/models/account_spec.rb \
    spec/models/browser_session_spec.rb'
```

Result: **6 examples, 6 failures**. The failures were direct missing-contract evidence:
`Account` rejected the unknown `username` attribute, the schema still exposed `email`, and the
BrowserSession examples could not construct a canonical Account. No production code had been
changed before this run.

## GREEN

The sole canonical migration was replaced in place with:

- normalized `accounts.username`;
- `accounts.state`;
- `accounts.last_activity_at`;
- username uniqueness/normalization/length/shape/state database constraints;
- BrowserSession `client_family`;
- BrowserSession `last_activity_at`;
- the coarse-family constraint and activity index; and
- no email, IP-address, or raw-user-agent columns.

The Account and BrowserSession models now apply the same canonical validations. The clean migration
was proven against a newly created isolated local PostgreSQL database with `SCHEMA` pointed at a
nonexistent path so Rails could not preload the stale committed schema. The migrated database was
then used to regenerate `db/schema.rb`.

Focused GREEN:

```bash
docker compose run --rm -e RAILS_ENV=test \
  -e TEST_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/coordination_server_task1 \
  coordination-server \
  bash -lc 'unset DATABASE_URL; bundle exec rspec \
    spec/models/account_spec.rb \
    spec/models/browser_session_spec.rb'
```

Result before database-constraint examples were added: **6 examples, 0 failures**.

## Refactor and regression

Direct PostgreSQL-constraint examples were added after the first GREEN to ensure model-validation
bypass cannot persist a non-normalized username or unsupported browser family.

```bash
docker compose run --rm -e RAILS_ENV=test \
  -e TEST_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/coordination_server_task1 \
  coordination-server \
  bash -lc 'unset DATABASE_URL; bundle exec rspec \
    spec/models/account_spec.rb \
    spec/models/browser_session_spec.rb'
```

Result: **8 examples, 0 failures**.

# 6. Task 2 — Username Website Authentication

## RED

Focused request tests were added for username-only forms, permanent/privacy/no-reset copy,
normalized signup, coarse BrowserSession classification, ignored email identity, generic
unknown/wrong-password/Deleting outcomes, minimal session status, and filtered username/receipt
parameters.

```bash
docker compose run --rm -e RAILS_ENV=test \
  -e TEST_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/coordination_server_task1 \
  coordination-server \
  bash -lc 'unset DATABASE_URL; bundle exec rspec \
    spec/requests/plan20_username_authentication_spec.rb'
```

Result: **5 examples, 5 failures**. The failures showed the old email form, email strong
parameters, email error copy, unauthenticated username session status, and unfiltered
username/deletion receipt.

## GREEN

The website authentication boundary now uses normalized username only, rejects `Deleting`
Accounts generically, classifies only `Chrome`/`Firefox`/`Other`, persists no IP/raw user agent,
filters username and receipt parameters, and renders username-only forms/status/copy.

Focused GREEN:

```bash
docker compose run --rm -e RAILS_ENV=test \
  -e TEST_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/coordination_server_task1 \
  coordination-server \
  bash -lc 'unset DATABASE_URL; bundle exec rspec \
    spec/requests/plan20_username_authentication_spec.rb'
```

Result: **5 examples, 0 failures**.

# 7. Task 3 — API and Policy Contracts

## RED

The existing Account API and service-policy request tests were replaced with the canonical
username Account projection, exact inactivity deadline, public Account policy, authenticated
retention field, and invalid-environment coverage.

```bash
docker compose run --rm -e RAILS_ENV=test \
  -e TEST_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/coordination_server_task1 \
  coordination-server \
  bash -lc 'unset DATABASE_URL; bundle exec rspec \
    spec/requests/plan15_account_authentication_spec.rb \
    spec/requests/service_policy_spec.rb'
```

Result: **9 examples, 5 failures**. Failures proved the API rejected username, server information
lacked Account policy, service policy lacked inactivity configuration/serialization, and a
superseded Account-page assertion still expected email.

## GREEN

The API now accepts only canonical `username`, returns
`{accountId, username, inactiveDeletionAt}`, advertises the public and authenticated inactivity
policies, validates `AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS` in `1..36500`, and retains protocol
version `1`. OpenAPI owns the strict username and policy shapes.

```bash
docker compose run --rm -e RAILS_ENV=test \
  -e TEST_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/coordination_server_task1 \
  coordination-server \
  bash -lc 'unset DATABASE_URL; bundle exec rspec \
    spec/requests/plan15_account_authentication_spec.rb \
    spec/requests/service_policy_spec.rb \
    spec/contracts/openapi_spec.rb'
```

Result: **10 examples, 0 failures**.

# 8. Task 4 — Activity Lifecycle Fence

## RED

Focused service/request tests were added for the 24-hour conditional Account/BrowserSession touch,
Deleting-state failure, successful authenticated API activity, failed-authorization non-activity,
and Deleting-state rejection at credential issue/authenticate/refresh.

The first corrected RED command failed during load because `Coordination::AccountActivity` did not
exist. After implementing the shared service and authority checks, focused GREEN was:

```bash
docker compose run --rm -e RAILS_ENV=test \
  -e TEST_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/coordination_server_task1 \
  coordination-server \
  bash -lc 'unset DATABASE_URL; bundle exec rspec \
    spec/services/coordination/account_activity_spec.rb \
    spec/requests/plan20_account_activity_spec.rb \
    spec/requests/replica_reads_spec.rb \
    spec/requests/upload_transfers_spec.rb'
```

Result: **11 examples, 0 failures**. A full Rails run before the transfer-boundary correction found
2 failures because inherited after-actions had no ordinary authenticated principal on ticket-only
transfer routes. Ticket use now validates/touches its owning Active Account directly.

## GREEN

Every authenticated website and ordinary API mutation now obtains the owning Account lifecycle
lock and rechecks `Active` before entering its mutation transaction. BrowserSession creation,
transfer-ticket issue/use, Cable-ticket issue/use, and Action Cable subscription apply the same
fence at their authority boundaries. Focused post-authentication transition tests prove an Account
that has become `Deleting` cannot create a BrowserSession, invoke an API mutation, use a previously
issued transfer ticket, or consume a previously issued Cable ticket:

```text
plan20_account_activity + upload_transfers + cable_tickets:
12 examples, 0 failures
```

The complete Rails regression run after the lifecycle changes passed:

```text
136 examples, 0 failures
```

Lock-order concurrency coverage across the complete mutation-family audit remains required before
the final verification matrix is complete.

# 9. Task 5 — Dashboard Projections

## RED

Request tests were added first for the private/no-store single page, Overview facts and exact
deadline, Device-field allowlist, active/removed/empty semantics, absence of website Device
mutation and API-session listing, individual/current/cross-Account BrowserSession behavior, and
sign-out-all-others.

```bash
docker compose run --rm -e RAILS_ENV=test \
  -e TEST_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/coordination_server_task1 \
  coordination-server \
  bash -lc 'unset DATABASE_URL; bundle exec rspec \
    spec/requests/plan20_account_dashboard_spec.rb'
```

Result: **5 examples, 5 failures**. The old minimal page lacked no-store, dashboard projections,
and all BrowserSession routes.

## GREEN

The dashboard now renders one responsive server-side page with the planned sections, allowlisted
Device projection, coarse/current website sessions, individual/all-other revocation, exact
inactivity deadline, serious security copy, and no API-session or Device-mutation control.

Focused result: **5 examples, 0 failures**.

# 10. Task 6 — Security and Deletion UI

## RED

Request tests were added first for precise confirmation copy, no Export gate, password plus typed
username validation, atomic Account freeze/session/ticket revocation, digest-only receipt storage,
receipt cookie, and minimal no-store status authorization. The RED result follows after execution.

## GREEN

After implementing the confirmation route, atomic lifecycle fence, digest-only receipt cookie, and
minimal status projection:

```text
4 examples, 0 failures
```

# 11. Task 7 — Verified Deletion Worker

## RED

The worker specification was written before its implementation. The focused suite failed while
loading because `Coordination::AccountDeletionWorker` did not exist:

```text
0 examples, 0 failures, 1 error occurred outside of examples
NameError: uninitialized constant Coordination::AccountDeletionWorker
```

## GREEN

After adding provider-neutral verified storage deletion, bounded key batching, restart-safe
per-reference completion, explicit dependency-first relational deletion, retry outcomes, and final
identity release:

```text
6 examples, 0 failures
```

The focused proof covers an empty Account, a synchronized Account with an unfinished upload,
external object and part bytes, already-missing idempotence, storage failure, failed absence
verification, cross-Account isolation, receipt expiry, and username/Vault-ID reservation through
verified completion.

# 12. Task 8 — Inactivity Reaping

## RED

The dispatcher specification was written before implementation. The focused suite failed while
loading because `DispatchAccountDeletionsJob` did not exist:

```text
0 examples, 0 failures, 1 error occurred outside of examples
NameError: uninitialized constant DispatchAccountDeletionsJob
```

## GREEN

After implementing lock-and-recheck inactivity acceptance, bounded due-Account dispatch, stranded
job redrive, expired receipt cleanup, and the hourly production schedule, the combined deletion
boundary passed:

```text
14 examples, 0 failures
```

This combined proof includes the four inactivity-dispatch examples, four manual acceptance/status
examples, and six verified worker examples.

# 13. Task 9 — Extension Username Replacement

## RED

The existing extension Account fixtures, HTTP projections, setup/login forms, settings state, and
server-selection tests still required the discarded email Account field. Replacing those
expectations first produced focused failures at each stale boundary before the implementation was
changed to the username-only contract.

## GREEN

The extension Account HTTP, Runtime, IndexedDB, setup/login, settings, synchronization, and test
fixtures now use `username` and `inactiveDeletionAt`. No email alias or alternate decoder was
added. The repository-wide stale-contract audit, rendered extension proof, and complete release
matrix are recorded in Sections 17–19.

Current regression evidence:

```text
browser-extension unit/release suite: 124 files passed, 1 skipped;
516 tests passed, 2 skipped
browser-extension typecheck: passed
```

# 14. Task 10 — Detachment Preflight and Atomic Transition

## RED

The first browser-backed matrix failed before reaching the transition because the proof fixture
pulled an unbundled phrase dependency into the raw browser harness. After the fixture was reduced
to supported cryptographic primitives, failure injection exposed a production defect: both
authority loaders treated the retained shared wrapping key as proof that their respective
authority record must exist. A correctly rolled-back detachment and a correctly committed
detachment could therefore be misclassified as partial state.

## GREEN

The strict `StopUsingSynchronizationServer` command, local completeness refusal,
offline transition, protected detached authority, Account/server cleanup, and live AppState
invalidation exist. Cryptographic detached-authority loading now verifies the Device certificate,
unwraps every retained epoch, opens every Device envelope, and requires envelope/root-key equality.

The authority loaders now use the presence of their own authority record as the discriminator and
require the shared wrapping key only when that record exists. The Chromium integration matrix
injects failure at every `put`, `delete`, and `clear` in both detachment and reattachment, closes
and reopens IndexedDB, and proves that only a complete bound state or complete detached state
survives:

```bash
corepack pnpm --filter @awsm/browser-extension exec tsc \
  -p tests/integration/tsconfig.json
LD_LIBRARY_PATH=apps/browser-extension/.output/browser-libs \
  corepack pnpm --filter @awsm/browser-extension exec playwright test \
  tests/integration/indexeddb.browser.test.ts --project=chromium \
  --grep 'detachment and reattachment atomic'
```

Result: **1 passed**.

A packaged Chromium E2E then created a real Account and synchronized Vault against the isolated
local Rails stack, opened two Library surfaces, switched the entire browser context offline,
recorded every request whose URL matched the configured server, and invoked
`StopUsingSynchronizationServer`. Both already-open surfaces changed visibly from
`Synchronization: Up to date` to `Synchronization: Local only` without reload. The active local
Vault remained selected, configuration became `LocalOnly`, synchronization state became
`LocalOnly`, and the recorded server-request list remained empty:

```bash
AWSM_EXTENSION_BUILD=.output/chrome-mv3-e2e \
  LD_LIBRARY_PATH=.output/browser-libs \
  corepack pnpm --filter @awsm/browser-extension exec playwright test \
  -c playwright.e2e.config.ts \
  --grep 'detaches a complete synchronized Vault while offline'
```

The same packaged journey now also captures one real page before detachment, returns to the
original Account using username/password and the retained Device proof without a Recovery Phrase,
detaches again, attaches to a different empty Account on the second isolated Rails server, waits
for complete upload, and requires the destination Library projection to equal the original
one-Capture history.

The first same-Account attempt exposed that the fresh Device-session credential was established
successfully but the subsequent authority GET tried to construct a persisted session manager
before that new session had been committed. Authority refresh now passes the fresh access token
explicitly through both authenticated authority reads and persists it only with the atomic restored
binding.

Result after adding offline, two-surface, original-Account, different-Account, and history-parity
assertions: **1 passed**.

This run first exposed that the strict extension server-information decoder had not adopted the
canonical `accountPolicy.inactiveRetentionDays` field already emitted by Rails. The decoder and
its malformed-policy tests were corrected; focused server-selection evidence is **20 tests
passed**.

The packaged journey now also captures the confirmation and completed local-only states at
`1280x900` and `390x844`. Direct inspection confirmed that the serious copy, disabled destructive
action, acknowledgement control, dialog margins, wrapping, status transition, retained Capture,
and local-only storage guidance remain visible and unclipped. The first resized narrow completion
capture retained the desktop-open navigation drawer; the proof now closes that responsive drawer
before capture and was rerun successfully.

# 15. Task 11 — Complete-Authority Attachment

## RED

Focused request tests initially failed against the single `keyEpoch` and
`deviceKeyEnvelope` attachment contract. The canonical request and OpenAPI contract were then
replaced in place; the discarded shape is now a tested `REQUEST_INVALID`.

## GREEN

Focused GREEN:

```text
Plan 15 initial attachment request suite: 8 examples, 0 failures
focused extension attachment/server-switch/reattachment unit tests: passing
full Rails suite: 136 examples, 0 failures
browser-extension typecheck: passed
```

The server now accepts only nonempty contiguous `keyEpochs`, the final
`activeKeyEpochId`, and exactly one `deviceKeyEnvelope` per epoch; a real two-epoch request proves
both epochs and envelopes persist while the Generation uses the final epoch. Ordinary attachment,
replacement publication, and Server Switch publication emit only this array contract.

Detached attachment now:

- loads and validates the complete protected authority;
- derives restart-stable Account/Vault-scoped idempotency keys;
- publishes the complete epoch/envelope set and current encrypted Generation;
- commits the destination Device session and binding only after remote activation;
- deletes detached authority in the same IndexedDB transaction that installs the bound authority;
  and
- supports a remembered-password return to the original Account through the existing Device proof
  without requiring the Recovery Phrase.

The browser-backed failure/restart matrix proves destination-promotion failure preserves the
complete detached authority and successful promotion removes it atomically with the destination
binding. The packaged E2E above proves complete encrypted-history upload/readability parity plus
same-Account and different-Account journeys using the real Rails protocol.

Task 11 implementation and behavioral proof are GREEN. Its user-visible states remain part of the
Task 12 rendered inspection and complete release matrix.

# 16. Task 12 — Documentation, Design, Release, and Rollout

## RED

The task-level RED evidence is recorded in Sections 13–15 and the broad-gate defect discoveries in
Section 17. Release preparation additionally found nondeterministic Chrome ZIP metadata before any
candidate was pushed or submitted, and staging inspection found stale public cache bodies before
any cache mutation.

## GREEN

All source, documentation, design, unsigned browser, signed browser, release, exact-tag staging,
cache-invalidation, and rendered public requirements are GREEN as recorded in Sections 17–20.

# 17. Full Verification Matrix

In progress. Current broad-gate evidence:

```text
Rails RSpec: 140 examples, 0 failures
RuboCop: 155 files inspected, no offenses
Brakeman: 0 errors, 0 security warnings
design:check and browser-extension lint: passed
browser-extension typecheck: passed
browser-extension unit/release suite: 124 files passed, 1 skipped;
  516 tests passed, 2 skipped
Chromium IndexedDB integration: 59 passed, 1 skipped
Chrome and Firefox production builds/static release validation: passed
Chrome and Firefox 0.2.0 archive creation/validation: passed
two-replica synchronization proof: passed
Coordination Server Redis-loss/recovery E2E: passed
```

The two heavyweight proof harnesses initially still used the discarded email Account field. After
their signup/login contract was replaced with `username`, the synchronization proof reached a
second stale fixture: its authority helper still emitted singular `keyEpoch` and
`deviceKeyEnvelope` fields. The helper now emits only complete `keyEpochs`,
`activeKeyEpochId`, and `deviceKeyEnvelopes`; both heavyweight proofs pass.

After the final `0.2.0` source preparation, the complete packaged Chrome lane passed **24/24**
serial scenarios in 12.0 minutes. Its first run exposed a test race after undo: visible card text
could satisfy assertions before the undo handler's awaited reconciliation completed, allowing the
next click to target a card that was being replaced. The journey now waits for the canonical
`Library change undone` live-region completion signal. The focused scenario passed **1/1**, then
the complete lane passed. The unsigned Firefox production and E2E builds passed
synchronization-permission, Capture, listing, and MHTML behavior on both repository-pinned Stable
and ESR (**4/4** in each build).

The first unsigned cross-browser run exposed two independent issues:

- a stale Future Protection loser could validate its now-stale epoch ordinal before recognizing
  that recovery authority had changed, producing `DEVICE_ENROLLMENT_INVALID`; and
- the disposable browser-proof Rails stack used the test `AsyncAdapter`, which accepted the
  replacement purge Job but never started a worker, leaving a valid purge at `Pending/Detach`.

Future Protection now checks the expected recovery and epoch authority before mutable ordinal
validation and still rechecks under the existing lock. Disposable behavioral proof stacks now use
the deterministic inline test adapter; production remains on Solid Queue, while focused worker
specs own retry, restart, storage-failure, and idempotency resilience. Focused regression runs
passed, and the final `0.2.0` cross-browser rerun passed **8/8** scenarios in 7.5 minutes.

The final complete rendered design lane passed **7/7** after updating and directly inspecting the
intentional Library status-row baselines.

The final two-replica proof initially timed out with its purge permanently at
`Pending/Snapshot`, retry count zero. Added bounded diagnostic state proved the test
`AsyncAdapter` accepted the Job but never ran it, matching the defect already found in the browser
proof stack. The standalone synchronization proof now also uses the deterministic inline test
adapter for behavioral execution. Production remains on Solid Queue; focused job specs prove
retry, restart, storage-failure, and idempotency behavior. The rerun passed and printed its
two-Replica convergence, remote-only restoration, Generation recovery, and verified-purge
completion. The final Coordination Server Redis-loss/recovery proof also passed.

The canonical migration was then rerun with `set -e` against a genuinely empty, isolated
`awsm-plan20-clean-db` PostgreSQL project. `db:prepare` succeeded; the migrated schema exposed
`username` and no `email`; migration version `20260719000000` was current; the OpenAPI contract
example passed **1/1**; and the temporary containers, network, and volumes were removed through the
cleanup trap. The production Coordination Server image also built successfully from
`apps/coordination-server/Dockerfile` as `awsm-plan20-production-check:local`.

The immutable candidate, signed Firefox proof, joint Release, and exact-tag staging verification
are recorded below.

# 18. Rendered and Accessibility Evidence

The Rails design lane now covers the complete Account dashboard and permanent-deletion
confirmation at `1280x900` and `390x844`. Every state passed the repository contrast audit and the
focused rendered lane:

```bash
LD_LIBRARY_PATH=.output/browser-libs \
  corepack pnpm --filter @awsm/browser-extension exec playwright test \
  -c tests/design/playwright.config.ts \
  tests/design/rails.design.e2e.test.ts \
  --grep 'trust, Account'
```

Result: **1 passed**.

The four screenshots were inspected directly for spacing, wrapping, hierarchy, destructive-action
prominence, narrow-layout flow, clipping, and overflow:

- `account-linux.png`;
- `account-narrow-linux.png`;
- `account-deletion-linux.png`; and
- `account-deletion-narrow-linux.png`.

Inspection found that the destructive submit inherited the generic yellow hover background and a
form selector weakened its danger background at rest. The shared danger-button hover/active state
and Rails form override were corrected, the lane passed again, and desktop/narrow screenshots were
re-inspected with a stable dark-red destructive control.

Rendered extension detachment confirmation and post-detachment states have now been inspected at
primary and narrow widths as described in Task 10. The full design regression passed **7/7** with
the repository contrast audit.

The real packaged storage-relief journey additionally evicted verified local Artifact bytes,
proved the resulting Artifacts were remote-only, attempted synchronization-server detachment, and
rendered the exact required refusal at desktop and narrow widths. Its first clean narrow capture
exposed that the action row stopped receiving its responsive stacking rule after the refusal was
appended, causing focus to horizontally scroll the dialog content off-canvas. The detachment action
row now uses the existing responsive server-action composition, and the test waits for the narrow
sidebar transition before capture. The focused packaged journey passed **1/1** in 1.4 minutes.
Direct inspection of `detachment-remote-only-refusal-desktop.png` and
`detachment-remote-only-refusal-narrow.png` confirms the title, serious explanatory copy,
acknowledgment, actions, and refusal remain fully visible without clipping or horizontal overflow.

# 19. Release Evidence

The first exact `0.2.0` packaging reproducibility check deliberately built and archived the
candidate twice. Firefox runtime and source ZIPs matched, but the Chrome ZIP differed at byte 11
because WXT preserved changing ZIP metadata. No candidate was pushed or submitted to AMO.

Runtime archive creation is now owned by one shared deterministic writer used for both Chrome and
Firefox. It sorts paths, ignores source filesystem timestamps, applies one canonical ZIP timestamp,
disables extended timestamps, and writes a fixed compression level. A focused regression constructs
the same tree in different creation orders with different source mtimes and proves byte equality.
The full package command was then run once with `TZ=UTC` and once with
`TZ=Pacific/Honolulu`; `cmp` proved the Chrome runtime, Firefox runtime, and Firefox source ZIPs
were byte-identical across both runs. Their current SHA-256 values are local build evidence only
and are intentionally not retained here because publication must independently bind checksums to
the immutable candidate commit.

The immutable candidate was committed as
`96b7204c6f0457e80ae94c36544390969f989b7b` and pushed to the authorized working fork's `main`
branch. A fetch proved local `HEAD` and `origin/main` resolved to that same full commit.

Before signing, the remote `v0.2.0` tag and Release were absent,
`FIREFOX_AMO_SIGNING_ENABLED` was exactly `true`, and both required AMO secret names were present
without inspecting their values. Candidate workflow run
[`30295953624`](https://github.com/mashuproject/awsm_bak/actions/runs/30295953624) was manually
dispatched on the exact commit. Its build, deterministic packaging, AMO submission, signed-XPI
validation, provenance creation, and run-scoped candidate upload passed.

The package-owned signed-candidate verifier was then run with explicit run ID `30295953624`. It
reproduced and compared the unsigned runtime and source archives, validated the Mozilla-signed
XPI, passed repository-pinned Firefox Stable and ESR production checks **4/4**, and passed the
complete signed Chrome/Firefox synchronization suite **8/8** in 9.2 minutes. It wrote successful
commit status `awsm/firefox-signed-local-proof` on the exact candidate; the status target is the
same candidate workflow run.

Annotated tag `v0.2.0` was created on the proven commit and pushed without moving another tag.
Publication workflow run
[`30297314122`](https://github.com/mashuproject/awsm_bak/actions/runs/30297314122) resolved the
local proof, downloaded the exact run-scoped candidate, revalidated provenance, and published one
joint non-draft, non-prerelease
[`v0.2.0` Release](https://github.com/mashuproject/awsm_bak/releases/tag/v0.2.0). The publisher did
not contact AMO again.

Independent verification downloaded all four public assets into a fresh temporary directory:

- `awsm-chrome-v0.2.0.zip`;
- its `.sha256` file;
- `awsm-firefox-v0.2.0.xpi`; and
- its `.sha256` file.

Both published checksums passed, both archives passed integrity checks, both root manifests report
`0.2.0`, and the XPI contains Mozilla signature entries.

# 20. Staging Evidence

Read-only inspection preceded every mutation. It proved:

- the reference staging Compose, source, database volume, opaque-storage volume, container
  network, and loopback origin were resolved explicitly;
- the application connected to the inspected staging PostgreSQL instance, proven by matching its
  live postmaster/database marker from both sides;
- staging database and opaque-storage resources were unused by production;
- staging and production source, Compose, container-network, database, and opaque-storage
  resources did not overlap;
- all staging containers carried the staging project label;
- the origin was bound only to loopback;
- origin liveness and readiness both returned 200;
- the environment file existed without being read; and
- every rollout command selected the staging project and Compose file explicitly.

The prior staging source and application image were preserved under timestamped rollback names.
An archive made from exact tag `v0.2.0` was transferred and verified by SHA-256 before extraction.
Only the resolved staging application and PostgreSQL containers were stopped and removed. The
isolated staging PostgreSQL and opaque-storage volumes were deleted. The existing Redis container
remained running with the same container identity; environment configuration, ingress, shared
connector, and production were not changed.

A fresh staging PostgreSQL volume was created. The application image was rebuilt from the exact
tag source, the canonical migration `20260719000000` was applied, and migration status reported it
`up`. The staging application was recreated from the new image. All three staging services then
ran, while origin liveness and readiness returned 200. A deterministic tree digest of the installed
source exactly matched a fresh extraction of the verified tag archive, the running container used
the newly built Compose image, and the deployed extension version reported `0.2.0`.

A temporary, untracked Playwright harness exercised the deployed HTTPS service with synthetic
Accounts and the packaged `0.2.0` extension. Live results:

- username-only signup and login passed with no email input;
- the dashboard rendered the exact inactivity-deletion date;
- Chrome and Firefox website sessions were projected coarsely;
- sign-out-all-others invalidated the other browser session;
- password change invalidated every website session;
- the empty Account deletion status page reached `Succeeded`;
- the deleted username was immediately reusable for a new Account;
- a synchronized Vault and active Chrome Device appeared on the dashboard;
- two open extension surfaces transitioned from `Up to date` to `Local only`;
- offline detachment emitted no request to the abandoned server;
- remembered-password login safely reattached the same local Vault and returned to `Up to date`;
  and
- synchronized Account deletion reached `Succeeded`.

Primary and `390x844` dashboard renders were inspected for both empty and active-Device states.
All content remained readable and contained, navigation and metadata wrapped cleanly, session
controls remained usable, the current-session marker stayed distinct, and the danger zone retained
clear but proportionate prominence. The temporary harness was removed. All failed-run synthetic
Accounts were subsequently reaped through the queued inactivity-deletion pipeline; aggregate
verification found zero synthetic Accounts, zero Accounts stuck `Deleting`, and zero retryable
deletion Jobs.

Public read-only cache inspection found that three of the four cacheable public pages returned old
`HIT` bodies rather than the current origin bodies. Dynamic Account pages and the authenticated
journeys reached the new origin.

After receiving separate authorization for only the four exact staging URLs, the pinned Cloudflare
CLI verified the exact active staging zone and accepted the dry run. Its OAuth profile lacked the
Cache Purge permission. A narrowly scoped API token successfully performed the filtered zone read,
but the CLI's live purge transport failed twice without changing cache state. The same token and
exact four-file body then succeeded through Cloudflare's official purge API.

The successful API response did not prove invalidation. Three successive identity requests and
three successive browser-compression requests per URL continued to return approximately
46,000-second-old `HIT` bodies for `/`, `/privacy`, and `/glossary`. `/security` returned the
current origin body, but its existing cache age also did not reset. Exact-URL invalidation was
therefore proven insufficient for the current edge state.

After separate explicit authorization, the hostname-only body
`{"hosts":["awsm.parasquid.dev"]}` passed the pinned CLI dry run and was accepted by Cloudflare's
official API. No prefix, whole-zone, production, ingress, tunnel, or service mutation was
performed. Verification then made three successive requests per canonical URL for both
`Accept-Encoding: identity` and `gzip, deflate, br, zstd`. All 24 responses returned status 200,
declared `Vary: accept-encoding`, exactly matched the current loopback origin body, and showed
fresh cache behavior: the first canonical identity request was a `MISS`, followed by low-age
`HIT` responses; browser-compression requests also returned only low-age current `HIT` bodies.

All four current public pages were then rendered through Firefox at `1280x900` and `390x844` and
inspected directly. The desktop and narrow layouts were readable and unclipped, long headings and
glossary terms wrapped cleanly, the narrow navigation collapsed to its intended Menu control, and
the public-preview banner remained visible without obscuring content.

# 21. Completion Audit

Every source, test, release, signed-browser, exact-tag deployment, origin-health, authenticated
journey, cache transition, public render, and rendered Account/Device requirement is proven above.
Production, the frozen upstream repository, shared ingress, and unauthorized cache state were not
changed. Plan 20 is complete.
