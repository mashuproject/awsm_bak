# Git-Like Synchronization Server Switching

**Document:** `docs/plans/10-git-like-synchronization-server-switching.md`

**Status:** Implemented

**Owner:** Engineering

**Last Updated:** 2026-07-20

**Depends On:** `docs/plans/09-account-authentication-and-full-vault-synchronization.md`,
`docs/specifications/runtime/synchronization.md`,
`docs/specifications/protocol/protocol.md`, and
`docs/architecture/19-testing-strategy.md`

> **Historical notice:** Plan 15 supersedes this plan's Account-key and candidate-signup
> assumptions. See
> [Plan 15](15-rails-account-recovery-phrase-device-sync.md) for the implemented canonical
> identity, Device, and recovery direction. This document remains historical implementation
> context.

---

# 1. Purpose

This is the decision-complete implementation plan for changing an authenticated Vault from one
Coordination Server to another. It is written for an implementer starting from a cold checkout with
no conversation context. Do not reopen the decisions recorded here.

The current pre-release implementation validates a replacement server only after it has suspended
the old synchronization context and signed the user out. That protects local Vault bytes but makes
a failed candidate disruptive and provides no safe way to reconcile a candidate server that already
contains the same Vault. Replace that behavior in place.

The completed workflow SHALL:

1. keep the source server, source Account, Cable subscription, and synchronization context active
   while a candidate server is validated and authenticated;
2. accept a candidate Account that owns no Vault and publish the current synchronized Vault to it;
3. accept a candidate Account that owns the same Vault ID and verified Root Key;
4. compare authenticated Generation ancestry and authoritative reachability in the trusted Runtime;
5. fast-forward the candidate server, fast-forward the local Replica, or safely union append-only
   authority when the proof permits it;
6. reject unrelated, cryptographically mismatched, corrupt, or initially unprovable histories
   before changing either authority;
7. resume idempotently after browser Worker termination at every persistent stage;
8. promote the candidate Account and server locally only after reconciliation succeeds; and
9. exercise the workflow through five real, independent, packaged-Chrome bug-hunting journeys.

The Git analogy applies to authenticated reachability, not to mutable files, timestamps, or numeric
Generation ordering. Immutable Events appended independently inside one active Generation can be
unioned safely after closure validation. Different Generation rewrites behave like divergent
branches: one side may advance only when ancestry and retained authority are proven; otherwise the
switch conflicts.

# 2. Scope and Non-Goals

## 2.1 In scope

- changing from one compatible Coordination Server origin to another;
- candidate login and candidate Account creation with email and password;
- one source Account and one staged candidate Account in the extension during the operation;
- publishing the current Vault into an empty candidate Account;
- exact same-Generation convergence;
- direct, cryptographically proven local-ahead and candidate-ahead fast-forward;
- explicit conflict when the available retained data cannot prove a fast-forward;
- a persisted, restart-safe Server Switch Job and candidate transfer checkpoints;
- local mutation fencing while reconciliation is applying;
- live state across popup, signup, and Library settings surfaces;
- source-session revocation after successful candidate promotion;
- a second independent real Coordination Server in packaged test infrastructure;
- unit, IndexedDB browser integration, packaged browser, rendered visual, release-exclusion, and
  documentation evidence; and
- fixing every product or test-harness defect discovered by the new tests and retaining the failing
  scenario as regression coverage.

## 2.2 Explicitly deferred

- overwriting either side to resolve a Server Switch conflict;
- semantic cherry-pick or selective reapplication of Events across divergent Generations;
- automatic merge of different Vault IDs or different Root Keys;
- switching more than one synchronized Vault per Account;
- multiple active Accounts after the operation completes;
- retaining a candidate Account for later background conflict resolution;
- compatibility readers, migrations, or preservation of pre-release IndexedDB/proof data;
- Firefox Host support;
- a test-only native Download Host; and
- a preserve-first stale-Replica copy workflow beyond the current export-first explicit discard.

The last three items remain Roadmap work and SHALL NOT be pulled into this implementation.

## 2.3 Pre-release replacement rules

- Replace the existing `ChangeSyncServer` Command and immediate-logout flow. Do not retain it as a
  compatibility alias.
- Keep `DATABASE_VERSION` at `1`. Add the canonical stores to the initial schema and delete/recreate
  development, proof, browser-profile, IndexedDB, and OPFS data. Do not add an IndexedDB upgrade
  branch.
- Keep protocol version `1` and the existing endpoint set. Replace the attachment request's
  Generation-zero restriction in place: an empty Account accepts the client's current active
  Generation ID and nonnegative Generation number as that server's first active Generation. Do not
  add a second attachment route, compatibility shape, or protocol-version branch.
- Do not add version fields to Commands or UI view models. Persisted Server Switch records use the
  sole canonical `version: 1` format.
- Do not add server-side plaintext, semantic Event interpretation, or a server-side merge endpoint.

# 3. Fixed Product Behavior

## 3.1 Entry and prerequisites

- The workflow begins from Library Settings through `Change synchronization server`.
- It is available only when the source Account is authenticated and its synchronized Vault is the
  active, unlocked Vault. If another local-only Vault is active, instruct the user to select the
  synchronized Vault. If it is locked, use the existing unlock flow.
- The first form collects only the candidate origin and the existing acknowledgement that changing
  servers changes Account context while retaining local Vault data.
- The candidate field starts empty rather than repeating the active origin. Submitting the active
  origin keeps the form open and explains that a different server is required.
- The Chrome Host requests candidate-origin permission before sending the begin Command.
- The Runtime canonicalizes and probes `/api/server-information` before persisting candidate state.
- Invalid origin, denied permission, redirect, network failure, incompatible information, or probe
  timeout leaves the source configuration, credentials, Cable, Job, and synchronization state
  untouched. Keep the Settings dialog open and show the specific server-selection or permission error;
  never replace these failures with a generic safety message.

## 3.2 Candidate authentication

- After a successful probe, the Settings dialog becomes a candidate login form and visibly names
  both source and candidate origins.
- Login remains inside the Settings dialog. `Create an Account on this server` opens the existing
  extension-owned signup tab in candidate-switch mode.
- Candidate signup collects email, password, password confirmation, and the existing no-recovery
  acknowledgement. It does not ask for a Vault name or local Vault selection: the current
  synchronized Vault is the sole candidate.
