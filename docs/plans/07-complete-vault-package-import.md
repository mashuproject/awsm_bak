# Complete Vault Package Import

**Document:** `docs/plans/07-complete-vault-package-import.md`
**Status:** Approved implementation plan
**Owner:** Engineering
**Last Updated:** 2026-07-19
**Depends On:** `docs/plans/03-multiple-vault-management.md`,
`docs/plans/05-passphrase-protected-vault-export.md`,
`docs/plans/06-independent-artifact-vault-graph-and-selective-export.md`, and the architecture and
specifications reconciled by this plan

---

# 1. Purpose

This is the decision-complete implementation plan for importing one canonical Complete AWSM Vault
Package into the browser extension. The implementer is expected to begin from a cold checkout with
no prior conversation context. Do not reopen decisions recorded here.

The completed feature lets a user:

1. choose `Import existing Vault` during first-launch onboarding or `Import Vault` from the Library;
2. select one `.awsm` Vault Package without loading the package into memory;
3. enter and retry the exact Export passphrase without selecting or staging the file again;
4. watch or cancel a live, persistent Import Job;
5. have the entire package authenticated before any destination Vault write;
6. add the contained Vault to the local Workspace with all authoritative history and identifiers
   preserved;
7. use fresh device-local key material rather than importing the source device's credentials; and
8. unlock the imported Vault later with `Unlock on this device`.

Import remains distinct from Restore and synchronization:

- **Import** creates the Vault contained in a manually exchanged Vault Package.
- **Restore** reconstructs a recovery point from Backup Sets.
- **Synchronization** reconciles replicas of an already participating Vault.

Import SHALL NOT replace, merge into, update, repair, or synchronize an existing Vault. It SHALL
NOT reinterpret a Selective package as complete or turn an authenticated omission into corruption.
The first Import implementation accepts only Complete packages because the current local Vault
model requires every referenced Artifact wrapper to be locally available. Selective Import remains
future work coupled to the canonical local availability and retention model.

The Vault Package format does not change. Continue to use export format version `1`, the exact
ZIP64 layout, passphrase key envelope, Manifest, Artifact graph, coverage rules, and strict
validator defined by `docs/specifications/portability/import-export.md` and Plan 06.

---

# 2. Scope and Non-Goals

## 2.1 In scope

- first-launch `Create Vault` versus `Import existing Vault` choice;
- Import entry points in the empty and populated Library;
- bounded-memory Host staging of a selected encrypted package in temporary OPFS storage;
- a workspace-scoped persistent Import Job and exclusive management lease;
- exact passphrase authentication with in-place retry;
- reuse and refactoring of the canonical read-only Vault Package validator;
- Complete-package enforcement as a capability boundary, not a corruption rule;
- preservation of the package's Vault, Generation, Event, Object, Bundle, Collection, and Artifact
  identities and authoritative bytes;
- fresh local Device ID, non-exportable device key, device slot, and verifier;
- byte-for-byte encrypted Artifact wrapper installation;
- Vault name, Library, Collection, and thumbnail Projection rebuild;
- one atomic IndexedDB activation of the imported Vault and rebuilt derived state;
- cancellation, rollback, restart cleanup, quota handling, and live invalidation;
- unit, Chromium integration, packaged-extension E2E, security, and rendered visual evidence; and
- complete documentation and Roadmap reconciliation after implementation.

## 2.2 Explicitly deferred

- Selective Import and persistent `NotLocallyAvailable` Artifact state;
- remote retrieval of authenticated omissions;
- retention profiles, pinning, eviction, and cache budgets;
- replacing or overwriting a local Vault;
- merging an imported history with an existing or divergent Vault;
- associating an imported Vault with an Account or Coordination Server;
- synchronization, Device enrollment, Account recovery, and server-backed complete retrieval;
- Backup, Restore, Merge Restore, or disaster-recovery workflows;
- importing plaintext archives or third-party formats;
- renaming a Vault during Import;
- using the Export passphrase as a local Vault unlock credential;
- importing source device slots, device keys, local metadata, Jobs, Commands, outcomes, Projections,
  Materializations, caches, cursors, or diagnostics; and
- package-format migrations, compatibility readers, aliases, negotiation, or fallback behavior.

## 2.3 Pre-release data policy

This feature adds the sole canonical `import_jobs` IndexedDB store to the current pre-release local
schema. Do not add an IndexedDB migration or increment names/types to imply a successor product
format. Clear and recreate existing extension development storage before verification. Tests,
fixtures, code, and documentation SHALL expose only the resulting canonical schema.

---

# 3. Fixed Product Decisions

## 3.1 Accepted package coverage

- Accept only a package whose authenticated Manifest declares `coverage: "Complete"` and has zero
  omissions.
- The current user-facing Export always emits such a package, so Export-to-Import portability is
  complete within the implemented product.
- A valid `Selective` package fails with `SELECTIVE_IMPORT_UNSUPPORTED`, not
  `IMPORT_PACKAGE_INVALID` and not `ARTIFACT_INVALID`.
- Do not add unavailable Artifact rows, placeholder payloads, omission records to local authority,
  or a Selective compatibility branch.

## 3.2 Identity collisions

- Preserve `manifest.originatingVaultId` as the local Vault ID.
- If any Workspace directory or Vault-authority record already exists for that Vault ID, reject the
  Import with `VAULT_ALREADY_EXISTS` after authenticating and validating the package and before
  destination writes.
- Reject even when the existing local Vault is byte-for-byte identical to the package.
- Do not offer Replace, Merge, Update, Keep Both, or generate a new Vault ID.
- Duplicate human-readable Vault names remain permitted. Existing short-ID disambiguation in the
  Vault picker continues to handle them.

## 3.3 Completion state

- Every imported Vault is committed with `manuallyLocked: true`.
- When another Vault is active, leave it selected and preserve its current lock/unlock state.
- When the Workspace has no active Vault at commit time, select the imported Vault but leave it
  locked.
- Do not retain the recovered Root Key after Import merely to open the new Vault.
- A later `Unlock on this device` SHALL unwrap the newly created local device slot and open the
  imported Vault normally.

## 3.4 Confirmation and passphrase behavior

- Import commits immediately after successful authentication and complete validation. There is no
  post-validation preview or second confirmation.
- The passphrase is exact input. Do not trim, normalize, case-fold, or otherwise transform it.
- Limit accepted input to at most 1,024 UTF-8 bytes. Do not require the Export-time 12-code-point
  minimum when attempting Import; a shorter value is simply unable to authenticate a canonical
  package.
