import { describe, expect, it, vi } from "vitest";

import { validateContentEventBody } from "../../src/domain/canonical/content-bodies";
import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
import type { CanonicalCaptureService } from "../../src/runtime/capture/canonical-service";
import { CanonicalClientRuntime } from "../../src/runtime/client/canonical-runtime";
import type { CanonicalContentService } from "../../src/runtime/content/canonical-service";
import type { CanonicalLibraryProjectionService } from "../../src/runtime/library/canonical-projection";
import type { CanonicalSearchService } from "../../src/runtime/search/canonical-service";
import type { CanonicalVaultService } from "../../src/runtime/vault/canonical-service";

function fixture() {
  const firstVaultId = randomIdentifier("Vault");
  const secondVaultId = randomIdentifier("Vault");
  const generationId = randomIdentifier("Generation");
  const clientCredentialId = randomIdentifier("ClientCredential");
  const createdFolderId = randomIdentifier("Folder");
  const createdTagId = randomIdentifier("Tag");
  const createdTagAssignmentId = randomIdentifier("TagAssignment");
  const createdNoteId = randomIdentifier("Note");
  const ceremony = {
    recoveryPhrase:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    confirm: vi.fn(async () => ({
      vaultId: secondVaultId,
      generationId,
      memberId: randomIdentifier("Member"),
      clientCredentialId,
    })),
    cancel: vi.fn(async () => undefined),
  };
  const vaults = {
    listVaults: vi.fn(async () => [
      {
        vaultId: firstVaultId,
        generationId,
        label: "First",
        selectedClientCredentialId: clientCredentialId,
        selected: true,
      },
      {
        vaultId: secondVaultId,
        generationId,
        label: null,
        selectedClientCredentialId: clientCredentialId,
        selected: false,
      },
    ]),
    beginCreate: vi.fn(async () => ceremony),
    selectVault: vi.fn(async () => undefined),
    openVault: vi.fn(async () => ({
      replicaState: { requiredFeatureSetId: randomIdentifier("RequiredFeatureSet") },
    })),
  } as unknown as CanonicalVaultService;
  const captures = { execute: vi.fn() } as unknown as CanonicalCaptureService;
  const library = { load: vi.fn() } as unknown as CanonicalLibraryProjectionService;
  const content = { execute: vi.fn() } as unknown as CanonicalContentService;
  const search = { load: vi.fn(), query: vi.fn() } as unknown as CanonicalSearchService;
  let setup = 0;
  const runtime = new CanonicalClientRuntime(
    vaults,
    captures,
    library,
    () => `setup-${++setup}`,
    content,
    () => createdFolderId,
    () => createdTagId,
    () => createdTagAssignmentId,
    () => createdNoteId,
    search,
  );
  return {
    runtime,
    vaults,
    captures,
    library,
    content,
    search,
    ceremony,
    firstVaultId,
    secondVaultId,
    createdFolderId,
    createdTagId,
    createdTagAssignmentId,
    createdNoteId,
  };
}

