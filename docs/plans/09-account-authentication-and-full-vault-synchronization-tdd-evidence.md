# Account Authentication and Full Vault Synchronization TDD Evidence

**Document:** `docs/plans/09-account-authentication-and-full-vault-synchronization-tdd-evidence.md`
**Status:** Implementation evidence
**Owner:** Engineering
**Last Updated:** 2026-07-20
**Plan:** `docs/plans/09-account-authentication-and-full-vault-synchronization.md`

---

# Purpose

This record preserves RED → GREEN → REFACTOR evidence for Plan 09 and the final verification and
rendered-inspection audit. It does not weaken any Plan 09 acceptance criterion.

# TDD Evidence

## Account cryptography and persistence

**RED:** Account vector, substitution, normalization, envelope-binding, non-exportable key, restart,
logout, session rotation, replay, and one-Vault constraint tests were introduced before the Account
Runtime, IndexedDB stores, Rails models, and public resources existed.

**GREEN:** The client matches the committed Argon2id13, HKDF-SHA256, and XChaCha20-Poly1305 vectors;
the server stores only BCrypt/digest authentication material and opaque envelopes; IndexedDB stores
non-exportable wrapping keys and encrypted refresh/Account-key material.

**REFACTOR:** Account password derivation, wire encoding, HTTP transport, persistence, and session
refresh are separate Services. Logout erases Account secrets without deleting device-local Vault
authority.

## Server choice, login, and signup

**RED:** popup view/protocol and packaged-browser tests failed until first launch linked to a stable
extension-owned setup tab that retained hosted, self-hosted, or local-only choice across permission
prompts.

**GREEN:** the setup tab owns exact optional-origin permission, strict origin validation, redirect
rejection, compatible-server probing, signup, recovery acknowledgement, and existing/new Vault
choice. The popup makes local-only operation primary and synchronization setup secondary. A signup
whose address is unavailable offers an in-tab sign-in recovery without losing the selected server
or entered email. The popup retains login and capture actions.

**Browser RED discovered during black-box integration:** the packaged extension remained on
“Choose synchronization” with `STORAGE_TRANSACTION_FAILED`. Chrome had rejected
`permissions.request()` because the request crossed into the service worker after user activation
was lost.

**Browser GREEN:** the stable setup tab and Library settings request the exact validated origin
during their user gesture. The background Host independently confirms permission, probes with
redirects and credentials disabled, and commits only a compatible origin.

## Full Replica synchronization

**RED:** enrollment, discovery, upload-order, canonical pull, remote bootstrap, Cable, and
large-Artifact tests failed against absent Runtime Services and persisted Job/checkpoint stores.

**GREEN:** dependency-first upload, idempotent checkpoints, fixed change fences, canonical Event
replay, complete Vault Replica validation, polling, content-free Cable hints, and bounded streaming beyond
4 GiB were implemented.

**Browser RED discovered during black-box integration:** the first real packaged-client signup
failed before issuing `POST /api/accounts`; the Worker reported `TypeError: Failed to execute
'fetch' on 'WorkerGlobalScope': Illegal invocation`.

**Browser GREEN:** Account and synchronization HTTP clients invoke native fetch with
`WorkerGlobalScope` as receiver. `tests/unit/http-receiver.test.ts` preserves the regression, and
the packaged two-profile test signs up, logs in, bootstraps, and converges a rename through actual
Rails, PostgreSQL, opaque Disk storage, and extension IndexedDB.

## Synchronized Vacuum and stale discard

**RED:** server-first Vacuum ordering, persisted remote/local activation checkpoints, stale conflict,
export-first warnings, complete server staging, and atomic replacement tests failed against the prior
local-only Vacuum and absent stale-discard path.

**GREEN:** synchronized Vacuum journals its candidate before remote compare-and-swap, records the
remote cursor before local activation, and resumes after restart. Stale resolution recommends exact
Complete Export, requires explicit overwrite/skip confirmation, discards unpublished stale state,
and atomically installs the verified server Replica without creating another Vault.

**REFACTOR:** the stale-discard service reuses canonical Projection, Artifact, and Generation
validators without treating the result as Import or Restore. Browser IndexedDB failure injection
proves the replacement transaction rolls back as a unit and creates no additional Vault.

