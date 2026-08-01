import { expect, test } from "@playwright/test";

async function scenario(page: import("@playwright/test").Page, name: string): Promise<unknown> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`/?scenario=${name}`);
  const output = page.locator("#result");
  try {
    await expect(output).toHaveAttribute("data-complete", "true");
  } catch (error) {
    throw new Error(`Harness did not complete: ${errors.join(" | ")}`, {
      cause: error,
    });
  }
  return JSON.parse(await output.innerText());
}

test("persists a non-exportable device key and Vault records", async ({ page }) => {
  await expect(scenario(page, "vault")).resolves.toEqual({
    deviceKeyExtractable: false,
    wrappedRootKeyBytes: 40,
    manuallyLocked: true,
  });
});

test("enforces the canonical storage families, Realms, immutability, and frontier CAS", async ({
  page,
}) => {
  await expect(scenario(page, "canonical-storage")).resolves.toEqual({
    databaseVersion: 1,
    stores: [
      "execution_state",
      "host_policy_state",
      "installation_state",
      "managed_resources",
      "materializations",
      "prepared_data",
      "quarantine",
      "replica_safety_state",
      "trusted_secrets",
      "vault_objects",
      "vault_records",
    ],
    wrappingKeyExtractable: false,
    wrappingKeyReused: true,
    realmIsolation: true,
    immutableIdempotent: true,
    immutableConflict: "IMMUTABLE_ITEM_CONFLICT",
    initializationAtomic: true,
    staleFrontier: "VAULT_CONTEXT_CHANGED",
    staleWriteAbsent: true,
  });
});

test("atomically restores an encrypted canonical Vault after browser restart", async ({ page }) => {
  await expect(scenario(page, "canonical-vault-initialization")).resolves.toEqual({
    recoveryWordCount: 12,
    directoryLabel: "Research vault",
    baselineRestored: true,
    genesisRestored: true,
    genesisSignature: true,
    frontierRestored: true,
    epochRestored: true,
    serviceRestored: true,
    selectedInDirectory: true,
    duplicateCreation: "VAULT_ALREADY_EXISTS",
  });
});

test("requires Recovery Phrase confirmation before committing a canonical Vault", async ({
  page,
}) => {
  await expect(scenario(page, "canonical-vault-ceremony")).resolves.toEqual({
    mismatch: "RECOVERY_PHRASE_MISMATCH",
    directoryCount: 1,
    selected: true,
    opened: true,
    reused: "The Vault creation ceremony is no longer active.",
  });
});

test("atomically commits concurrent canonical Captures and returns idempotent outcomes", async ({
  page,
}) => {
  await expect(scenario(page, "canonical-capture-commit")).resolves.toEqual({
    firstIdempotent: true,
    bothCommitted: true,
    recordCount: 4,
    objectCount: 4,
    outcomeCount: 2,
    resolutionCount: 12,
    artifactCount: 2,
    reopenedAfterCapture: true,
  });
});

test("replays the canonical DAG into an encrypted Frontier-bound live Library", async ({
  page,
}) => {
  const result = (await scenario(page, "canonical-library-projection")) as {
    updatedCaptureIds: string[];
    expectedCaptureIds: string[];
    [key: string]: unknown;
  };
  expect(result).toEqual({
    firstCaptureCount: 1,
    firstCaptureMatches: true,
    firstCacheCount: 1,
    updatedTitles: ["First", "Second"],
    updatedCaptureIds: result.expectedCaptureIds,
    expectedCaptureIds: result.expectedCaptureIds,
    allArtifactsAvailable: true,
    conflictCount: 0,
    restartedCaptureCount: 2,
    cacheCount: 1,
    cacheCiphertextExcludesTitles: true,
  });
});

