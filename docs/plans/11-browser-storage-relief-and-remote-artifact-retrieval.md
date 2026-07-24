# Browser Storage Relief and Remote Artifact Retrieval

**Document:** `docs/plans/11-browser-storage-relief-and-remote-artifact-retrieval.md`

**Status:** Approved

**Owner:** Engineering

**Last Updated:** 2026-07-21

**Depends On:** `docs/plans/09-account-authentication-and-full-vault-synchronization.md`,
`docs/plans/10-git-like-synchronization-server-switching.md`,
`docs/specifications/bundle/artifact.md`,
`docs/specifications/storage/object-store.md`,
`docs/specifications/runtime/storage.md`,
`docs/specifications/runtime/synchronization.md`,
`docs/specifications/protocol/protocol.md`, and
`docs/architecture/19-testing-strategy.md`

---

# 1. Purpose

This is the decision-complete implementation plan for repeatable browser storage relief backed by
an authenticated Coordination Server. It is written for an implementer starting from a cold
checkout with no conversation context. Do not reopen the decisions recorded here.

Browser extension Vaults currently retain every authoritative Artifact wrapper in OPFS. A large
number of page-snapshot primary captures and full-page screenshots can therefore consume substantial
browser storage even after their exact encrypted bytes are durably synchronized. The completed
feature SHALL let the user run **Free up browser storage** whenever desired. Each run synchronizes,
proves which eligible encrypted wrappers are members of the active server Generation, removes only
those verified local wrappers, and retains enough device-local state to distinguish intentional
remote-only availability from corruption.

The completed workflow SHALL:

1. expose an always-available Vault-level storage-maintenance surface for an unlocked synchronized
   Vault;
2. target the `PRIMARY` and `SCREENSHOT_FULL` Artifact Roles belonging to both Active and Deleted
   Captures;
3. treat each invocation as a repeatable manual cleanup, never as a persistent or automatic
   retention policy;
4. attempt synchronization before eviction and delete only the subset proven durable in the
   current Account's active server Generation;
5. permit the Coordination Server to hold the sole retained wrapper copy after an explicit
   confirmation;
6. retain immutable Artifact Object records and Bundle references while recording `RemoteOnly` as
   device-local operational availability;
7. retrieve, authenticate, decrypt, display, inspect, or download remote-only Artifacts on demand;
8. restore a requested wrapper locally by default and fall back to verified transient streaming
   when browser quota prevents retention;
9. make Complete Export, synchronized Vacuum, server switching, sign-out, and stale-Replica
   resolution correct in the presence of remote-only wrappers;
10. survive browser Worker termination and user cancellation without misclassifying missing files
    or losing the last unverified local copy; and
11. replace preserve-first stale-Replica recovery with export-first explicit stale-Replica discard,
    while moving a future preserve-first workflow to the Roadmap.

The Coordination Server remains zero knowledge. It stores and transfers the same opaque encrypted
bytes and never learns Artifact Role, MIME type, Capture status, local availability, or the user's
retention decision.

# 2. Scope and Non-Goals

## 2.1 In scope

- a repeatable, user-triggered **Free up browser storage** operation over the active synchronized
  Vault;
- exact local candidate count and encrypted-wrapper byte accounting before confirmation;
- a synchronization attempt and active-Generation proof before any deletion;
- verified-subset eviction when some local candidates remain unpublished or otherwise
  unverifiable;
- `PRIMARY` and `SCREENSHOT_FULL` wrappers from both Active and Deleted Captures;
- persistent device-local Artifact availability and per-Artifact storage-relief checkpoints;
- resumable and cancellable storage-relief Jobs;
- ordinary Pull/Upload behavior that preserves intentional remote-only absence while retaining the
  full-local default for newly learned Artifacts;
- local-first metadata, thumbnails, extracted text, and structured content after cleanup;
- on-demand active-Generation and Recovery Snapshot retrieval through existing download tickets;
- local restoration after ordinary access;
- bounded-memory transient retrieval after a local quota failure;
- Complete Export of remote-only wrappers without permanent rehydration;
- source-to-candidate relay of remote-only wrappers during Coordination Server switching;
- synchronized Vacuum cleanup of remote-only availability records for reclaimed Objects;
- a sign-out warning when the synchronized Vault contains remote-only wrappers;
- export-first explicit stale-Replica discard without creation of a Local recovery fork;
- live state across every open popup and Library surface;
- unit, IndexedDB/OPFS integration, Rails contract, synchronization proof, packaged-Chrome,
  fault-injection, security, bounded-memory, and rendered visual evidence;
- complete documentation and Roadmap reconciliation; and
- fixing defects found by the new journeys when those defects block or falsify the requested
  behavior, while retaining their failing scenarios as regression coverage.

## 2.2 Explicitly deferred

- a persistent `Full` or `Selective` local-retention profile;
- automatic age, quota, least-recently-used, or storage-pressure eviction;
- per-Capture or per-Artifact eviction controls;
- user pinning or `Always keep on this device` behavior;
- eviction of `THUMBNAIL`, `TEXT_EXTRACTED`, or `CONTENT_STRUCTURED` wrappers;
- server-side retention decisions, semantic inspection, or plaintext processing;
- server quota accounting, billing, abuse controls, or shared object-storage deployment;
- Device-presence proof that another browser retains a local copy;
- Selective Import or a change to the current Selective Export package contract;
- implementing the currently architectural-only Backup/Restore subsystem; its specifications are
  reconciled so a future complete Backup cannot omit remote-only wrappers;
- background prefetch, offline download queues, or predictive caching;
- preservation of a stale Replica as a new local-only Vault;
- compatibility readers, migrations, aliases, or preservation of pre-release IndexedDB, OPFS,
  browser-profile, proof-server, PostgreSQL, or opaque Disk data; and
- Firefox, web-client, desktop, or mobile Host implementation.

## 2.3 Pre-release canonical replacement

- Keep `DATABASE_VERSION` at `1`. Add the new stores to the sole initial IndexedDB schema and
  delete/recreate all development, proof, browser-profile, IndexedDB, and OPFS state before
  verification. Do not add an IndexedDB upgrade branch or old-store detection.
- Keep Artifact, Bundle, Event, cryptographic, Export, and HTTP protocol format versions at `1`.
  This feature changes local availability and Runtime behavior, not authoritative bytes.
- Keep transient App Commands and UI view models unversioned. Persisted availability, Job, and
  checkpoint records use their sole canonical `version: 1` shapes.
- Replace the current stale-Replica recovery-fork code, Commands, stages, result values, tests, and
  documentation in place. Do not retain a recovery-fork compatibility path.
- Remove `RECOVERY_FORK_FAILED` and every current-product claim that a stale Replica is re-authored
  as a local-only Vault. Add only the canonical discard outcome defined by this plan.
- Do not rename existing authoritative Objects, change Artifact IDs, rewrite Bundles, or emit Events
  for local availability changes.

# 3. Fixed Product Behavior

## 3.1 Repeatable manual cleanup

- **Free up browser storage** is a repeatable operation. The control remains available for the
  lifetime of an eligible synchronized Vault.
- Each run evaluates only the eligible wrappers that are locally present when its maintenance lease
  is acquired. A later Capture, synchronization download, or on-demand restoration remains local
  until the user runs cleanup again.
- A run does not enable a background policy and does not change behavior on another device.
- The operation targets exactly `PRIMARY` and `SCREENSHOT_FULL`. The Role comes from an
  authenticated Bundle Descriptor inside the trusted Runtime; the server never receives it.