- Candidate signup must call `SignupServerSwitchCandidate`, never the normal `SignupAccount` or
  `CompleteAccountVault` path. On success, clear both password fields, start comparison on the same
  Job, hide the form, and show `Account created. Return to Library to finish the server change.` with
  an `Open Library` control. Any already-open Settings surface advances live without reload.
- Account identities and Account Encryption Keys are server-local. Matching email addresses across
  servers do not imply matching Account IDs or keys.
- Plaintext passwords and authentication secrets are never persisted. Store only the same
  non-exportable keys, wrapped Account Encryption Key, encrypted refresh token, and public Account
  metadata used by the active Account, under candidate-specific keys.
- Wrong password, unknown Account, Account creation conflict, candidate authentication expiry, or
  malformed Account envelope leaves the source context active. The user may retry or cancel.
- A newly created candidate Account may remain empty on its server if the user cancels before Vault
  attachment. Do not invent Account deletion or rollback.

## 3.3 Visible state and controls

Expose an optional unversioned `serverSwitch` object in application state with:

- `candidateOrigin`;
- `state`: `AuthenticationRequired`, `VaultLocked`, `Comparing`, `Applying`, `Conflict`, or
  `Failed`;
- optional `direction`: `PublishLocal`, `FastForwardCandidate`, `FastForwardLocal`, or `Union`;
- `completedItems`, `totalItems`, `processedBytes`, and `totalBytes`;
- optional `errorId`; and
- optional conflict `reason`: `AncestryUnavailable` or `DivergedGeneration`.

Do not expose Account IDs, key IDs, Generation IDs, Object IDs, Event IDs, ciphertext metadata, or
tokens in the UI view model.

Use these user-facing states and controls:

- `Sign in to candidate server` while authentication is required;
- `Unlock this Vault to continue the server change` when the user locks during the operation;
- `Comparing authenticated Vault history…` during read-only comparison;
- `Publishing this Vault to the candidate server…` for an empty candidate;
- `Fast-forwarding the candidate server…` when local is ahead;
- `Fast-forwarding this device…` when the candidate is ahead;
- `Combining compatible append-only history…` for a same-Generation union;
- `Server switch conflict` with `No changes were made. AWSM is still synchronizing with <source>.`
  when read-only comparison conflicts;
- `Server switch stopped after a concurrent change` with
  the message “Some verified append-only history reached the candidate server before its history
  changed. Your active Vault is still synchronizing with <source>; neither Vault was overwritten.”
  when a race makes ancestry unprovable after candidate authority changed; and
- `Cancel server change` before application begins, `Try another server` after a conflict or
  terminal candidate failure, and no cancellation control after a direction is persisted and
  remote/local staging begins.

The candidate form, progress, conflict, failure, and completion states SHALL remain live across all
open surfaces. The Live UI State policy applies: subscribe before fetch, generation-guard renders,
refetch after invalidation, and discard candidate plaintext when the Job is cancelled or replaced.

## 3.4 Conflict outcome

- A conflict aborts the candidate operation rather than pausing the source Account.
- Detect every classifiable conflict before writing local authority or candidate remote authority.
- A concurrent candidate change may make proof impossible after `Union` or `PublishLocal` has
  committed some valid append-only authority. Do not claim that the candidate is unchanged in that
  case. Set the sanitized concurrent-change message from section 3.3, leave the source active, and
  never attempt a compensating delete or overwrite on the candidate.
- Erase candidate Account secrets, non-exportable candidate keys, transfer checkpoints, and any
  uncommitted local Artifact wrappers.
- Retain only a sanitized terminal report containing origins, timestamps, state, and the public
  conflict reason.
- Keep the source configuration, source credentials, source Account Vault registration, source
  synchronization Job, source Cable, local Vault authority, and source remote authority unchanged.
- A later source mutation SHALL still synchronize, proving that candidate failure did not suspend
  or replace the active context.

A nonempty candidate Account with another Vault ID is a terminal candidate failure, not a history
conflict. Set `SERVER_SWITCH_VAULT_MISMATCH`, erase candidate credentials and checkpoints, show
`This Account already contains a different Vault`, and preserve the complete source context. Do not
offer merge or overwrite controls.

# 4. Canonical Persistent Model

## 4.1 Stores

Add these stores to the sole initial IndexedDB schema in
`apps/browser-extension/src/drivers/indexeddb/schema.ts`:

- `server_switch_jobs` for the one active or terminal `ServerSwitchJobV1`; and
- `server_switch_checkpoints` for candidate upload/download/idempotency progress.

Continue to use the existing Account stores with distinct keys:

| Record                      | Active key         | Candidate key                      | Prior-revocation key           |
| --------------------------- | ------------------ | ---------------------------------- | ------------------------------ |
| Account metadata            | `active`           | `server-switch-candidate`          | `server-switch-prior`          |
| Account secrets             | `active`           | `server-switch-candidate`          | `server-switch-prior`          |
| AES-KW wrapping key         | `account-wrapping` | `server-switch-candidate-wrapping` | `server-switch-prior-wrapping` |
| AES-GCM session-storage key | `session-storage`  | `server-switch-candidate-session`  | `server-switch-prior-session`  |
| Account Vault registration  | `active`           | `server-switch-candidate`          | none                           |

Candidate and prior-secret decoders SHALL enforce the same canonical validation, non-extractable
key requirements, Account/session binding, and authenticated encryption as active records. Factor
the key prefix/scope internally; do not duplicate weaker candidate-only crypto.

Refactor `IndexedDbAccountRepository` around an internal explicit scope
(`active | server-switch-candidate | server-switch-prior`). Remove global record-count assumptions:
`hasAuthenticatedSecrets(scope)` validates exactly the two keys and one secret belonging to that
scope while ignoring complete records in other scopes. Context-specific erase removes only the
named scope. Ordinary user logout is unavailable while applying; outside a switch it erases the
active scope and ordinary synchronization rows exactly as the canonical logout flow requires.
Never call the existing store-wide `clear()` behavior while a Server Switch Job needs candidate or
prior credentials.

## 4.2 Server Switch Job

Define one canonical persisted `ServerSwitchJobV1`:

```ts
interface ServerSwitchJobV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly sourceOrigin: string;
  readonly candidateOrigin: string;
  readonly vaultId: string;
  readonly state:
    | "AuthenticationRequired"
    | "WaitingForUnlock"
    | "Running"
    | "Conflict"
    | "Failed"
    | "Succeeded";
  readonly stage:
    | "AuthenticateCandidate"
    | "Compare"
    | "PrepareRemote"
    | "ActivateRemote"
    | "PrepareLocal"
    | "ActivateLocal"
    | "PromoteContext"
    | "RevokePriorSession"
    | "Terminal";
  readonly direction?:
    "PublishLocal" | "FastForwardCandidate" | "FastForwardLocal" | "Union";
  readonly expectedLocalHead: StoredVaultHeadV1;
  readonly candidateGenerationId?: string;
  readonly candidateGenerationNumber?: number;
  readonly candidatePredecessorGenerationId?: string;
  readonly candidateHeadCursor?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedItems: number;
  readonly totalItems: number;
  readonly processedBytes: number;
  readonly totalBytes: number;
  readonly retryCount: number;
  readonly retryAt?: string;
  readonly candidateAuthorityChanged: boolean;
  readonly errorId?: string;
  readonly conflictReason?: "AncestryUnavailable" | "DivergedGeneration";
  readonly attachIdempotencyKey: string;
  readonly candidateIdempotencyKey: string;
}
```

`expectedLocalHead` is the full canonical local head, including sorted appended Object and Event
IDs. It fences every classification and activation. Do not replace it with only a Generation ID.
`candidateAuthorityChanged` begins `false`. Set it after the first successful attachment completion,
Event closure commit, or Generation activation. If the Worker stops between the remote response and
the Job write, startup must query the idempotent remote operation and repair the flag before choosing
UI text or cancellation behavior.

Store candidate transfer checkpoints under `[jobId, kind, entityId]` semantics. Reuse the existing
checkpoint state machine and idempotency rules, but never allow active synchronization code to read
candidate checkpoints or vice versa.

## 4.3 Commands

Replace `ChangeSyncServer` with these unversioned local Commands in the app protocol:

- `BeginServerSwitch { candidateOrigin, expectedVaultId }`;
- `LoginServerSwitchCandidate { email, password }`;
- `SignupServerSwitchCandidate { email, password }`;
- `CancelServerSwitch { jobId }`; and
- `RetryServerSwitch { jobId }`.

All Commands return canonical application state. Validate the current Job ID where supplied and
reject stale UI actions with `VAULT_CONTEXT_CHANGED`. `BeginServerSwitch` rejects the current origin,
an inactive/locked Vault, another running maintenance operation, or an existing nonterminal Server
Switch Job.

Use these new stable error IDs:

- `SERVER_SWITCH_CONFLICT` for unprovable or divergent Generation history;
- `SERVER_SWITCH_VAULT_MISMATCH` for a nonempty candidate Account owning another Vault ID; and
- existing `SYNCHRONIZATION_INTEGRITY_FAILED` for same-ID Root Key mismatch, corrupt immutable
  intersection, invalid envelopes, rollback, or incomplete closure.

Continue using `SERVER_INCOMPATIBLE`, `SERVER_PERMISSION_DENIED`, `AUTHENTICATION_FAILED`,
`SYNCHRONIZATION_AUTHENTICATION_REQUIRED`, `VAULT_BUSY`, `VAULT_LOCKED`, and
`VAULT_CONTEXT_CHANGED` in their existing domains.

# 5. Trusted Reconciliation Algorithm

Implement a platform-independent Runtime `ServerSwitchService`. The Chrome Host supplies candidate
HTTP transport, permissions already granted by UI, persistent repositories, time, notifications,
and the maintenance/Artifact Drivers. Do not put comparison rules in background, UI, or Host code.

## 5.1 Read-only comparison prerequisites

After candidate authentication, replace the begin-time `expectedLocalHead` with a fresh complete
snapshot so source changes made while the candidate was being authenticated participate in the
comparison. Then:

1. snapshot and persist the complete local head;
2. fetch the candidate Account Vault list and require cardinality zero or one;
3. if zero, classify `PublishLocal` without writing;
4. if one, require the same Vault ID;
5. unwrap the candidate Account slot with the candidate Account Encryption Key;
6. unwrap the local device slot and constant-time compare the raw Root Keys;
7. verify the local Vault verifier with the Root Key;
8. fetch and verify the candidate active Generation Object and complete active membership;
9. authenticate every downloaded immutable record and Event dependency closure;
10. compare intersecting natural IDs byte-for-byte; and
11. re-read the local head before returning a classification.

Any mismatch in steps 5–10 is an integrity failure, not a conflict and never a merge opportunity.
Always wipe temporary raw Account and Vault key bytes.

Define the authoritative closure for one side as:

- the active Generation Object;
- every Event and Object retained by the authenticated active Generation manifest; and
- every Event and Object appended in that Generation's current head.

Projection rows, Materializations, Jobs, cursors, Cable hints, caches, Commands, and operation
registries are never part of reachability.

A Generation ID authenticates the immutable Generation manifest but not the append tail accumulated
after that manifest was created. Therefore a named direct predecessor alone is insufficient proof of
a fast-forward. For a direct successor, fetch the exact superseded predecessor through the existing
Recovery enumeration on the server that holds the successor, authenticate its complete closure,
and require that recovered predecessor closure to equal the other side's current authoritative
closure ID-for-ID and byte-for-byte. This base-equality proof permits the successor to omit content
that its verified Vacuum intentionally reclaimed; do not require the successor retained manifest to
be a superset of its predecessor.

## 5.2 Classification table

Apply this table in order:

| Candidate condition                                                                                                                                            | Result                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Account owns no Vault                                                                                                                                          | `PublishLocal`         |
| Candidate Vault ID differs                                                                                                                                     | Vault mismatch         |
| Root Key differs or immutable intersection differs                                                                                                             | Integrity failure      |
| Active Generation IDs are equal                                                                                                                                | `Union`                |
| Candidate active ID equals local Generation's authenticated direct predecessor and source recovery proves the exact candidate closure was the successor's base | `FastForwardCandidate` |
| Local active ID equals candidate Generation's authenticated direct predecessor and candidate recovery proves the exact local closure was the successor's base  | `FastForwardLocal`     |
| A direct successor is named but the exact recovered predecessor base differs                                                                                   | Conflict               |
| Different active IDs are authenticated successors of the same predecessor                                                                                      | Conflict               |
| Required predecessor Recovery is unavailable or purged                                                                                                         | Conflict               |
| Recovery metadata, bytes, or authenticated closure are corrupt, malformed, or incomplete                                                                       | Integrity failure      |
| Different active IDs with none of the proofs above                                                                                                             | Conflict               |