test("runs the canonical multi-Vault Client facade across restart", async ({ page }) => {
  await expect(scenario(page, "canonical-client-runtime")).resolves.toEqual({
    recoveryWordCount: 12,
    selectedAfterCreate: "Second",
    selectedAfterSwitch: "First",
    captureCount: 1,
    captureTitle: "Facade capture",
    captureMatches: true,
    deleteIdempotent: true,
    deletedLifecycle: "Deleted",
    restoredLifecycle: "Active",
    moved: true,
    collectionTitle: "Reading list",
    merged: true,
    mergeReverted: true,
    folderName: "Research",
    folderLifecycleAfterDelete: "Deleted",
    folderLifecycleAfterRestore: "Active",
    collectionFolderPlaced: true,
    restartedFolderName: "Research",
    restartedCollectionFolderPlaced: true,
    tagName: "Important",
    tagAssignmentActive: true,
    tagAssignmentDormant: false,
    tagAssignmentRestored: true,
    tagAssignmentsAfterRemove: 0,
    restartedTagName: "Important",
    restartedTagAssignments: 0,
    noteTitle: "Context",
    revisedNoteBody: "Revised body.",
    deletedNoteState: "Deleted",
    restoredNoteState: "Active",
    restoredNoteBody: "Revised body.",
    restartedNoteTitle: "Context",
    restartedNoteBody: "Revised body.",
    searchCapture: { kind: "Capture", title: "Facade capture" },
    searchNote: { kind: "Note", title: "Context", snippet: "Revised body." },
    searchCoverage: {
      eligibleCaptures: 1,
      indexedCaptures: 1,
      unavailableHeavyContent: 1,
      failedCaptures: 0,
    },
    searchCacheCount: 1,
    searchCacheExcludesPlaintext: true,
    vacuumIdempotent: true,
    vacuumInvalidatedCaches: true,
    postVacuumCaptureCount: 2,
    postVacuumNoteBody: "Revised body.",
    closureIdempotent: true,
    closedWriteRejected: "Closed Vaults cannot author Content Events",
    restartedClosedSearchNote: { kind: "Note", title: "Context", snippet: "Revised body." },
    recordCount: 29,
    restartSelected: "First",
    restartVaultCount: 2,
  });
});

test("streams canonical multi-frame Artifact wrappers through content-addressed OPFS", async ({
  page,
}) => {
  await expect(scenario(page, "canonical-opfs-artifact")).resolves.toEqual({
    beforePromotion: false,
    promoted: true,
    retainedAfterDiscard: true,
    frameCount: 2,
    envelopeStorageIdMatches: true,
    corruptionDetected: true,
    repairedPresent: true,
    orphanRemoved: true,
    removed: true,
  });
});

test("runs the pinned local MiniLM through browser WASM without network fallback", async ({
  page,
}) => {
  test.skip(
    process.env.AWSM_SEARCH_MODEL_PROOF_DIR === undefined,
    "Set AWSM_SEARCH_MODEL_PROOF_DIR to the exact pinned MiniLM files.",
  );
  await expect(scenario(page, "search-local-minilm-inference")).resolves.toEqual({
    dimensions: 384,
    finite: true,
    normalized: true,
    distinct: true,
  });
});

test("creates the canonical storage-relief stores without a schema upgrade", async ({ page }) => {
  await expect(scenario(page, "storage-relief-schema")).resolves.toEqual({
    databaseVersion: 1,
    stores: ["artifact_availability", "storage_relief_checkpoints", "storage_relief_jobs"],
  });
});

test("persists canonical local-only Library preferences in the fresh schema", async ({ page }) => {
  await expect(scenario(page, "ui-preferences")).resolves.toEqual({
    databaseVersion: 1,
    storePresent: true,
    defaults: { version: 1, sort: "CapturedNewest", view: "Grid" },
    restored: { version: 1, sort: "TitleAscending", view: "List" },
    keys: ["library"],
  });
});

test("persists encrypted keyword Search rows and rejects authenticated-header tampering", async ({
  page,
}) => {
  await expect(scenario(page, "search-keyword-persistence")).resolves.toEqual({
    restoredTitle: "Private Search",
    ciphertextContainsPlaintext: false,
    tamperingRejected: true,
    postingCandidates: ["00000000-0000-4000-8000-000000000961"],
    searchStoreCount: 9,
  });
});