- Wrong passphrase, substituted key envelope, and key-envelope authentication failure share the
  same public `IMPORT_AUTHENTICATION_FAILED` result.
- An authentication failure leaves the Job non-terminal at `Authenticate` and retains the staged
  encrypted file so the user can retry in place.
- Clear the DOM field immediately after dispatch, never persist the passphrase, and release all
  Runtime string references in `finally`.

## 3.5 Concurrency

- At most one non-terminal Import Job exists in one Workspace.
- Beginning Import acquires a Workspace-wide management lease before package staging.
- Read-only Library list, detail, and Artifact reads MAY continue while Import runs.
- Block Create, Select, Rename, Lock, Unlock, Capture, Delete, Restore, Merge, Move, Extract, Undo,
  Vault Vacuum, Export, and another Import until Import is terminal.
- `Cancel Import` is the only permitted mutating management action during the lease.
- The storage transaction, not disabled controls, is the correctness boundary. Every raced mutation
  SHALL fail with `VAULT_BUSY` without writing.
- Import cannot begin while the active Vault already has a non-terminal Capture, Export, or Vacuum
  operation.

## 3.6 First launch

- Keep `Create Vault` as the primary first-launch popup action.
- Add a secondary `Import existing Vault` action that opens the full Library page at
  `library.html?import=1` in a new tab.
- Do not run the file picker or Import workflow inside the browser-action popup; popup lifetime is
  too short for staging, passphrase retry, progress, or error recovery.
- The no-Vault Library state SHALL present both `Create new Vault` and `Import existing Vault`
  directly. It SHALL no longer instruct the user to return to the toolbar popup.
- The `import=1` route opens the Import dialog once after canonical state is fetched. Refresh or
  reconciliation SHALL NOT repeatedly reopen a dismissed dialog.

---

# 4. Terminology, Authority, and Security Invariants

Use the glossary's canonical capitalization: Vault, Vault Package, Object, Event, Bundle, Artifact,
Projection, Materialization, Runtime, Host, Driver, Service, Import, Export, and Vault Generation.

Use these feature terms consistently:

- **Import source:** the user-selected encrypted `.awsm` file.
- **Import staging file:** the temporary OPFS copy named only by the Import Job ID.
- **Imported Vault:** the new local Vault created from the package's authoritative graph.
- **Prepared Artifact wrapper:** an encrypted wrapper copied into its destination Vault directory
  before the matching Object record becomes authoritative.
- **Import lease:** the workspace-scoped exclusion record represented by a non-terminal Import Job.

Preserve these invariants:

1. Package validation completes before writing any destination Vault record or Artifact wrapper.
2. The user-selected encrypted package may be copied to temporary Host storage before validation;
   it is not destination Vault authority.
3. Import never changes an authoritative identifier or encrypted authoritative byte.
4. Import never creates, edits, or appends an Event.
5. Import never creates a new Vault Generation or rewrites the imported head.
6. Import never stores an incomplete local Bundle graph.
7. Import never treats missing Complete-package content as unavailable; it is invalid.
8. Import never persists plaintext authoritative content.
9. The Export passphrase, derived passphrase key, and raw Root Key remain memory-only.
10. The raw Root Key never crosses from the Runtime to the UI or a general Host message.
11. Source device keys, slots, Device IDs, local lock state, and verifier never enter the imported
    Vault.
12. A fresh local Device ID, non-exportable device key, device slot, and verifier are created.
13. Projections and name caches are rebuilt locally and are never copied from the package.
14. The source staging file and every pre-commit prepared wrapper are removed after failure or
    cancellation.
15. A successful atomic commit makes the prepared wrappers authoritative; cleanup must not delete
    them afterward.
16. No operation crosses a validated Vault-prefixed storage range.
17. Import remains fully offline and never contacts an Account or Coordination Server.
18. Diagnostics reveal no passphrase, key, plaintext, title, URL, Vault name, source filename, or
    decrypted Event/descriptor field.

---

# 5. User Experience and Interaction States

## 5.1 Import entry points

Add `Import Vault` to the Library Vault-management actions. It remains visible when the active Vault
is locked and does not require any active Vault. Disable it whenever another management operation
owns the applicable lease.

The first-launch popup action and empty Library action both enter the same Library-hosted dialog.
Do not create separate Import implementations.

## 5.2 Dialog flow

The Import dialog title is `Import encrypted Vault`. It uses one accessible state machine:

1. **Select**
   - Explain that Import accepts an encrypted AWSM `.awsm` package and adds it as a locked Vault.
   - Use a visible file input with `.awsm` and `application/vnd.awsm.vault+zip` as picker hints.
   - Treat filename and MIME type only as hints; bytes remain authoritative.
   - Show the selected filename only in the live dialog. Never persist or log it.
2. **Acquire**
   - Begin the Import Job and Workspace lease.
   - Stream the selected `File` to Job-derived temporary OPFS storage.
   - Show bytes copied and total bytes, a determinate progress element, and `Cancel Import`.
   - Do not use `arrayBuffer()`, data URLs, a complete base64 value, or runtime-message transfer for
     the package.
3. **Authenticate**
   - Show one password input labeled `Export passphrase` and the staged file size.
   - Explain that the passphrase is not saved and will not unlock the imported local Vault.
   - Submit with `Import Vault`; keep `Cancel Import` available.
4. **Authentication failure**
   - Keep the dialog open, show one indistinguishable authentication error, focus and select the
     empty passphrase input, and retain the staged file.
   - Do not disclose whether the passphrase, key envelope, Manifest binding, or authentication tag
     differed.
5. **Validate / Prepare / Rebuild / Commit**
   - Close the secret-entry form after the passphrase attempt becomes authenticated.
   - Show live Job stage and monotonic bounded progress in the Library management surface.
   - Keep `Cancel Import` available until the commit boundary.
   - Closing the Library tab after authentication does not cancel the accepted background Job.
6. **Success**
   - Announce `Imported <Vault name> as a locked Vault.`
   - If another Vault remains active, show an optional `Switch to imported Vault` action using the
     existing selection flow; switching still locks both contexts as currently specified.
   - If the imported Vault became the only active Vault, render the existing locked state and
     `Unlock on this device` action.
7. **Terminal failure or cancellation**
   - Show a safe actionable message and restore focus to the initiating Import control when it
     still exists.
   - A retry after terminal failure begins a new Job and reselects the file.

## 5.3 Dialog lifetime