Generation numbers are sanity checks only: a direct successor number must equal predecessor
number plus one. Never infer ancestry from numbers, timestamps, UUID ordering, Delivery Cursors, or
matching names.

The current local canonical format retains only the active Generation Object, while a Coordination
Server exposes an exact superseded Generation only during its Recovery window. Therefore this slice
supports one direct successor only while the required predecessor recovery remains available. If
either side is more than one Generation away or the required exact predecessor is unavailable,
classification is `AncestryUnavailable`; do not add speculative chain reconstruction.

Use `DivergedGeneration` when both authenticated active Generation Objects are different direct
successors of the same named predecessor, or when a direct successor's recovered predecessor base
differs from the other side's current closure. Use `AncestryUnavailable` when neither active
Generation is the other's direct predecessor and that common-successor proof is absent, or when a
required Recovery is unavailable. Corrupt Recovery bytes are an integrity failure. A Vault mismatch
and integrity failure never receive a conflict reason.

## 5.3 Empty candidate: `PublishLocal`

- Create a candidate Account slot for the existing Vault Root Key using the candidate Account key.
- Attach the existing Vault ID and current active Generation identity through the provisional
  attachment contract. Send the current nonnegative Generation number; do not renumber it to zero.
- The candidate server records that Generation as its first known active Generation. Its database
  predecessor relation is null because no predecessor Replica was uploaded, even when the encrypted
  Generation Object authenticates an earlier predecessor. This absence is expected and does not
  rewrite the Generation Object.
- Upload every authoritative Object and Event with its original natural ID and encrypted bytes.
  Finish all transfers to `DurableUncommitted` while the attachment remains provisional.
- Complete attachment to publish the Generation, then commit Event closures in canonical dependency
  order. Persist checkpoints across both boundaries because completion and the Event commits are
  independently idempotent.
- Refetch and verify the resulting candidate active head and complete membership.
- Do not create a new local Vault, Root Key, device slot, Object, Event, Bundle, Artifact,
  Collection, or Generation identity.

## 5.4 Same Generation: `Union`

- Verify both Generation Objects are identical.
- Compute local-only and candidate-only authoritative IDs after validating the intersection.
- Upload local-only Object dependencies and Events to the candidate active Generation.
- Refetch a snapshot-bounded candidate head after uploads; do not trust the earlier cursor.
- Download and authenticate candidate-only closures.
- Require the final candidate head to cover every locally appended authoritative ID.
- Atomically commit candidate-only immutable records, rebuild affected Projections, update the
  local head/Delivery Cursor, and promote the candidate context.
- Canonical Event replay, not Delivery Cursor order, determines logical state. Independent valid
  append-only Events are not a conflict merely because both sides changed.

## 5.5 Local ahead: `FastForwardCandidate`

- Require the candidate active Generation to be the authenticated direct predecessor named by the
  local active Generation.
- Through the still-active source Account, enumerate and authenticate the exact superseded
  predecessor Recovery on the source server. Require its complete closure to equal the candidate's
  current closure ID-for-ID and byte-for-byte. Missing/purged Recovery is
  `AncestryUnavailable`; a different valid base is `DivergedGeneration`.
- Decode and verify the local successor Generation manifest and its complete retained closure.
- Upload all records required by the local successor into a candidate Generation scope.
- Use the original local successor Generation ID and encrypted Generation bytes; do not author a
  new rewrite.
- Submit the complete local active retained membership, seal it, and activate it using candidate
  predecessor ID, predecessor number, and freshly observed candidate head cursor.
- Any concurrent candidate commit that invalidates compare-and-swap returns to read-only
  comparison. Reclassify once; a second race becomes terminal `SERVER_SWITCH_CONFLICT` with the
  truthful message selected by `candidateAuthorityChanged` rather than retrying or guessing
  indefinitely.
- Verify candidate activation before promoting local Account/server context.

## 5.6 Candidate ahead: `FastForwardLocal`

- Require the local active Generation to be the authenticated direct predecessor named by the
  candidate active Generation.
- Through the candidate Account, enumerate and authenticate the exact superseded predecessor
  Recovery on the candidate server. Require its complete closure to equal the local current closure
  ID-for-ID and byte-for-byte. Missing/purged Recovery is `AncestryUnavailable`; a different valid
  base is `DivergedGeneration`.
- Decode and verify the candidate successor Generation manifest and its complete retained closure.
- Download and authenticate the complete candidate active Replica into prepared local records and
  prepared Artifact wrappers.
- Re-read and exactly compare `expectedLocalHead` immediately before activation.
- In one IndexedDB transaction, replace local authority, rebuild/store canonical Projections,
  promote candidate configuration/Account/registration, and move prior Account credentials to the
  revocation-pending keys.
- Commit prepared Artifact wrappers only as part of the same activation protocol. Clean them on
  abort or startup reconciliation.

## 5.7 Promotion common path

Promotion is the only point where the active server changes.

- Use `SynchronizationCoordinator.replaceContext` to abort and await source synchronization and
  discard source-context wakes immediately before the applying stage, not during probe or candidate
  authentication.
- Acquire a persisted exclusive Vault maintenance lease before the final comparison. Capture,
  Collection management, Rename, Vacuum, Import, Export, select, and other authoritative mutations
  must reject or remain disabled while applying.
- Lock is always permitted. Abort in-flight transport at its current idempotent boundary, set the
  Job to `WaitingForUnlock` without changing its stage, discard every transient Root/Account key and
  plaintext buffer, and invalidate all surfaces. Unlocking the same source Vault reruns comparison
  and resumes. If Lock is serialized immediately after atomic promotion, lock the candidate context
  instead. Never keep a Vault unlocked merely to finish a switch.
- Atomically promote candidate configuration, metadata, keys, secrets, Account Vault registration,
  and synchronization state. Clear active source checkpoints.
- Move source metadata/secrets/keys to the prior-revocation keys in that same transaction. Never
  leave both Accounts addressable as active.
- Connect Cable only after promotion commits and a candidate synchronization pass confirms the
  new registration.
- Attempt source-session revocation using the encrypted prior credentials. Whether the source is
  offline or already expired, local prior-secret erasure is mandatory after one bounded attempt;
  server-side credentials expire under the existing session policy.