- Active and Deleted Captures are both included. Deleted content remains retrievable and restorable
  until Vault Vacuum removes it from authoritative reachability.
- `THUMBNAIL`, `TEXT_EXTRACTED`, and `CONTENT_STRUCTURED` remain local so Library browsing,
  thumbnail display, and local inspection/search inputs continue to work without network access.

## 3.2 Entry, estimate, and confirmation

- Add an always-visible `Storage maintenance` section after the Active and Deleted Library content.
  It is independent of whether Deleted is empty.
- The section shows the exact number and encrypted byte length of currently local `PRIMARY` and
  `SCREENSHOT_FULL` wrappers. Label this value `Up to <size> can be freed` because remote
  verification occurs after confirmation.
- Count exact `StoredArtifactObjectV1.envelopeByteLength`, not plaintext length, browser quota
  estimates, filesystem allocation blocks, Bundle Descriptor bytes, Events, Projections, or
  remote-only wrappers.
- If no eligible wrapper is local, show `No heavy Artifacts are currently stored in this browser`
  and disable **Free up browser storage**.
- Show Vault Vacuum in the same section only when Deleted contains reclaimable Captures. Preserve
  its current destructive meaning and styling; storage relief is reversible retrieval state and
  must not inherit Vacuum's permanent-deletion styling.
- Clicking **Free up browser storage** uses a standard confirmation dialog. The confirmation SHALL
  state:
  - the exact local candidate count and `up to` encrypted byte total;
  - that AWSM synchronizes and verifies each encrypted server copy first;
  - that only verified copies are removed locally;
  - that the server may then hold the only copy;
  - that offline access to those payloads is lost until they are retrieved; and
  - that the action can be run again later.
- Confirmation starts one persisted Job. Cancellation of the dialog performs no write and starts no
  Job.
- `StartStorageRelief` echoes the displayed candidate count and byte total. The trusted Runtime
  snapshots the exact `StoredVaultHeadV1` plus the complete availability-row set, re-authenticates
  descriptors, and re-enumerates eligible wrappers across IndexedDB and OPFS.
- One IndexedDB transaction then rejects competing management work and rechecks the captured head,
  complete availability set, candidate count, and candidate bytes. If any value changed, create no
  Job/checkpoints, return `STORAGE_RELIEF_ESTIMATE_CHANGED`, and refetch the estimate so the user
  confirms the new values.
- When the values still match, that transaction creates the Job and one `Candidate` checkpoint for
  every wrapper in the confirmed set. A `Created` or `Running` Job is the persisted maintenance
  lease; waiting and terminal states do not block unrelated work, and no separate lease record
  exists. That immutable checkpoint set is the deletion ceiling for the run. Wrappers installed by
  the ensuing synchronization are not added; they remain local unless the user confirms a later
  run.
- The control requires the synchronized Vault to be active and unlocked. A local-only Vault shows
  `Connect this Vault to an Account to reduce device storage`; it does not offer a destructive local
  substitute.

## 3.3 Synchronize, prove, then evict

- After the confirmed candidate set and Job lease are persisted, suspend
  ordinary background reconciliation through the existing coordinator and perform one foreground
  synchronization attempt owned by that Job. The lease owner may make the synchronization commits
  required by that foreground attempt; all unrelated authoritative mutations reject with
  `VAULT_BUSY`. Release the coordinator and lease only after the Job is terminal or waiting for
  authentication/unlock.
- Resuming from `AuthenticationRequired` or `WaitingForUnlock` must reacquire the lease for the same
  Vault/Account/server context, rerun foreground synchronization when authentication permits, and
  revalidate the local-head and remote-Generation fences before the next deletion. Already
  committed `RemoteOnly` rows remain complete work; never repeat or roll them back.
- Authentication expiry moves the Job to `AuthenticationRequired`, clears authenticated secrets
  through the canonical logout path, deletes nothing, and allows the same Job to resume after login.
- Locking moves the Job to `WaitingForUnlock`, deletes nothing further, and allows the same Job to
  resume after unlock.
- A different active Vault, Account, server origin, Vault ID, Root Key, or active Generation context
  fails the Job with `VAULT_CONTEXT_CHANGED`. Never redirect the Job to the newly active context.
- A stale-Replica conflict or a remote Generation different from the local active Generation aborts
  the run before deletion. Storage relief is unavailable until stale resolution completes.
- After the synchronization attempt, enumerate the active server Generation and require stable
  Generation ID/number across every page and a final head recheck. Build an in-memory lookup using
  only opaque Object ID, broad Object type, encrypted byte length, and ciphertext SHA-256.
- After synchronization and before proof, persist the exact local `StoredVaultHeadV1` and remote
  Generation identity on the Job. Every later checkpoint transition and restart reconciliation
  must re-read and match both fences; drift aborts before any further wrapper deletion.
- A local wrapper is verified for eviction only when:
  - its authenticated descriptor Role is eligible;
  - its immutable local Artifact Object record matches the descriptor reference;
  - its wrapper exists and hashes to the Object record's exact length and checksum;
  - the active server Generation contains an `Artifact` record with the same ID, length, and
    checksum; and
  - the owning `BundleRegistered` Event, Bundle Descriptor Object, and exact Event dependency
    closure are active server members.
- The server's finalized immutable record and active membership are the approved durable-copy
  proof. Do not download the complete wrapper merely to prove the server still has the bytes.
- A locally valid candidate that fails remote membership, remote metadata, or dependency-closure
  proof is retained locally and recorded as skipped. One skipped candidate does not prevent other
  verified candidates from being evicted.
- An unexpectedly missing/corrupt candidate wrapper or an authenticated descriptor/Object mismatch
  is local corruption, not a skip. Fail the Job with the owning integrity outcome, create no
  `RemoteOnly` row for it, and perform no later candidate deletion in that run.
- Before removing one wrapper, persist its checkpoint as `Evicting` with the expected Object ID,
  encrypted length/checksum and remote Generation identity, bound to the Job's persisted local-head
  fence. Only then remove the canonical OPFS file and atomically create the `RemoteOnly`
  availability record while marking the checkpoint `Evicted`.
- Check cancellation between candidates. Do not interrupt an IndexedDB transition or OPFS file
  operation halfway through its recovery protocol.
- On success or cancellation, report verified candidates, evicted candidates, skipped candidates,
  freed encrypted bytes, retained candidate bytes, and the stable public reason counts. Do not
  expose Object IDs, checksums, server paths, or tokens to the UI.
- Map persisted skip reasons to these public groups: `NotRemoteMember` → `Not yet stored on the
server`, `RemoteMetadataMismatch` → `Server copy did not match`, and
  `DependencyClosureUnavailable` → `Capture history was not fully stored`. Show aggregate counts
  only. Integrity failures use the Job error presentation rather than a skip group.

## 3.4 Repeat, cancellation, and restart

- A completed run may be followed immediately or later by another run. Already-remote-only
  wrappers are not candidates and do not contribute to the estimate or result.
- A cancelled run retains every completed eviction and leaves every unstarted/skipped wrapper local.
  It ends in `Cancelled`; startup must not resume it automatically. The user may start a fresh run,
  which recomputes current truth.
- A Worker restart while `Created`, `Running`, `WaitingForUnlock`, or
  `AuthenticationRequired` reloads the same Job and checkpoints. `Running` resumes automatically
  after startup reconciliation; the waiting states resume only after their named condition is met.