The Library owns a short-lived Import acquisition session identified by the random Job ID.

- Closing or navigating away during `Acquire` or while idle at `Authenticate` requests
  cancellation and cleanup.
- If the page disappears while an authentication attempt is still deriving the key and that attempt
  fails, cancel because no surface remains to retry.
- Once authentication succeeds and the Job advances to `Validate`, the background owns the Job and
  continues independently of the initiating page.
- A new or already open Library surface sees the live Job through canonical `AppState` refetch and
  may cancel it.

## 5.4 Accessible behavior

- The first visible actionable control receives focus in every dialog state.
- Authentication feedback uses an alert and is associated with the passphrase input.
- Progress exposes an accessible name, current value, and maximum.
- Disabled controls remain visibly readable and do not collapse.
- Focus returns to the initiating control after cancel/failure when that control remains valid.
- State changes are announced through the existing polite live region.
- Do not use color alone for progress, error, or success meaning.

---

# 6. Public Application and Job Contracts

Application requests, results, view models, and invalidations remain unversioned local transient
contracts. The persisted Import Job carries version `1` because it crosses a persistent boundary.

## 6.1 Requests and results

Add these exact `AppRequest` members:

```ts
{
  readonly type: "BeginVaultImport";
  readonly sourceByteLength: number;
}

{
  readonly type: "ReportVaultImportProgress";
  readonly jobId: string;
  readonly acquiredBytes: number;
}

{
  readonly type: "CompleteVaultImportStaging";
  readonly jobId: string;
}

{
  readonly type: "ImportVault";
  readonly jobId: string;
  readonly passphrase: string;
}

{
  readonly type: "CancelVaultImport";
  readonly jobId: string;
}
```

None carries `expectedVaultId`; Import is Workspace-scoped and works with no active Vault.

Define results:

```ts
interface BeginVaultImportResult {
  readonly jobId: string;
}

interface ImportVaultResult {
  readonly jobId: string;
  readonly vaultId: string;
}
```

`ImportVault` remains pending through authenticated validation, preparation, rebuild, and commit.
An authentication failure rejects that attempt but leaves the Job non-terminal for another
`ImportVault` request using the same Job ID. Every other failure makes the Job terminal.

`ReportVaultImportProgress` SHALL accept only a safe non-negative integer that is monotonic and no
greater than `sourceByteLength`. `CompleteVaultImportStaging` SHALL independently open the Host
file and require its exact byte length before moving to `Authenticate`.

## 6.2 Persisted Import Job

Add the sole canonical persisted type:

```ts
type ImportJobState =
  "Created" | "Running" | "Succeeded" | "Failed" | "Cancelled";

type ImportJobStage =
  "Acquire" | "Authenticate" | "Validate" | "Prepare" | "Rebuild" | "Commit";

interface ImportJobV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly state: ImportJobState;
  readonly stage: ImportJobStage;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sourceByteLength: number;
  readonly acquiredBytes: number;
  readonly completedEntries: number;
  readonly totalEntries: number;
  readonly processedBytes: number;
  readonly totalBytes: number;
  readonly cancellationRequested: boolean;
  readonly destinationVaultId?: string;
  readonly errorId?: RuntimeErrorId;
}
```

Rules:

- `Created/Acquire` begins before staging and owns the Workspace lease.
- `Created/Authenticate` means staging is complete and the Job is awaiting or retrying a
  passphrase.
- `Running` begins only after the Root Key authenticates.
- `destinationVaultId` appears only after the package identity is authenticated.
- Counts and bytes describe encrypted operational data only.
- Stage-local progress is monotonic. Moving to a new stage may reset stage-local counters.
- A terminal Job never keeps the Workspace busy.
- Cancellation is a terminal state, not an error ID.
- Keep only the current/latest Import Job. Beginning a new Job removes a previous terminal Import
  Job in the same transaction.
- Never persist source filename, passphrase, derived key, raw Root Key, Vault name, temporary path,
  or decrypted package summary.

## 6.3 Application and Workspace state

Extend `AppState`:

```ts
interface AppState {
  // existing fields
  readonly latestImportJob?: ImportJobV1;
}
```

Replace the current busy shape with a strict union:

```ts
type WorkspaceBusyState =
  | {
      readonly operation: "Import";
    }
  | {
      readonly vaultId: string;
      readonly operation: "Capture" | "Vacuum" | "Export";
    };
```

Import is intentionally not assigned to the currently active Vault. `vaultManagementView` derives
`Import in progress`, disables mutation controls, and leaves read-only navigation available.

## 6.4 Error identifiers

Add these stable public Runtime error IDs:

- `IMPORT_AUTHENTICATION_FAILED`: passphrase/key-envelope authentication failed; retryable while
  the acquisition session exists;
- `IMPORT_PACKAGE_INVALID`: structure, checksum, reachability, replay, cryptographic content, or
  Complete coverage could not be proven;
- `SELECTIVE_IMPORT_UNSUPPORTED`: package is valid Selective interchange but this local Runtime
  cannot represent authenticated omissions;
- `VAULT_ALREADY_EXISTS`: the authenticated package Vault ID already exists locally;
- `IMPORT_INTERRUPTED`: the Runtime restarted or staging/execution ownership disappeared before
  atomic commit;
- `STORAGE_QUOTA_EXCEEDED`: temporary source or prepared destination storage lacks capacity.

Retain shared `UNSUPPORTED_FORMAT_VERSION`, `VAULT_BUSY`, `STORAGE_TRANSACTION_FAILED`, and
`CRYPTO_AUTHENTICATION_FAILED` where their canonical meanings apply. Map shared validator internals
to Import-specific public IDs at the Import Service boundary. Do not rename Export-facing errors as
part of this feature.

---

# 7. Workspace Lease and State Machine

## 7.1 Lease acquisition

Create a workspace-level Import repository because no destination Vault is trusted when staging
begins. `BeginVaultImport` performs one readwrite IndexedDB transaction that:

1. validates `sourceByteLength` as a non-negative safe integer;
2. loads Workspace metadata;
3. rejects any non-terminal Import Job;
4. checks the active Vault, when present, for non-terminal Capture or Export Jobs and a Vacuum
   lease;
5. deletes the previous terminal Import Job;
6. creates `ImportJobV1` in `Created/Acquire`; and
7. commits the Import lease before returning the Job ID.

The Job ID is a fresh UUID and is the only staging-file name input.

## 7.2 Mutation fencing

