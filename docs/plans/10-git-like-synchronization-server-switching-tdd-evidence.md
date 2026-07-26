# Git-Like Synchronization Server Switching TDD Evidence

> **Historical notice:** Plan 15 supersedes the Account-key and candidate-signup assumptions
> evidenced here. See
> [Plan 15](15-rails-account-recovery-phrase-device-sync.md) and its evidence for the canonical
> implementation.

**Document:** `docs/plans/10-git-like-synchronization-server-switching-tdd-evidence.md`

**Status:** Implementation evidence

**Owner:** Engineering

**Last Updated:** 2026-07-20

**Plan:** `docs/plans/10-git-like-synchronization-server-switching.md`

---

# Purpose

This record preserves RED → GREEN evidence for Plan 10. It records defects found by progressively
stronger unit, IndexedDB, request, and packaged-browser proofs; it does not weaken the plan's
acceptance criteria.

# Runtime classification and candidate isolation

**RED:** pure classifier tests initially had no model for an empty candidate, equal Generation
append tails, direct authenticated predecessor bases, unavailable Recovery, sibling successors,
immutable-byte mismatch, Vault mismatch, or Root Key mismatch.

**GREEN:** the trusted Runtime authenticates complete local, candidate, and Recovery closures before
classifying `PublishLocal`, `Union`, `FastForwardCandidate`, or `FastForwardLocal`. Unprovable or
divergent Generation history conflicts; Vault and integrity mismatches remain distinct terminal
failures. Candidate credentials, registration, checkpoints, transport, and session remain scoped
away from the active source context until promotion.

# Restart safety and atomic promotion

**RED:** browser write-failure injection found that a synchronous IndexedDB store exception escaped
without explicitly aborting the promotion transaction. Queued writes could therefore commit a
partial Account/Replica promotion.

**GREEN:** promotion explicitly aborts on every synchronous or asynchronous failure. Injection at
every Account, configuration, registration, head, Event, Object, Projection, name, and Job write
proves complete rollback.

**RED:** termination and lock/resume tests exposed two restart defects. Replaying an already staged
Artifact wrapper was treated as a collision, and Lock left an aborted Server Switch controller
installed so Unlock reused its aborted signal.

**GREEN:** exact encrypted wrapper size and SHA-256 replay is idempotent while partial or mismatched
preparation is replaced. Lock discards the controller and plaintext context; Unlock reauthenticates,
recompares canonical state, and resumes the persisted stage. Worker termination after remote
activation and before local activation converges without duplicate attachment or Generation.

Browser integration closes and reopens IndexedDB at every persistent Job state/stage pair. The local
application path now journals `ActivateLocal` before its fault boundary; startup routes repeated
termination there back through verified preparation and the atomic promotion transaction.

# Authentication and live surfaces

**RED:** candidate expiry after remote activation restarted from the comparison entry path, and
direct background Job writes failed to invalidate already-open Settings surfaces. Canonical failure
state existed in IndexedDB while the visible dialog remained stale.

**GREEN:** candidate metadata identity survives secret erasure, reauthentication requires the same
candidate Account, and every persistent stage resumes its own reconciliation path. All Server Switch
Job writes publish the canonical invalidation wake; open surfaces refetch and display authentication,
progress, lock, conflict, failure, and promotion changes without reload.

# Packaged bug-hunting discoveries

**RED:** a headless Chrome screenshot Host could remain pending forever, preventing a Capture and
therefore an entire synchronization journey from reaching a terminal state.

**GREEN:** every screenshot Host operation is bounded and restoration still runs. The packaged
harness reports terminal Capture failure promptly and retries only the known pre-authority
`PAGE_SNAPSHOT_FAILED` condition once.

**RED:** the richer union baseline distributed Captures across Collections, exposing a harness wait
that looked for one rendered group containing the global Capture count.

**GREEN:** Capture completion waits on canonical `ListLibrary` total authority while rendered-state
tests retain separate visibility assertions.

**RED:** independent Collection operations raced an in-flight pull. Atomic reconciliation correctly
raised `VAULT_CONTEXT_CHANGED`, but background error mapping converted that safe optimistic race to
`Offline` with exponential backoff.

**GREEN:** `VAULT_CONTEXT_CHANGED` completes the stale pull Job and immediately queues a fresh
mutation pass through the serialized synchronization coordinator. The union journey converges four
active Captures and four Collections in a fresh candidate browser.

**RED:** after successful Server Switch publication and Vacuum, the first new source mutation
replayed Events retained into the successor Generation. The server compared the successor request
bytes to the original predecessor commit request and returned `OBJECT_ID_CONFLICT`, leaving source
synchronization offline after a later Server Switch conflict.

**GREEN:** committing an exact immutable Event closure that is already a member of the requested
active Generation is an idempotent acknowledgement. It does not create another Event commit or
Delivery Cursor; changed dependencies and nonmember closures still conflict. The divergent-
Generation journey now performs a new source Capture after conflict and remains `UpToDate`.

