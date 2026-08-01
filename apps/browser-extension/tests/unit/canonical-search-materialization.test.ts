import { describe, expect, it, vi } from "vitest";

import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import type { CanonicalLibraryProjection } from "../../src/runtime/library/canonical-projection";
import {
  buildCanonicalSearchMaterialization,
  decodeCanonicalSearchMaterialization,
  encodeCanonicalSearchMaterialization,
  queryCanonicalSearch,
} from "../../src/runtime/search/canonical-materialization";
import { CanonicalSearchService } from "../../src/runtime/search/canonical-service";
import type { CanonicalVaultService } from "../../src/runtime/vault/canonical-service";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("The Search fixture is incomplete");
  return value;
}

function projection(): CanonicalLibraryProjection {
  const vaultId = randomIdentifier("Vault");
  const generationId = randomIdentifier("Generation");
  const collectionId = randomIdentifier("Collection");
  const firstBundleId = randomIdentifier("Bundle");
  const secondBundleId = randomIdentifier("Bundle");
  const tagId = randomIdentifier("Tag");
  const tagAssignmentId = randomIdentifier("TagAssignment");
  const noteId = randomIdentifier("Note");
  return {
    vaultId,
    generationId,
    frontier: [randomIdentifier("VaultRecord")],
    captures: [
      {
        bundleId: firstBundleId,
        descriptorObjectId: randomIdentifier("VaultObject"),
        assignedCollectionId: collectionId,
        currentCollectionId: collectionId,
        effectiveCollectionId: collectionId,
        registrationRecordId: randomIdentifier("VaultRecord"),
        memberId: randomIdentifier("Member"),
        clientCredentialId: randomIdentifier("ClientCredential"),
        assertedAt: 20,
        capturedAt: 20,
        originalUrl: "https://example.com/first",
        finalUrl: "https://example.com/first",
        title: "Alpha reference",
        profile: "awsm.capture.web-page-snapshot",
        adapter: "awsm.adapter.browser-web-page",
        artifactObjectId: randomIdentifier("VaultObject"),
        artifactId: randomIdentifier("Artifact"),
        artifactStorageItemId: randomIdentifier("StorageItem"),
        artifactAvailableLocally: true,
        lifecycle: 1,
      },
      {
        bundleId: secondBundleId,
        descriptorObjectId: randomIdentifier("VaultObject"),
        assignedCollectionId: collectionId,
        currentCollectionId: collectionId,
        effectiveCollectionId: collectionId,
        registrationRecordId: randomIdentifier("VaultRecord"),
        memberId: randomIdentifier("Member"),
        clientCredentialId: randomIdentifier("ClientCredential"),
        assertedAt: 10,
        capturedAt: 10,
        originalUrl: "https://example.net/second",
        finalUrl: "https://example.net/second",
        title: "Alpha reference",
        profile: "awsm.capture.web-page-snapshot",
        adapter: "awsm.adapter.browser-web-page",
        artifactObjectId: randomIdentifier("VaultObject"),
        artifactId: randomIdentifier("Artifact"),
        artifactStorageItemId: randomIdentifier("StorageItem"),
        artifactAvailableLocally: false,
        lifecycle: 1,
      },
    ],
    collections: [
      {
        collectionId,
        explicitTitle: "Research",
        title: "Research",
        tailBundleId: firstBundleId,
        activeCaptureCount: 2,
        redirectedTo: null,
        folderId: null,
      },
    ],
    folders: [],
    tags: [
      {
        tagId,
        name: "Reviewed",
        nameHeadCauseIds: [randomIdentifier("VaultRecord")],
        lifecycle: 1,
        lifecycleHeadCauseIds: [randomIdentifier("VaultRecord")],
        redirectedTo: null,
      },
    ],
    tagAssignments: [
      {
        assignmentId: tagAssignmentId,
        assignedCauseId: randomIdentifier("VaultRecord"),
        tagId,
        effectiveTagId: tagId,
        targetKind: 2,
        targetId: firstBundleId,
        active: true,
      },
    ],
    notes: [
      {
        noteId,
        targetKind: 2,
        targetId: firstBundleId,
        state: 1,
        versions: [
          {
            headCauseId: randomIdentifier("VaultRecord"),
            contentObjectId: randomIdentifier("VaultObject"),
            title: "Context",
            body: "Canonical delta details",
            bodyDialect: "awsm.note.commonmark",
            originVaultId: vaultId,
            memberId: randomIdentifier("Member"),
            clientCredentialId: randomIdentifier("ClientCredential"),
            assertedAt: 21,
          },
        ],
      },
    ],
    conflicts: [],
  };
}