Every Runtime mutation performs an early Import-busy check for a fast safe response. Every
readwrite storage transaction that can mutate Workspace or Vault state SHALL also include
`import_jobs` and reject a non-terminal Job with `VAULT_BUSY` before its first write.

At minimum, update the storage boundaries for:

- Vault Create, Select, Rename, automatic locked state, and device Unlock state;
- Capture Job acquisition and atomic registration;
- Library lifecycle and Collection operations;
- Vault Vacuum acquisition and commit;
- Export acquisition; and
- any helper that writes active Workspace or Vault records.

Do not rely on a one-time Runtime check because a request can race lease acquisition.

Refactor automatic Lock and device Unlock ordering so the lease-protected metadata transaction commits
before changing the in-memory Root Key reference. If Import wins the transaction race, Lock/Unlock
returns `VAULT_BUSY` without changing either persistent or in-memory lock state. If Lock/Unlock wins,
its local Root Key change completes as the already-ordered operation before Import proceeds.

## 7.3 Authentication retry transition

`ImportVault` is valid only for the matching non-terminal Job in `Created/Authenticate` with a
complete staging file.

- Set the visible stage to `Authenticate` while deriving and authenticating.
- On `IMPORT_AUTHENTICATION_FAILED`, keep `state: "Created"`, keep
  `stage: "Authenticate"`, clear transient progress, and return the safe retryable error.
- On successful key-envelope authentication, atomically update to `Running/Validate` and continue
  without waiting for user confirmation.
- On invalid structure discovered before key authentication, fail terminally only when it is not
  intentionally indistinguishable from key-envelope authentication under the package contract.
- Once `Running`, a second `ImportVault` request for the same Job is rejected as busy/idempotently
  attached only if an explicit in-memory execution registry already owns it. Do not start a second
  validator.

## 7.4 Cancellation boundary

- Cancellation sets `cancellationRequested: true`, aborts the in-memory controller, and propagates
  through staging, KDF/authentication, ZIP reads, validation, Artifact copying, Projection rebuild,
  and the pre-commit path.
- Cancellation before the IndexedDB commit starts ends as `Cancelled` after cleanup.
- Check cancellation immediately before opening the activation transaction.
- Once activation requests have been scheduled in the transaction, do not report Cancelled. Let the
  atomic transaction succeed or fail and report its actual result.
- Repeated cancellation is idempotent.

---

# 8. Host Staging and Streaming Boundaries

## 8.1 Source staging

Add a Chrome Host adapter shared by the Library page and background Runtime integration. Use the
temporary directory:

```text
awsm-vault-imports/
  <import-job-id>.awsm.tmp
```

Validate the Job UUID before deriving the filename. Never accept a caller-supplied path.

The Library Host SHALL:

1. obtain a `File` through the visible file input;
2. create/truncate the exact Job-derived OPFS staging file;
3. stream `file.stream()` into `FileSystemWritableFileStream` with an `AbortSignal`;
4. retain at most one bounded transfer chunk plus platform buffers;
5. report throttled monotonic byte progress through the Runtime request;
6. close the writable and call `CompleteVaultImportStaging`; and
7. abort and remove the partial file when acquisition fails or is cancelled.

Do not send the File, Blob, FileSystem handle, whole bytes, or whole-package base64 through
`browser.runtime` messaging.

The background Host adapter SHALL open the staged file as an immutable `File`/`Blob` snapshot for
each validation or copy pass and remove it by Job-derived name during cleanup.

## 8.2 Artifact installation

Extend the platform-independent `ArtifactStore` boundary with encrypted-wrapper preparation rather
than putting OPFS logic in the Import Service:

```ts
interface ArtifactStore {
  // existing methods

  prepareEncrypted(input: {
    readonly vaultId: string;
    readonly object: StoredArtifactObjectV1;
    readonly encrypted: ReadableStream<Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<void>;
}
```

`prepareEncrypted` SHALL:

- derive the final opaque destination path from validated Vault/Object IDs;
- fail if a file already exists;
- stream exact encrypted bytes without decryption or re-encryption;
- calculate wrapper byte length and SHA-256 while writing;
- require exact equality with the authoritative Artifact Object record;
- close and re-stat the file before success; and
- remove the file after any error or cancellation.

Use existing explicit `remove(vaultId, objectId)` for per-Object rollback. For restart cleanup, call
`reconcile(destinationVaultId, emptySet)` only after proving the Workspace has no committed
directory entry for that Vault. Never delete a whole directory based solely on an interrupted Job
record.

## 8.3 Memory bounds

- Never buffer an Artifact wrapper or plaintext Artifact wholesale.
- Preserve the existing 16 MiB bound for compact CBOR records and compact text/structured content.
- It is acceptable to retain the validated collection of compact stored Event/Object records and
  prepared Projection records needed for one atomic IndexedDB transaction; memory SHALL remain
  independent of large page-snapshot and screenshot payload sizes.
- Multi-gigabyte test inputs may use sparse/generated streams. Tests must prove counters and peak
  retained transfer buffers without allocating proportional bytes.

---

# 9. Shared Package Validation

## 9.1 Refactor, do not duplicate

The current Export writer calls `validateVaultPackage()` before download. Import SHALL use the same
container parser, key-envelope opener, strict record decoders, authoritative replay, Bundle graph
verification, Artifact streaming verification, structured-content checks, and coverage proof.

Refactor shared validation only where needed to expose a Runtime-internal immutable validated graph.
Do not create an Import-specific permissive decoder or a second Event replay implementation.

The internal validated result SHALL provide enough data for preparation without returning secrets
to application/UI types:

```ts
interface ValidatedCompleteVaultPackage {
  readonly manifest: ExportManifestV1;
  readonly generation: StoredVaultGenerationV1;
  readonly head: StoredVaultHeadV1;
  readonly events: readonly StoredEvent[];
  readonly objects: readonly StoredObjectV1[];
  readonly currentVaultName: string;
  readonly vaultCreatedAt: string;
  readonly rootKey: CryptoKey;
}
```

This is an in-process Runtime result, not a persisted or public versioned format. `rootKey` is a
non-extractable HKDF key used only until preparation completes.

The key-envelope opening scope also retains the raw 32-byte Root Key long enough to provision the
new local device slot and verifier. Keep that raw value private to one Runtime callback/scope and
wipe it in `finally`; do not add it to `ValidatedCompleteVaultPackage` or return it to a Host.

## 9.2 Validation order

Against the completed staging file, Import SHALL:

1. validate ZIP64 signatures, central directory, canonical path order, STORE-only metadata, exact
   fixed entries, no duplicate/traversal/extra paths, and no compression expansion;
2. strictly decode and bind `manifest.cbor` and `key.cbor`;
3. reject unsupported format/algorithm identifiers with `UNSUPPORTED_FORMAT_VERSION` where the
   owning specification requires that outcome;
4. derive the passphrase key and authenticate the Root Key without diagnostic detail;
5. verify package/Vault/Manifest identity binding and content-integrity checksum;
6. retain the authenticated coverage value while continuing the existing validator's Complete or
   Selective coverage proof; do not classify Selective merely from an unverified Manifest;
7. authenticate Generation/head identity and exact active reachability;
8. strictly decode, authenticate, order, and replay every supported Event;
9. prove the Vault has exactly one `VaultCreated`, derive `vaultCreatedAt`, and reduce all Vault name
   Events to `currentVaultName`;
10. prove every `BundleRegistered` exact descriptor/Artifact closure and every lifecycle/Collection
    transition;
11. strictly decode every Object and match exact reachability;
12. stream-check every present Artifact wrapper length/checksum, frame authentication, plaintext
    length/checksum, Role-specific structure, and text/structured relationship; and
13. prove Complete or Selective coverage and every authenticated omission exactly as the current
    shared validator requires; then return `SELECTIVE_IMPORT_UNSUPPORTED` for a valid Selective
    package or the immutable validated graph for a valid Complete package.

Do not write a destination wrapper, IndexedDB Vault record, Projection, name cache, or key slot
during this pass.

## 9.3 Collision check

After complete validation and before destination preparation, query the Workspace/Vault stores for
`manifest.originatingVaultId`. Reject if the Vault directory or any singleton/authority row exists.
Treat unexplained partial rows as `VAULT_ALREADY_EXISTS` or a safe storage-integrity failure; never
adopt or clean them as part of Import.

Repeat the collision check in the final activation transaction to close the race.

---

# 10. Local Credential and Projection Preparation

## 10.1 Local device records

Create fresh device-local records while the validated Root Key is available:

1. generate a fresh random Device UUID;
2. import a temporary extractable HMAC Root Key carrier from the raw Root Key solely for AES-KW
   `wrapKey`;
3. call the existing device-slot primitive to generate a fresh non-exportable AES-KW device key and
   wrap the Root Key;
4. create a fresh verifier bound to the new device slot;
5. create `VaultMetadataV1` with the package Vault ID, fresh Device ID, authenticated
   `vaultCreatedAt`, `manuallyLocked: true`, and the new verifier; and
6. wipe raw key bytes and release temporary carriers after all preparation that requires them.

Do not copy or derive the new Device ID from any Event's historical Device ID. Historical Events
remain unchanged and may reference the originating devices.

## 10.2 Authoritative records

Prepare for storage without changing:

- the exact stored Vault Generation record;
- the exact stored head;
- every stored Event wrapper and ordering field;
- every stored Bundle Descriptor Object record and envelope bytes;
- every stored Artifact Object record; and
- every encrypted Artifact wrapper byte.

Do not import Commands, command outcomes, capture/export/import Jobs, Vacuum leases, or operational
state. They were excluded from the package and remain absent for the imported Vault.

## 10.3 Projection builder refactor

Split `LibraryProjectionRebuilder.execute()` into:

1. a pure/read-only prepare phase that accepts Event/Object read ports, Root Key, Vault ID, and
   ArtifactStore and returns:
   - all encrypted `StoredProjectionV1` Library item rows;
   - one encrypted Collection Projection;
   - one encrypted Vault Name Projection; and
   - the reduced plaintext Vault name only for immediate workspace-cache encryption; and
2. the existing repository write wrapper for normal rebuild callers.

Import invokes only the prepare phase before activation. It reads prepared encrypted Artifact files
for thumbnails, derives the same logical Library state as replay, and performs no IndexedDB write.

Encrypt the Workspace Vault-name cache with the existing Workspace name-cache key, Workspace ID,
imported Vault ID, and reduced name Projection source Event. The directory entry itself contains no
plaintext name.

Projection ciphertext need not match any originating device because Projections are rebuildable and
use fresh nonces. Logical state must match canonical replay exactly.

---

# 11. Atomic Destination Activation

## 11.1 Commit input

Define one internal atomic input containing:

```ts
interface AtomicVaultImport {
  readonly job: ImportJobV1;
  readonly records: VaultRecordsV1;
  readonly events: readonly StoredEvent[];
  readonly objects: readonly StoredObjectV1[];
  readonly libraryProjections: readonly StoredProjectionV1[];
  readonly collectionProjection: StoredCollectionProjectionV1;
  readonly vaultNameProjection: StoredVaultNameProjectionV1;
  readonly nameCache: WorkspaceVaultNameCacheV1;
}
```

This is an unversioned internal transaction input, not a persisted or externally exchanged format.

## 11.2 One transaction

Commit these stores in one readwrite IndexedDB transaction:

```text
workspace_metadata
vault_directory
vault_name_cache
vault_name_projection
vault_metadata
key_slots
device_keys
objects
events
library_projection
collection_projection
vault_generations
vault_head
import_jobs
```

Before the first write, the transaction SHALL:

1. reload and strictly decode the Import Job;
2. require the matching Job to be `Running/Commit`, not cancelled, and bound to the destination
   Vault ID;
3. reload Workspace metadata;
4. prove no directory, metadata, key slot, device key, Generation, head, Event, Object, or
   Projection row already exists for the destination Vault ID;
5. validate every supplied record is scoped to the destination Vault;
6. require Generation/head identity to match the validated Manifest;
7. require Event/Object IDs to equal exact active reachability;
8. require Projection and name-cache identities/source Events to match replay; and
9. require the prepared Artifact Object IDs to equal all Artifact Objects in the input.

The transaction SHALL then:

1. add local metadata, device slot, and device key;
2. add the exact Generation, head, Events, and Objects;
3. add every rebuilt Library Projection plus Collection and Vault Name Projections;
4. add the encrypted Workspace name cache and directory entry using authenticated
   `vaultCreatedAt`;
5. set `workspace.activeVaultId` to the imported Vault only when it is still undefined, otherwise
   leave it unchanged;
6. mark the Import Job `Succeeded` in the same transaction; and
7. commit once.

Do not update the previously active Vault's metadata or in-memory context. If the Workspace was
empty, publish invalidation and let normal reconciliation create the locked active context; do not
activate the recovered Root Key.