test("atomically commits keyword rows, opaque postings, statistics, Jobs, and checkpoints", async ({
  page,
}) => {
  await expect(scenario(page, "search-keyword-atomic-commit")).resolves.toEqual({
    projectionGeneration: "00000000-0000-4000-8000-000000000950:1",
    completedCaptures: 1,
    checkpointState: "Committed",
    privatePostingCandidates: ["00000000-0000-4000-8000-000000000951"],
    queryCandidateIds: ["00000000-0000-4000-8000-000000000951"],
    activeDocumentCount: 1,
    staleConcurrentCommitRejected: true,
    coordinatorResult: [
      {
        bundleId: "00000000-0000-4000-8000-000000000951",
        match: "ExactPhrase",
        snippet: "Private local Search passage.",
      },
    ],
    semanticState: "NotConfigured",
  });
});

test("atomically commits encrypted semantic centroids, passages, Job, and checkpoint", async ({
  page,
}) => {
  await expect(scenario(page, "search-semantic-atomic-commit")).resolves.toEqual({
    restoredBundleId: "00000000-0000-4000-8000-000000000972",
    passageCount: 2,
    providerIdentityHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    scanned: ["00000000-0000-4000-8000-000000000972"],
    ciphertextContainsTitle: false,
    checkpointState: "Committed",
    staleRejected: true,
    modelReferencesAfterConfigure: 1,
    modelReferencesAfterRepeatedConfigure: 1,
    semanticCleared: true,
    modelReferencesAfterDisable: 0,
    indexedVaultGeneration: "00000000-0000-4000-8000-000000000979:12",
    remoteCredential: "fixture-api-key",
    remoteCredentialDeleted: true,
  });
});

test("persists Search index lease contention, expiry takeover, renewal, and release", async ({
  page,
}) => {
  await expect(scenario(page, "search-index-lease")).resolves.toEqual({
    firstOwner: "library-a",
    contentionRejected: true,
    takeoverOwner: "library-b",
    renewedUntil: "2026-07-26T00:01:10.000Z",
    waitingState: "WaitingForLibrary",
    leaseCleared: true,
  });
});

test("atomically records and resumes one failed Search Capture checkpoint", async ({ page }) => {
  await expect(scenario(page, "search-index-failure-resume")).resolves.toEqual({
    failedState: "Failed",
    failedCaptures: 1,
    retryAt: "2026-07-26T00:05:02.000Z",
    failedCheckpointState: "Failed",
    failedAttemptCount: 1,
    failedCheckpointError: "SEARCH_PROVIDER_UNAVAILABLE",
    resumedState: "Created",
    resumedFailedCaptures: 0,
    resumedCheckpointState: "Pending",
  });
});

test("runs a resumable keyword Search Job to completion against encrypted IndexedDB", async ({
  page,
}) => {
  await expect(scenario(page, "search-keyword-indexer")).resolves.toEqual({
    state: "Succeeded",
    completedCaptures: 1,
    checkpointState: "Committed",
    indexedTitle: "Private Search",
    invalidations: 1,
  });
});

test("atomically promotes only a verified local model Cache generation", async ({ page }) => {
  await expect(scenario(page, "search-local-model-cache")).resolves.toEqual({
    ready: true,
    cachedText: "abc",
    pointerManifest: "fixture-manifest",
    corruptPromotionRejected: true,
    pointerUnchanged: true,
    removed: true,
    cacheNamesAfterRemoval: [],
  });
});

test("persists storage-relief checkpoints and remote-only state atomically", async ({ page }) => {
  await expect(scenario(page, "storage-relief-persistence")).resolves.toEqual({
    state: "Running",
    checkpointState: "Evicted",
    verifiedArtifacts: 1,
    evictedArtifacts: 1,
    freedBytes: 4096,
    remoteBeforeClear: true,
    remoteAfterClear: false,
    jobStateAfterClear: "Running",
    cancellationPersisted: true,
    driftErrorId: "STORAGE_RELIEF_ESTIMATE_CHANGED",
    mismatchedAvailabilityRejected: true,
    stateAfterRejectedCommit: "Evicting",
  });
});

test("holds a storage-relief maintenance lease only while actively working", async ({ page }) => {
  await expect(scenario(page, "storage-relief-lease")).resolves.toEqual({
    busy: "Storage relief",
    captureErrorId: "VAULT_BUSY",
    vacuumErrorId: "VAULT_BUSY",
    busyWhileWaiting: null,
  });
});