- Mark the Job `Succeeded`, notify live surfaces, release the maintenance lease, and then remove
  the terminal Job after the success presentation is acknowledged or the next startup reconciles
  it.

# 6. Failure, Restart, and Concurrency Semantics

## 6.1 Cancellation boundary

- Cancellation is allowed in `AuthenticateCandidate` and read-only `Compare` before a direction is
  persisted as applying.
- Cancellation erases candidate credentials, candidate checkpoints, prepared wrappers, and the
  nonterminal Job. It does not log out or modify the source Account.
- Once a direction is persisted and its first candidate staging or prepared-local write begins,
  hide/disable Cancel. The operation is resumable and must reach a verified terminal state. This
  earlier boundary avoids abandoning a provisional attachment or Generation candidate that has no
  immediate deletion contract.

## 6.2 Startup reconciliation

At background startup, before accepting Commands:

- `AuthenticationRequired`: restore the candidate login presentation; source synchronization may
  continue.
- `WaitingForUnlock`: expose only the normal unlock control and sanitized Job context; after unlock,
  revalidate source/candidate authentication, local head, and the current remote fence before
  resuming the persisted stage.
- `Compare`: erase incomplete prepared downloads and rerun comparison from canonical local and
  candidate state.
- `PrepareRemote` or `ActivateRemote`: query candidate attachment/candidate Generation state using
  persisted idempotency keys, resume missing uploads, and verify activation before promotion.
- `PrepareLocal` or `ActivateLocal`: reconcile prepared Artifact wrappers; if the atomic local
  transaction did not commit, discard preparation and redownload; if it committed, proceed from
  promoted authority.
- `PromoteContext`: inspect active configuration and Account identity. Complete promotion only when
  candidate remote/local authority verifies; never roll an already committed local authority back
  to source data.
- `RevokePriorSession`: keep candidate active, make one bounded revocation attempt, erase prior
  secrets, and finish.
- `Conflict` or `Failed`: require candidate secrets to be absent and leave the sanitized report.
- `Succeeded`: require candidate to be the sole active context and clean terminal operational rows.

Every reconciliation branch is idempotent. A Worker may terminate repeatedly at the same stage.

## 6.3 Authentication expiry

- Candidate expiry before application returns to `AuthenticationRequired` and retains the source
  context.
- Candidate expiry after remote application retains the resumable Job and prompts for candidate
  reauthentication; never restart from a new Account or attach a second Vault.
- Source expiry while candidate comparison is read-only does not make the candidate active. Mark
  source synchronization `AuthenticationRequired`, retain candidate progress, and allow the user to
  authenticate either side. Applying may continue only when both identities needed by the chosen
  direction are available.
- Never call ordinary remote logout when the corresponding session is already known expired; clear
  local secrets directly and preserve the appropriate Job.

## 6.4 Races

- Source mutations before the maintenance lease are included only if they appear in the newly
  persisted `expectedLocalHead`; otherwise reclassify.
- Source mutations after lease acquisition are rejected with `VAULT_BUSY`.
- Candidate mutations between comparison and application are fenced by the existing operation
  contracts: Event commits require the active Generation ID/number, while Generation candidate
  creation and activation compare the head cursor under the server's Vault lock. Concurrent commits
  in the same Generation commute and are included by the final refetch. Refetch and reclassify once
  after a fence failure. Before candidate authority changes, an unprovable result uses the ordinary
  conflict outcome. After candidate authority changes, continue from the accepted immutable
  intersection when it still proves `Union` or a direct fast-forward; otherwise use the
  concurrent-change conflict outcome and never roll back accepted Events.
- A late source HTTP response is aborted/fenced and cannot commit after candidate promotion.
- Cable hints from either context are wake-ups only. Candidate hints cannot enter the active
  coordinator before promotion; source hints queued before replacement are discarded at promotion.

# 7. Implementation Map

## 7.1 Runtime and persistence

- Add the persisted types/stores and scoped candidate credential operations under
  `src/drivers/indexeddb`.
- Factor active/candidate Account credential persistence so both paths share exact encryption,
  validation, key-wiping, and partial-state rejection.
- Add `ServerSwitchService`, a pure reconciliation classifier, and direction-specific executors
  under `src/runtime/synchronization`.
- Generalize existing upload, remote download, same-Generation pull, and Generation-candidate code
  through narrow interfaces. Do not copy protocol logic into the new service.
- Extend `IndexedDbWorkspaceRepository` with explicit atomic commits for Union/FastForwardLocal plus
  candidate Account promotion. Inject write-failure points and prove rollback at every store write.
- Add startup reconciliation before normal enrollment/synchronization startup.
- Start from `src/runtime/synchronization/runner.ts`, `enrollment.ts`, `pull.ts`, `download.ts`,
  `upload.ts`, `vacuum.ts`, and `coordinator.ts`; extract shared operations before adding
  `server-switch.ts` and `server-switch-classifier.ts`.
- Put persisted record shapes and strict decoders beside the existing IndexedDB schema/account/job
  records. Put app Commands and public view state in `src/app/protocol.ts`, orchestration in
  `src/app/background.ts`, and no business rules in either file.

## 7.2 Background and Hosts

- Replace the current `ChangeSyncServer` handler with the five Commands from section 4.3.
- Keep separate source and candidate `AccountSessionManager` instances keyed by origin and Account
  scope. Do not use one mutable global manager for both.
- Keep candidate transport out of the active Cable subscriber and synchronization coordinator.
- Add server-switch fault checkpoints only in `e2e` mode:
  - `server-switch:after-candidate-authentication`;
  - `server-switch:after-classification`;
  - `server-switch:after-remote-activation`;
  - `server-switch:before-local-activation`; and
  - `server-switch:after-promotion`.
- The production release verifier SHALL reject the test-control namespace from every emitted
  JavaScript file, as it does for existing recovery fault controls.

## 7.3 UI

- Refactor Account Settings into renderable steps driven solely by canonical application state.
- Reuse the existing Account form validation and safe error mapping. Do not expose raw server
  messages.
- Make candidate signup mode explicit and non-sensitive, for example
  `signup.html?purpose=server-switch`; the origin and Job remain in Runtime state, not the URL.
- Show source/candidate origins and direction clearly. Never imply that a new Vault will be created
  when an empty candidate receives the existing Vault.
- Keep visible controls dimensioned, keyboard reachable, named, and focus-managed. Preserve modal
  geometry when replacing the origin form with authentication/progress/conflict content.