**Packaged-journey RED:** the cold first-use proof exposed a pull that could replace newer local
Projection state with an older server snapshot while a mutation wake was coalesced into an active
synchronization run.

**Packaged-journey GREEN:** same-Generation reconciliation now fences both the local Vault Head
observed by the pull and the requirement that the remote Head contains every locally appended Event
and Object. A mutation wake that arrives during an active run schedules one final upload pass. The
packaged journey then exercises signup, two captures, Collection extraction and cross-profile
merge, disconnected divergence, synchronized deletion and Vacuum, export-first stale resolution,
and explicit stale discard before server replacement. Complete Export-to-Import
portability remains in the dedicated package suite because packaged headless Chrome cannot complete
the native save-as dialog boundary.

**Packaged-journey follow-up RED:** repeated state reads created pull Jobs, direct Retry left a
server-superseded Generation behind a generic retry loop, Cable hints could race synchronized
Vacuum, and the first post-Vacuum pull reconstructed the active Generation without its predecessor
metadata. These defects appeared as status churn, a stale Replica that required an unnecessary
sign-out/sign-in cycle, an indefinitely busy Vacuum, and a false synchronization-integrity failure.

**Packaged-journey follow-up GREEN:** state reads are now pure and visible surfaces send an explicit
wake on entry, focus, visibility restoration, or connectivity restoration. A single coordinator
serializes and coalesces passive polls, interactive retries, mutation wakes, and Cable hints;
synchronized Vacuum fences that coordinator before its current-Replica check and remote activation.
Superseded-Generation Retry performs Account/Vault discovery directly, and same-Generation pulls
preserve the locally verified predecessor metadata. Focused unit and browser integration tests cover
the coordinator fence, retry protocol, local-Head reconciliation fence, retained local authority,
and post-Vacuum Generation reconstruction.

**Resilience-gap RED:** the packaged proof could not deterministically stop the Worker between
stale-discard checkpoints, authentication expiry during synchronized Vacuum was not exercised,
and changing servers did not wait for an active old-context pull to stop. A late response could
therefore outlive its configured server context, while restart behavior was inferred only from the
atomic activation test.

**Resilience-gap GREEN:** release-excluded fault checkpoints now pause every discard boundary and
inject Vacuum authentication expiry. Startup reconciliation is independently exercised through a
real IndexedDB close/reopen at `PrepareServerReplacement` and `ActivateServerReplacement`. Server
replacement aborts and awaits the coordinator, discards old wakes, signs
out, and then installs the new origin; pull reconciliation retains its local-Head and remote-coverage
fences. Unit tests cover cancellation/coalescing and every Vacuum authentication checkpoint, while
the release verifier rejects the test-control namespace from emitted JavaScript.

## Coordination Server switching follow-up

Plan 10 replaces Plan 09's immediate sign-out server-change flow. Candidate origin validation,
authentication, comparison, and failure now preserve the active source context. Promotion occurs
only after trusted Runtime reconciliation classifies and completes `PublishLocal`,
`FastForwardCandidate`, `FastForwardLocal`, or `Union`; divergent authenticated Generations produce
an explicit conflict without overwriting either authority. The decision record and current evidence
are owned by `docs/plans/10-git-like-synchronization-server-switching.md` and its TDD evidence.

## Server security and operations

**RED:** the credential-sentinel request spec initially exposed Account-key/ciphertext parameter
names not covered by filtering. An unknown login email also skipped BCrypt while a wrong secret for
an existing Account performed BCrypt, leaving a timing oracle.

**GREEN:** secret filtering covers password, authentication secret, tokens, Cable ticket, Account
key, envelope/ciphertext, and KDF salt families. Login performs exactly one BCrypt verification
against a real or synthetic digest and returns the same outcome. Cable tickets are one-use,
digest-only, Account-bound, TTL-limited, scrubbed from retained request URL state, and channel tests
reject another Account's Vault.

**CURRENT CANONICAL RECONCILIATION:** Plan 14 replaced the original PostgreSQL Cable-ticket rows and
cleanup with TTL-bound Redis digest keys plus atomic `GETDEL`, and replaced Solid Cable with Redis
Pub/Sub. This historical RED/GREEN record does not describe the current persistence adapter.

