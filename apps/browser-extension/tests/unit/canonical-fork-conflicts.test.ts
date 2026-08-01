import { describe, expect, it } from "vitest";

import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { advisoryExtensions } from "../../src/domain/canonical/features";
import { identifier } from "../../src/domain/canonical/identifiers";
import { signVaultEvent } from "../../src/domain/canonical/record";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import {
  CanonicalReplayService,
  type ReplayedCanonicalVault,
} from "../../src/runtime/projection/canonical-replay";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import { buildForkContentCheckpoint } from "../../src/runtime/vault/canonical-fork-content";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";
import {
  type PersistedOpenedCanonicalVault,
  requireCanonicalClientSecret,
} from "../../src/runtime/vault/canonical-service";
import {
  buildVacuumContentCheckpoint,
  type CanonicalVacuumContentState,
  decodeVacuumContentCheckpoint,
  deriveForkContentState,
  deriveVacuumContentState,
} from "../../src/runtime/vault/canonical-vacuum-content-checkpoint";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

async function replayFromState(
  state: CanonicalVacuumContentState,
): Promise<ReplayedCanonicalVault> {
  const initialContent = buildVacuumContentCheckpoint(state, {
    createCause: (sourceCauseId) => identifier("BaselineCause", sourceCauseId),
    retainDeletedCaptures: true,
  });
  const creation = await prepareCanonicalVaultCreation({
    label: state.vaultLabel.value,
    assertedAt: 1,
    initialContent,
  });
  const replicaState: CanonicalReplicaState = {
    vaultId: creation.ids.vaultId,
    generationId: creation.ids.generationId,
    causalFrontier: [creation.genesis.recordId],
    authorityFrontier: [creation.genesis.recordId],
    continuityRecordIds: [creation.genesis.recordId],
    baselineId: creation.baseline.recordId,
    currentKeyEpochId: creation.secrets.keyEpoch.id,
    requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
    authoringClientCredentialId: creation.ids.clientCredentialId,
    memberId: creation.ids.firstMemberId,
    lifecycle: 1,
    preservationRoots: [],
    garbageCollectionFences: [],
    adoption: null,
  };
  const vault = {
    directory: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      label: state.vaultLabel.value,
      selectedClientCredentialId: creation.ids.clientCredentialId,
    },
    replicaState,
    clientSecret: {
      vaultId: creation.ids.vaultId,
      memberId: creation.ids.firstMemberId,
      clientCredentialId: creation.ids.clientCredentialId,
      signingPublicKey: creation.secrets.client.signingPublicKey,
      signingSecretKey: creation.secrets.client.signingSecretKey,
      wrappingPublicKey: creation.secrets.client.wrappingPublicKey,
      wrappingPrivateKey: creation.secrets.client.wrappingPrivateKey,
    },
    epochSecret: {
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      displayNumber: 0,
      key: creation.secrets.keyEpoch.key,
    },
    baseline: creation.baseline,
    genesis: creation.genesis,
    installationWrappingKey: {} as CryptoKey,
    replicaStateStorageBytes: new Uint8Array(),
  } satisfies PersistedOpenedCanonicalVault;
  return new CanonicalReplayService({} as never).replayOpened(vault);
}