- On context promotion, discard decrypted candidate/source drafts and refetch the active Vault from
  Runtime state before rendering.
- Render and inspect origin entry, candidate login/signup, validation error, authentication error,
  locked/waiting, each applying direction, conflict, concurrent-change conflict, terminal failure,
  and success at the primary desktop width and the materially different narrow width. Also inspect
  keyboard focus, disabled controls, wrapping, progress updates, and the transition back from
  unlock; DOM existence alone is insufficient.
- Implement the Settings states in `src/ui/library-view.ts` and
  `entrypoints/library/{main.ts,style.css}`; implement candidate signup in
  `entrypoints/signup/{main.ts,style.css,index.html}`. Update popup presentation only when the
  canonical app state already exposes information the popup needs.

## 7.4 Coordination Server

Do not add a production endpoint or server-side reconciliation behavior. Reuse:

- Account creation/session endpoints;
- Account Vault list and attach;
- active record enumeration and downloads;
- immutable uploads and Event closure commit;
- Generation candidate create/upload/retain/seal/activate; and
- superseded recovery enumeration where it provides existing authenticated evidence.

Replace the initial-attachment Generation-zero constraint in
`app/controllers/api/vaults_controller.rb` and the matching serializer assumptions. The existing
`POST /api/vaults` request SHALL accept a safe nonnegative `generationNumber`, persist that exact
number on the provisional Generation, find the provisional upload by Generation ID rather than
number zero, and publish that same number on completion. It SHALL NOT create missing predecessor
rows or infer ancestry. Update `docs/specifications/protocol/http-api.openapi.yaml`,
`docs/specifications/protocol/messages.md`, the protocol prose, `spec/requests/vaults_spec.rb`, and
the synchronization proof in place. Keep the initial format/protocol version at `1`.

Add request specs proving attachment at Generation `0` and at a nonzero current Generation,
idempotent replay for both, exact number publication, unsafe/negative number rejection, same
natural-ID byte rejection, candidate CAS fencing, and Account isolation. The Service never
classifies ancestry or performs a union.

# 8. Five Packaged Bug-Hunting Journeys

Implement five separate serial Playwright tests. Each uses unique emails and fresh browser profiles
against two independent real Coordination Servers. Do not combine them into one test whose early
failure prevents later scenarios from running.

Create `tests/e2e/server-switch.e2e.test.ts` with exactly one `test()` per journey and workers set to
one. Do not use `test.describe.serial`: Playwright skips later tests after a failure in that mode,
which defeats independent bug discovery. Serialization comes from the one-worker configuration. A
shared setup helper may establish identical servers only by keeping profile A authenticated to
server A while a second profile signs into A and completes the visible empty-candidate switch to
server B. Before the switch, the helper creates three Captures, nontrivial Collection topology, and
one deleted-but-not-Vacuumed Capture so both servers receive the exact same append tail and have
reclaimable authority. The second profile's source-session revocation must not revoke profile A's
independent session. Each test builds this baseline afresh; no test depends on another test's state.

## 8.1 Empty candidate server

1. On server A, create an Account and synchronized Vault with three Captures and nontrivial
   Collection topology; delete one Capture without Vacuum so Deleted state is authoritative. Log an
   independent observer profile into A before starting the switch.
2. Begin a switch to server B and create a new candidate Account.
3. While candidate authentication is visible, mutate through server A and prove the open Library
   updates, demonstrating that source synchronization remains active.
4. Continue; B owns no Vault, so classify `PublishLocal` using the new local head.
5. Verify B receives the same Vault ID, Generation identity, Events, Objects, Captures, Collections,
   deleted state, and Vault name. Prove Root Key continuity by successfully authenticating the
   candidate Account slot and Vault verifier inside the Runtime; the test must never export or log
   raw key bytes.
6. Verify the client is authenticated and `UpToDate` on B without another login.
7. Add one mutation through the switched profile, prove it reaches B, and use the independent A
   observer to prove it does not appear on A.

Capture candidate login, publish progress, and successful B settings states.

## 8.2 Candidate behind local

1. Establish identical A/B state through the real empty-candidate path with the two-profile helper.
   Use the independently authenticated profile A as the switching client.
2. In profile A, complete synchronized Vacuum on A without making another pre-Vacuum mutation.
   Require A to have one direct successor Generation and become stably `UpToDate`; leave B at the
   byte-identical authenticated predecessor. This exact baseline is what makes the direction a true
   fast-forward rather than a conflict.
3. Begin a switch to B and log into the existing B Account.
4. Require classification `FastForwardCandidate` from the direct successor plus exact source
   Recovery/candidate-current-base equality proof.
5. Arm `server-switch:after-remote-activation`, apply, and terminate the extension Worker after B
   advances but before local context promotion.
6. Restart the Library. Startup SHALL observe B already advanced, avoid duplicate uploads or a
   second Generation, and promote B idempotently.
7. Verify exact Event/Object counts, content, topology, Generation ID, and stable `UpToDate` state.

## 8.3 Local behind candidate

1. Establish identical A/B state.
2. Keep profile A on A. Through profile B, complete synchronized Vacuum on B without making another
   pre-Vacuum mutation. Require B to have one direct successor Generation and become stably
   `UpToDate`; leave A at the byte-identical authenticated predecessor.
3. Begin profile A's switch to B; classify `FastForwardLocal` from the direct successor plus exact
   candidate-Recovery/local-current-base equality proof.
4. Arm `server-switch:before-local-activation` and terminate the Worker.
5. Before retry completes, prove the previous local authority remains complete—the deleted Capture,
   Projection, Artifact, and pre-Vacuum storage counts remain present with no partial activation.
6. Resume; atomically install B and promote the context.
7. Keep two extension surfaces open and prove both update to the post-Vacuum Deleted state and
   storage counts without reload.

Capture the fast-forward-local busy state and completed live Library state.

## 8.4 Safe same-Generation union

1. Establish identical A/B state in the same active Generation.
2. Append one valid Capture plus a Collection operation on A.
3. Independently append a different Capture plus a different noncontradictory Collection operation
   on B.
4. Begin A's switch to B; classify `Union`, not conflict.
5. Verify local-only dependencies upload before their Events, candidate-only records authenticate,
   and the final candidate head covers both sides.
6. Verify canonical replay produces both Captures and expected Collection topology with no duplicate
   Object, Event, Bundle, or operation.
7. Open a fresh B browser and prove exact convergence.