- Startup handles an `Evicting` checkpoint as follows:
  - local wrapper present and valid: repeat removal, then commit `RemoteOnly`;
  - local wrapper absent and checkpoint metadata matches the immutable Object record: commit
    `RemoteOnly`;
  - local wrapper present but corrupt or immutable metadata differs: fail with integrity error and
    do not mark it remote-only; and
  - neither a matching checkpoint nor `RemoteOnly` record exists: absence remains corruption.
- A failed run retains its checkpoints for sanitized diagnosis until the next confirmed run. That
  run first reconciles any `Evicting` checkpoint, removes the old terminal Job/checkpoints, and
  recomputes current truth; it never treats a skipped or failed candidate as remote-only.

## 3.5 On-demand access

- An Artifact remains authoritatively `Present` whenever its descriptor reference and Object record
  exist. Local availability is a separate field: `Local` or `RemoteOnly`.
- `NotProduced` and capture-time `Failed` retain their existing meanings and never gain an
  availability field.
- Opening a local Artifact uses the existing authenticated local stream.
- Opening a remote-only Artifact requires the same synchronized Vault to be active and unlocked,
  the Account to be authenticated, and the current server context to own the matching Vault.
- For an ordinary active Replica, request an active-record download ticket. For a stale Replica's
  Complete Export, request the exact Recovery Snapshot Generation download ticket.
- Validate ticket response Object ID, broad type, encrypted length, and ciphertext checksum against
  the immutable local Artifact Object record before reading bytes. Stream with bounded memory and
  verify wrapper length/checksum plus every authenticated Artifact frame and final plaintext
  length/checksum before reporting success.
- Ordinary preview, inspection, or download first attempts to write and verify the encrypted wrapper
  into the local Artifact Store. After commit, delete its `RemoteOnly` record, open plaintext from
  the local wrapper, publish one application-state invalidation, and leave it local until a later
  cleanup run.
- If local preparation fails specifically with `STORAGE_QUOTA_EXCEEDED`, delete the partial wrapper,
  acquire a fresh download ticket, and perform the requested read transiently. Do not reuse the
  consumed stream, buffer the full encrypted wrapper, clear `RemoteOnly`, or evict another Artifact.
- A transient screenshot preview may continue using the existing bounded plaintext Blob behavior
  for the current screenshot size limit. MHTML and other downloads continue to stream through the
  native save boundary and abort the partial destination on failure.
- Authentication, offline, server unavailability, missing active/recovery membership, remote
  integrity failure, local corruption, user cancellation, and quota fallback are distinct outcomes.
  A remote-only network failure is not `BUNDLE_INVALID`.
- When the Artifact cannot be retrieved, keep it `RemoteOnly`, show a retryable message, and retain
  locally available Library metadata and compact Artifacts.

## 3.6 Sign-out and offline behavior

- Signing out remains allowed when remote-only wrappers exist.
- Before sign-out, show a standard warning that names the remote-only Artifact count and explains
  that those payloads will be unavailable until the same Account on the configured server is
  authenticated again. The user may continue or cancel sign-out.
- Sign-out still erases Account secrets and preserves device slots, encrypted Vault authority,
  server origin, non-secret Account/Vault association, availability records, and locally retained
  wrappers.
- While signed out or offline, Library cards, thumbnails, metadata, compact Artifact inspection,
  and locally available heavy Artifacts continue to work. A remote-only action offers sign-in or
  retry rather than rendering the Vault corrupt.

## 3.7 Ordinary synchronization

- Normal synchronization must preserve one-shot cleanup. An existing immutable Artifact Object
  with a matching `RemoteOnly` row satisfies local Replica completeness; Pull must not download its
  wrapper merely because the OPFS file is absent.
- An Artifact first learned from a remote Generation still downloads and installs locally under the
  current full-local default. It is eligible only for a later user-confirmed cleanup run.
- When publishing a later local Generation that retains a remote-only Artifact, Upload reuses the
  current server's exact committed Object after verifying ID, broad type, encrypted length, and
  checksum. It must not request a nonexistent local wrapper. If the server cannot prove/reuse that
  Object, synchronization fails safely rather than creating an incomplete Generation.
- A matching `RemoteOnly` row plus a valid local wrapper is interrupted-restoration state. Startup
  or synchronization verifies the wrapper and clears the row. A missing wrapper without a matching
  availability row or in-progress eviction checkpoint remains corruption.
- Pull/activation removes availability rows for Objects that no longer belong to the installed
  authoritative Replica. It never copies availability state from the server.
- Bootstrap on a new device, `FastForwardLocal`, and explicit stale discard intentionally install a
  complete local Replica. These are the only synchronization paths in this plan that clear all
  installed Objects' remote-only state by downloading their wrappers.

# 4. Canonical Local Persistence

## 4.1 Authority boundary

- `StoredArtifactObjectV1` remains immutable and unchanged. It continues to bind the Artifact Object
  ID to the exact encrypted wrapper length and checksum.
- Bundle Descriptors remain immutable and unchanged. Do not add availability, server origin,
  download state, cache policy, or local path to an Artifact reference.
- Availability and storage-relief Jobs are local operational state. They are not included in Vault
  Generation reachability, Event dependencies, synchronization, Backup, Export, Import, or
  Projection replay.
- The server never commands eviction and never receives local availability.
- A `RemoteOnly` record proves only that this device intentionally removed a wrapper after the
  recorded verification boundary. It does not make a server record authoritative and does not
  weaken end-to-end integrity checks during retrieval.

## 4.2 Initial IndexedDB stores

Add these stores in `apps/browser-extension/src/drivers/indexeddb/schema.ts`:

- `artifact_availability`, keyed by `[vaultId, artifactObjectId]`; and
- `storage_relief_jobs`, keyed by `[vaultId, jobId]`; and
- `storage_relief_checkpoints`, keyed by `[vaultId, jobId, artifactObjectId]`.

Do not overload `objects`, `synchronization_checkpoints`, `vacuum_jobs`, `export_jobs`, or
`capture_jobs`. Add all stores to Vault deletion, Workspace replacement, stale-Replica replacement,
and test cleanup transactions where applicable.

Define the sole canonical persisted records:

```ts
interface StoredRemoteOnlyArtifactV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly artifactObjectId: string;
  readonly markedAt: string;
}

type StorageReliefJobState =
  | "Created"
  | "Running"
  | "WaitingForUnlock"
  | "AuthenticationRequired"
  | "Succeeded"
  | "Failed"
  | "Cancelled";

type StorageReliefJobStage =
  "Synchronize" | "Preflight" | "Evict" | "Checkpoint";

interface StorageReliefJobV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly jobId: string;
  readonly state: StorageReliefJobState;
  readonly stage: StorageReliefJobStage;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expectedServerOrigin: string;
  readonly expectedAccountId: string;
  readonly expectedLocalHead?: StoredVaultHeadV1;
  readonly expectedGenerationId?: string;
  readonly expectedGenerationNumber?: number;
  readonly candidateArtifacts: number;
  readonly candidateBytes: number;
  readonly verifiedArtifacts: number;
  readonly verifiedBytes: number;
  readonly evictedArtifacts: number;
  readonly freedBytes: number;
  readonly skippedArtifacts: number;
  readonly skippedBytes: number;
  readonly cancellationRequested: boolean;
  readonly errorId?: RuntimeErrorId;
}

type StorageReliefCheckpointState =
  "Candidate" | "Verified" | "Evicting" | "Evicted" | "Skipped";

type StorageReliefSkipReason =
  "NotRemoteMember" | "RemoteMetadataMismatch" | "DependencyClosureUnavailable";

interface StorageReliefCheckpointV1 {
  readonly version: 1;
  readonly vaultId: string;
  readonly jobId: string;
  readonly artifactObjectId: string;
  readonly envelopeByteLength: number;
  readonly envelopeChecksum: Uint8Array;
  readonly state: StorageReliefCheckpointState;
  readonly remoteGenerationId?: string;
  readonly remoteGenerationNumber?: number;
  readonly skipReason?: StorageReliefSkipReason;
}
```