describe("canonical conflict-preserving Fork", () => {
  it("replays complete Collection, Folder, and Note candidates from a Fork Baseline", async () => {
    const collectionA = filled("Collection", 1);
    const collectionB = filled("Collection", 2);
    const collectionC = filled("Collection", 3);
    const folderA = filled("Folder", 4);
    const folderB = filled("Folder", 5);
    const noteId = filled("Note", 6);
    const noteObjectA = filled("VaultObject", 7);
    const noteObjectB = filled("VaultObject", 8);
    const collectionCauseA = filled("VaultRecord", 11);
    const collectionCauseB = filled("VaultRecord", 12);
    const folderCauseA = filled("VaultRecord", 13);
    const folderCauseB = filled("VaultRecord", 14);
    const noteCauseA = filled("VaultRecord", 15);
    const noteCauseB = filled("VaultRecord", 16);
    const attribution = {
      originVaultId: filled("Vault", 17),
      memberId: filled("Member", 18),
      clientCredentialId: filled("ClientCredential", 19),
      assertedAt: 20,
    };
    const state: CanonicalVacuumContentState = {
      vaultLabel: { value: "Conflicted", headCauseIds: [] },
      credentialLabels: [],
      captures: [],
      collections: [collectionA, collectionB, collectionC].map((collectionId) => ({
        collectionId,
        explicitTitle: null,
        titleHeadCauseIds: [],
        folderId: null,
        folderHeadCauseIds: [],
        activeRedirect: null,
        intrinsicTail: null,
        effectiveTail: null,
      })),
      folders: [
        {
          folderId: folderA,
          name: "A",
          nameHeadCauseIds: [folderCauseA],
          parentFolderId: null,
          parentHeadCauseIds: [],
          lifecycle: 1,
          lifecycleHeadCauseIds: [folderCauseA],
        },
        {
          folderId: folderB,
          name: "B",
          nameHeadCauseIds: [folderCauseB],
          parentFolderId: null,
          parentHeadCauseIds: [],
          lifecycle: 1,
          lifecycleHeadCauseIds: [folderCauseB],
        },
      ],
      tags: [],
      tagAssignments: [],
      notes: [
        {
          noteId,
          targetKind: 1,
          targetId: collectionA,
          state: 3,
          versions: [
            {
              headCauseId: noteCauseA,
              contentObjectId: noteObjectA,
              restoreContentObjectId: null,
              attribution,
            },
            {
              headCauseId: noteCauseB,
              contentObjectId: noteObjectB,
              restoreContentObjectId: null,
              attribution,
            },
          ],
        },
      ],
      activeConflicts: [
        {
          kind: 1,
          subjectIds: [collectionA],
          candidates: [
            {
              headCauseId: collectionCauseA,
              redirects: [{ sourceId: collectionA, destinationId: collectionB }],
            },
            {
              headCauseId: collectionCauseB,
              redirects: [{ sourceId: collectionA, destinationId: collectionC }],
            },
          ],
        },
        {
          kind: 2,
          subjectIds: [folderA, folderB],
          candidates: [
            {
              headCauseId: folderCauseA,
              placements: [{ folderId: folderA, parentFolderId: folderB }],
            },
            {
              headCauseId: folderCauseB,
              placements: [{ folderId: folderB, parentFolderId: folderA }],
            },
          ],
        },
        {
          kind: 4,
          subjectIds: [noteId],
          candidates: [
            { headCauseId: noteCauseA, noteId, contentObjectId: noteObjectA },
            { headCauseId: noteCauseB, noteId, contentObjectId: noteObjectB },
          ],
        },
      ],
    };
    const replay = await replayFromState(state);

    const forkState = deriveForkContentState(replay);

    expect(forkState.activeConflicts).toEqual(state.activeConflicts);
    expect(forkState.folders.map(({ parentHeadCauseIds }) => parentHeadCauseIds)).toEqual([[], []]);
    expect(forkState.notes[0]).toMatchObject({
      state: 3,
      versions: [
        expect.objectContaining({ headCauseId: noteCauseA }),
        expect.objectContaining({ headCauseId: noteCauseB }),
      ],
    });

    const mapped = buildForkContentCheckpoint(forkState, {
      mapIdentifier: (kind, source) =>
        identifier(kind, new Uint8Array(32).fill((source[0] ?? 0) + 100)),
    });
    const destination = decodeVacuumContentCheckpoint(mapped.content.checkpoint);
    expect(destination.activeConflicts).toHaveLength(3);
    expect(destination.activeConflicts[0]).toMatchObject({
      kind: 1,
      subjectIds: [filled("Collection", 101)],
      candidates: [
        expect.objectContaining({ headCauseId: filled("VaultRecord", 111) }),
        expect.objectContaining({ headCauseId: filled("VaultRecord", 112) }),
      ],
    });
    expect(destination.activeConflicts[1]).toMatchObject({
      kind: 2,
      subjectIds: [filled("Folder", 104), filled("Folder", 105)],
    });
    expect(destination.activeConflicts[2]).toMatchObject({
      kind: 4,
      subjectIds: [filled("Note", 106)],
      candidates: [
        expect.objectContaining({ contentObjectId: filled("VaultObject", 107) }),
        expect.objectContaining({ contentObjectId: filled("VaultObject", 108) }),
      ],
    });
  });

  it("keeps Vacuum fail-closed for the same checkpointed conflicts", async () => {
    const conflictCause = filled("VaultRecord", 31);
    const collectionA = filled("Collection", 32);
    const collectionB = filled("Collection", 33);
    const replay = await replayFromState({
      vaultLabel: { value: null, headCauseIds: [] },
      credentialLabels: [],
      captures: [],
      collections: [],
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [],
      activeConflicts: [
        {
          kind: 1,
          subjectIds: [collectionA],
          candidates: [
            {
              headCauseId: conflictCause,
              redirects: [{ sourceId: collectionA, destinationId: collectionB }],
            },
          ],
        },
      ],
    });

    expect(() => deriveVacuumContentState(replay)).toThrow(
      /Vacuum preflight requires every checkpointed Conflict to be resolved/u,
    );
  });

  it("removes checkpointed Collection candidates after an exact descendant Resolution", async () => {
    const collectionA = filled("Collection", 41);
    const collectionB = filled("Collection", 42);
    const collectionC = filled("Collection", 43);
    const causeA = filled("VaultRecord", 44);
    const causeB = filled("VaultRecord", 45);
    const replay = await replayFromState({
      vaultLabel: { value: null, headCauseIds: [] },
      credentialLabels: [],
      captures: [],
      collections: [collectionA, collectionB, collectionC].map((collectionId) => ({
        collectionId,
        explicitTitle: null,
        titleHeadCauseIds: [],
        folderId: null,
        folderHeadCauseIds: [],
        activeRedirect: null,
        intrinsicTail: null,
        effectiveTail: null,
      })),
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [],
      activeConflicts: [
        {
          kind: 1,
          subjectIds: [collectionA],
          candidates: [
            {
              headCauseId: causeA,
              redirects: [{ sourceId: collectionA, destinationId: collectionB }],
            },
            {
              headCauseId: causeB,
              redirects: [{ sourceId: collectionA, destinationId: collectionC }],
            },
          ],
        },
      ],
    });
    const resolution = await signVaultEvent(
      {
        vaultId: replay.vault.replicaState.vaultId,
        generationId: replay.vault.replicaState.generationId,
        parentRecordIds: [replay.vault.genesis.recordId],
        authorityParentRecordIds: [replay.vault.genesis.recordId],
        dependencies: [],
        requiredFeatureSetId: replay.vault.replicaState.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 2,
        type: 10,
        signerCredentialId: requireCanonicalClientSecret(replay.vault).clientCredentialId,
        assertedAt: 46,
        body: canonicalMap([
          [0, canonicalSet([causeA, causeB])],
          [1, canonicalSet([])],
        ]),
      },
      requireCanonicalClientSecret(replay.vault).signingSecretKey,
    );
    replay.graph.add(resolution.recordId, resolution.parentRecordIds);
    const resolvedReplay: ReplayedCanonicalVault = {
      ...replay,
      events: [...replay.events, resolution],
    };

    expect(deriveForkContentState(resolvedReplay).activeConflicts).toEqual([]);
  });

  it("replays and replaces checkpointed Folder candidates through one acyclic Resolution", async () => {
    const folderA = filled("Folder", 51);
    const folderB = filled("Folder", 52);
    const causeA = filled("VaultRecord", 53);
    const causeB = filled("VaultRecord", 54);
    const replay = await replayFromState({
      vaultLabel: { value: null, headCauseIds: [] },
      credentialLabels: [],
      captures: [],
      collections: [],
      folders: [
        {
          folderId: folderA,
          name: "A",
          nameHeadCauseIds: [causeA],
          parentFolderId: null,
          parentHeadCauseIds: [],
          lifecycle: 1,
          lifecycleHeadCauseIds: [causeA],
        },
        {
          folderId: folderB,
          name: "B",
          nameHeadCauseIds: [causeB],
          parentFolderId: null,
          parentHeadCauseIds: [],
          lifecycle: 1,
          lifecycleHeadCauseIds: [causeB],
        },
      ],
      tags: [],
      tagAssignments: [],
      notes: [],
      activeConflicts: [
        {
          kind: 2,
          subjectIds: [folderA, folderB],
          candidates: [
            {
              headCauseId: causeA,
              placements: [{ folderId: folderA, parentFolderId: folderB }],
            },
            {
              headCauseId: causeB,
              placements: [{ folderId: folderB, parentFolderId: folderA }],
            },
          ],
        },
      ],
    });
    const resolution = await signVaultEvent(
      {
        vaultId: replay.vault.replicaState.vaultId,
        generationId: replay.vault.replicaState.generationId,
        parentRecordIds: [replay.vault.genesis.recordId],
        authorityParentRecordIds: [replay.vault.genesis.recordId],
        dependencies: [],
        requiredFeatureSetId: replay.vault.replicaState.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 2,
        type: 17,
        signerCredentialId: requireCanonicalClientSecret(replay.vault).clientCredentialId,
        assertedAt: 55,
        body: canonicalMap([
          [0, canonicalSet([causeA, causeB])],
          [
            1,
            canonicalSet([
              canonicalMap([
                [0, folderA],
                [1, null],
              ]),
              canonicalMap([
                [0, folderB],
                [1, folderA],
              ]),
            ]),
          ],
        ]),
      },
      requireCanonicalClientSecret(replay.vault).signingSecretKey,
    );
    replay.graph.add(resolution.recordId, resolution.parentRecordIds);

    const forkState = deriveForkContentState({
      ...replay,
      events: [...replay.events, resolution],
    });

    expect(forkState.activeConflicts).toEqual([]);
    expect(forkState.folders).toEqual([
      expect.objectContaining({
        folderId: folderA,
        parentFolderId: null,
        parentHeadCauseIds: [resolution.recordId],
      }),
      expect.objectContaining({
        folderId: folderB,
        parentFolderId: folderA,
        parentHeadCauseIds: [resolution.recordId],
      }),
    ]);
  });

  it("blocks quarantined Capture identity collisions instead of selecting a candidate", async () => {
    const replay = await replayFromState({
      vaultLabel: { value: null, headCauseIds: [] },
      credentialLabels: [],
      captures: [],
      collections: [],
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [],
      activeConflicts: [],
    });
    const bundleId = filled("Bundle", 61);
    const registrations = await Promise.all(
      [
        {
          descriptorObjectId: filled("VaultObject", 62),
          collectionId: filled("Collection", 63),
        },
        {
          descriptorObjectId: filled("VaultObject", 64),
          collectionId: filled("Collection", 65),
        },
      ].map((candidate, index) =>
        signVaultEvent(
          {
            vaultId: replay.vault.replicaState.vaultId,
            generationId: replay.vault.replicaState.generationId,
            parentRecordIds: [replay.vault.genesis.recordId],
            authorityParentRecordIds: [replay.vault.genesis.recordId],
            dependencies: [
              {
                type: DEPENDENCY_TYPES.BundleDescriptorObject,
                id: candidate.descriptorObjectId,
              },
            ],
            requiredFeatureSetId: replay.vault.replicaState.requiredFeatureSetId,
            extensions: advisoryExtensions([]),
            family: 2,
            type: 3,
            signerCredentialId: requireCanonicalClientSecret(replay.vault).clientCredentialId,
            assertedAt: 66 + index,
            body: canonicalMap([
              [0, bundleId],
              [1, candidate.descriptorObjectId],
              [2, candidate.collectionId],
            ]),
          },
          requireCanonicalClientSecret(replay.vault).signingSecretKey,
        ),
      ),
    );
    for (const registration of registrations) {
      replay.graph.add(registration.recordId, registration.parentRecordIds);
    }

    expect(() =>
      deriveForkContentState({ ...replay, events: [...replay.events, ...registrations] }),
    ).toThrow(/Fork preflight found a Capture identity conflict/u);
  });
});