## 8.5 Diverged Generation conflict

1. Establish identical A/B state containing at least two Captures.
2. On A delete one Capture and complete synchronized Vacuum.
3. Independently on B delete the other Capture and complete synchronized Vacuum, producing a
   different successor from the shared predecessor.
4. Begin A's switch to B and authenticate the candidate.
5. Classify `DivergedGeneration` before any candidate/local authority write.
6. Show the sanitized conflict report and erase candidate secrets.
7. Verify A still has its expected post-Vacuum content, remains authenticated to A, and remains
   live/UpToDate.
8. Verify B still has its different post-Vacuum content through its existing browser.
9. Mutate A again and prove A synchronization still works.

Capture desktop and narrow conflict states. Assert that neither UI exposes identifiers or
ciphertext metadata.

# 9. Supporting Test Matrix

## 9.1 Unit tests

Write RED tests before implementation for:

- every row of the classification table;
- same Generation with equal, local-only, candidate-only, and two-sided append sets;
- intersecting ID with different bytes;
- missing Object dependency, duplicate reachability, invalid Event Vault, invalid Generation
  verifier, rollback, and malicious server metadata;
- direct predecessor with valid/invalid number and an exact recovered-base match/mismatch;
- named predecessor whose Recovery is unavailable, purged, corrupt, or incomplete;
- different Vault ID and same-ID different Root Key;
- local-head change during comparison;
- candidate head-cursor race and one permitted reclassification;
- a race after one accepted Union/PublishLocal Event, remote-flag repair after termination, and the
  truthful concurrent-change conflict presentation;
- candidate credential encryption, reload, partial-state rejection, erasure, and key wiping;
- cancellation before writes and cancellation rejection after writes;
- source/candidate coordinator isolation; and
- prior-session revocation failure still erasing local prior credentials.

## 9.2 Browser IndexedDB integration

- Close/reopen IndexedDB at every Server Switch stage and assert the startup decision in section
  6.2.
- Inject failure at every store write in Union/FastForwardLocal promotion and prove all authority,
  active Account, configuration, keys, registration, name cache, Projections, and Job state roll
  back together.
- Prove remote-first resume after candidate attachment and Generation activation.
- Prove prepared Artifact wrapper cleanup before commit and retention after commit.
- Keep two surfaces open and prove live invalidation for authentication, progress, conflict,
  promotion, failure, lock during application, and unlock/resume.

## 9.3 Candidate validation and authentication failures

Cover every failure at the lowest real boundary that can produce it without changing production
behavior:

- Extend the Account Server Host/unit tests to cover invalid and insecure origins, a false return
  from `browser.permissions.request`, permission API rejection, probe timeout, redirected probe,
  incompatible server information, and malformed response. Assert the Runtime receives the stable
  public error and no candidate Job or credential record is written.
- Create `tests/e2e/server-switch-failures.e2e.test.ts` with
  `preserves the source context across candidate authentication failures`. Through visible packaged
  UI, exercise wrong password, unknown Account, and a candidate Account owning another Vault ID,
  resetting only the terminal candidate attempt between cases.
- In the same file add `reauthenticates a candidate switch before and after remote application`.
  Expire the unique candidate Account's session in the candidate proof database—test infrastructure
  may mutate authentication rows but never Vault authority—once before any write and once after a
  `FastForwardCandidate` remote activation. Prove candidate login resumes the same Job without a
  second attachment or Generation.

Every pre-application failure SHALL assert that source origin, source Account state, Cable-driven
updates, synchronization Job identity, and local Vault state remain unchanged.

## 9.4 Server request tests

- Replaying identical attachment, upload, Event commit, candidate seal, and candidate activation
  operations is idempotent.
- Reusing an idempotency key with different method/path/body is rejected.
- Reusing a natural ID with different bytes is rejected.
- Another Account cannot observe or mutate the candidate Vault.
- Candidate activation fails when the predecessor head cursor changes.
- Logs and error payloads contain no password, authentication secret, token, Account key, Vault key,
  plaintext, or content-derived metadata.

# 10. Two-Server E2E Infrastructure

- Extend the proof Compose topology with `postgres-candidate-proof` and
  `coordination-candidate-proof`.
- Give the candidate server an independent PostgreSQL volume, opaque-storage volume, database URL,
  and Rails process. Do not point two ports at one database.
- Bind source to `127.0.0.1:3300` and candidate to `127.0.0.1:3301` in the browser-only Compose
  override.
- Update the proof startup script to remove both servers' volumes before the suite and wait for both
  `/ready` endpoints.
- Update Playwright web-server configuration and global teardown to start/stop both services.
- Keep workers at one unless isolation is later proven. Use unique Accounts and browser profiles per
  journey.
- Set finite action and expectation timeouts. No browser action may inherit an unlimited timeout.
- Build packaged E2E mode explicitly and continue loading `.output/chrome-mv3-e2e`; production
  builds must remain free of fault controls and broadened permissions.

Test setup SHALL use visible extension flows and production Runtime/server contracts. It may use
helpers to reduce repetition, but it must not seed authoritative IndexedDB or server rows directly
for the five journeys. A helper failure must report which baseline invariant failed.

# 11. TDD and Bug-Discovery Workflow

The tests exist both as executable architectural proof and as deliberate bug-discovery pressure.
Passing assertions is not the only goal.

For each scenario:

1. write the smallest failing unit/integration/E2E proof for the intended invariant;
2. run it against the current implementation and record the RED failure in a new
   `10-git-like-synchronization-server-switching-tdd-evidence.md`;
3. classify the failure as product defect, harness defect, or incorrect expectation using Runtime,
   IndexedDB, network, server, and rendered-state evidence;
4. fix the underlying cause rather than weakening the assertion or increasing timeouts blindly;
5. preserve the scenario as regression coverage;
6. run neighboring tests after every fix because lifecycle defects commonly cross boundaries; and
7. document any new invariant or behavior discovered during testing in its canonical owner.

When a packaged test fails:

- inspect the trace, canonical application state, persisted Job/checkpoint state, server response,
  and screenshot;
- determine the last committed authority boundary;
- distinguish a genuinely busy/resumable operation from a hung UI;
- add bounded waits around canonical states, never sleeps;
- never monkeypatch production logic when a release-excluded fault checkpoint can expose the real
  boundary; and
- verify a harness accommodation is absent from the release build.

# 12. Documentation Completion

