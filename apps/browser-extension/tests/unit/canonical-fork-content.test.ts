import { describe, expect, it } from "vitest";

import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { advisoryExtensions } from "../../src/domain/canonical/features";
import { identifier } from "../../src/domain/canonical/identifiers";
import {
  ARTIFACT_OBJECT,
  BUNDLE_DESCRIPTOR_OBJECT,
  encodeVaultObject,
  NOTE_CONTENT_OBJECT,
} from "../../src/domain/canonical/object";
import { exactMap, mapValue } from "../../src/domain/canonical/schema";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  encodeCanonicalValue,
} from "../../src/domain/canonical/value";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import {
  buildForkContentCheckpoint,
  type ForkIdentifierKind,
  rebuildForkVaultObject,
} from "../../src/runtime/vault/canonical-fork-content";
import {
  type CanonicalVacuumContentState,
  decodeVacuumContentCheckpoint,
} from "../../src/runtime/vault/canonical-vacuum-content-checkpoint";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, key) => [key, value] as const));
}

describe("canonical Fork Content checkpoint", () => {
  it("maps every destination identity while retaining only historical attribution", () => {
    const sourceVaultId = filled("Vault", 1);
    const memberId = filled("Member", 2);
    const credentialId = filled("ClientCredential", 3);
    const bundleId = filled("Bundle", 4);
    const descriptorObjectId = filled("VaultObject", 5);
    const collectionId = filled("Collection", 6);
    const destinationCollectionId = filled("Collection", 7);
    const folderId = filled("Folder", 8);
    const tagId = filled("Tag", 9);
    const assignmentId = filled("TagAssignment", 10);
    const noteId = filled("Note", 11);
    const noteContentObjectId = filled("VaultObject", 12);
    const sharedCause = filled("VaultRecord", 13);
    const state: CanonicalVacuumContentState = {
      vaultLabel: { value: "Research", headCauseIds: [sharedCause] },
      credentialLabels: [
        { clientCredentialId: credentialId, value: "Laptop", headCauseIds: [sharedCause] },
      ],
      captures: [
        {
          bundleId,
          descriptorObjectId,
          assignedCollectionId: collectionId,
          assignmentHeadCauseIds: [sharedCause],
          lifecycle: 1,
          lifecycleHeadCauseIds: [sharedCause],
          registrationCauseId: sharedCause,
          attribution: {
            originVaultId: sourceVaultId,
            memberId,
            clientCredentialId: credentialId,
            assertedAt: 14,
          },
        },
      ],
      collections: [
        {
          collectionId,
          explicitTitle: "Inbox",
          titleHeadCauseIds: [sharedCause],
          folderId,
          folderHeadCauseIds: [sharedCause],
          activeRedirect: {
            destinationCollectionId,
            controllingCauseId: sharedCause,
          },
          intrinsicTail: { bundleId, registrationCauseId: sharedCause },
          effectiveTail: { bundleId, registrationCauseId: sharedCause },
        },
        {
          collectionId: destinationCollectionId,
          explicitTitle: null,
          titleHeadCauseIds: [],
          folderId: null,
          folderHeadCauseIds: [],
          activeRedirect: null,
          intrinsicTail: null,
          effectiveTail: { bundleId, registrationCauseId: sharedCause },
        },
      ],
      folders: [
        {
          folderId,
          name: "Sources",
          nameHeadCauseIds: [sharedCause],
          parentFolderId: null,
          parentHeadCauseIds: [sharedCause],
          lifecycle: 1,
          lifecycleHeadCauseIds: [sharedCause],
        },
      ],
      tags: [
        {
          tagId,
          name: "Read",
          nameHeadCauseIds: [sharedCause],
          activeRedirect: null,
          lifecycle: 1,
          lifecycleHeadCauseIds: [sharedCause],
        },
      ],
      tagAssignments: [
        {
          assignmentId,
          assignedCauseId: sharedCause,
          tagId,
          targetKind: 2,
          targetId: bundleId,
        },
      ],
      notes: [
        {
          noteId,
          targetKind: 1,
          targetId: collectionId,
          state: 1,
          versions: [
            {
              headCauseId: sharedCause,
              contentObjectId: noteContentObjectId,
              restoreContentObjectId: null,
              attribution: {
                originVaultId: sourceVaultId,
                memberId,
                clientCredentialId: credentialId,
                assertedAt: 15,
              },
            },
          ],
        },
      ],
      activeConflicts: [],
    };
    const offsets: Record<ForkIdentifierKind, number> = {
      Bundle: 100,
      Collection: 101,
      Folder: 102,
      Tag: 103,
      TagAssignment: 104,
      Note: 105,
      VaultObject: 106,
      BaselineCause: 107,
    };

    const fork = buildForkContentCheckpoint(state, {
      mapIdentifier: (kind, source) =>
        identifier(kind, new Uint8Array(32).fill((source[0] ?? 0) + offsets[kind])),
    });

    expect(fork.state.vaultLabel.value).toBe("Research");
    expect(fork.state.credentialLabels).toEqual([]);
    expect(fork.state.captures[0]).toMatchObject({
      bundleId: filled("Bundle", 104),
      descriptorObjectId: filled("VaultObject", 111),
      assignedCollectionId: filled("Collection", 107),
      attribution: {
        originVaultId: sourceVaultId,
        memberId,
        clientCredentialId: credentialId,
        assertedAt: 14,
      },
    });
    expect(fork.state.collections[0]).toMatchObject({
      collectionId: filled("Collection", 107),
      folderId: filled("Folder", 110),
      activeRedirect: { destinationCollectionId: filled("Collection", 108) },
      intrinsicTail: { bundleId: filled("Bundle", 104) },
    });
    expect(fork.state.tags[0]?.tagId).toEqual(filled("Tag", 112));
    expect(fork.state.tagAssignments[0]).toMatchObject({
      assignmentId: filled("TagAssignment", 114),
      tagId: filled("Tag", 112),
      targetId: filled("Bundle", 104),
    });
    expect(fork.state.notes[0]).toMatchObject({
      noteId: filled("Note", 116),
      targetId: filled("Collection", 107),
      versions: [expect.objectContaining({ contentObjectId: filled("VaultObject", 118) })],
    });
    expect(fork.content.dependencies).toEqual([
      { type: DEPENDENCY_TYPES.BundleDescriptorObject, id: filled("VaultObject", 111) },
      { type: DEPENDENCY_TYPES.NoteContentObject, id: filled("VaultObject", 118) },
    ]);
    expect(
      new Set(fork.content.causeMapping.map(({ baselineCauseId }) => baselineCauseId[0])),
    ).toEqual(new Set([120]));
  });

  it("retains Deleted Captures and their scoped organization state", () => {
    const cause = filled("VaultRecord", 20);
    const bundleId = filled("Bundle", 21);
    const collectionId = filled("Collection", 22);
    const state: CanonicalVacuumContentState = {
      vaultLabel: { value: null, headCauseIds: [] },
      credentialLabels: [],
      captures: [
        {
          bundleId,
          descriptorObjectId: filled("VaultObject", 23),
          assignedCollectionId: collectionId,
          assignmentHeadCauseIds: [cause],
          lifecycle: 2,
          lifecycleHeadCauseIds: [cause],
          registrationCauseId: cause,
          attribution: {
            originVaultId: filled("Vault", 24),
            memberId: filled("Member", 25),
            clientCredentialId: filled("ClientCredential", 26),
            assertedAt: 27,
          },
        },
      ],
      collections: [],
      folders: [],
      tags: [],
      tagAssignments: [
        {
          assignmentId: filled("TagAssignment", 28),
          assignedCauseId: cause,
          tagId: filled("Tag", 29),
          targetKind: 2,
          targetId: bundleId,
        },
      ],
      notes: [
        {
          noteId: filled("Note", 30),
          targetKind: 2,
          targetId: bundleId,
          state: 1,
          versions: [
            {
              headCauseId: cause,
              contentObjectId: filled("VaultObject", 31),
              restoreContentObjectId: null,
              attribution: {
                originVaultId: filled("Vault", 24),
                memberId: filled("Member", 25),
                clientCredentialId: filled("ClientCredential", 26),
                assertedAt: 32,
              },
            },
          ],
        },
      ],
      activeConflicts: [],
    };
    const fork = buildForkContentCheckpoint(state, {
      mapIdentifier: (kind, source) =>
        identifier(kind, new Uint8Array(32).fill((source[0] ?? 0) + 64)),
    });
    const decoded = decodeVacuumContentCheckpoint(fork.content.checkpoint);

    expect(decoded.captures).toHaveLength(1);
    expect(decoded.captures[0]?.lifecycle).toBe(2);
    expect(decoded.tagAssignments).toHaveLength(1);
    expect(decoded.notes).toHaveLength(1);
    expect(fork.content.omissions).toEqual([]);
  });

  it("creates a fresh Genesis over the prepared Fork Content checkpoint", async () => {
    const state: CanonicalVacuumContentState = {
      vaultLabel: { value: "Forked research", headCauseIds: [filled("VaultRecord", 40)] },
      credentialLabels: [],
      captures: [],
      collections: [],
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [],
      activeConflicts: [],
    };
    const fork = buildForkContentCheckpoint(state, {
      mapIdentifier: (kind, source) =>
        identifier(kind, new Uint8Array(32).fill((source[0] ?? 0) + 64)),
    });
    const requiredFeatureSetId = filled("RequiredFeatureSet", 41);

    const prepared = await prepareCanonicalVaultCreation({
      label: "Forked research",
      assertedAt: 42,
      initialContent: fork.content,
      requiredFeatureSetId,
    });
    const body = exactMap(prepared.baseline.body, [0, 1, 2, 3, 4, 5], "Fork Baseline body");

    expect(mapValue(body, 1)).toBe(1);
    expect(encodeCanonicalValue(mapValue(body, 2))).toEqual(
      encodeCanonicalValue(fork.content.checkpoint),
    );
    expect(prepared.baseline.requiredFeatureSetId).toEqual(requiredFeatureSetId);
    expect(prepared.genesis.requiredFeatureSetId).toEqual(requiredFeatureSetId);
    expect(prepared.baseline.dependencies).toEqual(
      expect.arrayContaining([
        { type: DEPENDENCY_TYPES.KeyEnvelope, id: prepared.clientKeyEnvelope.id },
        { type: DEPENDENCY_TYPES.KeyEnvelope, id: prepared.recoveryKeyEnvelope.id },
      ]),
    );
    expect(prepared.genesis.parentRecordIds).toEqual([]);
  });

  it("rebuilds every Vault Object under the destination Vault identity", () => {
    const sourceVaultId = filled("Vault", 50);
    const destinationVaultId = filled("Vault", 51);
    const sourceFeatureSetId = filled("RequiredFeatureSet", 52);
    const destinationFeatureSetId = filled("RequiredFeatureSet", 53);
    const sourceBundleId = filled("Bundle", 54);
    const destinationBundleId = filled("Bundle", 55);
    const artifactDigest = filled("Artifact", 56);
    const artifact = encodeVaultObject({
      vaultId: sourceVaultId,
      objectType: ARTIFACT_OBJECT,
      requiredFeatureSetId: sourceFeatureSetId,
      extensions: advisoryExtensions([]),
      body: indexedMap(
        1,
        "awsm.artifact.capture",
        "application/vnd.awsm.web-page+zip",
        "awsm.representation.web-page-zip",
        0,
        artifactDigest,
        indexedMap(1, 1_048_576, 16, 0, artifactDigest),
        encodeCanonicalValue(indexedMap(1)),
      ),
    });
    const rebuiltArtifact = rebuildForkVaultObject({
      source: artifact,
      destinationVaultId,
      requiredFeatureSetId: destinationFeatureSetId,
      mapIdentifier: () => {
        throw new Error("Artifact bodies do not contain mapped identities");
      },
    });
    const descriptor = encodeVaultObject({
      vaultId: sourceVaultId,
      objectType: BUNDLE_DESCRIPTOR_OBJECT,
      requiredFeatureSetId: sourceFeatureSetId,
      extensions: advisoryExtensions([]),
      body: indexedMap(
        1,
        sourceBundleId,
        57,
        "https://example.com/",
        "https://example.com/",
        "awsm.capture.web-page-snapshot",
        "awsm.adapter.browser-web-page",
        1,
        "Example",
        canonicalSet([indexedMap(artifact.objectId, "awsm.artifact.primary")]),
        [],
        indexedMap(1, encodeCanonicalValue(indexedMap(1))),
      ),
    });
    const rebuiltDescriptor = rebuildForkVaultObject({
      source: descriptor,
      destinationVaultId,
      requiredFeatureSetId: destinationFeatureSetId,
      mapIdentifier: <Kind extends "Bundle" | "VaultObject">(kind: Kind) =>
        (kind === "Bundle" ? destinationBundleId : rebuiltArtifact.objectId) as ReturnType<
          typeof identifier<Kind>
        >,
    });
    const note = encodeVaultObject({
      vaultId: sourceVaultId,
      objectType: NOTE_CONTENT_OBJECT,
      requiredFeatureSetId: sourceFeatureSetId,
      extensions: advisoryExtensions([]),
      body: indexedMap(1, "Title", "Body", "awsm.note.commonmark"),
    });
    const rebuiltNote = rebuildForkVaultObject({
      source: note,
      destinationVaultId,
      requiredFeatureSetId: destinationFeatureSetId,
      mapIdentifier: () => {
        throw new Error("Note bodies do not contain mapped identities");
      },
    });
    const descriptorBody = exactMap(
      rebuiltDescriptor.body,
      [...Array(12).keys()],
      "rebuilt Descriptor",
    );
    const artifactReferences = mapValue(descriptorBody, 9) as readonly ReadonlyMap<
      number,
      CanonicalValue
    >[];

    expect(rebuiltArtifact.vaultId).toEqual(destinationVaultId);
    expect(rebuiltArtifact.requiredFeatureSetId).toEqual(destinationFeatureSetId);
    expect(encodeCanonicalValue(rebuiltArtifact.body)).toEqual(encodeCanonicalValue(artifact.body));
    expect(rebuiltArtifact.objectId).not.toEqual(artifact.objectId);
    expect(mapValue(descriptorBody, 1)).toEqual(destinationBundleId);
    expect(mapValue(artifactReferences[0] as ReadonlyMap<number, CanonicalValue>, 0)).toEqual(
      rebuiltArtifact.objectId,
    );
    expect(rebuiltNote.vaultId).toEqual(destinationVaultId);
    expect(rebuiltNote.requiredFeatureSetId).toEqual(destinationFeatureSetId);
    expect(encodeCanonicalValue(rebuiltNote.body)).toEqual(encodeCanonicalValue(note.body));
    expect(rebuiltNote.objectId).not.toEqual(note.objectId);
  });
});