## 11.3 Rollback and cleanup

- Any IndexedDB request failure aborts the entire activation transaction.
- On abort, remove every prepared Artifact wrapper by its exact validated Object ID.
- On success, prepared wrappers are authoritative and SHALL NOT be removed even if later source-file
  cleanup or notification fails.
- Remove the temporary Import source after terminal success, failure, or cancellation.
- Cleanup failure after a successful commit is operational debt handled by startup reconciliation;
  it must not change the successful Import result.

---

# 12. Restart, Recovery, and Live State

## 12.1 Startup reconciliation

Before accepting application requests, reconcile the latest Import Job:

- `Created/Acquire` or `Created/Authenticate` after worker restart becomes `Failed` with
  `IMPORT_INTERRUPTED`; remove its partial/staged source.
- Any `Running` Job whose activation transaction did not commit becomes `Failed` with
  `IMPORT_INTERRUPTED`; remove source staging and prepared wrappers only after proving no committed
  Vault directory exists.
- A Job marked `Succeeded` is left unchanged and its destination wrappers are retained.
- If activation committed but a stale in-memory caller disappeared, the Job is already `Succeeded`
  because terminal state was part of the same transaction.
- Cleanup only Job-derived source paths and the exact authenticated destination Vault scope.

Publish one invalidation after reconciliation changes visible Job or Workspace state.

## 12.2 Live invalidation

- Publish one canonical unversioned invalidation after each visible Job state/stage change and after
  atomic activation.
- Notifications are wake-up signals only. Popup and Library refetch `AppState` and render canonical
  state.
- Subscribe before initial fetch, generation-guard reconciliation, coalesce bursts without losing
  the final invalidation, and reconcile on focus/visibility as current surfaces already do.
- Import does not transfer Vault names, progress objects, or plaintext through the invalidation.
- Keep at least two Library surfaces open in tests. Starting, progressing, cancelling, failing, and
  succeeding through one SHALL update the other without reload.

## 12.3 Context handling

- With an existing active Vault, successful Import does not change the active context token or
  discard its decrypted UI.
- With no active Vault, activation changes Workspace state from no context to a locked active Vault;
  every surface must discard stale onboarding state and refetch.
- A user-triggered switch after Import follows the existing context-change rules and discards
  plaintext from the previously active Vault.

---

# 13. Error, Privacy, and Diagnostic Behavior

## 13.1 Safe failure mapping

Use these user-facing messages or equivalent concise copy:

```text
IMPORT_AUTHENTICATION_FAILED
The package could not be authenticated. Check the Export passphrase and try again.

IMPORT_PACKAGE_INVALID
This Vault Package is incomplete, corrupt, or unsupported.

SELECTIVE_IMPORT_UNSUPPORTED
This version can import only Complete Vault Packages.

VAULT_ALREADY_EXISTS
This Vault already exists on this device.

IMPORT_INTERRUPTED
Import was interrupted before the Vault was added. Select the package and try again.

STORAGE_QUOTA_EXCEEDED
There is not enough local storage to import this Vault.
```

Do not tell the user which encrypted entry, Event, Object, checksum, tag, or field failed. Internal
tests may inspect structured causes without placing sensitive values into production diagnostics.

## 13.2 Diagnostics allowlist

Diagnostics MAY include:

- Job ID;
- stage and terminal safe error ID;
- package byte size;
- bounded entry/Object/Event counts;
- processed encrypted byte counts;
- durations; and
- whether cleanup succeeded.

Diagnostics SHALL NOT include:

- source filename or path;
- Export passphrase or its length/content;
- salt, nonce, derived key, raw Root Key, device key, or wrapped-key bytes;
- Vault name, Capture title, URL, normalized text, structured blocks, MHTML, or image data;
- decrypted Events, descriptors, Projections, or Artifact plaintext;
- plaintext checksums; or
- ciphertext samples.

## 13.3 Failure safety

- Invalid packages leave no destination Vault records or wrappers.
- Authentication retries do not create local credentials repeatedly; credential preparation begins
  only after complete package validation.
- Quota failure during source staging leaves no partial staging file after cancellation/cleanup.
- Quota failure during wrapper preparation removes every wrapper prepared for that Job.
- Projection rebuild failure removes prepared wrappers and leaves no Vault directory entry.
- Collision failure never deletes or modifies the existing Vault.

---

# 14. Documentation Reconciliation

Implementation is incomplete until all canonical documents describe the resulting behavior.

Reconcile in authority order:

1. update `docs/specifications/portability/import-export.md` so Import is no longer an undefined
   future boundary; specify Complete-only local Import, validation-before-write, collision
   rejection, fresh local credentials, atomic activation, and Selective capability failure;
2. update Runtime Jobs and storage specifications for the workspace-scoped Import Job, Host staging,
   lease, streaming, cancellation, and restart behavior;
3. update Vault and Object Store specifications for identity preservation, local key provisioning,
   Artifact wrapper installation, and atomic authority;
4. update architecture documents for Runtime/Host/Driver responsibilities, portability, security,
   content storage, testing, and operations cleanup;
5. update the PRD, README, and user-facing product prose from Export-only portability to current
   Complete Export/Import interchange;
6. reconcile Plans 05 and 06 so their “future/user-facing Import” deferrals point to this plan while
   retaining only still-deferred Selective/remote availability work;
7. verify Backup/Restore documents continue to distinguish Restore from Import and do not inherit
   the Import collision or package semantics; and
8. audit `ROADMAP.md` paragraph by paragraph. Remove any now-completed generic Import work while
   retaining only unresolved Selective Import, remote retrieval, retention, Account association,
   and synchronization deltas.

Do not add an Implemented/Completed section to the Roadmap. Do not copy detailed Import contracts
into the Roadmap. Link briefly to the owning Import/Export specification when future Selective work
needs the current foundation.

Search the entire repository for stale claims such as:

```text
future Import
no user-facing Import
Import workflow is not defined
Export-only portability
every imported Artifact is necessarily available
Import may merge
Import may replace
```

Update only claims made stale by completed implementation. Do not erase legitimate descriptions of
still-deferred Selective Import or Backup Restore.

During implementation, create
`docs/plans/07-complete-vault-package-import-tdd-evidence.md` and record focused RED/GREEN commands,
integration evidence, visual screenshots inspected, security scans, and final verification.

---

# 15. Ordered TDD Implementation Tasks

Every task follows RED-GREEN-REFACTOR. Production behavior SHALL NOT precede the focused failing
test. Every defect discovered during implementation first receives a failing regression test.

