import { describe, expect, it } from "vitest";

import { openCompactItem } from "../../src/crypto/compact";
import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { advisoryExtensions } from "../../src/domain/canonical/features";
import { identifier } from "../../src/domain/canonical/identifiers";
import { signVaultEvent, verifyVaultEventSignature } from "../../src/domain/canonical/record";
import { CausalGraph } from "../../src/domain/canonical/reducers";
import { exactMap, mapValue } from "../../src/domain/canonical/schema";
import { type CanonicalValue, canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { bytesEqual } from "../../src/domain/hash";
import type { ReplayedCanonicalVault } from "../../src/runtime/projection/canonical-replay";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";
import type { PersistedOpenedCanonicalVault } from "../../src/runtime/vault/canonical-service";
import {
  buildVacuumContentCheckpoint,
  type CanonicalVacuumContentState,
  decodeVacuumContentCheckpoint,
  deriveInitialAuthorityVacuumContentState,
  prepareInitialAuthorityVacuum,
  prepareInitialAuthorityVacuumSuccessorBaseline,
} from "../../src/runtime/vault/canonical-vacuum-content-checkpoint";

function filled<Kind extends Parameters<typeof identifier>[0]>(kind: Kind, byte: number) {
  return identifier(kind, new Uint8Array(32).fill(byte));
}

async function registrationReplay(): Promise<{
  readonly replay: ReplayedCanonicalVault;
  readonly bundleId: ReturnType<typeof filled<"Bundle">>;
  readonly descriptorObjectId: ReturnType<typeof filled<"VaultObject">>;
  readonly collectionId: ReturnType<typeof filled<"Collection">>;
}> {
  const creation = await prepareCanonicalVaultCreation({ label: "Research", assertedAt: 1 });
  const bundleId = filled("Bundle", 20);
  const descriptorObjectId = filled("VaultObject", 21);
  const collectionId = filled("Collection", 22);
  const registration = await signVaultEvent(
    {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      parentRecordIds: [creation.genesis.recordId],
      authorityParentRecordIds: [creation.genesis.recordId],
      dependencies: [{ type: DEPENDENCY_TYPES.BundleDescriptorObject, id: descriptorObjectId }],
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 2,
      type: 3,
      signerCredentialId: creation.ids.clientCredentialId,
      assertedAt: 2,
      body: canonicalMap([
        [0, bundleId],
        [1, descriptorObjectId],
        [2, collectionId],
      ]),
    },
    creation.secrets.client.signingSecretKey,
  );
  const replicaState: CanonicalReplicaState = {
    vaultId: creation.ids.vaultId,
    generationId: creation.ids.generationId,
    causalFrontier: [registration.recordId],
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
      label: "Research",
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
  const graph = new CausalGraph();
  graph.add(creation.genesis.recordId, []);
  graph.add(registration.recordId, registration.parentRecordIds);
  return {
    replay: { vault, graph, events: [creation.genesis, registration] },
    bundleId,
    descriptorObjectId,
    collectionId,
  };
}

describe("canonical Vacuum Content checkpoint", () => {
  it("reuses one fresh Baseline Cause across every retained fact controlled by one Event", () => {
    const sourceCause = filled("VaultRecord", 1);
    const mappedCause = filled("BaselineCause", 2);
    const bundleId = filled("Bundle", 3);
    const descriptorObjectId = filled("VaultObject", 4);
    const collectionId = filled("Collection", 5);
    const state: CanonicalVacuumContentState = {
      vaultLabel: { value: "Research", headCauseIds: [sourceCause] },
      credentialLabels: [],
      captures: [
        {
          bundleId,
          descriptorObjectId,
          assignedCollectionId: collectionId,
          assignmentHeadCauseIds: [sourceCause],
          lifecycle: 1,
          lifecycleHeadCauseIds: [sourceCause],
          registrationCauseId: sourceCause,
          attribution: {
            originVaultId: filled("Vault", 6),
            memberId: filled("Member", 7),
            clientCredentialId: filled("ClientCredential", 8),
            assertedAt: 9,
          },
        },
      ],
      collections: [
        {
          collectionId,
          explicitTitle: null,
          titleHeadCauseIds: [],
          folderId: null,
          folderHeadCauseIds: [],
          activeRedirect: null,
          intrinsicTail: { bundleId, registrationCauseId: sourceCause },
          effectiveTail: { bundleId, registrationCauseId: sourceCause },
        },
      ],
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [],
      activeConflicts: [],
    };

    const built = buildVacuumContentCheckpoint(state, {
      createCause: (cause) => {
        expect(cause).toEqual(sourceCause);
        return mappedCause;
      },
    });

    const checkpoint = exactMap(built.checkpoint, [...Array(10).keys()], "Content checkpoint");
    const label = exactMap(mapValue(checkpoint, 1), [0, 1], "Vault label");
    const capture = exactMap(
      (mapValue(checkpoint, 3) as readonly CanonicalValue[])[0] as CanonicalValue,
      [...Array(8).keys()],
      "Capture",
    );
    const collection = exactMap(
      (mapValue(checkpoint, 4) as readonly CanonicalValue[])[0] as CanonicalValue,
      [...Array(8).keys()],
      "Collection",
    );
    const intrinsicTail = exactMap(mapValue(collection, 6), [0, 1], "Intrinsic tail");
    const effectiveTail = exactMap(mapValue(collection, 7), [0, 1], "Effective tail");

    expect(mapValue(label, 1)).toEqual([mappedCause]);
    expect(mapValue(capture, 3)).toEqual([mappedCause]);
    expect(mapValue(capture, 5)).toEqual([mappedCause]);
    expect(mapValue(capture, 6)).toEqual(mappedCause);
    expect(mapValue(intrinsicTail, 1)).toEqual(mappedCause);
    expect(mapValue(effectiveTail, 1)).toEqual(mappedCause);
    expect(built.causeMapping).toEqual([
      { sourceCauseId: sourceCause, baselineCauseId: mappedCause },
    ]);
    expect(built.dependencies).toEqual([
      { type: DEPENDENCY_TYPES.BundleDescriptorObject, id: descriptorObjectId },
    ]);
    expect(
      built.dependencies.some(
        ({ type, id }) => type === DEPENDENCY_TYPES.VaultRecord && id === sourceCause,
      ),
    ).toBe(false);
    expect(built.omissions).toEqual([]);
  });

  it("omits a Deleted Capture and only its Capture-scoped assignments and Notes", () => {
    const bundleId = filled("Bundle", 10);
    const collectionId = filled("Collection", 11);
    const tagId = filled("Tag", 12);
    const state: CanonicalVacuumContentState = {
      vaultLabel: { value: null, headCauseIds: [] },
      credentialLabels: [],
      captures: [
        {
          bundleId,
          descriptorObjectId: filled("VaultObject", 13),
          assignedCollectionId: collectionId,
          assignmentHeadCauseIds: [filled("VaultRecord", 14)],
          lifecycle: 2,
          lifecycleHeadCauseIds: [filled("VaultRecord", 15)],
          registrationCauseId: filled("VaultRecord", 16),
          attribution: {
            originVaultId: filled("Vault", 17),
            memberId: filled("Member", 18),
            clientCredentialId: filled("ClientCredential", 19),
            assertedAt: 20,
          },
        },
      ],
      collections: [
        {
          collectionId,
          explicitTitle: null,
          titleHeadCauseIds: [],
          folderId: null,
          folderHeadCauseIds: [],
          activeRedirect: null,
          intrinsicTail: null,
          effectiveTail: null,
        },
      ],
      folders: [],
      tags: [
        {
          tagId,
          name: "Keep",
          nameHeadCauseIds: [filled("VaultRecord", 21)],
          activeRedirect: null,
          lifecycle: 1,
          lifecycleHeadCauseIds: [filled("VaultRecord", 22)],
        },
      ],
      tagAssignments: [
        {
          assignmentId: filled("TagAssignment", 23),
          assignedCauseId: filled("VaultRecord", 24),
          tagId,
          targetKind: 2,
          targetId: bundleId,
        },
      ],
      notes: [
        {
          noteId: filled("Note", 25),
          targetKind: 2,
          targetId: bundleId,
          state: 1,
          versions: [
            {
              headCauseId: filled("VaultRecord", 26),
              contentObjectId: filled("VaultObject", 27),
              attribution: {
                originVaultId: filled("Vault", 17),
                memberId: filled("Member", 18),
                clientCredentialId: filled("ClientCredential", 19),
                assertedAt: 28,
              },
            },
          ],
        },
      ],
      activeConflicts: [],
    };

    const built = buildVacuumContentCheckpoint(state);

    expect(built.dependencies).toEqual([]);
    expect(built.omissions).toEqual([
      { kind: 1, logicalId: bundleId },
      { kind: 2, logicalId: state.tagAssignments[0]?.assignmentId },
      { kind: 3, logicalId: state.notes[0]?.noteId },
    ]);
    expect(decodeVacuumContentCheckpoint(built.checkpoint)).toMatchObject({
      captures: [],
      tagAssignments: [],
      notes: [],
      tags: [{ tagId }],
    });
  });

  it("derives exact current Capture heads and Collection tails from authenticated replay", async () => {
    const { replay, bundleId, collectionId } = await registrationReplay();
    const registration = replay.events[1];
    if (registration === undefined) throw new TypeError("Registration Event is unavailable");

    const state = deriveInitialAuthorityVacuumContentState(replay);

    expect(state.captures).toEqual([
      expect.objectContaining({
        bundleId,
        assignedCollectionId: collectionId,
        assignmentHeadCauseIds: [registration.recordId],
        lifecycleHeadCauseIds: [registration.recordId],
        registrationCauseId: registration.recordId,
      }),
    ]);
    expect(state.collections).toEqual([
      expect.objectContaining({
        collectionId,
        intrinsicTail: { bundleId, registrationCauseId: registration.recordId },
        effectiveTail: { bundleId, registrationCauseId: registration.recordId },
      }),
    ]);
  });

  it("constructs an authenticated kind-2 successor without predecessor Content dependencies", async () => {
    const { replay, descriptorObjectId } = await registrationReplay();
    const successorGenerationId = filled("Generation", 30);

    const prepared = await prepareInitialAuthorityVacuumSuccessorBaseline({
      replay,
      successorGenerationId,
      createCause: (sourceCauseId) => {
        const bytes = Uint8Array.from(sourceCauseId);
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        return identifier("BaselineCause", bytes);
      },
      protectionParameters: new Uint8Array(64).fill(32),
    });

    const body = exactMap(prepared.baseline.body, [0, 1, 2, 3, 4, 5], "Successor body");
    const commitment = exactMap(mapValue(body, 5), [0, 1, 2], "Predecessor commitment");
    expect(prepared.baseline).toMatchObject({
      vaultId: replay.vault.replicaState.vaultId,
      generationId: successorGenerationId,
    });
    expect(mapValue(body, 1)).toBe(2);
    expect(mapValue(commitment, 0)).toEqual(replay.vault.replicaState.generationId);
    expect(mapValue(commitment, 1)).toEqual(replay.vault.replicaState.causalFrontier);
    expect(mapValue(commitment, 2)).toEqual(prepared.predecessorStateDigest);
    expect(prepared.predecessorStateDigest).toHaveLength(32);
    expect(prepared.successorStateDigest).toHaveLength(32);
    expect(prepared.omissionDigest).toHaveLength(32);
    expect(prepared.baseline.dependencies).toEqual(
      expect.arrayContaining([
        { type: DEPENDENCY_TYPES.BundleDescriptorObject, id: descriptorObjectId },
        ...replay.vault.baseline.dependencies,
      ]),
    );
    expect(
      prepared.baseline.dependencies.some(({ type }) => type === DEPENDENCY_TYPES.VaultRecord),
    ).toBe(false);
    const decoded = decodeVacuumContentCheckpoint(mapValue(body, 2));
    const registrationEvent = replay.events.find((event) => event.family === 2 && event.type === 3);
    if (registrationEvent === undefined) throw new TypeError("Registration Event is unavailable");
    const registrationMapping = prepared.content.causeMapping.find(({ sourceCauseId }) =>
      bytesEqual(sourceCauseId, registrationEvent.recordId),
    );
    if (registrationMapping === undefined) throw new TypeError("Registration mapping is absent");
    expect(decoded.captures).toEqual([
      expect.objectContaining({
        descriptorObjectId,
        registrationCauseId: registrationMapping.baselineCauseId,
      }),
    ]);
    await expect(
      openCompactItem({
        vaultId: replay.vault.replicaState.vaultId,
        keyEpochId: replay.vault.epochSecret.keyEpochId,
        keyEpochKey: replay.vault.epochSecret.key,
        envelopeBytes: prepared.baselineEnvelope.bytes,
      }),
    ).resolves.toMatchObject({ payloadBytes: prepared.baseline.bytes });
  });

  it("authors the terminal predecessor Vacuum Event over the exact prepared successor", async () => {
    const { replay } = await registrationReplay();
    const successorGenerationId = filled("Generation", 40);
    const prepared = await prepareInitialAuthorityVacuum({
      replay,
      successorGenerationId,
      assertedAt: 3,
      baselineProtectionParameters: new Uint8Array(64).fill(41),
      eventProtectionParameters: new Uint8Array(64).fill(42),
    });

    const body = exactMap(prepared.event.body, [0, 1, 2, 3, 4, 5, 6], "Vacuum body");
    expect(prepared.event).toMatchObject({
      vaultId: replay.vault.replicaState.vaultId,
      generationId: replay.vault.replicaState.generationId,
      parentRecordIds: replay.vault.replicaState.causalFrontier,
      authorityParentRecordIds: replay.vault.replicaState.authorityFrontier,
      dependencies: [
        { type: DEPENDENCY_TYPES.VaultBaseline, id: prepared.successor.baseline.recordId },
      ],
      family: 3,
      type: 1,
    });
    expect(mapValue(body, 0)).toEqual(replay.vault.replicaState.generationId);
    expect(mapValue(body, 1)).toEqual(replay.vault.replicaState.causalFrontier);
    expect(mapValue(body, 2)).toEqual(successorGenerationId);
    expect(mapValue(body, 3)).toEqual(prepared.successor.baseline.recordId);
    expect(mapValue(body, 4)).toEqual(prepared.successor.predecessorStateDigest);
    expect(mapValue(body, 5)).toEqual(prepared.successor.successorStateDigest);
    expect(mapValue(body, 6)).toEqual(prepared.successor.omissionDigest);
    expect(prepared.continuityRecordIds).toEqual(
      canonicalSet([replay.vault.genesis.recordId, prepared.event.recordId]),
    );
    expect(
      await verifyVaultEventSignature(prepared.event, replay.vault.clientSecret.signingPublicKey),
    ).toBe(true);
    await expect(
      openCompactItem({
        vaultId: replay.vault.replicaState.vaultId,
        keyEpochId: replay.vault.epochSecret.keyEpochId,
        keyEpochKey: replay.vault.epochSecret.key,
        envelopeBytes: prepared.eventEnvelope.bytes,
      }),
    ).resolves.toMatchObject({ payloadBytes: prepared.event.bytes });
  });

  it("checkpoints conflict-free Folder, Tag, assignment, and Note state with exact heads", async () => {
    const { replay, collectionId, descriptorObjectId } = await registrationReplay();
    const folderId = filled("Folder", 50);
    const tagId = filled("Tag", 51);
    const assignmentId = filled("TagAssignment", 52);
    const noteId = filled("Note", 53);
    const noteContentObjectId = filled("VaultObject", 54);
    const events = [...replay.events];
    const initialParent = events.at(-1)?.recordId;
    if (initialParent === undefined) throw new TypeError("Replay has no causal parent");
    let parent = initialParent;
    const append = async (input: {
      readonly type: number;
      readonly body: CanonicalValue;
      readonly dependencies?: readonly {
        readonly type: (typeof DEPENDENCY_TYPES)[keyof typeof DEPENDENCY_TYPES];
        readonly id: Uint8Array;
      }[];
    }) => {
      const event = await signVaultEvent(
        {
          vaultId: replay.vault.replicaState.vaultId,
          generationId: replay.vault.replicaState.generationId,
          parentRecordIds: [parent],
          authorityParentRecordIds: replay.vault.replicaState.authorityFrontier,
          dependencies: input.dependencies ?? [],
          requiredFeatureSetId: replay.vault.replicaState.requiredFeatureSetId,
          extensions: advisoryExtensions([]),
          family: 2,
          type: input.type,
          signerCredentialId: replay.vault.clientSecret.clientCredentialId,
          assertedAt: events.length + 1,
          body: input.body,
        },
        replay.vault.clientSecret.signingSecretKey,
      );
      replay.graph.add(event.recordId, event.parentRecordIds);
      events.push(event);
      parent = event.recordId;
      return event;
    };
    const folderCreated = await append({
      type: 12,
      body: canonicalMap([
        [0, folderId],
        [1, "Sources"],
        [2, null],
      ]),
    });
    const collectionPlaced = await append({
      type: 11,
      body: canonicalMap([
        [0, collectionId],
        [1, folderId],
      ]),
    });
    const tagCreated = await append({
      type: 18,
      body: canonicalMap([
        [0, tagId],
        [1, "Reviewed"],
      ]),
    });
    const tagAssigned = await append({
      type: 20,
      body: canonicalMap([
        [0, assignmentId],
        [1, tagId],
        [
          2,
          canonicalMap([
            [0, 1],
            [1, collectionId],
          ]),
        ],
      ]),
    });
    const noteCreated = await append({
      type: 27,
      body: canonicalMap([
        [0, noteId],
        [
          1,
          canonicalMap([
            [0, 1],
            [1, collectionId],
          ]),
        ],
        [2, noteContentObjectId],
      ]),
      dependencies: [{ type: DEPENDENCY_TYPES.NoteContentObject, id: noteContentObjectId }],
    });
    const advanced: ReplayedCanonicalVault = {
      ...replay,
      vault: {
        ...replay.vault,
        replicaState: { ...replay.vault.replicaState, causalFrontier: [parent] },
      },
      events,
    };

    const state = deriveInitialAuthorityVacuumContentState(advanced);
    const built = buildVacuumContentCheckpoint(state, {
      createCause: (sourceCauseId) => identifier("BaselineCause", sourceCauseId),
    });

    expect(state.folders).toEqual([
      expect.objectContaining({
        folderId,
        nameHeadCauseIds: [folderCreated.recordId],
        parentHeadCauseIds: [folderCreated.recordId],
        lifecycleHeadCauseIds: [folderCreated.recordId],
      }),
    ]);
    expect(state.collections).toEqual([
      expect.objectContaining({
        collectionId,
        folderId,
        folderHeadCauseIds: [collectionPlaced.recordId],
      }),
    ]);
    expect(state.tags).toEqual([
      expect.objectContaining({
        tagId,
        nameHeadCauseIds: [tagCreated.recordId],
        lifecycleHeadCauseIds: [tagCreated.recordId],
      }),
    ]);
    expect(state.tagAssignments).toEqual([
      expect.objectContaining({ assignmentId, assignedCauseId: tagAssigned.recordId }),
    ]);
    expect(state.notes).toEqual([
      expect.objectContaining({
        noteId,
        versions: [
          expect.objectContaining({
            headCauseId: noteCreated.recordId,
            contentObjectId: noteContentObjectId,
          }),
        ],
      }),
    ]);
    expect(built.dependencies).toEqual(
      expect.arrayContaining([
        { type: DEPENDENCY_TYPES.BundleDescriptorObject, id: descriptorObjectId },
        { type: DEPENDENCY_TYPES.NoteContentObject, id: noteContentObjectId },
      ]),
    );
  });
});
