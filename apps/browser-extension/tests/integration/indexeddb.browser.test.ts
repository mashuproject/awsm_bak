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
    staleMutable: "VAULT_CONTEXT_CHANGED",
    staleMutableWriteAbsent: true,
    staleAbsent: "VAULT_CONTEXT_CHANGED",
    staleAbsentWriteAbsent: true,
  });
});

test("reopens a canonical pull Job after an IndexedDB restart", async ({ page }) => {
  await expect(scenario(page, "canonical-pull-job")).resolves.toEqual({
    snapshotCursor: 9,
    quarantineCount: 1,
    waitingRetry: true,
    locatorRetained: true,
  });
});

test("promotes one authenticated Hosted Content pull through IndexedDB and restart", async ({
  page,
}) => {
  await expect(scenario(page, "canonical-hosted-pull")).resolves.toEqual({
    promoted: true,
    objectPromoted: true,
    completed: true,
    quarantineRemoved: true,
    reopened: true,
  });
});

test("hydrates one verified Artifact from a configured Hosted Replica through IndexedDB and OPFS", async ({
  page,
}) => {
  await expect(scenario(page, "canonical-hosted-artifact-hydration")).resolves.toEqual({
    hydrated: true,
    localResolutionPublished: true,
    reopened: true,
    refreshedChannelPersisted: true,
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

test("atomically activates Complete Import and restores canonical Backup snapshots", async ({
  page,
}) => {
  await expect(scenario(page, "canonical-complete-import")).resolves.toEqual({
    vaultLabel: "Imported research",
    readOnly: true,
    authoringPreserved: true,
    vacuumAdoption: { relation: "incoming-vacuum-successor", changed: true },
    vacuumReopened: true,
    predecessorMaterializationsRemoved: true,
    predecessorAfterAdoption: { relation: "incoming-generation-ancestor", changed: false },
    successorStatePreserved: true,
    garbageCollectionReclaimedPredecessor: true,
    garbageCollectionReclaimedArtifact: true,
    garbageCollectionResumedAfterInterruption: true,
    backupSnapshotCommitted: true,
    backupRestoredReadable: true,
    backupKnownNoop: true,
    recordCount: 2,
    resolutionCount: 4,
    epochCount: 1,
    restartedReadable: true,
    knownRelation: "equal",
    incomingRelation: "incoming-fast-forward",
    reconciliation: { relation: "incoming-fast-forward", changed: true },
    ancestorReconciliation: { relation: "incoming-ancestor", changed: false },
    divergentReconciliation: { relation: "divergent", changed: false },
    reconciledLifecycle: 2,
    collisionStatePreserved: true,
    reconciledRecordCount: 3,
    duplicate: "VAULT_ALREADY_EXISTS",
  });
});

test("survives a client restart before Recovery Phrase confirmation and atomically consumes setup", async ({
  page,
}) => {
  await expect(scenario(page, "canonical-vault-ceremony")).resolves.toEqual({
    mismatch: "RECOVERY_PHRASE_MISMATCH",
    directoryCount: 1,
    selected: true,
    opened: true,
    resumableSetupId: true,
    resumablePhraseAbsent: true,
    resumedAfterRestart: true,
    reused: "VAULT_CREATION_NOT_FOUND",
  });
});

test("recovers a canonical Member into a fresh Client and reopens it after restart", async ({
  page,
}) => {
  await expect(scenario(page, "canonical-member-recovery")).resolves.toEqual({
    readOnlyBeforeRecovery: true,
    recoveredSameMember: true,
    freshClientCredential: true,
    recoveryEventAccepted: true,
    replacementRevision: 1,
    oldPhraseRetired: true,
    effectiveRecoveryHeads: 1,
    restartedClientActive: true,
    authoredAfterRestart: true,
    clientSecretCount: 1,
    epochSecretCount: 1,
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
    restartedForkCaptureCount: 2,
    restartedForkNoteBody: "Revised body.",
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
    secondVacuumAdvancedGeneration: true,
    postSecondVacuumCaptureCount: 2,
    postSecondVacuumNoteBody: "Revised body.",
    forkRecoveryWordCount: 12,
    forkIdentityFresh: true,
    forkCaptureCount: 2,
    forkNoteBody: "Revised body.",
    sourceCaptureCountAfterFork: 2,
    closureIdempotent: true,
    closedWriteRejected: "Closed Vaults cannot author Content Events",
    restartedClosedSearchNote: { kind: "Note", title: "Context", snippet: "Revised body." },
    recordCount: 31,
    restartSelected: "First",
    restartVaultCount: 3,
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
    importedBeforePromotion: false,
    importedPresent: true,
    opaqueTamperRejected: true,
    corruptionDetected: true,
    repairedPresent: true,
    orphanRemoved: true,
    removed: true,
  });
});