test("restores credentials and retains only an unusable reauthentication key on logout", async ({
  page,
}) => {
  await expect(scenario(page, "account-persistence")).resolves.toEqual({
    username: "reader_test",
    refreshRestored: true,
    sessionKeyExtractable: false,
    signedOut: true,
    retainedUsername: "reader_test",
    refreshReplaced: true,
    sessionKeyReused: true,
    localObjectCount: 1,
  });
});

test("isolates active and candidate Account credentials across logout and restart", async ({
  page,
}) => {
  await expect(scenario(page, "account-scope-isolation")).resolves.toEqual({
    activeUsername: "active_test",
    candidateUsername: "candidate_test",
    activePresentBeforeLogout: true,
    candidatePresentBeforeLogout: true,
    activePresentAfterLogout: false,
    candidatePresentAfterLogout: true,
    candidateRefreshRestored: true,
    candidateVaultId: "00000000-0000-4000-8000-000000000834",
    candidatePresentAfterErase: false,
  });
});

test("persists strict restart-safe Server Switch Jobs and scoped checkpoints", async ({ page }) => {
  await expect(scenario(page, "server-switch-persistence")).resolves.toEqual({
    direction: "FastForwardCandidate",
    checkpointState: "Durable",
    staleDeleteRejected: true,
    matchingDeleteSucceeded: true,
    jobRemoved: true,
    checkpointRemoved: true,
    corruptJobRejected: true,
    repeatedStagesStable: true,
    startupDecisions: [
      "PresentAuthentication",
      "Compare",
      "ApplyRemote",
      "CompleteRemoteActivation",
      "ApplyLocal",
      "ApplyLocal",
      "PromoteUnchangedLocal",
      "RevokePriorSession",
      "CleanupSuccess",
    ],
    reopenedStages: [
      "AuthenticationRequired:AuthenticateCandidate",
      "Running:Compare",
      "Running:PrepareRemote",
      "Running:ActivateRemote",
      "Running:PrepareLocal",
      "WaitingForUnlock:ActivateLocal",
      "Running:PromoteContext",
      "Running:RevokePriorSession",
      "Succeeded:Terminal",
    ],
  });
});

test("atomically replaces a stale-epoch capture head while retaining immutable history", async ({
  page,
}) => {
  await expect(scenario(page, "stale-epoch-replay-commit")).resolves.toEqual({
    success: {
      immutableObjectCount: 4,
      immutableEventCount: 2,
      headObjectIds: [
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000202",
      ],
      headEventIds: ["00000000-0000-4000-8000-000000000102"],
      projectionBundleIds: ["00000000-0000-4000-8000-000000000302"],
    },
    rollback: {
      rejected: true,
      newObjectsAbsent: true,
      oldHeadRetained: true,
      oldProjectionRetained: true,
    },
  });
});

test("protects restart-safe Vault replacement state and rejects tampering", async ({ page }) => {
  await expect(scenario(page, "vault-replacement-persistence")).resolves.toEqual({
    state: "Running",
    stage: "Rewrite",
    plaintextRestored: true,
    staleCasRejected: true,
    tamperErrorId: "CRYPTO_AUTHENTICATION_FAILED",
    sensitiveStateCleared: true,
  });
});

test("finishes protected writes after browser cryptography yields the event loop", async ({
  page,
}) => {
  await expect(
    scenario(page, "vault-replacement-persistence&delayCrypto=true"),
  ).resolves.toMatchObject({
    state: "Running",
    plaintextRestored: true,
  });
});

test("stages a restart-safe replacement without changing the active Workspace", async ({
  page,
}) => {
  await expect(scenario(page, "vault-replacement-hidden-stage")).resolves.toEqual({
    activeVaultUnchanged: true,
    directoryContainsOnlySource: true,
    hiddenStageRestored: true,
    targetRecordsRestored: true,
    collisionErrorId: "VAULT_ALREADY_EXISTS",
    discardRemovedOnlyTarget: true,
  });
});

test("atomically promotes replacement authority and removes the source Vault", async ({ page }) => {
  await expect(scenario(page, "vault-replacement-promotion")).resolves.toEqual({
    activeReplacement: true,
    sourceRemoved: true,
    targetRetained: true,
    registrationPromoted: true,
    deviceAuthorityRestored: true,
    purgeTrackingRetained: true,
  });
});