Decoder rules SHALL reject unknown fields, versions, states, stages, reasons, malformed UUIDs,
unsafe counters, negative byte lengths, invalid checksums, cross-Vault keys, and impossible
state/field combinations. In particular:

- only `Created`, `Running`, `WaitingForUnlock`, or `AuthenticationRequired` Jobs may be resumable;
- `Created`/`Synchronize` Jobs have the confirmed counters and `Candidate` checkpoints but no local
  head or remote Generation fence; both fences are mandatory from `Preflight` onward;
- only `Verified`, `Evicting`, or `Evicted` checkpoints contain remote Generation identity;
- only `Skipped` checkpoints contain `skipReason`;
- an `Evicted` checkpoint requires a matching `RemoteOnly` record after reconciliation; and
- counters must equal the decoded checkpoint aggregation whenever a Job is read or updated:
  candidate totals include every checkpoint, verified totals include `Verified`, `Evicting`, and
  `Evicted`, evicted totals include only `Evicted`, and skipped totals include only `Skipped`.

## 4.3 Repository and Artifact Store operations

Add narrow repository operations rather than exposing raw stores:

- `createStorageReliefJob` requires the UI-confirmed count/bytes, Runtime-snapshotted local head and
  complete availability set, and Runtime-enumerated candidates; one transaction rejects drift or
  competing management work, then creates the Job lease and complete `Candidate` checkpoint set;
- `saveStorageReliefCheckpoint` enforces legal forward-only transitions and updates aggregate Job
  counters in the same IndexedDB transaction;
- `markArtifactRemoteOnly` commits the availability row and `Evicted` checkpoint together;
- `clearArtifactRemoteOnly` removes exactly one row after a verified local installation;
- `listRemoteOnlyArtifacts`, `isArtifactRemoteOnly`, and `latestStorageReliefJob` are Vault-scoped;
- `requestStorageReliefCancellation` changes only a nonterminal Job; and
- Vault deletion, stale replacement, Import activation, and Vacuum remove availability/checkpoint
  rows only for Objects that cease to belong to the affected local Vault.

Keep at most one nonterminal Job and one latest terminal result per Vault. When a fresh confirmed
run starts, first reconcile any prior `Evicting` checkpoint, then delete the prior terminal Job and
its checkpoints in the same transaction that creates the new Job. The corresponding `RemoteOnly`
rows remain. This bounds operational history without weakening intentional-absence authority.

Extend the local `ArtifactStore` Driver with these bounded operations:

- inspect whether the canonical wrapper file exists;
- stream and verify an existing encrypted wrapper against its immutable Object record;
- remove an exact wrapper idempotently; and
- prepare a remotely downloaded encrypted wrapper without exposing it as complete until its exact
  length/checksum verifies.

Keep network behavior out of the Host Driver. The new Runtime Artifact resolver owns local-versus-
remote selection and consumes the existing `ArtifactStore` plus an authenticated remote transport.

# 5. Runtime Artifact Resolver

## 5.1 Interfaces

Add a Runtime-owned `ArtifactResolver` used by Library, Export, server switching, and stale Export.
Its public inputs SHALL include:

- expected Vault context;
- immutable `StoredArtifactObjectV1`;
- authenticated `ArtifactReferenceV1` when plaintext is requested;
- remote scope: `ActiveGeneration` or `RecoveryGeneration` with the exact Generation ID;
- retention mode: `RestoreLocal` or `Transient`; and
- `AbortSignal`.

Expose separate operations for encrypted and plaintext streams. Do not make Export decrypt and
re-encrypt wrappers; Complete Export requires the original encrypted bytes unchanged.

`RestoreLocal` means attempt a verified local installation and, only for
`STORAGE_QUOTA_EXCEEDED`, automatically retry once with a fresh ticket as a transient stream. Its
result reports `retention: "Local" | "Transient"` so callers render the correct availability.
`Transient` bypasses local installation and never changes availability; Export and Server Switch
always request it.

The remote transport SHALL:

- use the configured current or source server and Account session supplied by the caller;
- create the existing scoped record-download ticket;
- reject redirects, cross-origin ticket drift, malformed metadata, wrong broad Object type, wrong
  Vault/Generation scope, length/checksum mismatch, and undocumented response fields through the
  existing strict HTTP receiver;
- return a bounded `ReadableStream<Uint8Array>`; and
- translate server outcomes into stable Runtime error IDs without exposing server diagnostics.

## 5.2 Stable errors

Add these Runtime error IDs and use them consistently across App responses:

- `STORAGE_RELIEF_AUTHENTICATION_REQUIRED`: the Job is waiting for the same Account to sign in;
- `STORAGE_RELIEF_ESTIMATE_CHANGED`: the confirmed count/bytes no longer match and no Job started;
- `REMOTE_ARTIFACT_AUTHENTICATION_REQUIRED`: retrieval requires the same Account session;
- `REMOTE_ARTIFACT_OFFLINE`: the Host confirms the browser is offline;
- `REMOTE_ARTIFACT_UNAVAILABLE`: the configured server is unreachable or returns a retryable
  availability failure;
- `REMOTE_ARTIFACT_NOT_FOUND`: the exact active/recovery membership or retained Recovery Snapshot
  no longer exists;
- `REMOTE_ARTIFACT_INTEGRITY_FAILED`: remote metadata or bytes fail verification; and
- `STALE_REPLICA_DISCARD_FAILED`: server replacement did not activate and stale state remains.

Continue to use `VAULT_LOCKED`, `VAULT_BUSY`, `VAULT_CONTEXT_CHANGED`,
`STORAGE_QUOTA_EXCEEDED`, `SYNCHRONIZATION_INTERRUPTED`, `SYNCHRONIZATION_INTEGRITY_FAILED`, and
`SYNCHRONIZATION_CONFLICT` where their existing meaning is exact. An aborted Artifact request is a
caller-controlled cancellation result, not a new error ID. Remove `RECOVERY_FORK_FAILED`.

Expected remote availability failures must not be collapsed into `BUNDLE_INVALID`.
`BUNDLE_INVALID` remains the outcome for authoritative descriptor/Object disagreement or an
unmarked missing/corrupt local wrapper.

# 6. Application Protocol and Live State

## 6.1 App Commands

Add these unversioned App requests, each carrying `expectedVaultId`:

- `GetStorageReliefEstimate` returns local candidate Artifact count and encrypted bytes;
- `StartStorageRelief` carries the displayed `candidateArtifacts` and `candidateBytes`, creates the
  one active Job only if they still match, and returns its Job ID;
- `CancelStorageRelief` carries the Job ID and requests cancellation; and
- `DiscardStaleReplica` carries `exportDecision: "Exported" | "SkipConfirmed"`.

Remove `ResolveStaleReplica`. `DiscardStaleReplica` returns `null`; it never returns a fork Vault ID.

Validate exact allowed keys, UUIDs, discriminants, safe counters, and required Vault context in
`isAppRequest`. Do not accept old request names or ignored extra properties.