Reconcile all of the following before completion:

- `docs/specifications/runtime/synchronization.md`: candidate context, classification, promotion,
  restart, and conflict requirements;
- `docs/specifications/protocol/http-api.openapi.yaml`,
  `docs/specifications/protocol/messages.md`, and the owning protocol prose: attachment publishes
  the supplied current Generation as the server's first known Generation rather than requiring
  number zero;
- `docs/architecture/08-synchronization.md`: reachability model and source/candidate isolation;
- `docs/architecture/19-testing-strategy.md`: five two-server journeys and fault expectations;
- `docs/plans/09-account-authentication-and-full-vault-synchronization.md`: replace the stale
  immediate server-change statements with a brief reference to this approved plan;
- Plan 09 TDD evidence: remove or qualify claims that immediate sign-out is the final workflow;
- `README.md` and any user-facing Account/server prose;
- protocol documentation only where client use or test expectations need clarification—do not add
  a server merge contract; and
- `ROADMAP.md`: remove or narrow only work fully completed by this implementation and retain the
  existing Firefox, Download Host, future preserve-first stale-Replica recovery, Redis, build, and
  web-client items.

Search all Markdown for `ChangeSyncServer`, `changing servers signs out`, `server change`,
`replacement context`, and claims that a failed candidate logs out the active Account. Completed
behavior belongs in canonical documentation, not the Roadmap.

# 13. Implementation Sequence

Follow this order. Do not start with the packaged happy paths.

## Phase 1: RED contracts and classifier

- Add failing classifier, root-identity, reachability, closure, and error tests.
- Add failing repository tests for scoped candidate credentials and Server Switch Jobs.
- Add failing app-protocol tests for the replacement Commands and view model.
- Add failing OpenAPI/request tests for attaching an empty Account at a nonzero current Generation.

## Phase 2: Persistence and candidate authentication

- Add canonical stores/types/decoders without a compatibility upgrade path.
- Implement scoped credential persistence and erasure.
- Implement begin, candidate login/signup, cancel, and retry through Runtime/background boundaries.
- Add rendered authentication/error/progress states and visual inspection.

## Phase 3: Read-only comparison

- Implement complete candidate/recovery download, exact predecessor-base validation, and pure
  classification.
- Prove conflict and integrity failures perform zero authoritative writes.
- Implement sanitized conflict terminal state and source-context continuity.

## Phase 4: Apply directions and atomic promotion

- Replace the server's Generation-zero attachment constraint and make current-Generation attachment
  request/proof tests green before implementing `PublishLocal`.
- Implement `PublishLocal`, `Union`, `FastForwardCandidate`, and `FastForwardLocal` in that order.
- Add local maintenance lease, source coordinator replacement, atomic promotion, and prior-session
  cleanup.
- Add write-failure rollback tests before marking each direction green.

## Phase 5: Restart safety

- Implement startup reconciliation for every stage.
- Add IndexedDB close/reopen and repeated-fault tests.
- Add release-excluded server-switch checkpoints under the existing `awsm:test-fault-control`
  namespace. Extend `scripts/verify-release.mjs` and its test so any server-switch checkpoint in
  production output fails the build.

## Phase 6: Two-server packaged journeys

- Add the independent candidate server topology.
- Implement the five journeys separately.
- Implement the two packaged authentication/lifecycle tests from section 9.3.
- Fix every discovered product/harness defect and preserve regression coverage.
- Capture and inspect every required desktop/narrow state.

## Phase 7: Documentation and full verification

- Reconcile canonical documentation and Roadmap.
- Delete/recreate pre-release test/development data.
- Run the complete verification matrix below.

# 14. Acceptance Criteria

The work is complete only when all are true:

- a failed candidate probe/authentication/conflict leaves source synchronization observably live;
- empty, candidate-behind, local-behind, and same-Generation-union workflows converge with the same
  Vault ID and Root Key and no duplicated/lost authority;
- divergent Generations never overwrite or silently merge;
- local/candidate identity and immutable bytes are cryptographically verified before comparison;
- source-context responses cannot commit after promotion;
- every persistent stage survives repeated Worker termination;
- local activation and Account/server promotion are atomic;
- candidate and prior credentials are encrypted, scoped, and erased at their terminal boundaries;
- five independent real two-server packaged journeys pass;
- rendered states have been visually inspected at desktop and materially different narrow widths;
- release output contains no fault-control namespace or test-only permission;
- all introduced warnings/errors are resolved; and
- all related documentation and Roadmap language describes only the canonical resulting behavior.

# 15. Verification Commands

Discover manifest changes before execution, but at minimum run:

```bash
corepack pnpm --filter @awsm/browser-extension lint
corepack pnpm --filter @awsm/browser-extension typecheck
corepack pnpm --filter @awsm/browser-extension test
corepack pnpm --filter @awsm/browser-extension test:integration
corepack pnpm --filter @awsm/browser-extension build
corepack pnpm --filter @awsm/browser-extension test:e2e:chrome
corepack pnpm test:sync-proof

docker compose up -d coordination-server
docker compose exec -T coordination-server bundle exec rspec
docker compose -f compose.sync-proof.yml -f compose.browser-proof.yml down --volumes --remove-orphans

corepack pnpm exec prettier --check \
  docs/plans/10-git-like-synchronization-server-switching.md \
  docs/plans/10-git-like-synchronization-server-switching-tdd-evidence.md \
  docs/plans/09-account-authentication-and-full-vault-synchronization.md \
  docs/plans/09-account-authentication-and-full-vault-synchronization-tdd-evidence.md \
  docs/specifications/runtime/synchronization.md \
  docs/specifications/protocol/protocol.md \
  docs/specifications/protocol/messages.md \
  docs/specifications/protocol/http-api.openapi.yaml \
  docs/architecture/08-synchronization.md \
  docs/architecture/19-testing-strategy.md \
  README.md \
  ROADMAP.md

git diff --check
rg -n "awsm:test-fault-control|server-switch:" apps/browser-extension/.output/chrome-mv3
```

The final `rg` command must return no release JavaScript matches. Use the repository's actual Rails
test command if its manifest differs; do not skip the full request/model/Job suite.

Before committing, follow `AGENTS.md`: inspect ignored files, stage only the coherent
implementation, review the full staged diff and `git diff --cached --check`, exclude browser
profiles/build output/secrets, and use a Conventional Commit message that describes the observable
server-switch outcome.