test("atomically promotes candidate Account authority and retains prior revocation credentials", async ({
  page,
}) => {
  await expect(scenario(page, "server-switch-promotion")).resolves.toEqual({
    serverOrigin: "https://candidate.example",
    activeUsername: "candidate_test",
    activeRefresh: "refresh-candidate_test",
    priorUsername: "source_test",
    priorRefresh: "refresh-source_test",
    candidateRemoved: true,
    registrationAccountId: "00000000-0000-4000-8000-000000000850",
    synchronizationStage: "FetchChanges",
    synchronizationCursor: 21,
    switchStage: "RevokePriorSession",
  });
});

test("keeps detachment and reattachment atomic across every IndexedDB write failure and restart", async ({
  page,
}) => {
  const result = (await scenario(page, "detached-authority-atomicity")) as {
    detachmentWrites: number;
    detachmentAtomic: boolean;
    reattachmentWrites: number;
    reattachmentAtomic: boolean;
  };
  expect(result.detachmentWrites).toBeGreaterThan(0);
  expect(result.detachmentAtomic).toBe(true);
  expect(result.reattachmentWrites).toBeGreaterThan(0);
  expect(result.reattachmentAtomic).toBe(true);
});

test("rolls back every authoritative store write during Replica promotion", async ({ page }) => {
  const result = (await scenario(page, "server-switch-replica-promotion-atomicity")) as {
    successAtomic: boolean;
    failurePoints: number;
    allAtomic: boolean;
  };
  expect(result.successAtomic).toBe(true);
  expect(result.failurePoints).toBeGreaterThan(20);
  expect(result.allAtomic).toBe(true);
});

test("isolates Vault metadata, key slots, device keys, generations, and heads", async ({
  page,
}) => {
  await expect(scenario(page, "vault-record-isolation")).resolves.toEqual({
    firstVaultId: "00000000-0000-4000-8000-000000000001",
    secondVaultId: "00000000-0000-4000-8000-000000000101",
    firstLocked: true,
    secondLocked: false,
  });
});

test("bootstraps one Workspace and structured-clones its non-exportable name key", async ({
  page,
}) => {
  await expect(scenario(page, "workspace")).resolves.toEqual({
    version: 1,
    sameWorkspace: true,
    activeVaultId: null,
    nameKeyExtractable: false,
  });
});

test("creates a named Vault and all Workspace/Vault records in one transaction", async ({
  page,
}) => {
  await expect(scenario(page, "atomic-vault-create")).resolves.toEqual({
    activeMatchesCreated: true,
    name: "Amber Archive",
    eventCount: 1,
    headEventCount: 1,
    directoryHasPlaintextName: false,
  });
});

test("rolls back Vault creation at every canonical store write", async ({ page }) => {
  await expect(scenario(page, "atomic-vault-create-failures")).resolves.toEqual({
    failurePoints: 11,
    allAtomic: true,
  });
});

test("selects the active Vault atomically and manually locks both contexts", async ({ page }) => {
  await expect(scenario(page, "atomic-vault-select")).resolves.toEqual({
    activeIsFirst: true,
    firstLocked: true,
    secondLocked: true,
    staleErrorId: "VAULT_CONTEXT_CHANGED",
    unchangedAfterStaleRequest: true,
    sameTargetStayedUnlocked: true,
    missingErrorId: "VAULT_NOT_FOUND",
    busyErrorId: "VAULT_BUSY",
  });
});

test("rolls back active Vault selection at every canonical store write", async ({ page }) => {
  await expect(scenario(page, "atomic-vault-select-failures")).resolves.toEqual({
    failurePoints: 3,
    allAtomic: true,
  });
});

test("renames the active Vault by atomically replacing name state and appending history", async ({
  page,
}) => {
  const result = await scenario(page, "atomic-vault-rename");
  expect(result).toMatchObject({ name: "Quiet Folio" });
  expect((result as { eventIds: string[] }).eventIds).toHaveLength(2);
  expect((result as { headEventIds: string[] }).headEventIds).toHaveLength(2);
  expect((result as { eventIds: string[] }).eventIds).toEqual(
    (result as { headEventIds: string[] }).headEventIds,
  );
});