## 6.2 View models

Expose an optional `latestStorageReliefJob` in `AppState` with only:

- `jobId`;
- `state`: `Running`, `WaitingForUnlock`, `AuthenticationRequired`, `Succeeded`, `Failed`, or
  `Cancelled`;
- `stage`: `Synchronizing`, `Checking server copies`, `Freeing browser storage`, or `Finishing`;
- candidate, verified, freed, and skipped counts/bytes;
- `cancellationRequested`; and
- optional stable `errorId`.

Do not expose Account IDs, server origins, Vault/Generation/Object/Event identifiers, checksums,
paths, tickets, or tokens through the view model.

Extend Artifact detail output without overloading production state:

```ts
interface ArtifactDetailItem {
  // Existing fields remain.
  readonly availability?: "Local" | "RemoteOnly";
}
```

`availability` is present only when `state === "Present"`. `canPreview`, `canInspect`, and
`canDownload` continue to describe semantic capability; the UI separately handles whether access
requires retrieval.

## 6.3 Invalidation

- Publish one canonical payload-free invalidation after Job creation, each durable stage/counter
  transition, cancellation request, terminal result, `RemoteOnly` commit, successful local
  restoration, sign-out, and stale-Replica activation.
- Every open surface subscribes before its initial fetch, refetches canonical state, validates the
  active Vault context, and generation-guards rendering.
- Coalesce progress bursts without dropping the final invalidation.
- Lock, sign-out, active Vault replacement, or stale activation immediately aborts Artifact sessions,
  revokes Blob URLs, clears decrypted detail/inspection state, and discards pending UI renders.

# 7. Cross-Workflow Requirements

## 7.1 Complete Export

- Complete Export remains complete. Never silently convert it to Selective because wrappers are
  remote-only.
- Replace direct `ArtifactStore.openEncrypted` calls in Export preparation, validation, and package
  iteration with `ArtifactResolver.openEncrypted(..., Transient)`.
- For a current Replica use active-Generation downloads. For a stale Replica use its exact server
  Recovery Snapshot Generation.
- Preserve snapshot fencing: validate the Vault head and remote scope before validation, before
  native download, and after package enumeration. A changed local or server Generation returns
  `VAULT_BUSY`/the owning synchronization conflict outcome and deletes the incomplete destination.
- Remote-only wrapper retrieval must remain streaming and must not create local wrappers or clear
  availability records.
- Authentication or Recovery Snapshot expiry fails the Complete Export safely and leaves the stale
  Replica unchanged. The user may reauthenticate, retry, or explicitly skip Export during stale
  discard.
- Complete packages still contain byte-for-byte original encrypted wrappers and import into a fresh
  local-only Vault with every wrapper `Local` and no availability rows.

## 7.2 Vault Vacuum

- Storage relief never changes Vault reachability or history and therefore never creates a Vault
  Generation.
- Local-only Vault Vacuum behavior is unchanged because local-only Vaults cannot contain
  `RemoteOnly` rows.
- Synchronized Vacuum may retain active remote-only Artifact Objects without rehydrating their
  wrappers. Server candidate sealing proves retained active membership; local semantic verification
  still authenticates descriptors, Events, and immutable Artifact metadata.
- When synchronized Vacuum removes Deleted Artifact Objects, delete their availability rows and any
  terminal storage-relief checkpoints in the same local activation transaction that removes Object
  records. OPFS removal remains idempotent for already-remote-only wrappers.
- A storage-relief Job and Vault Vacuum are mutually exclusive through the Vault maintenance lease.

## 7.3 Coordination Server switching

- Keep source authentication and source server access active until candidate promotion, as required
  by Plan 10.
- Replace Upload Runner's direct local Artifact read with `ArtifactResolver.openEncrypted` bound to
  the source context. Local wrappers stream locally; remote-only wrappers stream from the source
  server and upload to the candidate with bounded memory.
- Verify source download metadata and complete candidate upload checksum before recording the
  candidate checkpoint durable.
- If the candidate already contains the exact active member, retain the existing idempotent path and
  do not fetch the source wrapper unnecessarily.
- A source authentication/network/integrity failure before promotion leaves the source context and
  all local availability records unchanged and fails or reauthenticates the same switch Job. Never
  promote a candidate missing one active dependency.
- `PublishLocal`, `FastForwardCandidate`, and same-Generation `Union` preserve remote-only rows after
  successful promotion because the candidate was proven to hold those same Objects.
- `FastForwardLocal` downloads and installs the candidate's complete current Replica under the
  current one-shot retention policy. Atomically clear remote-only rows for successfully installed
  wrappers and remove rows for Objects no longer authoritative.
- A switched Vault resolves future remote-only access only through the promoted server. Do not
  retain a fallback to the source server.

## 7.4 Stale-Replica explicit discard

Replace `StaleReplicaRecoveryService`, `LocalRecoveryForkBuilder`, fork persistence, and fork cleanup
with one `StaleReplicaDiscardService`:

1. Require the existing explicit Conflict Job, exact Vault/Account binding, current remote
   Generation identity, unlocked Root Key, and either successful Complete Export or the existing
   two-part skip confirmation.
2. Display `Discard stale local Replica and use server data`; explain that unpublished local changes
   will be permanently lost and no local recovery Vault will be created.
3. Download and validate the complete current server Replica into staging through the existing
   bounded `RemoteReplicaDownloader`. The replacement follows the one-shot/full-local default and
   therefore installs every current server Artifact wrapper locally.
4. Rebuild and authenticate all Projections before activation.
5. Atomically replace the stale Vault's Generation, head, Events, Objects, Projections, name cache,
   synchronization state, and Artifact availability rows. Clear every old availability row because
   all replacement wrappers were downloaded locally.
6. Only after the IndexedDB authority transaction commits, reconcile OPFS to the replacement
   Artifact ID set and publish invalidation.
7. On restart before activation, remove only uncommitted replacement wrappers and return the same
   synchronization Job to `Conflict`. After activation, startup retains the server Replica and
   completes idempotent cleanup.

Remove `recoveryForkVaultId`, `PrepareRecoveryFork`, fork name-cache preparation, recovered-Vault
directory writes, and `{ forkVaultId }` App results. Rename remaining stages to
`PrepareServerReplacement` and `ActivateServerReplacement`; do not preserve old stage aliases.

The stale dialog continues to recommend Complete Export. If the user declines it, require both:

- `I understand that I am declining the recommended encrypted Export`; and
- `I understand that this stale local Replica and any unpublished changes will be permanently
discarded`.

Do not offer silent discard, automatic timeout, or a partial replacement.

# 8. UI and Accessibility Contract

Follow `apps/browser-extension/DESIGN.md`; this feature extends the existing quiet archival-tool
surface and introduces no new framework or visual language.

## 8.1 Storage maintenance states

Render and inspect all of these states:

- resting with nonzero local candidate count/bytes;
- resting with nothing to free;
- local-only Vault guidance;
- standard confirmation;
- synchronizing;
- checking server copies;
- freeing storage with item and byte progress;
- cancellation requested;
- waiting for unlock;
- authentication required;
- completed with exact freed/skipped counts and bytes;
- cancelled after partial safe completion;
- offline or server unavailable with no deletion;
- stale-Replica conflict with no deletion; and
- integrity failure with retained local copy where available.

The Cancel control remains keyboard reachable while cancellation is possible and becomes disabled
after request persistence. Progress uses native semantics and a polite live region. Color is never
the only state signal. Do not expose per-Artifact identifiers.