**RED:** a same-Generation Union could accept one new candidate Event and then observe an independent
candidate Vacuum. The Job did not journal the accepted Event until the complete remote transfer
finished, and the later Generation change was misclassified as an integrity failure. That could
permit a read-only retry claim after a write or leave the truthful concurrent-conflict presentation
unreachable.

**GREEN:** the first commit response whose Delivery Cursor proves new authority journals
`candidateAuthorityChanged` before the local Event checkpoint becomes `Committed`. One head race is
reclassified only before that boundary. A later candidate Generation rewrite terminates as a
sanitized conflict, retains the source context, and explicitly says that verified append-only
history reached the candidate and neither Vault was overwritten. The real two-server race journey
renders desktop and narrow evidence and completes a later source Capture.

**RED:** candidate permission rejection, probe transport failure, and probe timeout could escape as
host exceptions instead of stable public server-selection errors.

**GREEN:** permission failures map to `SERVER_PERMISSION_DENIED`; bounded probe failures and malformed
server information map to `SERVER_INCOMPATIBLE`; no candidate Job or credentials are written.

**RED:** the long first-time stale-Replica journey retained a locator for a Settings dialog that live
invalidation had replaced, then attempted the page-level recovery action through the modal.

**GREEN:** the journey waits on canonical Conflict state, resolves the current Settings dialog,
closes it through its visible control, and then exercises the unobstructed recovery action.

**RED:** the complete packaged suite found that Vacuum could retain a `CollectionsMerged` Event while
reclaiming the deleted Capture descriptor named by that Event's dependency list. The candidate
Generation therefore passed local logical replay but failed the Coordination Server's complete
dependency-closure seal with `GENERATION_REACHABILITY_INVALID`.

**GREEN:** Vacuum rewrites a retained management Event whenever its dependency Object is reclaimed,
anchors the replacement to a retained Capture descriptor, and remaps `CollectionMergeReverted` when
its named merge Event was rewritten. The first-time journey now proves the merge-then-delete shape
through synchronized Vacuum and later Server Switch publication.

**RED:** a neighboring packaged Capture test used a fixed sleep and assumed MHTML acquisition could
not reach its documented recoverable pre-authority failure, leaving the test waiting for success
after the UI had correctly rendered `PAGE_SNAPSHOT_FAILED`.

**GREEN:** the test waits on canonical rendered success or the bounded recoverable failure and uses
the visible retry control once. No timeout was increased to conceal a terminal state.

# Packaged journey evidence

`tests/e2e/server-switch.e2e.test.ts` contains exactly five independent one-worker journeys:

1. empty candidate publication while an independent source observer stays live;
2. candidate-behind direct fast-forward with Worker termination after remote activation;
3. local-behind direct fast-forward with Worker termination before local activation;
4. same-Generation two-sided Capture and Collection union with lock/unlock and fresh-browser
   convergence; and
5. sibling successor conflict with sanitized desktop/narrow presentation and a successful later
   source mutation.

`tests/e2e/server-switch-failures.e2e.test.ts` separately covers wrong password, unknown Account,
Vault mismatch, candidate reauthentication before any write and after remote activation, and the
post-Event concurrent candidate-Generation rewrite.

The local-behind journey additionally keeps two Library surfaces open, proves both reconcile to the
post-Vacuum Deleted state without reload, and compares exact local Object, Event, Generation, and
head authority with the candidate browser after promotion.

# Verification

The final current worktree passed:

- browser-extension Biome lint across 198 files;
- browser-extension TypeScript typecheck;
- 61 Vitest files containing 283 unit tests, including the repeated startup decision for every
  persistent Server Switch state/stage pair;
- 39 packaged-Chromium IndexedDB/OPFS integration tests, including repeated reopen at every Server
  Switch state/stage pair and exhaustive atomic-promotion write-failure injection;
- the production extension build and release verifier, which reject the fault-control namespace and
  test-only permissions;
- all 21 one-worker packaged-Chrome E2E tests against two independent real Coordination Servers;
- rendered inspection of 20 Server Switch desktop/narrow captures at 1280px and 420px widths;
- the HTTP, Cable, polling, Generation-recovery, and verified-purge two-Replica synchronization
  proof;
- Coordination Server RuboCop across 105 files, bundler-audit, import-map audit, Brakeman with zero
  warnings, and 46 RSpec examples; and
- Prettier across every changed Markdown document and `git diff --check`.

The final documentation/Roadmap search found no stale immediate-sign-out or failed-candidate logout
claim. Remaining Roadmap entries are intentionally forward-looking: automated builds, Redis-backed
ephemeral coordination, recovered-local-only and native-Download journey extensions, Firefox Host
support, and the web client.