test("rolls back Vault Rename at every canonical store write", async ({ page }) => {
  await expect(scenario(page, "atomic-vault-rename-failures")).resolves.toEqual({
    failurePoints: 4,
    allAtomic: true,
  });
});

test("accepts identical immutable Objects and rejects conflicting bytes", async ({ page }) => {
  await expect(scenario(page, "immutable")).resolves.toEqual({
    conflictId: "IMMUTABLE_OBJECT_CONFLICT",
    objectCount: 1,
  });
});

test("isolates colliding Object IDs and counts by Vault prefix", async ({ page }) => {
  await expect(scenario(page, "vault-isolation")).resolves.toEqual({
    firstByte: 7,
    secondByte: 8,
    firstCounts: { objects: 1, events: 0, projections: 0, outcomes: 0 },
    secondCounts: { objects: 1, events: 0, projections: 0, outcomes: 0 },
  });
});

test("isolates colliding Capture Job IDs and rejects mismatched stored Vault identity", async ({
  page,
}) => {
  await expect(scenario(page, "capture-job-vault-isolation")).resolves.toEqual({
    firstTabId: 7,
    secondTabId: 8,
    mismatchedReadRejected: true,
  });
});

test("rejects an Event whose declared Vault differs from the scoped Driver", async ({ page }) => {
  await expect(scenario(page, "event-vault-mismatch")).resolves.toEqual({
    rejected: true,
    counts: { objects: 0, events: 0, projections: 0, outcomes: 0 },
  });
});

test("commits registration atomically and idempotently", async ({ page }) => {
  const result = await scenario(page, "atomic");
  expect(result).toMatchObject({
    appendedObjects: 2,
    appendedEvents: 1,
    counts: {
      objects: 2,
      events: 1,
      projections: 1,
      outcomes: 1,
    },
  });
});

test("rolls back an Object when a later Event write conflicts", async ({ page }) => {
  const result = await scenario(page, "rollback");
  expect(result).toMatchObject({
    errorId: "STORAGE_TRANSACTION_FAILED",
    rolledBackObject: false,
    appendedObjects: 2,
    appendedEvents: 1,
    counts: {
      objects: 2,
      events: 1,
      projections: 1,
      outcomes: 1,
    },
  });
});

test("clears rebuildable Projection rows without deleting Objects", async ({ page }) => {
  await expect(scenario(page, "projection")).resolves.toMatchObject({
    objects: 2,
    projections: 0,
  });
});

test("reconciles interrupted jobs around the atomic commit boundary", async ({ page }) => {
  await expect(scenario(page, "interruption")).resolves.toMatchObject({
    beforeCommit: { state: "Failed", errorId: "CAPTURE_INTERRUPTED" },
    afterCommit: { state: "Succeeded" },
  });
});

test("persists dismissal of a completed recent-capture notice", async ({ page }) => {
  await expect(scenario(page, "dismissal")).resolves.toMatchObject({
    state: "Succeeded",
    noticeDismissed: true,
  });
});

test("atomically changes grouped Projection rows while retaining immutable Objects", async ({
  page,
}) => {
  await expect(scenario(page, "library-state")).resolves.toEqual({
    counts: { objects: 4, events: 3, projections: 2, outcomes: 2 },
    firstObject: true,
    secondObject: true,
  });
});

test("rolls back every Vacuum deletion when the transaction fails", async ({ page }) => {
  await expect(scenario(page, "vacuum-rollback")).resolves.toEqual({
    failed: true,
    objectRetained: true,
    counts: { objects: 2, events: 1, projections: 1, outcomes: 2 },
  });
});

test("removes reclaimed remote-only availability and terminal relief history during Vacuum", async ({
  page,
}) => {
  await expect(scenario(page, "vacuum-availability-cleanup")).resolves.toEqual({
    objectRetained: false,
    availabilityRows: 0,
    reliefJobs: 0,
    reliefCheckpoints: 0,
  });
});

test("activates nothing when the source Vault Generation changed", async ({ page }) => {
  await expect(scenario(page, "vacuum-cas-conflict")).resolves.toEqual({
    failed: true,
    objectRetained: true,
    activeGenerationId: "00000000-0000-4000-8000-000000000990",
  });
});