## 8.2 Artifact detail states

- Artifact rows show `Present · Local` or `Present · Remote only` beside the existing MIME type and
  plaintext size.
- A remote-only full screenshot retains the current automatic preview behavior when Capture detail
  opens. Show `Retrieving screenshot…` until verified local restoration or transient rendering
  completes.
- Existing Inspect and Download controls remain visible for remote-only Artifacts. Their accessible
  description announces that retrieval is required.
- Authentication-required, offline, unavailable, integrity-failure, and quota-transient messages
  render in place without shifting unrelated metadata/actions.
- After successful local restoration, the row and every other open surface update to `Local`
  without reload.
- Cancellation/navigation aborts the remote request, clears partial files and plaintext chunks,
  closes the Artifact session, and restores focus predictably.

## 8.3 Sign-out and stale discard

- The sign-out warning appears only when the synchronized Vault has at least one remote-only row.
- The stale dialog removes every claim that a local recovery Vault will be created.
- Preserve the Export-first visual hierarchy, both skip acknowledgments, progress/busy state,
  retryable failure, and focus restoration.
- Inspect desktop and 390 px narrow layouts for wrapping, overflow, control dimensions, focus,
  dialog scrolling, and live announcements.

# 9. Security and Failure Invariants

- Plaintext, plaintext checksums, Artifact Role, MIME type, Capture status, availability, filenames,
  local paths, and content-derived metadata never cross the Coordination Server boundary.
- Server logs, Rails rows, error bodies, Action Cable payloads, Job diagnostics, and browser logs
  contain none of the above and no credentials, transfer capabilities, keys, or decrypted content.
- Download tickets remain short-lived, scoped, unguessable, digest-only at rest, Account-bound, and
  single-purpose.
- The Runtime validates immutable metadata before reading remote bytes and validates ciphertext plus
  plaintext integrity before successful exposure.
- A network 200 with empty, truncated, overlong, reordered, or checksum-mismatched bytes is a hard
  integrity failure, never successful retrieval or remote-only proof.
- A missing wrapper with no `RemoteOnly` row or matching in-progress checkpoint remains corruption.
- A `RemoteOnly` row with a locally present valid wrapper is a recoverable interrupted restoration;
  startup or the next access clears the row after verification.
- Never delete a local wrapper based on Account authentication alone, server Object existence
  outside active membership, a stale synchronization checkpoint, a Recovery Snapshot membership,
  or broad matching counters.
- Never delete or overwrite a partial native download as successful; abort it through the existing
  Download Host boundary.
- Never automatically evict another wrapper to satisfy quota.
- Never use browser `localStorage`, Cache Storage, plaintext diagnostics, or a Projection as the
  availability authority.

# 10. TDD and Evidence Workflow

Create `docs/plans/11-browser-storage-relief-and-remote-artifact-retrieval-tdd-evidence.md` during
implementation. For each behavior:

1. write the smallest failing test first;
2. run it and record the exact RED command, expected failure, and observed failure;
3. implement only enough to make it green;
4. run the focused test and record the GREEN evidence;
5. inject the named failure or regression and prove the test turns red again when practical;
6. refactor while green;
7. run neighboring suites; and
8. record screenshot, trace, database, server, or filesystem evidence without secrets or plaintext.

Do not test prose strings when a semantic state or accessible outcome can be asserted. Visible
behavior tests must assert visibility and meaningful dimensions, not DOM presence alone.

## 10.1 Unit tests

Add failing tests for:

- exact eligible Role selection and inclusion of Active plus Deleted Captures;
- exclusion of compact Roles and already-remote-only wrappers;
- exact encrypted byte accounting beyond 4 GiB with safe integers;
- remote active-membership and dependency-closure proof;
- local/server metadata mismatch and stable skip reasons;
- legal and illegal Job/checkpoint transitions;
- cancellation between candidates and repeat-run behavior;
- `Evicting` startup reconciliation for file-present/file-absent/corrupt cases;
- unmarked missing wrapper remaining `BUNDLE_INVALID`;
- Pull preserving an existing remote-only wrapper, Pull installing a newly learned wrapper locally,
  and Upload reusing an exact committed remote-only Object without an OPFS read;
- availability-aware Library detail and decoder strictness;
- local restoration, quota-specific retry through a fresh transient ticket, and cleanup of partial
  wrappers;
- Complete Export selecting active versus Recovery Snapshot scope without clearing availability;
- Server Switch selecting local versus source-remote streams;
- sign-out warning eligibility;
- removal of recovery-fork Commands, stages, results, error IDs, and aliases; and
- explicit stale-discard preconditions and rollback.

## 10.2 IndexedDB and real-browser integration

Extend the existing IndexedDB browser harness with real OPFS behavior. Cover:

- initial canonical stores and strict decoders;
- creation of availability/Job/checkpoint rows under explicit Vault keys;
- transaction abort before `Evicting` persistence;
- Worker/database restart after `Evicting` but before file removal;
- restart after file removal but before `RemoteOnly` commit;
- restart after verified wrapper download but before availability clearing;
- ordinary Pull preserving remote-only rows and installed-wrapper Pull clearing only interrupted
  restoration rows;
- cancellation persistence and no automatic cancelled-Job resume;
- automatic active-Job resume;
- lock/authentication wait and resume;
- Vault switch/context rejection;
- mutual exclusion with Capture, Import, Export, Vacuum, and applying Server Switch;
- atomic stale server-Replica replacement with no recovery-fork Vault rows;
- Import producing only local wrappers; and
- Vacuum/replacement/Vault deletion removing only the correct availability rows.

Each failure test SHALL inspect IndexedDB rows and OPFS filenames directly, reopen the repository,
and assert the same canonical state after restart.

## 10.3 Coordination Server request and synchronization proof tests

No new server route is expected. Extend contract tests to prove existing resources support this
client behavior:

- active-member ticket issuance succeeds only for the authenticated Account's active Generation;
- Recovery Snapshot tickets succeed only for the exact retained superseded Generation;
- unrelated Account, wrong Vault, inactive/nonmember Object, expired recovery, malformed ID,
  consumed/expired ticket, and wrong transfer purpose fail without disclosure;
- returned metadata exactly matches stored length/checksum/type;
- truncated/missing opaque Disk bytes cannot be reported as a successful transfer;
- existing upload finalization and Event closure remain the durability proof used before eviction;
- server switching relays a source-only remote wrapper into the candidate and candidate promotion
  rejects one missing dependency; and
- request/response/log/database audits contain no semantic or plaintext fields.

The Docker synchronization proof SHALL retain two independent clients and add a remote-only round
trip: capture, synchronize, evict on one client, retrieve exact ciphertext/plaintext, and converge
without relying on Action Cable delivery.

## 10.4 Packaged-Chrome journeys

Use real packaged extension pages, real background Workers, real IndexedDB/OPFS, and real independent
Coordination Servers. Do not seed authoritative browser/server state directly for the primary
journeys.

### Journey A: free and restore

1. Create an Account and capture a page with MHTML, full screenshot, thumbnail, text, and structured
   content.
2. Synchronize and record exact local wrapper sizes.
3. Open two Library pages before mutation.
4. Run **Free up browser storage** and confirm.
5. Prove both surfaces show progress and final state without reload.
6. Inspect OPFS: `PRIMARY` and `SCREENSHOT_FULL` wrappers are absent; compact wrappers remain.
7. Trigger another ordinary synchronization pass and prove the remote-only wrappers remain absent.
8. Open Capture detail, observe remote retrieval, verify screenshot pixels/landmarks, and prove the
   full screenshot becomes local on both surfaces.