describe("canonical Search Materialization", () => {
  it("binds exact authoritative context, round-trips one protected payload, and reports honest coverage", async () => {
    const source = projection();
    const materialization = await buildCanonicalSearchMaterialization(source);

    expect(materialization).toMatchObject({
      format: 1,
      vaultId: source.vaultId,
      generationId: source.generationId,
      frontier: source.frontier,
      coverage: {
        eligibleCaptures: 2,
        indexedCaptures: 2,
        unavailableHeavyContent: 2,
        failedCaptures: 0,
      },
    });
    expect(
      decodeCanonicalSearchMaterialization(encodeCanonicalSearchMaterialization(materialization)),
    ).toEqual(materialization);

    const changedFrontier = await buildCanonicalSearchMaterialization({
      ...source,
      frontier: [randomIdentifier("VaultRecord")],
    });
    const changedGeneration = await buildCanonicalSearchMaterialization({
      ...source,
      generationId: randomIdentifier("Generation"),
    });
    expect(changedFrontier.materializationId).not.toEqual(materialization.materializationId);
    expect(changedGeneration.materializationId).not.toEqual(materialization.materializationId);
  });

  it("searches authenticated Capture organization and Note content with deterministic stable-ID ties", async () => {
    const source = projection();
    const materialization = await buildCanonicalSearchMaterialization(source);
    const first = required(source.captures[0]);
    const second = required(source.captures[1]);
    const collection = required(source.collections[0]);
    const tag = required(source.tags[0]);
    const note = required(source.notes[0]);

    expect(
      queryCanonicalSearch(materialization, {
        query: "delta",
        scope: "Active",
        hosts: [],
        collectionIds: [],
        tagIds: [],
      })
        .map(({ kind, id }) => [kind, identifierStorageKey(id)] as const)
        .toSorted((left, right) => left[1].localeCompare(right[1])),
    ).toEqual([["Note", identifierStorageKey(note.noteId)]]);

    expect(
      queryCanonicalSearch(materialization, {
        query: "reviewed",
        scope: "Active",
        hosts: [],
        collectionIds: [collection.collectionId],
        tagIds: [tag.tagId],
      })
        .map(({ kind, id }) => [kind, identifierStorageKey(id)] as const)
        .toSorted((left, right) => left[1].localeCompare(right[1])),
    ).toEqual(
      [
        ["Capture", identifierStorageKey(first.bundleId)] as const,
        ["Note", identifierStorageKey(note.noteId)] as const,
      ].toSorted((left, right) => left[1].localeCompare(right[1])),
    );

    const ties = queryCanonicalSearch(materialization, {
      query: 'alpha "reference"',
      scope: "Active",
      hosts: [],
      collectionIds: [],
      tagIds: [],
    }).filter(({ kind }) => kind === "Capture");
    expect(ties.map(({ id }) => identifierStorageKey(id))).toEqual(
      source.captures.map(({ bundleId }) => identifierStorageKey(bundleId)).toSorted(),
    );

    expect(
      queryCanonicalSearch(materialization, {
        query: "alpha",
        scope: "Active",
        hosts: ["example.net"],
        collectionIds: [],
        tagIds: [],
        capturedFrom: 5,
        capturedBefore: 15,
      }).map(({ id }) => identifierStorageKey(id)),
    ).toEqual([identifierStorageKey(second.bundleId)]);
    const deletedMaterialization = await buildCanonicalSearchMaterialization({
      ...source,
      captures: source.captures.map((capture) =>
        capture === second ? { ...capture, lifecycle: 2 as const } : capture,
      ),
    });
    expect(
      queryCanonicalSearch(deletedMaterialization, {
        query: "alpha",
        scope: "Deleted",
        hosts: [],
        collectionIds: [],
        tagIds: [],
      }).map(({ id }) => identifierStorageKey(id)),
    ).toEqual([identifierStorageKey(second.bundleId)]);
  });

  it("uses bounded passages, BM25F field weights, and escaped bounded snippets", async () => {
    const source = projection();
    const note = required(source.notes[0]);
    const body = `<script>alert(1)</script> alpha ${"filler ".repeat(400)}`;
    const materialization = await buildCanonicalSearchMaterialization({
      ...source,
      notes: [{ ...note, versions: [{ ...required(note.versions[0]), body }] }],
    });
    const indexedNote = required(materialization.documents.find(({ kind }) => kind === "Note"));
    const bodyFields = indexedNote.fields.filter(({ kind }) => kind === "Body");
    expect(bodyFields.length).toBeGreaterThan(1);
    expect(
      bodyFields.every(
        ({ text, tokens }) =>
          new TextEncoder().encode(text).byteLength <= 768 && tokens.length <= 160,
      ),
    ).toBe(true);

    const results = queryCanonicalSearch(materialization, {
      query: "alpha",
      scope: "Active",
      hosts: [],
      collectionIds: [],
      tagIds: [],
    });
    expect(results[0]?.kind).toBe("Capture");
    const noteResult = required(results.find(({ kind }) => kind === "Note"));
    expect(noteResult.snippet).toContain("&lt;script&gt;");
    expect(noteResult.snippet).not.toContain("<script>");
    expect(noteResult.snippet.length).toBeLessThanOrEqual(240);
  });

  it("atomically activates only the exact wrapped Generation-and-Frontier materialization", async () => {
    let source = projection();
    let stored: Uint8Array | undefined;
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const storage = {
      getBytes: vi.fn(async () => stored),
      commitReplicaMutation: vi.fn(async (commit) => {
        expect(commit.expectedReplicaState).toEqual(new Uint8Array([7]));
        expect(commit.nextReplicaState.bytes).toEqual(new Uint8Array([7]));
        expect(commit.mutableItems).toHaveLength(1);
        stored = commit.mutableItems[0].bytes;
      }),
    };
    const vaults = {
      realm: NORMAL_STORAGE_REALM,
      storage,
      openVault: vi.fn(async () => ({
        replicaState: {
          vaultId: source.vaultId,
          generationId: source.generationId,
          causalFrontier: source.frontier,
        },
        installationWrappingKey: wrappingKey,
        replicaStateStorageBytes: new Uint8Array([7]),
      })),
    } as unknown as CanonicalVaultService;
    const library = { load: vi.fn(async () => source) };
    const service = new CanonicalSearchService(vaults, library);

    expect(NAMESPACES.searchMaterialization).toMatchObject({
      family: "materializations",
      protection: "InstallationWrapped",
      synchronization: "Never",
      exportTreatment: "Rebuild",
      backupTreatment: "Rebuild",
      immutable: false,
    });

    const first = await service.load(source.vaultId);
    const second = await service.load(source.vaultId);
    expect(second).toEqual(first);
    expect(storage.commitReplicaMutation).toHaveBeenCalledTimes(1);
    expect(storage.getBytes).toHaveBeenCalledWith(NORMAL_STORAGE_REALM, {
      namespace: NAMESPACES.searchMaterialization.key,
      scopeKey: identifierStorageKey(source.vaultId),
      itemKey: "current",
    });
    expect(new TextDecoder().decode(stored)).not.toContain("Alpha reference");

    source = { ...source, frontier: [randomIdentifier("VaultRecord")] };
    const advanced = await service.load(source.vaultId);
    expect(advanced.materializationId).not.toEqual(first.materializationId);
    expect(storage.commitReplicaMutation).toHaveBeenCalledTimes(2);
  });
});