# Rendered Visual Inspection

The packaged-Chromium visual scenarios captured and the image-inspection tool viewed these Account
states:

- local-first server choice at 420×760 and 340×700;
- unavailable-Account recovery and in-tab sign-in at 720×900 and 360×760;
- login with visible Email focus at 420×760;
- signup resting/focused at 720×900 and narrow at 360×760;
- password-confirmation validation alert;
- disabled signup with visible synchronization progress;
- successful signup with credential form removed;
- Account/settings dialog at 1280×720 and 360×760; and
- typed local-device reset at wide and narrow widths, including disabled and enabled destructive
  action states and proof that IndexedDB and private filesystem storage are empty; and
- stale-Replica export-first dialog at desktop and narrow widths, confirmed overwrite, busy, and
  failure states.

Inspection findings:

- controls retain meaningful dimensions and visible focus;
- hosted-origin and warning copy wrap without horizontal clipping;
- signup spacing and input widths remain coherent at narrow width;
- validation, progress, and success use a stable prominent status region;
- the success form originally remained visible because author `display: grid` overrode `hidden`;
  `[hidden]` now removes it and the rerendered success state was inspected;
- the narrow settings dialog keeps viewport margins, wraps the synthetic email, and keeps checkbox
  and action geometry usable, with routine server controls preceding local reset; and
- stale-discard confirmation geometry, progress movement, error prominence, and modal margins were
  inspected after the viewport-width and checkbox-alignment corrections.

# Focused Green Commands

```text
corepack pnpm --filter @awsm/browser-extension exec vitest run tests/unit/http-receiver.test.ts
  1 file, 2 tests passed

corepack pnpm --filter @awsm/browser-extension exec vitest run tests/unit/synchronization-recovery.test.ts tests/unit/synchronization-recovery-reconciliation.test.ts
  2 files, 4 tests passed

corepack pnpm --filter @awsm/browser-extension exec playwright test tests/integration/indexeddb.browser.test.ts --project=chromium --grep 'stale Replica'
  1 test passed

corepack pnpm --filter @awsm/browser-extension exec playwright test tests/integration/indexeddb.browser.test.ts --project=chromium --grep 'synchronized Vacuum remote'
  1 test passed

corepack pnpm exec playwright test -c playwright.e2e.config.ts --grep 'converges two packaged'
  1 test passed

corepack pnpm exec playwright test -c playwright.e2e.config.ts --grep 'first-time self-hosted'
  1 packaged two-profile journey passed

corepack pnpm exec playwright test -c playwright.e2e.config.ts --grep 'renders Account onboarding'
  1 test passed; all generated screenshots inspected

docker compose exec -T -e RAILS_ENV=test -e AWSM_SYNTHETIC_ACCOUNT_SECRET=test-only-synthetic-account-secret coordination-server bundle exec rspec spec/requests/authentication_spec.rb spec/channels/vault_changes_channel_spec.rb
  10 examples, 0 failures
```

# Final Verification Matrix

The complete matrix is intentionally recorded only from the final current worktree:

| Command                                   | Final result            |
| ----------------------------------------- | ----------------------- |
| `corepack pnpm lint`                      | 175 files, no issues    |
| `corepack pnpm typecheck`                 | Passed                  |
| `corepack pnpm test`                      | 51 files, 206 passed    |
| `corepack pnpm test:integration`          | 33 passed               |
| `corepack pnpm test:e2e:chrome`           | 7 passed                |
| `corepack pnpm build`                     | Passed                  |
| `corepack pnpm test:sync-proof`           | Passed                  |
| Documentation Prettier check              | Passed                  |
| `git diff --check`                        | Passed                  |
| Coordination Server `bin/rubocop`         | 105 files, no offenses  |
| Coordination Server `bin/bundler-audit`   | No vulnerabilities      |
| Coordination Server `bin/importmap audit` | No vulnerable packages  |
| Coordination Server Brakeman              | No warnings             |
| Coordination Server RSpec                 | 43 examples, 0 failures |
| Coordination Server `bin/ci`              | Passed in 10.40s        |