test("blocks writes while Vacuum owns the Vault and recovers an abandoned pre-activation lease", async ({
  page,
}) => {
  await expect(scenario(page, "vacuum-lease")).resolves.toEqual({
    blocked: true,
    committedAfterRecovery: true,
  });
});

test("retains synchronized Vacuum remote and local activation checkpoints across restart", async ({
  page,
}) => {
  await expect(scenario(page, "synchronized-vacuum-journal")).resolves.toEqual({
    remoteIntentStage: "ActivateRemote",
    candidateGenerationId: "00000000-0000-4000-8000-000000000985",
    localPendingStage: "ActivateLocal",
    activatedHeadCursor: 17,
    discarded: true,
  });
});

test("atomically commits a Collection Event, item rows, topology, and generation tail", async ({
  page,
}) => {
  await expect(scenario(page, "collection-operation")).resolves.toEqual({
    counts: { objects: 4, events: 3, projections: 2, outcomes: 2 },
    topologyStored: "00000000-0000-4000-8000-000000000992",
    appendedEvents: 3,
  });
});

test("reports scoped management activity and rejects Vacuum while Capture runs", async ({
  page,
}) => {
  await expect(scenario(page, "management-busy")).resolves.toEqual({
    captureBusy: "Capture",
    vacuumWhileCaptureErrorId: "VAULT_BUSY",
    vacuumBusy: "Vacuum",
  });
});

test("holds an exclusive Export lease, releases it on cancellation, and reconciles interruption", async ({
  page,
}) => {
  await expect(scenario(page, "export-lease")).resolves.toEqual({
    busy: "Export",
    inactiveErrorId: "VAULT_CONTEXT_CHANGED",
    lockedErrorId: "VAULT_LOCKED",
    registrationBlocked: true,
    captureBlocked: true,
    vacuumBlocked: true,
    committedAfterCancellation: true,
    reconciled: true,
    interruptedState: "Failed",
    interruptedErrorId: "EXPORT_INTERRUPTED",
  });
});

test("holds one Workspace Import lease and fences Vault mutations", async ({ page }) => {
  await expect(scenario(page, "import-lease")).resolves.toEqual({
    stage: "Acquire",
    busy: true,
    secondErrorId: "VAULT_BUSY",
    captureBlocked: true,
    registrationBlocked: true,
    vacuumBlocked: true,
    exportBlocked: true,
    lockBlocked: true,
    busyAfterCancellation: false,
  });
});

test("persists the complete Import Job lifecycle and reconciles interruption", async ({ page }) => {
  await expect(scenario(page, "import-job-lifecycle")).resolves.toEqual({
    regressiveProgressErrorId: "STORAGE_TRANSACTION_FAILED",
    oversizedProgressErrorId: "STORAGE_TRANSACTION_FAILED",
    prematureStagingErrorId: "STORAGE_TRANSACTION_FAILED",
    authenticateStage: "Authenticate",
    retryState: "Created",
    runningStage: "Validate",
    preparedEntries: 2,
    regressiveExecutionErrorId: "STORAGE_TRANSACTION_FAILED",
    cancelledState: "Cancelled",
    repeatedCancellationState: "Cancelled",
    reconciled: true,
    interruptedState: "Failed",
    interruptedErrorId: "IMPORT_INTERRUPTED",
    busyAfterInterruption: false,
  });
});

test("atomically activates an imported Vault and rejects destination collisions", async ({
  page,
}) => {
  await expect(scenario(page, "atomic-vault-import")).resolves.toEqual({
    selectedInEmptyWorkspace: true,
    importedLocked: true,
    eventCount: 1,
    objectCount: 1,
    projectionCount: 1,
    jobState: "Succeeded",
    collisionErrorId: "VAULT_ALREADY_EXISTS",
    directoryCountAfterCollision: 1,
    persistedEpochOrdinals: [0, 1],
    persistedHistoricalRootByte: 6,
    persistedActiveRootByte: 7,
    rollbackFailurePoints: 16,
    rollbackAlwaysAtomic: true,
  });
});