9. Download the Artifact labeled `MHTML` and compare exact plaintext bytes to the original capture; prove it becomes
   local.
10. Run storage relief again and prove both restored wrappers can be evicted again.

### Journey B: verified subset, cancellation, and restart

1. Create several eligible wrappers with a mix of committed remote membership and deliberately
   unpublished local work through release-excluded fault checkpoints.
2. Prove only the matching committed subset is removed and skipped counts/bytes are exact.
3. Stop the Worker at every checkpoint around one removal and reopen the Library.
4. Prove automatic resume yields one `RemoteOnly` row and no corrupt/ambiguous absence.
5. Cancel a later run after at least one eviction; prove completed work remains remote-only,
   untouched work remains local, and restart does not resume the cancelled Job.

### Journey C: offline, authentication, and quota

1. Evict heavy wrappers, sign out through the warning, and prove compact Library content remains
   usable.
2. Attempt remote access while signed out and offline; verify distinct visible outcomes and no
   corruption claim.
3. Sign in to the same Account and restore successfully.
4. Inject a real/test-host OPFS quota failure after a partial remote write; prove partial cleanup,
   fresh-ticket transient retry, successful preview/download, and retained `RemoteOnly` state.
5. Return malformed/truncated remote bytes and prove no plaintext success, no local restoration,
   and a visible integrity failure.

### Journey D: Complete Export and Import

1. Evict all eligible heavy wrappers.
2. Create a Complete Export and prove remote bytes stream without reappearing in local OPFS.
3. Import the package into a fresh local-only Vault and verify every Artifact is local and exact.
4. Repeat from a stale Replica whose remote-only bytes require Recovery Snapshot tickets.
5. Expire or deny the Recovery Snapshot and prove Export fails safely without changing stale state.

### Journey E: server switching

1. Evict source wrappers.
2. Switch to an empty candidate server and prove source-to-candidate relay with bounded memory.
3. Verify candidate membership/checksums and successful on-demand access after promotion.
4. Repeat with candidate upload interruption, source authentication expiry, source corruption, and
   candidate head race; prove source remains active and no incomplete candidate is promoted.
5. Exercise `FastForwardLocal` and prove the installed candidate Replica is fully local with stale
   availability rows removed.

### Journey F: explicit stale discard

1. Make Browser B stale through synchronized Vacuum from Browser A while B has local unpublished
   work and remote-only wrappers.
2. Prove Browser B is read-only and the dialog offers Complete Export first.
3. Complete Export through the Recovery Snapshot, discard, and verify Browser B atomically matches
   the server with no recovered local-only Vault.
4. Repeat using the two-part skip confirmation and verify the destructive copy names the lost local
   state accurately.
5. Stop the Worker before and after replacement activation; prove rollback before and durable
   server state after.

## 10.5 Rendered visual inspection

Capture and inspect fresh screenshots for every state in section 8 at 1280×900 and 390×844. Drive
focus, confirmation, cancellation, sign-out warning, stale acknowledgments, remote screenshot load,
quota fallback, errors, and success. Check alignment, spacing cadence, typography, wrapping,
clipping, scroll ownership, layout movement, focus visibility, live regions, control dimensions,
accessible names, and the absence of plaintext after lock/context change.

# 11. Release-Excluded Fault Checkpoints

Add test-only checkpoints under the existing `awsm:test-fault-control` namespace:

- `storage-relief:after-job-created`;
- `storage-relief:after-synchronization`;
- `storage-relief:after-candidate-checkpoint`;
- `storage-relief:after-verified-checkpoint`;
- `storage-relief:after-evicting-checkpoint`;
- `storage-relief:after-wrapper-removed`;
- `storage-relief:after-remote-only-commit`;
- `artifact-retrieval:after-partial-local-write`;
- `artifact-retrieval:after-local-verify`;
- `artifact-retrieval:before-availability-clear`;
- `stale-discard:after-server-preparation`; and
- `stale-discard:before-activation`.

Every checkpoint must be absent from production builds. Extend
`apps/browser-extension/scripts/verify-release.mjs` and its tests so release output containing any
storage-relief/retrieval/stale-discard checkpoint fails.

# 12. Documentation Completion

Reconcile all affected documents before completion. At minimum:

- `README.md` and `VISION.md`: describe repeatable local storage relief, remote-only access,
  sign-out/offline consequences, and explicit stale discard without implying server plaintext;
- `docs/plans/01-mvp-prd.md`: update synchronized Vault and stale-resolution acceptance criteria;
- Plans 06, 09, and 10 plus their evidence records: remove current-product claims that Complete
  Replicas always retain every wrapper locally, direct OPFS reads always satisfy Export/server
  switching, or stale resolution creates a Local recovery fork;
- `docs/architecture/glossary.md`: remove `Local recovery fork` as a current canonical concept and
  define remote-only Artifact availability as device-local operational state without making it an
  authoritative domain object;
- `docs/architecture/00-design-principles.md`: retain local-first and fail-safe rules while
  explicitly allowing user-approved server-only encrypted payload retention;
- `docs/architecture/01-system-overview.md`, `05-client-runtime.md`, `07-content-storage.md`,
  `08-synchronization.md`, `10-projection-engine.md`, `15-coordination-server.md`,
  `16-archive-protocol.md`, `19-testing-strategy.md`, and `20-deployment-and-operations.md`:
  reconcile availability, retrieval, server switch, stale discard, diagnostics, and proof journeys;
- `docs/specifications/storage/object-store.md`: distinguish authoritative Artifact Object records
  from local wrapper availability and preserve corruption rules;
- `docs/specifications/bundle/artifact.md` and `bundle/manifest.md` together: keep immutable
  references unchanged while defining allowed device-local remote-only availability;
- `docs/specifications/runtime/storage.md`, `runtime/runtime.md`, `runtime/jobs.md`, and
  `runtime/synchronization.md`: own resolver, Job, maintenance lease, retry, cancellation, and stale
  discard contracts;
- `docs/specifications/protocol/protocol.md`, `messages.md`, `errors.md`, and
  `http-api.openapi.yaml`: verify existing active/recovery downloads own all required wire behavior;
  change OpenAPI only if implementation discovers a real contract gap, never to expose semantic
  eviction data;
- `docs/specifications/portability/import-export.md`, `backup.md`, and `restore.md`: ensure Complete
  Export and any future complete Backup source remote-only wrappers, and that Import/Restore never
  persists device-local availability from a source package; and
- `ROADMAP.md`: remove implemented manual eviction/on-demand retrieval/basic quota UX from the web
  initiative, retain future persistent profiles/automatic policies/pinning/production quota work,
  and replace `Recovered Local-Only Vault Journey Proof` with a future preserve-first stale-Replica
  recovery initiative that retrieves Recovery Snapshot payloads and re-encrypts a complete fresh
  local-only Vault.

Search the entire repository for `Complete Replica`, `local recovery fork`, `recoveryForkVaultId`,
`RECOVERY_FORK_FAILED`, `ResolveStaleReplica`, `PrepareRecoveryFork`, `Missing Artifact`,
`openEncrypted`, `selective local retention`, `remote-only`, `eviction`, and `pinning`. Resolve every
stale claim rather than leaving contradictory current behavior.

# 13. Implementation Sequence