## Task 1: Canonical Import contracts and store

**RED:** App protocol tests require the five Import requests/results, strict field validation,
workspace busy union, Import Job decoder, stage/state invariants, and new safe errors. IndexedDB
bootstrap tests require the canonical `import_jobs` store.

**GREEN:** add types, strict decoders, store definition, and application state plumbing without an
Import executor. Reject unknown fields, unsafe integers, invalid transitions, persisted secrets,
and malformed IDs.

**Verification:** focused protocol/decoder tests, typecheck, no compatibility names, and a fresh
development database only.

## Task 2: Workspace Import lease

**RED:** Chromium IndexedDB tests require atomic acquisition, only one non-terminal Job, previous
terminal retention replacement, refusal while Capture/Export/Vacuum is active, and `VAULT_BUSY`
from every raced mutation.

**GREEN:** implement the workspace Import repository, state transitions, management-busy query, and
transaction-level fencing in every mutation boundary.

**Verification:** inject races between Import acquisition and Create, Select, Rename, Lock, Unlock,
Capture registration, Library operations, Vacuum, and Export. Assert zero losing-request writes.

## Task 3: First-launch and Library entry UI

**RED:** view/E2E tests require `Create Vault` plus `Import existing Vault` in first launch, correct
full-page routing, both empty-Library choices, populated-Library Import action, and no popup-hosted
file input.

**GREEN:** add the routing and shared Import dialog shell. Ensure `import=1` opens once and focus is
correct.

**Verification:** keyboard tests and rendered popup, empty wide/narrow Library, populated Library,
and initial dialog screenshots.

## Task 4: Bounded source staging

**RED:** Host tests require exact Job-derived OPFS paths, truncating writes, monotonic progress,
bounded chunks, exact final size, cancellation cleanup, quota mapping, and rejection of invalid Job
IDs.

**GREEN:** implement `ChromeVaultImportHost` source staging/open/cleanup and dialog Acquire state.

**Verification:** real Chromium OPFS with large generated File streams, abort at every chunk
boundary, no whole-file `arrayBuffer()` or message payload, and no original filename in IndexedDB or
logs.

## Task 5: Shared validator result and Complete boundary

**RED:** package tests require the validator to return the exact stored graph, reduced Vault name
and creation time, distinguish Selective coverage, preserve existing Export validation, and expose
no raw Root Key.

**GREEN:** refactor the current validator/replay into shared internal results and a scoped raw-key
callback. Map errors separately for Export and Import.

**Verification:** all existing Export package tests remain green; adversarial Complete/Selective,
wrong-passphrase, substituted envelope, unsupported-version, and malformed package tests pass.

## Task 6: Authentication retry Job behavior

**RED:** Runtime tests require exact input handling, 1,024-byte maximum, same staged Job after wrong
passphrase, no persisted error/secret, terminal invalid-package behavior, and single execution
ownership.

**GREEN:** implement `ImportVault` authentication transitions, in-memory AbortController/execution
registry, retry response, and dialog focus/feedback.

**Verification:** multiple wrong attempts followed by the correct passphrase use one staged file;
page disappearance at Authenticate cancels; page disappearance after successful authentication does
not cancel.

## Task 7: Encrypted Artifact preparation

**RED:** ArtifactStore browser tests require byte-for-byte encrypted copying, independent
length/SHA-256 verification, collision rejection, bounded memory, cancellation, quota failure,
cross-Vault isolation, and exact rollback.

**GREEN:** add `prepareEncrypted` and Import's second-pass wrapper installer after complete
validation.

**Verification:** compare source/package/destination wrapper bytes, inject truncation/substitution,
test multi-gigabyte logical streams, and prove no wrapper is written before validation finishes.

## Task 8: Local credentials and prepared Projections

**RED:** tests require a fresh Device ID/key/slot/verifier, preserved Vault identity/creation time,
locked metadata, successful later device unlock, pure Projection preparation, correct Vault name,
Library/Collection state, Deleted Captures, warnings, and thumbnail caches.

**GREEN:** implement scoped credential preparation and split Projection rebuild into prepare and
commit phases.

**Verification:** compare imported logical Projections to source replay; prove device key is
non-exportable, historical Events unchanged, raw key wiped/released, and no package Projection was
read.

## Task 9: Atomic activation and collision safety

**RED:** Chromium IndexedDB tests require one atomic import across every listed store, no overwrite,
existing-active preservation, empty-Workspace locked selection, terminal Job commit, and rollback
at every store write.

**GREEN:** implement `AtomicVaultImport` validation and the single activation transaction.

**Verification:** inject failure at each add/put, race a same-ID Vault creation, confirm no partial
directory/keys/authority/Projections, and confirm prepared wrapper cleanup only on failed commit.

## Task 10: Cancellation and restart reconciliation

**RED:** tests cover cancellation during every stage, abandonment before authentication, worker
termination before commit, activation success at the commit boundary, staged-source leftovers, and
safe prepared-wrapper reconciliation.

**GREEN:** propagate one AbortSignal, implement startup Job reconciliation, and make cleanup
authority-aware.

**Verification:** terminate the worker on both sides of activation; committed Vaults survive and
unlock, uncommitted data disappears, and terminal Job state matches reality.

## Task 11: Live UI and terminal experiences

**RED:** two-surface E2E tests require live stage/progress updates, global mutation disablement,
read-only browsing, cancellation from another surface, retryable authentication error, collision,
Selective, invalid, quota, success, and empty-Workspace locked completion.

**GREEN:** finish AppState reconciliation, progress/status UI, success switch action, accessible
announcements, and focus restoration.

**Verification:** automated visibility/dimension assertions plus manual screenshot inspection for
every state in section 17.

## Task 12: End-to-end portability and documentation

**RED:** an end-to-end test exports a populated Vault and fails until a fresh Workspace can import,
unlock, replay, browse, inspect, and re-export equivalent authority. Documentation/source audits
fail on stale Import claims.

**GREEN:** complete integration, documentation reconciliation, Roadmap pruning, TDD evidence, and
security checks.

**Verification:** run section 16 in full, inspect section 17 screenshots, and complete every
acceptance criterion in section 18.

---

# 16. Required Verification

Discover final commands from manifests at implementation time. At minimum run:

```bash
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm test:integration
corepack pnpm build
corepack pnpm test:e2e
corepack pnpm exec prettier --check <changed-markdown-paths...>
git diff --check
```

Required focused evidence:

- canonical Import Job decoder and state-transition tests;
- real Chromium IndexedDB Workspace lease races;
- real Chromium OPFS source staging and encrypted Artifact installation;
- current Export package validation remaining unchanged;
- Export of a Vault containing active and Deleted Captures, Collections, every Artifact Role, and
  warning states;
- Import into a fresh separate Workspace/database and later local device unlock;
- equality of Vault/Generation/Event/Object/Bundle/Artifact identifiers and authoritative encrypted
  bytes;
- logical equality of rebuilt Vault name, Library, Collection, Deleted, Artifact detail, and
  thumbnail state;
- duplicate-Vault rejection without mutation;
- valid Selective-package capability rejection distinct from corruption;
- wrong-passphrase retry using one staged file;
- rollback injection at every destination store write;
- cancellation and worker termination before and after atomic commit;
- source and prepared-wrapper orphan cleanup;
- multi-gigabyte logical package streaming without proportional memory;
- known-plaintext and secret scans of IndexedDB, OPFS, diagnostics, messages, and production build;
- at least two long-lived Library surfaces proving live Import state and final Vault-directory
  updates; and
- keyboard, accessibility, primary-width, and narrow-width rendered inspection.

Run repository searches for prohibited or stale implementation patterns, including:

```bash
rg -n 'arrayBuffer\(\)|readAsDataURL|base64' apps/browser-extension/src apps/browser-extension/entrypoints
rg -n -i 'passphrase|root.?key|vault name|source filename' apps/browser-extension/src
rg -n -i 'future import|no user-facing import|import workflow.*not.*defined' README.md VISION.md ROADMAP.md docs
rg -n -i 'merge import|replace existing vault|selective import' README.md VISION.md ROADMAP.md docs
```

Inspect each match in context; some bounded compact-data uses and still-future Selective Import
references are legitimate. Do not satisfy audits by weakening language or hiding names.

---

# 17. Rendered Visual Inspection Matrix

Capture and inspect screenshots with the available image-inspection tooling. Tests that only locate
DOM nodes do not satisfy this section.

Inspect at the popup's supported width and at both primary and materially narrow Library widths:

1. first-launch popup with primary Create and secondary Import actions;
2. empty Library with Create and Import choices;
3. populated unlocked Library management bar;
4. populated locked Library management bar;
5. Select file dialog state before and after file choice;
6. Acquire progress at start, middle, and completion;
7. Authenticate resting and focused states;
8. wrong-passphrase alert with focus restored to the empty input;
9. Validate, Prepare, Rebuild, and Commit progress states;
10. Cancel requested/disabled control state;
11. invalid package failure;
12. Selective unsupported failure;
13. existing-Vault collision failure;
14. storage quota failure;
15. cancellation restoration;
16. success while another Vault remains active, including switch action; and
17. success in an initially empty Workspace, showing the imported Vault locked.

For every affected state compare alignment, padding, margins, spacing cadence, typography, wrapping,
clipping, overflow, control prominence, focus treatment, progress geometry, readable error copy,
and unintended layout movement. Assert visible controls have meaningful dimensions and accessible
names. Verify reduced-motion behavior does not depend on animation.

---

# 18. Acceptance Criteria

The feature is complete only when every statement is true:

1. First launch visibly offers both creating a new Vault and importing an existing Vault.
2. Import runs in the full Library surface and is available with no Vault or a locked Vault.
3. A selected package is staged through bounded streaming and never transferred whole through
   extension messages or memory.
4. Wrong passphrase retries use the same staged package and persist no secret.
5. The shared validator authenticates the entire package before any destination Vault write.
6. Only canonical Complete packages are accepted; valid Selective packages receive the dedicated
   unsupported-capability error.
7. Existing Vault identity always causes safe rejection without replacement or merge.
8. Every authoritative Vault, Generation, Event, Object, Bundle, Collection, Artifact identifier and
   encrypted byte is preserved.
9. Every imported Artifact wrapper is present, byte-identical, and independently reverified.
10. Source device credentials and operational/derived records are absent.
11. The imported Vault has a fresh Device ID, non-exportable device key, device slot, and verifier.
12. The imported Vault is locked and can later unlock through its new local device slot.
13. Vault name, Library, Collection, Deleted, and thumbnail Projections rebuild solely from imported
    authority.
14. Existing active Vault selection and lock state remain unchanged; an empty Workspace selects the
    imported Vault locked.
15. Destination records and rebuilt Projections become visible in one atomic transaction.
16. Failure at any pre-commit or commit point leaves no destination authority or prepared wrapper.
17. Cancellation and restart cleanup never delete a successfully committed Vault.
18. The Workspace Import lease blocks every mutation at both UI and storage boundaries while
    allowing read-only browsing.
19. All open surfaces update from canonical refetched state without reload.
20. Import remains offline, distinct from Restore/synchronization, and creates no Event or Vault
    Generation.
21. Existing development data is cleared; no migration, fallback, alias, or superseded-format reader
    exists.
22. Every related document and Roadmap passage reflects current Complete Import and only unresolved
    Selective/remote work remains future-facing.
23. Unit, Chromium integration, E2E, typecheck, lint, build, Markdown formatting, security audits,
    visual inspection, and `git diff --check` all pass.

---

# 19. Fixed Decisions Checklist

The implementer SHALL treat these as settled:

- accept Complete packages only;
- keep Selective Import deferred with a distinct capability error;
- reject every existing Vault ID, including an identical Vault;
- never replace, merge, update, or re-ID an imported Vault;
- add the imported Vault locked;
- preserve an existing active Vault unchanged;
- select the imported Vault locked only when the Workspace has no active Vault;
- commit immediately after validation with no preview confirmation;
- retain staged encrypted bytes for wrong-passphrase retry;
- use a Workspace-wide exclusive management lease while allowing read-only browsing;
- keep first-launch Create primary and route Import to the full Library;
- stage the package in OPFS through a Host adapter, not runtime messaging;
- reuse the exact Export validator and authoritative replay;
- validate fully before destination wrapper or IndexedDB writes;
- copy encrypted wrappers byte-for-byte without decryption or re-encryption;
- create fresh local device credentials and never import source device state;
- rebuild every Projection and encrypted workspace name cache locally;
- atomically activate authority, derived state, directory membership, and terminal Job status;
- persist no passphrase, raw key, filename, path, Vault name, or plaintext diagnostic;
- clear pre-release development storage and add no compatibility path; and
- reconcile every affected document and keep the Roadmap forward-looking.