test("atomically discards a stale Replica and activates the complete server replacement", async ({
  page,
}) => {
  await expect(scenario(page, "atomic-stale-discard")).resolves.toEqual({
    rollbackFailurePoints: 11,
    rollbackAlwaysAtomic: true,
    originalUsesServerGeneration: true,
    originalEventIds: ["00000000-0000-4000-8000-000000000851"],
    additionalVaultCreated: false,
    jobState: "Succeeded",
  });
});

test("rejects remote reconciliation that races or omits local authority", async ({ page }) => {
  await expect(scenario(page, "remote-reconciliation-fence")).resolves.toEqual({
    omissionErrorId: "VAULT_CONTEXT_CHANGED",
    changedHeadErrorId: "VAULT_CONTEXT_CHANGED",
    localMutationPreserved: true,
    jobStillRunning: true,
    retainedRemoteOnlyIds: ["00000000-0000-4000-8000-000000000916"],
  });
});

test("evicts a verified Artifact wrapper through the persisted storage-relief Job", async ({
  page,
}) => {
  const result = await scenario(page, "storage-relief-runner");
  expect(result).toMatchObject({
    synchronized: true,
    localPresent: false,
    remoteOnly: true,
    state: "Succeeded",
  });
  expect((result as { freedBytes: number }).freedBytes).toBeGreaterThan(0);
});

test("recovers every storage-relief interruption around proof and deletion", async ({ page }) => {
  const result = await scenario(page, "storage-relief-fault-matrix");
  const completed = {
    synchronized: true,
    localPresent: false,
    remoteOnly: true,
    state: "Succeeded",
    interrupted: true,
  };
  expect(result).toMatchObject({
    afterSynchronization: {
      ...completed,
      interruptedCheckpointState: "Candidate",
      localAfterInterruption: true,
      remoteOnlyAfterInterruption: false,
    },
    afterVerifiedCheckpoint: {
      ...completed,
      interruptedCheckpointState: "Verified",
      localAfterInterruption: true,
      remoteOnlyAfterInterruption: false,
    },
    afterEvictingCheckpoint: {
      ...completed,
      interruptedCheckpointState: "Evicting",
      localAfterInterruption: true,
      remoteOnlyAfterInterruption: false,
    },
    afterWrapperRemoved: {
      ...completed,
      interruptedCheckpointState: "Evicting",
      localAfterInterruption: false,
      remoteOnlyAfterInterruption: false,
    },
    afterRemoteOnlyCommit: {
      ...completed,
      interruptedCheckpointState: "Evicted",
      localAfterInterruption: false,
      remoteOnlyAfterInterruption: true,
    },
  });
});

test("reconciles every interrupted stale-discard stage after an IndexedDB restart", async ({
  page,
}) => {
  const recovered = {
    reconciled: true,
    state: "Conflict",
    stage: "Checkpoint",
    preparedIdsCleared: true,
    artifactsRemoved: true,
  };
  await expect(scenario(page, "stale-discard-restart")).resolves.toEqual({
    PrepareServerReplacement: recovered,
    ActivateServerReplacement: recovered,
  });
});

test("streams encrypted Artifact wrappers through scoped OPFS storage", async ({ page }) => {
  await expect(scenario(page, "artifact-store")).resolves.toEqual({
    objectType: "Artifact",
    rootKeyExtractable: false,
    ciphertextExcludesPlaintext: true,
    recovered: "known plaintext artifact",
    collisionRejected: true,
    orphanRemoved: true,
    encryptedImportCopiedExactly: true,
    encryptedImportReplaySucceeded: true,
    corruptEncryptedImportRejected: true,
    wrapperPresent: true,
    wrapperVerified: true,
    wrapperAbsentAfterRemoval: true,
    quotaErrorId: "STORAGE_QUOTA_EXCEEDED",
    quotaArtifactRemoved: true,
  });
});

test("stages an encrypted Vault Package through bounded OPFS streaming", async ({ page }) => {
  await expect(scenario(page, "import-source-staging")).resolves.toEqual({
    storedBytes: 700000,
    finalProgress: 700000,
    progressMonotonic: true,
    bytesMatch: true,
    cleanupRemoved: true,
    quotaErrorId: "STORAGE_QUOTA_EXCEEDED",
    quotaSourceRemoved: true,
  });
});