Follow this order. Each task begins with a failing test, includes implementation, and ends with the
named focused verification before the next task begins.

## Phase 1: Canonical contracts and persistence

1. Add RED decoder/protocol tests for availability, storage-relief Jobs/checkpoints, App Commands,
   view models, error IDs, and removal of recovery-fork shapes.
2. Add the initial IndexedDB stores, strict persisted types/decoders, Vault-scoped keys, aggregate
   invariants, and repository operations.
3. Add RED real-OPFS integration tests and implement Artifact Store presence/verification/removal
   primitives.
4. Add restart reconciliation for `Evicting` and interrupted restoration before implementing the
   user-triggered Job.

## Phase 2: Remote resolver

1. Add RED active/recovery ticket metadata and malicious-stream tests around a narrow remote
   transport.
2. Implement encrypted local/remote selection and exact ciphertext verification.
3. Implement plaintext local restoration, quota-specific cleanup and fresh-ticket transient retry,
   cancellation, and typed outcomes.
4. Route Library Artifact reads through the resolver and make availability/error unit tests green.

## Phase 3: Ordinary synchronization awareness

1. Add RED Pull tests that distinguish matching remote-only absence, unmarked corruption, and a
   newly learned remote Artifact.
2. Add RED Upload tests for exact server Object reuse and refusal to publish when a retained
   remote-only Object is unavailable or mismatched.
3. Implement availability-aware Pull/Upload and activation cleanup without changing the full-local
   default for newly learned Objects.
4. Run the ordinary two-client convergence proof before implementing deletion.

## Phase 4: Storage-relief Job

1. Add RED eligibility, estimate, remote-proof, skip, cancellation, lease, and resume tests.
2. Implement the synchronize/preflight/evict/checkpoint state machine and background startup resume.
3. Add App Commands, state projection, invalidation, and cancellation.
4. Inject every fault checkpoint and make the IndexedDB/OPFS restart matrix green.

## Phase 5: Library and sign-out UI

1. Add RED UI model tests for maintenance placement, estimates, progress, results, remote-only rows,
   retrieval, and sign-out warning.
2. Implement the Storage maintenance section beside conditional Vacuum.
3. Implement visible remote-only retrieval/restoration/transient/error states.
4. Add multi-surface invalidation tests and visually inspect desktop/narrow states before continuing.

## Phase 6: Complete Export, Vacuum, and server switching

1. Add RED Export tests for active/recovery remote-only streams, snapshot drift, package abort, and
   no rehydration; then route Export through the resolver.
2. Add RED Vacuum tests for retained remote-only Objects and reclaimed availability cleanup; then
   update atomic activation.
3. Add RED Server Switch tests for source relay, source failure, candidate completeness, successful
   promotion, and FastForwardLocal availability reconciliation; then replace direct OPFS upload
   reads.
4. Run affected unit, integration, and two-server proof suites before stale-flow work.

## Phase 7: Replace stale recovery with explicit discard

1. Add RED tests for the new Command, two-part confirmation, complete server staging, atomic
   activation, restart behavior, and absence of a fork.
2. Implement `StaleReplicaDiscardService` and replacement transaction.
3. Delete recovery-fork builder, types, stages, error, UI copy, result handling, and obsolete tests.
4. Add current/recovery-scope Complete Export coverage and the packaged stale-discard journey.

## Phase 8: Packaged journeys and documentation

1. Implement Journeys A–F independently and preserve every discovered regression.
2. Capture and inspect all required visual states.
3. Prove release output excludes fault controls and test-only permissions.
4. Reconcile every document in section 12 and rewrite Roadmap entries to contain future work only.
5. Delete/recreate all pre-release data and run the complete verification matrix.

# 14. Acceptance Criteria

The work is complete only when all are true:

- users can run **Free up browser storage** repeatedly whenever eligible local wrappers exist;
- only authenticated, locally valid, active-server-member `PRIMARY` and `SCREENSHOT_FULL` wrappers
  are removed;
- Active and Deleted captures are included while compact Artifacts remain locally usable;
- skipped/unpublished/mismatched wrappers remain local and are reported accurately;
- the server may become the sole copy only after the explicit confirmation and exact proof;
- every intentional absence has a valid `RemoteOnly` record and every unexplained absence remains
  corruption;
- cancellation and every injected Worker restart converge without data loss or ambiguous state;
- ordinary access restores locally, quota failure streams transiently, and integrity failure exposes
  no successful partial content;
- Complete Export remains complete and does not rehydrate remote-only wrappers;
- synchronized Vacuum, sign-out, server switching, and FastForwardLocal behave exactly as sections
  7.2–7.3 require;
- stale resolution performs export-first explicit discard, atomically installs verified server
  state, and never creates a recovery-fork Vault;
- all open surfaces update without reload and discard plaintext on context changes;
- real transfers remain bounded-memory beyond 4 GiB;
- server requests, storage, logs, and diagnostics reveal no plaintext or semantic Artifact data;
- packaged Journeys A–F pass against real browser/server/storage boundaries;
- every required desktop/narrow state has fresh inspected screenshot evidence;
- production output contains no fault-control namespace or test-only permission;
- all introduced formatter, linter, type, build, test, and documentation warnings/errors are
  resolved; and
- canonical documentation and Roadmap contain no stale recovery-fork or Complete-local-Replica
  claims.

# 15. Verification Commands

Discover any manifest changes before execution, but at minimum run:

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
  docs/plans/11-browser-storage-relief-and-remote-artifact-retrieval.md \
  docs/plans/11-browser-storage-relief-and-remote-artifact-retrieval-tdd-evidence.md \
  README.md VISION.md ROADMAP.md \
  docs/plans/01-mvp-prd.md \
  docs/plans/06-independent-artifact-vault-graph-and-selective-export.md \
  docs/plans/09-account-authentication-and-full-vault-synchronization.md \
  docs/plans/10-git-like-synchronization-server-switching.md \
  docs/architecture/*.md \
  docs/specifications/**/*.md \
  docs/specifications/protocol/http-api.openapi.yaml

git diff --check
rg -n "awsm:test-fault-control|storage-relief:|artifact-retrieval:|stale-discard:" \
  apps/browser-extension/.output/chrome-mv3
rg -n \
  "Local recovery fork|recoveryForkVaultId|RECOVERY_FORK_FAILED|ResolveStaleReplica|PrepareRecoveryFork" \
  README.md VISION.md ROADMAP.md docs apps/browser-extension/src apps/browser-extension/tests
```

The release-output `rg` command must return no JavaScript matches. The stale-term search may retain
only the future Roadmap initiative and the new plan/evidence text that explicitly describes removal;
no current-product contract, code, fixture, test name, UI copy, or error may retain the discarded
behavior.

Before committing, follow `AGENTS.md`: inspect ignored files, stage only the coherent implementation
and documentation, review `git diff --cached --stat`, `git diff --cached --check`, and the full
staged diff, exclude browser profiles/build output/logs/secrets/agent state, and use Conventional
Commits. Recommended coherent commits are:

1. `feat(storage): add remote-only artifact availability`;
2. `feat(storage): free verified browser artifact storage`;
3. `feat(sync): retrieve and relay remote-only artifacts`;
4. `feat(sync): discard stale replicas explicitly`;
5. `test(storage): prove remote artifact lifecycle`;
6. `docs(storage): define remote-backed browser retention`.

Each commit must pass its focused tests and remain independently understandable. Do not claim a
journey, integrity guarantee, or documentation reconciliation before the staged state proves it.