describe("canonical Client Runtime", () => {
  it("presents the local Vault directory with one explicit selection", async () => {
    const { runtime, firstVaultId, secondVaultId } = fixture();

    await expect(runtime.state()).resolves.toEqual({
      selectedVaultId: identifierStorageKey(firstVaultId),
      vaults: [
        { vaultId: identifierStorageKey(firstVaultId), label: "First", selected: true },
        { vaultId: identifierStorageKey(secondVaultId), label: null, selected: false },
      ],
    });
  });

  it("keeps Recovery Phrase setup memory-only and consumes it after confirmation", async () => {
    const { runtime, ceremony, firstVaultId, secondVaultId } = fixture();
    const expectedVaultId = identifierStorageKey(firstVaultId);

    const setup = await runtime.beginVaultCreation({
      expectedVaultId,
      label: "Second",
      assertedAt: 10,
    });
    expect(setup).toEqual({ setupId: "setup-1", recoveryPhrase: ceremony.recoveryPhrase });
    await expect(
      runtime.confirmVaultCreation({
        setupId: setup.setupId,
        recoveryPhrase: ceremony.recoveryPhrase,
      }),
    ).resolves.toEqual({ vaultId: identifierStorageKey(secondVaultId) });
    await expect(
      runtime.confirmVaultCreation({
        setupId: setup.setupId,
        recoveryPhrase: ceremony.recoveryPhrase,
      }),
    ).rejects.toMatchObject({ id: "VAULT_CREATION_NOT_FOUND" });
  });

  it("rejects stale selection commands before changing the selected Vault", async () => {
    const { runtime, vaults, secondVaultId } = fixture();

    await expect(
      runtime.selectVault({
        expectedVaultId: null,
        vaultId: identifierStorageKey(secondVaultId),
      }),
    ).rejects.toMatchObject({ id: "VAULT_CONTEXT_CHANGED" });
    expect(vaults.selectVault).not.toHaveBeenCalled();
  });

  it("authors Capture only against the expected selected Vault", async () => {
    const { runtime, captures, firstVaultId } = fixture();
    const bundleId = randomIdentifier("Bundle");
    const outcome = {
      commandId: "capture-1",
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      bundleId,
      assignedCollectionId: randomIdentifier("Collection"),
      eventRecordId: randomIdentifier("VaultRecord"),
      descriptorObjectId: randomIdentifier("VaultObject"),
      artifactObjectId: randomIdentifier("VaultObject"),
      artifactStorageItemId: randomIdentifier("StorageItem"),
    };
    vi.mocked(captures.execute).mockResolvedValue(outcome);
    const primary = { blob: new Blob(["snapshot"]) };

    await expect(
      runtime.capture({
        expectedVaultId: identifierStorageKey(firstVaultId),
        commandId: "capture-1",
        originalUrl: "https://example.com/",
        finalUrl: "https://example.com/final",
        title: "Example",
        capturedAt: 10,
        primary,
      }),
    ).resolves.toEqual({ bundleId: identifierStorageKey(bundleId) });
    expect(captures.execute).toHaveBeenCalledWith({
      commandId: "capture-1",
      vaultId: firstVaultId,
      originalUrl: "https://example.com/",
      finalUrl: "https://example.com/final",
      title: "Example",
      capturedAt: 10,
      primary,
    });
  });

  it("projects a Client-safe Library view from the selected Vault", async () => {
    const { runtime, library, firstVaultId } = fixture();
    const bundleId = randomIdentifier("Bundle");
    const collectionId = randomIdentifier("Collection");
    const artifactId = randomIdentifier("Artifact");
    vi.mocked(library.load).mockResolvedValue({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      conflicts: [],
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [],
      captures: [
        {
          bundleId,
          descriptorObjectId: randomIdentifier("VaultObject"),
          assignedCollectionId: collectionId,
          currentCollectionId: collectionId,
          effectiveCollectionId: collectionId,
          registrationRecordId: randomIdentifier("VaultRecord"),
          memberId: randomIdentifier("Member"),
          clientCredentialId: randomIdentifier("ClientCredential"),
          assertedAt: 10,
          capturedAt: 9,
          originalUrl: "https://example.com/",
          finalUrl: "https://example.com/final",
          title: "Example",
          profile: "awsm.capture.web-page-snapshot",
          adapter: "awsm.adapter.browser-web-page",
          artifactObjectId: randomIdentifier("VaultObject"),
          artifactId,
          artifactStorageItemId: randomIdentifier("StorageItem"),
          artifactAvailableLocally: true,
          lifecycle: 1,
        },
      ],
      collections: [],
    });

    await expect(runtime.listLibrary(identifierStorageKey(firstVaultId))).resolves.toEqual([
      {
        bundleId: identifierStorageKey(bundleId),
        collectionId: identifierStorageKey(collectionId),
        artifactId: identifierStorageKey(artifactId),
        capturedAt: 9,
        originalUrl: "https://example.com/",
        finalUrl: "https://example.com/final",
        title: "Example",
        availableLocally: true,
        lifecycle: "Active",
      },
    ]);
  });

  it("queries the exact selected Vault and exposes safe Search results and honest coverage", async () => {
    const { runtime, search, firstVaultId } = fixture();
    const bundleId = randomIdentifier("Bundle");
    const passageId = randomIdentifier("Artifact");
    vi.mocked(search.query).mockResolvedValue([
      {
        kind: "Capture",
        id: bundleId,
        title: "Result",
        passageId,
        snippet: "safe &lt;mark&gt;",
        score: 4.5,
      },
    ]);
    vi.mocked(search.load).mockResolvedValue({
      coverage: {
        eligibleCaptures: 2,
        indexedCaptures: 2,
        unavailableHeavyContent: 2,
        failedCaptures: 0,
      },
    } as Awaited<ReturnType<CanonicalSearchService["load"]>>);
    const expectedVaultId = identifierStorageKey(firstVaultId);

    await expect(
      runtime.search({
        expectedVaultId,
        query: "result",
        scope: "Active",
        hosts: ["example.com"],
        collectionIds: [],
        tagIds: [],
      }),
    ).resolves.toEqual([
      {
        kind: "Capture",
        id: identifierStorageKey(bundleId),
        title: "Result",
        passageId: identifierStorageKey(passageId),
        snippet: "safe &lt;mark&gt;",
        score: 4.5,
      },
    ]);
    await expect(runtime.searchCoverage(expectedVaultId)).resolves.toEqual({
      eligibleCaptures: 2,
      indexedCaptures: 2,
      unavailableHeavyContent: 2,
      failedCaptures: 0,
    });
    expect(search.query).toHaveBeenCalledWith(firstVaultId, {
      query: "result",
      scope: "Active",
      hosts: ["example.com"],
      collectionIds: [],
      tagIds: [],
    });
  });

  it("resolves exactly the current Collection merge conflict with one acyclic redirect graph", async () => {
    const { runtime, library, content, firstVaultId } = fixture();
    const sourceId = randomIdentifier("Collection");
    const firstDestinationId = randomIdentifier("Collection");
    const secondDestinationId = randomIdentifier("Collection");
    const firstCauseId = randomIdentifier("VaultRecord");
    const secondCauseId = randomIdentifier("VaultRecord");
    const eventRecordId = randomIdentifier("VaultRecord");
    vi.mocked(library.load).mockResolvedValue({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [sourceId, firstDestinationId, secondDestinationId].map((collectionId) => ({
        collectionId,
        explicitTitle: null,
        title: "Collection",
        tailBundleId: null,
        activeCaptureCount: 0,
        redirectedTo: null,
        folderId: null,
      })),
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [],
      conflicts: [
        {
          kind: "CollectionMerge",
          reason: "MultipleDestinations",
          subjectCollectionIds: [sourceId],
          candidateRecordIds: canonicalSet([firstCauseId, secondCauseId]),
        },
      ],
    });
    vi.mocked(content.execute).mockResolvedValue({
      commandId: "resolve-collection-1",
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      eventRecordId,
    });

    await expect(
      runtime.resolveCollectionMergeConflict({
        expectedVaultId: identifierStorageKey(firstVaultId),
        commandId: "resolve-collection-1",
        subjectCollectionIds: [identifierStorageKey(sourceId)],
        conflictingCauseIds: [
          identifierStorageKey(secondCauseId),
          identifierStorageKey(firstCauseId),
        ],
        redirects: [
          {
            sourceCollectionId: identifierStorageKey(sourceId),
            destinationCollectionId: identifierStorageKey(secondDestinationId),
          },
        ],
        assertedAt: 20,
      }),
    ).resolves.toEqual({ eventRecordId: identifierStorageKey(eventRecordId) });
    expect(content.execute).toHaveBeenCalledWith({
      commandId: "resolve-collection-1",
      vaultId: firstVaultId,
      type: 10,
      assertedAt: 20,
      expectedCausalFrontier: expect.arrayContaining([expect.any(Uint8Array)]),
      body: canonicalMap([
        [0, canonicalSet([firstCauseId, secondCauseId])],
        [
          1,
          canonicalSet([
            canonicalMap([
              [0, sourceId],
              [1, secondDestinationId],
            ]),
          ]),
        ],
      ]),
    });
  });

  it("rejects a stale partial Collection conflict without authoring a Resolution Event", async () => {
    const { runtime, library, content, firstVaultId } = fixture();
    const sourceId = randomIdentifier("Collection");
    const destinationId = randomIdentifier("Collection");
    const firstCauseId = randomIdentifier("VaultRecord");
    const secondCauseId = randomIdentifier("VaultRecord");
    vi.mocked(library.load).mockResolvedValue({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [sourceId, destinationId].map((collectionId) => ({
        collectionId,
        explicitTitle: null,
        title: "Collection",
        tailBundleId: null,
        activeCaptureCount: 0,
        redirectedTo: null,
        folderId: null,
      })),
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [],
      conflicts: [
        {
          kind: "CollectionMerge",
          reason: "MultipleDestinations",
          subjectCollectionIds: [sourceId],
          candidateRecordIds: canonicalSet([firstCauseId, secondCauseId]),
        },
      ],
    });

    await expect(
      runtime.resolveCollectionMergeConflict({
        expectedVaultId: identifierStorageKey(firstVaultId),
        commandId: "resolve-stale-collection",
        subjectCollectionIds: [identifierStorageKey(sourceId)],
        conflictingCauseIds: [identifierStorageKey(firstCauseId)],
        redirects: [],
        assertedAt: 21,
      }),
    ).rejects.toMatchObject({ id: "COLLECTION_MERGE_CONFLICT_CHANGED" });
    expect(content.execute).not.toHaveBeenCalled();
  });

  it("exposes exact Collection and Note conflict identities without projection internals", async () => {
    const { runtime, library, firstVaultId } = fixture();
    const subjectId = randomIdentifier("Collection");
    const noteId = randomIdentifier("Note");
    const firstCauseId = randomIdentifier("VaultRecord");
    const secondCauseId = randomIdentifier("VaultRecord");
    vi.mocked(library.load).mockResolvedValue({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [],
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [],
      conflicts: [
        {
          kind: "CollectionMerge",
          reason: "Cycle",
          subjectCollectionIds: [subjectId],
          candidateRecordIds: canonicalSet([firstCauseId, secondCauseId]),
        },
        {
          kind: "Note",
          noteId,
          candidateRecordIds: canonicalSet([firstCauseId, secondCauseId]),
        },
      ],
    });

    await expect(runtime.listLibraryConflicts(identifierStorageKey(firstVaultId))).resolves.toEqual(
      [
        {
          kind: "CollectionMerge",
          reason: "Cycle",
          subjectCollectionIds: [identifierStorageKey(subjectId)],
          candidateRecordIds: canonicalSet([
            identifierStorageKey(firstCauseId),
            identifierStorageKey(secondCauseId),
          ]),
        },
        {
          kind: "Note",
          noteId: identifierStorageKey(noteId),
          candidateRecordIds: canonicalSet([
            identifierStorageKey(firstCauseId),
            identifierStorageKey(secondCauseId),
          ]),
        },
      ],
    );
  });

  it("authors the canonical Folder and Collection-placement workflow without repetitive wrappers", async () => {
    const { runtime, library, content, firstVaultId, createdFolderId } = fixture();
    const parentFolderId = randomIdentifier("Folder");
    const collectionId = randomIdentifier("Collection");
    const eventRecordId = randomIdentifier("VaultRecord");
    vi.mocked(library.load).mockResolvedValue({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [
        {
          collectionId,
          explicitTitle: null,
          title: "Collection",
          tailBundleId: null,
          activeCaptureCount: 0,
          redirectedTo: null,
          folderId: null,
        },
      ],
      folders: [
        {
          folderId: parentFolderId,
          name: "Parent",
          parentFolderId: null,
          effectiveParentFolderId: null,
          lifecycle: 1,
        },
      ],
      tags: [],
      tagAssignments: [],
      notes: [],
      conflicts: [],
    });
    vi.mocked(content.execute).mockResolvedValue({
      commandId: "folder-command",
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      eventRecordId,
    });
    const vaultId = identifierStorageKey(firstVaultId);
    const parentId = identifierStorageKey(parentFolderId);
    const createdId = identifierStorageKey(createdFolderId);

    await expect(runtime.listFolders(vaultId)).resolves.toEqual([
      {
        folderId: parentId,
        name: "Parent",
        parentFolderId: null,
        effectiveParentFolderId: null,
        lifecycle: "Active",
      },
    ]);
    await expect(
      runtime.createFolder({
        expectedVaultId: vaultId,
        commandId: "folder-create",
        name: "Child",
        parentFolderId: parentId,
        assertedAt: 30,
      }),
    ).resolves.toEqual({ folderId: createdId, eventRecordId: identifierStorageKey(eventRecordId) });
    await runtime.renameFolder({
      expectedVaultId: vaultId,
      commandId: "folder-rename",
      folderId: parentId,
      name: "Renamed",
      assertedAt: 31,
    });
    await runtime.placeFolder({
      expectedVaultId: vaultId,
      commandId: "folder-place",
      folderId: parentId,
      parentFolderId: null,
      assertedAt: 32,
    });
    await runtime.deleteFolder({
      expectedVaultId: vaultId,
      commandId: "folder-delete",
      folderId: parentId,
      assertedAt: 33,
    });
    await runtime.restoreFolder({
      expectedVaultId: vaultId,
      commandId: "folder-restore",
      folderId: parentId,
      assertedAt: 34,
    });
    await runtime.placeCollectionInFolder({
      expectedVaultId: vaultId,
      commandId: "collection-folder",
      collectionId: identifierStorageKey(collectionId),
      folderId: parentId,
      assertedAt: 35,
    });

    expect(vi.mocked(content.execute).mock.calls.map(([command]) => command)).toEqual([
      {
        commandId: "folder-create",
        vaultId: firstVaultId,
        type: 12,
        assertedAt: 30,
        body: canonicalMap([
          [0, createdFolderId],
          [1, "Child"],
          [2, parentFolderId],
        ]),
      },
      {
        commandId: "folder-rename",
        vaultId: firstVaultId,
        type: 13,
        assertedAt: 31,
        body: canonicalMap([
          [0, parentFolderId],
          [1, "Renamed"],
        ]),
      },
      {
        commandId: "folder-place",
        vaultId: firstVaultId,
        type: 14,
        assertedAt: 32,
        body: canonicalMap([
          [0, parentFolderId],
          [1, null],
        ]),
      },
      {
        commandId: "folder-delete",
        vaultId: firstVaultId,
        type: 15,
        assertedAt: 33,
        body: canonicalMap([[0, parentFolderId]]),
      },
      {
        commandId: "folder-restore",
        vaultId: firstVaultId,
        type: 16,
        assertedAt: 34,
        body: canonicalMap([[0, parentFolderId]]),
      },
      {
        commandId: "collection-folder",
        vaultId: firstVaultId,
        type: 11,
        assertedAt: 35,
        body: canonicalMap([
          [0, collectionId],
          [1, parentFolderId],
        ]),
      },
    ]);
  });

  it("resolves only the exact current Folder conflict with one complete acyclic forest", async () => {
    const { runtime, library, content, firstVaultId } = fixture();
    const firstFolderId = randomIdentifier("Folder");
    const secondFolderId = randomIdentifier("Folder");
    const firstCauseId = randomIdentifier("VaultRecord");
    const secondCauseId = randomIdentifier("VaultRecord");
    const frontierId = randomIdentifier("VaultRecord");
    const eventRecordId = randomIdentifier("VaultRecord");
    vi.mocked(library.load).mockResolvedValue({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier: [frontierId],
      captures: [],
      collections: [],
      folders: [firstFolderId, secondFolderId].map((folderId) => ({
        folderId,
        name: "Folder",
        parentFolderId: null,
        effectiveParentFolderId: null,
        lifecycle: 1,
      })),
      tags: [],
      tagAssignments: [],
      notes: [],
      conflicts: [
        {
          kind: "Folder",
          subjectFolderIds: canonicalSet([firstFolderId, secondFolderId]),
          candidateRecordIds: canonicalSet([firstCauseId, secondCauseId]),
        },
      ],
    });
    vi.mocked(content.execute).mockResolvedValue({
      commandId: "folder-resolve",
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      eventRecordId,
    });
    const firstId = identifierStorageKey(firstFolderId);
    const secondId = identifierStorageKey(secondFolderId);
    const orderedPlacements = [
      { folderId: firstFolderId, parentFolderId: null },
      { folderId: secondFolderId, parentFolderId: firstFolderId },
    ].toSorted((left, right) =>
      identifierStorageKey(left.folderId).localeCompare(identifierStorageKey(right.folderId)),
    );

    await expect(
      runtime.resolveFolderConflict({
        expectedVaultId: identifierStorageKey(firstVaultId),
        commandId: "folder-resolve",
        subjectFolderIds: [secondId, firstId],
        conflictingCauseIds: [
          identifierStorageKey(secondCauseId),
          identifierStorageKey(firstCauseId),
        ],
        placements: [
          { folderId: secondId, parentFolderId: firstId },
          { folderId: firstId, parentFolderId: null },
        ],
        assertedAt: 40,
      }),
    ).resolves.toEqual({ eventRecordId: identifierStorageKey(eventRecordId) });
    expect(content.execute).toHaveBeenCalledWith({
      commandId: "folder-resolve",
      vaultId: firstVaultId,
      type: 17,
      assertedAt: 40,
      expectedCausalFrontier: [frontierId],
      body: canonicalMap([
        [0, canonicalSet([firstCauseId, secondCauseId])],
        [
          1,
          orderedPlacements.map((placement) =>
            canonicalMap([
              [0, placement.folderId],
              [1, placement.parentFolderId],
            ]),
          ),
        ],
      ]),
    });
  });

  it("rejects a partial stale Folder conflict without authoring a Resolution Event", async () => {
    const { runtime, library, content, firstVaultId } = fixture();
    const firstFolderId = randomIdentifier("Folder");
    const secondFolderId = randomIdentifier("Folder");
    const firstCauseId = randomIdentifier("VaultRecord");
    const secondCauseId = randomIdentifier("VaultRecord");
    vi.mocked(library.load).mockResolvedValue({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [],
      folders: [firstFolderId, secondFolderId].map((folderId) => ({
        folderId,
        name: "Folder",
        parentFolderId: null,
        effectiveParentFolderId: null,
        lifecycle: 1,
      })),
      tags: [],
      tagAssignments: [],
      notes: [],
      conflicts: [
        {
          kind: "Folder",
          subjectFolderIds: canonicalSet([firstFolderId, secondFolderId]),
          candidateRecordIds: canonicalSet([firstCauseId, secondCauseId]),
        },
      ],
    });

    await expect(
      runtime.resolveFolderConflict({
        expectedVaultId: identifierStorageKey(firstVaultId),
        commandId: "folder-stale",
        subjectFolderIds: [
          identifierStorageKey(firstFolderId),
          identifierStorageKey(secondFolderId),
        ],
        conflictingCauseIds: [identifierStorageKey(firstCauseId)],
        placements: [
          { folderId: identifierStorageKey(firstFolderId), parentFolderId: null },
          { folderId: identifierStorageKey(secondFolderId), parentFolderId: null },
        ],
        assertedAt: 41,
      }),
    ).rejects.toMatchObject({ id: "FOLDER_CONFLICT_CHANGED" });
    expect(content.execute).not.toHaveBeenCalled();
  });

  it("blocks ordinary hierarchy mutation only for Folders in an active scoped conflict", async () => {
    const { runtime, library, content, firstVaultId } = fixture();
    const firstFolderId = randomIdentifier("Folder");
    const secondFolderId = randomIdentifier("Folder");
    vi.mocked(library.load).mockResolvedValue({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [],
      folders: [firstFolderId, secondFolderId].map((folderId) => ({
        folderId,
        name: "Folder",
        parentFolderId: null,
        effectiveParentFolderId: null,
        lifecycle: 1,
      })),
      tags: [],
      tagAssignments: [],
      notes: [],
      conflicts: [
        {
          kind: "Folder",
          subjectFolderIds: canonicalSet([firstFolderId, secondFolderId]),
          candidateRecordIds: canonicalSet([
            randomIdentifier("VaultRecord"),
            randomIdentifier("VaultRecord"),
          ]),
        },
      ],
    });

    await expect(
      runtime.placeFolder({
        expectedVaultId: identifierStorageKey(firstVaultId),
        commandId: "folder-bypass",
        folderId: identifierStorageKey(firstFolderId),
        parentFolderId: null,
        assertedAt: 42,
      }),
    ).rejects.toMatchObject({ id: "FOLDER_CONFLICT" });
    expect(content.execute).not.toHaveBeenCalled();
  });

  it("authors member-safe Tag workflows while deriving exact observed removal Causes", async () => {
    const { runtime, library, content, firstVaultId, createdTagId, createdTagAssignmentId } =
      fixture();
    const tagId = randomIdentifier("Tag");
    const assignmentId = randomIdentifier("TagAssignment");
    const assignedCauseId = randomIdentifier("VaultRecord");
    const collectionId = randomIdentifier("Collection");
    const eventRecordId = randomIdentifier("VaultRecord");
    vi.mocked(library.load).mockResolvedValue({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [
        {
          collectionId,
          explicitTitle: null,
          title: "Collection",
          tailBundleId: null,
          activeCaptureCount: 0,
          redirectedTo: null,
          folderId: null,
        },
      ],
      folders: [],
      tags: [{ tagId, name: "Saved", lifecycle: 1, redirectedTo: null }],
      tagAssignments: [
        {
          assignmentId,
          assignedCauseId,
          tagId,
          effectiveTagId: tagId,
          targetKind: 1,
          targetId: collectionId,
          active: true,
        },
      ],
      notes: [],
      conflicts: [],
    });
    vi.mocked(content.execute).mockResolvedValue({
      commandId: "tag-command",
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      eventRecordId,
    });
    const vaultId = identifierStorageKey(firstVaultId);
    const existingTagId = identifierStorageKey(tagId);
    const targetId = identifierStorageKey(collectionId);

    await expect(runtime.listTags(vaultId)).resolves.toEqual([
      { tagId: existingTagId, name: "Saved", lifecycle: "Active", redirectedTo: null },
    ]);
    await expect(runtime.listTagAssignments(vaultId)).resolves.toEqual([
      {
        assignmentId: identifierStorageKey(assignmentId),
        assignedCauseId: identifierStorageKey(assignedCauseId),
        tagId: existingTagId,
        effectiveTagId: existingTagId,
        targetKind: "Collection",
        targetId,
        active: true,
      },
    ]);
    await runtime.createTag({
      expectedVaultId: vaultId,
      commandId: "tag-create",
      name: "Research",
      assertedAt: 50,
    });
    await runtime.renameTag({
      expectedVaultId: vaultId,
      commandId: "tag-rename",
      tagId: existingTagId,
      name: "Reading",
      assertedAt: 51,
    });
    await runtime.assignTag({
      expectedVaultId: vaultId,
      commandId: "tag-assign",
      tagId: existingTagId,
      targetKind: "Collection",
      targetId,
      assertedAt: 52,
    });
    await runtime.removeTagAssignments({
      expectedVaultId: vaultId,
      commandId: "tag-remove",
      tagId: existingTagId,
      targetKind: "Collection",
      targetId,
      assertedAt: 53,
    });
    await runtime.deleteTag({
      expectedVaultId: vaultId,
      commandId: "tag-delete",
      tagId: existingTagId,
      assertedAt: 54,
    });
    await runtime.restoreTag({
      expectedVaultId: vaultId,
      commandId: "tag-restore",
      tagId: existingTagId,
      assertedAt: 55,
    });

    expect(vi.mocked(content.execute).mock.calls.map(([command]) => command)).toEqual([
      {
        commandId: "tag-create",
        vaultId: firstVaultId,
        type: 18,
        assertedAt: 50,
        body: canonicalMap([
          [0, createdTagId],
          [1, "Research"],
        ]),
      },
      {
        commandId: "tag-rename",
        vaultId: firstVaultId,
        type: 19,
        assertedAt: 51,
        body: canonicalMap([
          [0, tagId],
          [1, "Reading"],
        ]),
      },
      {
        commandId: "tag-assign",
        vaultId: firstVaultId,
        type: 20,
        assertedAt: 52,
        body: canonicalMap([
          [0, createdTagAssignmentId],
          [1, tagId],
          [
            2,
            canonicalMap([
              [0, 1],
              [1, collectionId],
            ]),
          ],
        ]),
      },
      {
        commandId: "tag-remove",
        vaultId: firstVaultId,
        type: 21,
        assertedAt: 53,
        body: canonicalMap([[0, canonicalSet([assignedCauseId])]]),
      },
      {
        commandId: "tag-delete",
        vaultId: firstVaultId,
        type: 22,
        assertedAt: 54,
        body: canonicalMap([[0, tagId]]),
      },
      {
        commandId: "tag-restore",
        vaultId: firstVaultId,
        type: 23,
        assertedAt: 55,
        body: canonicalMap([[0, tagId]]),
      },
    ]);
  });

  it("authors one Note Content Object atomically with its exact creation Event", async () => {
    const { runtime, library, content, firstVaultId, createdNoteId } = fixture();
    const collectionId = randomIdentifier("Collection");
    const eventRecordId = randomIdentifier("VaultRecord");
    vi.mocked(library.load).mockResolvedValue({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [
        {
          collectionId,
          explicitTitle: null,
          title: "Research",
          tailBundleId: null,
          activeCaptureCount: 0,
          redirectedTo: null,
          folderId: null,
        },
      ],
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [],
      conflicts: [],
    });
    vi.mocked(content.execute).mockResolvedValue({
      commandId: "note-create",
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      eventRecordId,
    });

    await expect(
      runtime.createNote({
        expectedVaultId: identifierStorageKey(firstVaultId),
        commandId: "note-create",
        targetKind: "Collection",
        targetId: identifierStorageKey(collectionId),
        title: "Context",
        body: "A complete **Note**.",
        assertedAt: 60,
      }),
    ).resolves.toEqual({
      noteId: identifierStorageKey(createdNoteId),
      eventRecordId: identifierStorageKey(eventRecordId),
    });
    expect(content.execute).toHaveBeenCalledOnce();
    const command = vi.mocked(content.execute).mock.calls[0]?.[0];
    expect(command).toMatchObject({
      commandId: "note-create",
      vaultId: firstVaultId,
      type: 27,
      assertedAt: 60,
      dependencies: [{ type: 6 }],
    });
    expect(command?.objects).toHaveLength(1);
    expect(command?.dependencies?.[0]?.id).toEqual(command?.objects?.[0]?.objectId);
  });

  it("lists, revises, deletes, and restores a Note from exact fenced current heads", async () => {
    const { runtime, library, content, firstVaultId } = fixture();
    const noteId = randomIdentifier("Note");
    const collectionId = randomIdentifier("Collection");
    const activeCauseId = randomIdentifier("VaultRecord");
    const deletedCauseId = randomIdentifier("VaultRecord");
    const frontier = [randomIdentifier("VaultRecord")];
    const eventRecordId = randomIdentifier("VaultRecord");
    const projection = (state: 1 | 2, headCauseId: typeof activeCauseId) => ({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier,
      captures: [],
      collections: [],
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [
        {
          noteId,
          targetKind: 1 as const,
          targetId: collectionId,
          state,
          versions: [
            {
              headCauseId,
              contentObjectId: state === 1 ? randomIdentifier("VaultObject") : null,
              title: state === 1 ? "Context" : null,
              body: state === 1 ? "Original" : null,
              bodyDialect: state === 1 ? ("awsm.note.commonmark" as const) : null,
              originVaultId: firstVaultId,
              memberId: randomIdentifier("Member"),
              clientCredentialId: randomIdentifier("ClientCredential"),
              assertedAt: 59,
            },
          ],
        },
      ],
      conflicts: [],
    });
    vi.mocked(library.load).mockResolvedValue(projection(1, activeCauseId));
    vi.mocked(content.execute).mockResolvedValue({
      commandId: "note-command",
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      eventRecordId,
    });
    const vaultId = identifierStorageKey(firstVaultId);
    const clientNoteId = identifierStorageKey(noteId);

    await expect(runtime.listNotes(vaultId)).resolves.toMatchObject([
      {
        noteId: clientNoteId,
        targetKind: "Collection",
        targetId: identifierStorageKey(collectionId),
        state: "Active",
        versions: [{ headCauseId: identifierStorageKey(activeCauseId), title: "Context" }],
      },
    ]);
    await runtime.reviseNote({
      expectedVaultId: vaultId,
      commandId: "note-revise",
      noteId: clientNoteId,
      title: "Updated",
      body: "Revised",
      assertedAt: 60,
    });
    await runtime.deleteNote({
      expectedVaultId: vaultId,
      commandId: "note-delete",
      noteId: clientNoteId,
      assertedAt: 61,
    });
    vi.mocked(library.load).mockResolvedValue(projection(2, deletedCauseId));
    await runtime.restoreNote({
      expectedVaultId: vaultId,
      commandId: "note-restore",
      noteId: clientNoteId,
      assertedAt: 62,
    });

    const commands = vi.mocked(content.execute).mock.calls.map(([command]) => command);
    expect(commands.map(({ type }) => type)).toEqual([28, 29, 30]);
    expect(commands.map(({ expectedCausalFrontier }) => expectedCausalFrontier)).toEqual([
      frontier,
      frontier,
      frontier,
    ]);
    const revisedObjectId = commands[0]?.objects?.[0]?.objectId;
    if (revisedObjectId === undefined) throw new Error("Revised Note Object is unavailable");
    expect(commands[0]?.body).toEqual(
      canonicalMap([
        [0, noteId],
        [1, canonicalSet([activeCauseId])],
        [2, revisedObjectId],
      ]),
    );
    expect(commands[1]?.body).toEqual(
      canonicalMap([
        [0, noteId],
        [1, canonicalSet([activeCauseId])],
      ]),
    );
    expect(commands[2]?.body).toEqual(
      canonicalMap([
        [0, noteId],
        [1, canonicalSet([deletedCauseId])],
      ]),
    );
  });

  it("resolves one exact Note Conflict by retaining and splitting whole-Note content", async () => {
    const { runtime, library, content, firstVaultId, createdNoteId } = fixture();
    const noteId = randomIdentifier("Note");
    const collectionId = randomIdentifier("Collection");
    const causes = canonicalSet(Array.from({ length: 3 }, () => randomIdentifier("VaultRecord")));
    const frontier = [randomIdentifier("VaultRecord")];
    const eventRecordId = randomIdentifier("VaultRecord");
    vi.mocked(library.load).mockResolvedValue({
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      frontier,
      captures: [],
      collections: [],
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [
        {
          noteId,
          targetKind: 1,
          targetId: collectionId,
          state: 3,
          versions: causes.map((headCauseId, index) => ({
            headCauseId,
            contentObjectId: index === 2 ? null : randomIdentifier("VaultObject"),
            title: index === 2 ? null : `Version ${index}`,
            body: index === 2 ? null : `Body ${index}`,
            bodyDialect: index === 2 ? null : ("awsm.note.commonmark" as const),
            originVaultId: firstVaultId,
            memberId: randomIdentifier("Member"),
            clientCredentialId: randomIdentifier("ClientCredential"),
            assertedAt: 60 + index,
          })),
        },
      ],
      conflicts: [{ kind: "Note", noteId, candidateRecordIds: causes }],
    });
    vi.mocked(content.execute).mockResolvedValue({
      commandId: "note-resolve",
      vaultId: firstVaultId,
      generationId: randomIdentifier("Generation"),
      eventRecordId,
    });
    const vaultId = identifierStorageKey(firstVaultId);

    await runtime.resolveNoteConflict({
      expectedVaultId: vaultId,
      commandId: "note-resolve",
      noteId: identifierStorageKey(noteId),
      conflictingCauseIds: causes.map(identifierStorageKey),
      retainedOriginal: { title: "Merged", body: "Merged body" },
      splitNotes: [{ title: "Alternate", body: "Alternate body" }],
      assertedAt: 70,
    });

    const command = vi.mocked(content.execute).mock.calls[0]?.[0];
    expect(command).toMatchObject({
      type: 31,
      expectedCausalFrontier: frontier,
      dependencies: [{ type: 6 }, { type: 6 }],
    });
    expect(command?.objects).toHaveLength(2);
    const retainedObjectId = command?.objects?.[0]?.objectId;
    const splitObjectId = command?.objects?.[1]?.objectId;
    if (retainedObjectId === undefined || splitObjectId === undefined) {
      throw new Error("Resolved Note Objects are unavailable");
    }
    expect(command?.body).toEqual(
      canonicalMap([
        [0, noteId],
        [1, causes],
        [2, retainedObjectId],
        [
          3,
          [
            canonicalMap([
              [0, createdNoteId],
              [1, splitObjectId],
            ]),
          ],
        ],
      ]),
    );
    if (command === undefined) throw new Error("Note Resolution command is unavailable");
    expect(validateContentEventBody(command.type, command.body)).toEqual(command.dependencies);
  });
});
