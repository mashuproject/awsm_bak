import { describe, expect, it, vi } from "vitest";

import { openCompactItem } from "../../src/crypto/compact";
import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import {
  advisoryExtensions,
  encodeFeatureManifest,
  featureManifestId,
  requiredFeatureSetId,
} from "../../src/domain/canonical/features";
import {
  keyEpochId as deriveKeyEpochId,
  type Identifier,
  identifier,
} from "../../src/domain/canonical/identifiers";
import { signVaultEvent, verifyVaultEventSignature } from "../../src/domain/canonical/record";
import { exactMap, mapValue } from "../../src/domain/canonical/schema";
import { type CanonicalValue, canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { bytesEqual } from "../../src/domain/hash";
import type { ReplicaMutationCommit } from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import {
  CanonicalReplayService,
  type ReplayedCanonicalVault,
} from "../../src/runtime/projection/canonical-replay";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";
import { validateCurrentVaultAuthority } from "../../src/runtime/vault/canonical-open";
import {
  type PersistedOpenedCanonicalVault,
  requireCanonicalClientSecret,
} from "../../src/runtime/vault/canonical-service";
import {
  buildVacuumContentCheckpoint,
  type CanonicalVacuumContentState,
  decodeVacuumContentCheckpoint,
  deriveVacuumContentState,
  prepareVacuum,
  prepareVacuumSuccessorBaseline,
} from "../../src/runtime/vault/canonical-vacuum-content-checkpoint";
import { CanonicalVacuumService } from "../../src/runtime/vault/canonical-vacuum-service";

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
  return {
    replay: await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: registration.bytes })),
    } as never).replayOpened(vault),
    bundleId,
    descriptorObjectId,
    collectionId,
  };
}

async function activeInvitationReplay(): Promise<{
  readonly replay: ReplayedCanonicalVault;
  readonly invitationId: Identifier<"Invitation">;
  readonly invitation: Awaited<ReturnType<typeof signVaultEvent>>;
}> {
  const creation = await prepareCanonicalVaultCreation({
    label: "Authority Vacuum",
    assertedAt: 1,
  });
  const invitationId = filled("Invitation", 14);
  const invitation = await signVaultEvent(
    {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      parentRecordIds: [creation.genesis.recordId],
      authorityParentRecordIds: [creation.genesis.recordId],
      dependencies: [],
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 1,
      type: 5,
      signerCredentialId: creation.ids.clientCredentialId,
      assertedAt: 2,
      body: canonicalMap([
        [0, invitationId],
        [
          1,
          canonicalSet([
            canonicalMap([
              [0, "awsm.vault"],
              [1, creation.ids.firstMemberId],
              [2, creation.ids.vaultId],
              [3, "awsm.vault.join"],
              [4, new Uint8Array()],
            ]),
          ]),
        ],
        [2, new Uint8Array(32).fill(15)],
        [3, new Uint8Array(32).fill(16)],
        [4, new Uint8Array(32).fill(17)],
        [5, new Uint8Array(32).fill(18)],
      ]),
    },
    creation.secrets.client.signingSecretKey,
  );
  const vault: PersistedOpenedCanonicalVault = {
    directory: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      label: "Authority Vacuum",
      selectedClientCredentialId: creation.ids.clientCredentialId,
    },
    replicaState: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      causalFrontier: [invitation.recordId],
      authorityFrontier: [invitation.recordId],
      continuityRecordIds: [creation.genesis.recordId, invitation.recordId],
      baselineId: creation.baseline.recordId,
      currentKeyEpochId: creation.secrets.keyEpoch.id,
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      authoringClientCredentialId: creation.ids.clientCredentialId,
      memberId: creation.ids.firstMemberId,
      lifecycle: 1,
      preservationRoots: [],
      garbageCollectionFences: [],
      adoption: null,
    },
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
  };
  return {
    replay: await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: invitation.bytes })),
    } as never).replayOpened(vault),
    invitationId,
    invitation,
  };
}

async function keyEpochTransitionReplay(): Promise<{
  readonly replay: ReplayedCanonicalVault;
  readonly transition: Awaited<ReturnType<typeof signVaultEvent>>;
}> {
  const creation = await prepareCanonicalVaultCreation({
    label: "Epoch Vacuum",
    assertedAt: 1,
  });
  const epochKey = new Uint8Array(32).fill(93);
  const keyEpochId = deriveKeyEpochId(creation.ids.vaultId, epochKey);
  const recoveryEnvelopeId = filled("KeyEnvelope", 91);
  const clientEnvelopeId = filled("KeyEnvelope", 92);
  const transition = await signVaultEvent(
    {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      parentRecordIds: [creation.genesis.recordId],
      authorityParentRecordIds: [creation.genesis.recordId],
      dependencies: [
        { type: DEPENDENCY_TYPES.KeyEnvelope, id: recoveryEnvelopeId },
        { type: DEPENDENCY_TYPES.KeyEnvelope, id: clientEnvelopeId },
      ],
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      extensions: advisoryExtensions([]),
      family: 1,
      type: 12,
      signerCredentialId: creation.ids.clientCredentialId,
      assertedAt: 2,
      body: canonicalMap([
        [0, canonicalSet([creation.secrets.keyEpoch.id])],
        [1, keyEpochId],
        [2, 1],
        [
          3,
          canonicalSet([
            canonicalMap([
              [0, keyEpochId],
              [1, 1],
              [2, creation.ids.recoveryCredentialId],
              [3, 0],
              [4, recoveryEnvelopeId],
            ]),
            canonicalMap([
              [0, keyEpochId],
              [1, 2],
              [2, creation.ids.clientCredentialId],
              [3, null],
              [4, clientEnvelopeId],
            ]),
          ]),
        ],
      ]),
    },
    creation.secrets.client.signingSecretKey,
  );
  const vault: PersistedOpenedCanonicalVault = {
    directory: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      label: "Epoch Vacuum",
      selectedClientCredentialId: creation.ids.clientCredentialId,
    },
    replicaState: {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      causalFrontier: [transition.recordId],
      authorityFrontier: [transition.recordId],
      continuityRecordIds: [creation.genesis.recordId, transition.recordId],
      baselineId: creation.baseline.recordId,
      currentKeyEpochId: keyEpochId,
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      authoringClientCredentialId: creation.ids.clientCredentialId,
      memberId: creation.ids.firstMemberId,
      lifecycle: 1,
      preservationRoots: [],
      garbageCollectionFences: [],
      adoption: null,
    },
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
      keyEpochId,
      displayNumber: 1,
      key: epochKey,
    },
    baseline: creation.baseline,
    genesis: creation.genesis,
    installationWrappingKey: {} as CryptoKey,
    replicaStateStorageBytes: new Uint8Array(),
  };
  return {
    replay: await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: transition.bytes })),
      readResolvedOpaqueItem: vi.fn(async () => new Uint8Array()),
    } as never).replayOpened(vault),
    transition,
  };
}

describe("canonical Vacuum Content checkpoint", () => {
  it("derives the successor authority checkpoint from the current Authority State", async () => {
    const { replay, invitationId } = await activeInvitationReplay();

    const successor = await prepareVacuumSuccessorBaseline({
      replay,
      successorGenerationId: filled("Generation", 19),
    });
    const body = exactMap(successor.baseline.body, [0, 1, 2, 3, 4, 5], "Successor Baseline body");
    const authority = exactMap(
      mapValue(body, 3),
      [...Array(10).keys()],
      "Successor authority checkpoint",
    );
    const activeInvitations = mapValue(authority, 5);
    if (!Array.isArray(activeInvitations) || activeInvitations.length !== 1) {
      throw new TypeError("Successor authority checkpoint must retain the active Invitation");
    }
    const checkpointInvitation = exactMap(
      activeInvitations[0],
      [0, 1, 2, 3, 4, 5, 6],
      "Successor active Invitation",
    );
    expect(mapValue(checkpointInvitation, 0)).toEqual(invitationId);
  });

  it("depends on every current authority Envelope and Feature Manifest", async () => {
    const { replay } = await registrationReplay();
    const keyEnvelopeId = filled("KeyEnvelope", 31);
    const manifest = {
      featureKey: "awsm.test-vacuum",
      revision: 1,
      parameters: new Uint8Array(),
      requiredManifestIds: [],
      incompatibleKeys: [],
    } as const;
    const manifestBytes = encodeFeatureManifest(manifest);
    const manifestId = featureManifestId(manifestBytes);
    const featureSetId = requiredFeatureSetId([manifest]);
    const clientSecret = requireCanonicalClientSecret(replay.vault);
    const currentReplay: ReplayedCanonicalVault = {
      ...replay,
      vault: {
        ...replay.vault,
        replicaState: {
          ...replay.vault.replicaState,
          requiredFeatureSetId: featureSetId,
        },
      },
      authority: {
        ...replay.authority,
        keyEnvelopeSlots: [
          ...replay.authority.keyEnvelopeSlots,
          {
            keyEpochId: replay.vault.epochSecret.keyEpochId,
            targetKind: 2,
            targetCredentialId: clientSecret.clientCredentialId,
            targetRevision: null,
            keyEnvelopeId,
          },
        ],
        requiredFeatureSetId: featureSetId,
        featureManifests: [{ id: manifestId, bytes: manifestBytes, manifest }],
      },
    };

    const successor = await prepareVacuumSuccessorBaseline({
      replay: currentReplay,
      successorGenerationId: filled("Generation", 32),
    });

    expect(successor.baseline.dependencies).toEqual(
      expect.arrayContaining([
        { type: DEPENDENCY_TYPES.KeyEnvelope, id: keyEnvelopeId },
        { type: DEPENDENCY_TYPES.FeatureManifest, id: manifestId },
      ]),
    );
  });

  it("retains a Deleted Note restore target and its exact Object dependency", () => {
    const restoreContentObjectId = filled("VaultObject", 91);
    const deletedVersion = {
      headCauseId: filled("VaultRecord", 92),
      contentObjectId: null,
      restoreContentObjectId,
      attribution: {
        originVaultId: filled("Vault", 93),
        memberId: filled("Member", 94),
        clientCredentialId: filled("ClientCredential", 95),
        assertedAt: 96,
      },
    };
    const state: CanonicalVacuumContentState = {
      vaultLabel: { value: null, headCauseIds: [] },
      credentialLabels: [],
      captures: [],
      collections: [],
      folders: [],
      tags: [],
      tagAssignments: [],
      notes: [
        {
          noteId: filled("Note", 97),
          targetKind: 1,
          targetId: filled("Collection", 98),
          state: 2,
          versions: [deletedVersion],
        },
      ],
      activeConflicts: [],
    };

    const built = buildVacuumContentCheckpoint(state, {
      createCause: (sourceCauseId) => identifier("BaselineCause", sourceCauseId),
    });
    const decodedVersion = decodeVacuumContentCheckpoint(built.checkpoint).notes[0]?.versions[0] as
      | (CanonicalVacuumContentState["notes"][number]["versions"][number] & {
          readonly restoreContentObjectId: Identifier<"VaultObject"> | null;
        })
      | undefined;

    expect(decodedVersion?.restoreContentObjectId).toEqual(restoreContentObjectId);
    expect(built.dependencies).toEqual([
      { type: DEPENDENCY_TYPES.NoteContentObject, id: restoreContentObjectId },
    ]);
  });

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
              restoreContentObjectId: null,
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

    const state = deriveVacuumContentState(replay);

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

    const prepared = await prepareVacuumSuccessorBaseline({
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
    const prepared = await prepareVacuum({
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
    expect(prepared.adoptedReplicaState).toMatchObject({
      vaultId: replay.vault.replicaState.vaultId,
      generationId: successorGenerationId,
      causalFrontier: [prepared.successor.baseline.recordId],
      authorityFrontier: [prepared.event.recordId],
      continuityRecordIds: prepared.continuityRecordIds,
      baselineId: prepared.successor.baseline.recordId,
      adoption: { vacuumEventRecordId: prepared.event.recordId },
    });
    expect(
      await verifyVaultEventSignature(
        prepared.event,
        requireCanonicalClientSecret(replay.vault).signingPublicKey,
      ),
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
          signerCredentialId: requireCanonicalClientSecret(replay.vault).clientCredentialId,
          assertedAt: events.length + 1,
          body: input.body,
        },
        requireCanonicalClientSecret(replay.vault).signingSecretKey,
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

    const state = deriveVacuumContentState(advanced);
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

  it("replays an adopted successor Baseline as the empty Event Frontier", async () => {
    const { replay } = await registrationReplay();
    const prepared = await prepareVacuum({
      replay,
      successorGenerationId: filled("Generation", 60),
      assertedAt: 3,
    });
    const adoptedVault: PersistedOpenedCanonicalVault = {
      ...replay.vault,
      directory: {
        ...replay.vault.directory,
        generationId: prepared.successor.baseline.generationId,
      },
      replicaState: prepared.adoptedReplicaState,
      baseline: prepared.successor.baseline,
    };
    const openResolvedCompactItem = vi.fn();
    const service = new CanonicalReplayService({
      openVault: vi.fn(async () => adoptedVault),
      openResolvedCompactItem,
    } as never);

    const adopted = await service.replayOpened(adoptedVault);

    expect(adopted.events).toEqual([]);
    expect(adopted.graph.has(prepared.successor.baseline.recordId)).toBe(true);
    expect(
      prepared.successor.content.causeMapping.every(({ baselineCauseId }) =>
        adopted.graph.has(baselineCauseId),
      ),
    ).toBe(true);
    expect(openResolvedCompactItem).not.toHaveBeenCalled();
  });

  it("restores checkpointed Authority State after Vacuum adoption", async () => {
    const { replay, invitationId } = await activeInvitationReplay();
    const prepared = await prepareVacuum({
      replay,
      successorGenerationId: filled("Generation", 61),
      assertedAt: 3,
    });
    const adoptedVault: PersistedOpenedCanonicalVault = {
      ...replay.vault,
      directory: {
        ...replay.vault.directory,
        generationId: prepared.successor.baseline.generationId,
      },
      replicaState: prepared.adoptedReplicaState,
      baseline: prepared.successor.baseline,
    };

    const adopted = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(),
    } as never).replayOpened(adoptedVault);

    expect(adopted.authority.activeInvitations.map(({ invitationId: id }) => id)).toEqual([
      invitationId,
    ]);
  });

  it("advances checkpointed Authority State after Vacuum adoption", async () => {
    const { replay, invitationId } = await activeInvitationReplay();
    const prepared = await prepareVacuum({
      replay,
      successorGenerationId: filled("Generation", 62),
      assertedAt: 3,
    });
    const nextInvitationId = filled("Invitation", 63);
    const clientSecret = requireCanonicalClientSecret(replay.vault);
    const nextInvitation = await signVaultEvent(
      {
        vaultId: replay.vault.replicaState.vaultId,
        generationId: prepared.successor.baseline.generationId,
        parentRecordIds: [prepared.successor.baseline.recordId],
        authorityParentRecordIds: [prepared.event.recordId],
        dependencies: [],
        requiredFeatureSetId: replay.vault.replicaState.requiredFeatureSetId,
        extensions: advisoryExtensions([]),
        family: 1,
        type: 5,
        signerCredentialId: clientSecret.clientCredentialId,
        assertedAt: 4,
        body: canonicalMap([
          [0, nextInvitationId],
          [
            1,
            canonicalSet([
              canonicalMap([
                [0, "awsm.vault"],
                [1, clientSecret.memberId],
                [2, replay.vault.replicaState.vaultId],
                [3, "awsm.vault.join"],
                [4, new Uint8Array()],
              ]),
            ]),
          ],
          [2, new Uint8Array(32).fill(64)],
          [3, new Uint8Array(32).fill(65)],
          [4, new Uint8Array(32).fill(66)],
          [5, new Uint8Array(32).fill(67)],
        ]),
      },
      clientSecret.signingSecretKey,
    );
    const adoptedVault: PersistedOpenedCanonicalVault = {
      ...replay.vault,
      directory: {
        ...replay.vault.directory,
        generationId: prepared.successor.baseline.generationId,
      },
      replicaState: {
        ...prepared.adoptedReplicaState,
        causalFrontier: [nextInvitation.recordId],
        authorityFrontier: [nextInvitation.recordId],
        continuityRecordIds: [...prepared.continuityRecordIds, nextInvitation.recordId],
      },
      baseline: prepared.successor.baseline,
    };
    const adopted = await new CanonicalReplayService({
      openResolvedCompactItem: vi.fn(async () => ({ payloadBytes: nextInvitation.bytes })),
    } as never).replayOpened(adoptedVault);

    expect(adopted.authority.activeInvitations.map(({ invitationId: id }) => id)).toEqual([
      invitationId,
      nextInvitationId,
    ]);
  });

  it("authenticates an adopted successor through Genesis and its Vacuum Event", async () => {
    const { replay } = await registrationReplay();
    const prepared = await prepareVacuum({
      replay,
      successorGenerationId: filled("Generation", 70),
      assertedAt: 3,
    });

    await expect(
      validateCurrentVaultAuthority({
        baseline: prepared.successor.baseline,
        initialBaseline: replay.vault.baseline,
        genesis: replay.vault.genesis,
        continuityEvents: [replay.vault.genesis, prepared.event],
        replicaState: prepared.adoptedReplicaState,
        clientSecret: replay.vault.clientSecret,
        epochSecret: replay.vault.epochSecret,
      }),
    ).resolves.toBeUndefined();
  });

  it("authenticates a successor carrying post-Genesis Authority State", async () => {
    const { replay, invitation } = await activeInvitationReplay();
    const prepared = await prepareVacuum({
      replay,
      successorGenerationId: filled("Generation", 73),
      assertedAt: 3,
    });

    await expect(
      validateCurrentVaultAuthority({
        baseline: prepared.successor.baseline,
        initialBaseline: replay.vault.baseline,
        genesis: replay.vault.genesis,
        continuityEvents: [replay.vault.genesis, invitation, prepared.event],
        replicaState: prepared.adoptedReplicaState,
        clientSecret: replay.vault.clientSecret,
        epochSecret: replay.vault.epochSecret,
      }),
    ).resolves.toBeUndefined();
  });

  it("authenticates a successor after a Key Epoch Transition", async () => {
    const { replay, transition } = await keyEpochTransitionReplay();
    const prepared = await prepareVacuum({
      replay,
      successorGenerationId: filled("Generation", 94),
      assertedAt: 3,
    });

    await expect(
      validateCurrentVaultAuthority({
        baseline: prepared.successor.baseline,
        initialBaseline: replay.vault.baseline,
        genesis: replay.vault.genesis,
        continuityEvents: [replay.vault.genesis, transition, prepared.event],
        replicaState: prepared.adoptedReplicaState,
        clientSecret: replay.vault.clientSecret,
        epochSecret: replay.vault.epochSecret,
      }),
    ).resolves.toBeUndefined();
  });

  it("authenticates readable imported authority without a local Client Credential", async () => {
    const { replay } = await registrationReplay();
    const readOnlyReplay: ReplayedCanonicalVault = {
      ...replay,
      vault: {
        ...replay.vault,
        directory: { ...replay.vault.directory, selectedClientCredentialId: null },
        replicaState: {
          ...replay.vault.replicaState,
          authoringClientCredentialId: null,
          memberId: null,
        },
        clientSecret: null,
      },
    };

    await expect(
      validateCurrentVaultAuthority({
        baseline: readOnlyReplay.vault.baseline,
        initialBaseline: readOnlyReplay.vault.baseline,
        genesis: readOnlyReplay.vault.genesis,
        continuityEvents: [readOnlyReplay.vault.genesis],
        replicaState: readOnlyReplay.vault.replicaState,
        clientSecret: null,
        epochSecret: readOnlyReplay.vault.epochSecret,
      }),
    ).resolves.toBeUndefined();
    expect(deriveVacuumContentState(readOnlyReplay).captures[0]?.attribution.memberId).toEqual(
      requireCanonicalClientSecret(replay.vault).memberId,
    );
  });

  it("rejects an invalid post-Genesis Continuity Event before the first Vacuum", async () => {
    const { replay, invitation } = await activeInvitationReplay();

    await expect(
      validateCurrentVaultAuthority({
        baseline: replay.vault.baseline,
        initialBaseline: replay.vault.baseline,
        genesis: replay.vault.genesis,
        continuityEvents: [replay.vault.genesis, { ...invitation, signature: new Uint8Array(64) }],
        replicaState: replay.vault.replicaState,
        clientSecret: replay.vault.clientSecret,
        epochSecret: replay.vault.epochSecret,
      }),
    ).rejects.toThrow("Vault Event signature is invalid");
  });

  it("authenticates repeated Vacuum boundaries as one Generation chain", async () => {
    const { replay } = await registrationReplay();
    const first = await prepareVacuum({
      replay,
      successorGenerationId: filled("Generation", 70),
      assertedAt: 3,
    });
    const firstVault: PersistedOpenedCanonicalVault = {
      ...replay.vault,
      directory: {
        ...replay.vault.directory,
        generationId: first.successor.baseline.generationId,
      },
      replicaState: first.adoptedReplicaState,
      baseline: first.successor.baseline,
    };
    const firstReplay = await new CanonicalReplayService({
      openVault: vi.fn(async () => firstVault),
      openResolvedCompactItem: vi.fn(),
    } as never).replayOpened(firstVault);
    const second = await prepareVacuum({
      replay: firstReplay,
      successorGenerationId: filled("Generation", 71),
      assertedAt: 4,
    });

    await expect(
      validateCurrentVaultAuthority({
        baseline: second.successor.baseline,
        initialBaseline: replay.vault.baseline,
        genesis: replay.vault.genesis,
        continuityEvents: [replay.vault.genesis, second.event, first.event],
        replicaState: second.adoptedReplicaState,
        clientSecret: replay.vault.clientSecret,
        epochSecret: replay.vault.epochSecret,
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateCurrentVaultAuthority({
        baseline: second.successor.baseline,
        initialBaseline: replay.vault.baseline,
        genesis: replay.vault.genesis,
        continuityEvents: [replay.vault.genesis, second.event],
        replicaState: second.adoptedReplicaState,
        clientSecret: replay.vault.clientSecret,
        epochSecret: replay.vault.epochSecret,
      }),
    ).rejects.toThrow("Continuity Proof has a missing or cyclic Authority Parent");
    await expect(
      validateCurrentVaultAuthority({
        baseline: second.successor.baseline,
        initialBaseline: replay.vault.baseline,
        genesis: replay.vault.genesis,
        continuityEvents: [replay.vault.genesis, first.event, second.event],
        replicaState: {
          ...second.adoptedReplicaState,
          continuityRecordIds: [
            ...second.adoptedReplicaState.continuityRecordIds,
            filled("VaultRecord", 72),
          ],
        },
        clientSecret: replay.vault.clientSecret,
        epochSecret: replay.vault.epochSecret,
      }),
    ).rejects.toThrow("Continuity Proof Record set does not match");
    expect(second.continuityRecordIds).toEqual(
      expect.arrayContaining([
        replay.vault.genesis.recordId,
        first.event.recordId,
        second.event.recordId,
      ]),
    );
  });

  it("adopts Vacuum atomically without deleting predecessor authoritative data", async () => {
    const { replay: sourceReplay } = await registrationReplay();
    const installationWrappingKey = await crypto.subtle.generateKey(
      { name: "AES-KW", length: 256 },
      false,
      ["wrapKey", "unwrapKey"],
    );
    const replay = {
      ...sourceReplay,
      vault: {
        ...sourceReplay.vault,
        installationWrappingKey,
        replicaStateStorageBytes: new Uint8Array([1, 2, 3]),
      },
    } satisfies ReplayedCanonicalVault;
    const commitReplicaMutation = vi.fn(async (_commit: ReplicaMutationCommit) => undefined);
    const storage = {
      getBytes: vi.fn(async () => undefined),
      commitReplicaMutation,
    };
    const vaults = {
      storage,
      realm: NORMAL_STORAGE_REALM,
      openVault: vi.fn(async () => replay.vault),
    };
    const service = new CanonicalVacuumService(vaults as never);
    vi.spyOn(service.replay, "replay").mockResolvedValue(replay);

    const outcome = await service.vacuum({
      commandId: "vacuum-atomic-1",
      vaultId: replay.vault.replicaState.vaultId,
      assertedAt: 3,
    });

    expect(outcome.predecessorGenerationId).toEqual(replay.vault.replicaState.generationId);
    expect(commitReplicaMutation).toHaveBeenCalledOnce();
    const commit = commitReplicaMutation.mock.calls[0]?.[0];
    expect(commit?.expectedReplicaState).toEqual(replay.vault.replicaStateStorageBytes);
    expect(commit?.immutableItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ namespace: NAMESPACES.vaultRecord.key }),
        expect.objectContaining({ namespace: NAMESPACES.commandOutcome.key }),
      ]),
    );
    expect(commit?.immutableItems).toHaveLength(3);
    expect(commit?.mutableItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ namespace: NAMESPACES.logicalResolution.key }),
        expect.objectContaining({ namespace: NAMESPACES.vaultDirectory.key }),
      ]),
    );
    expect(commit?.mutableItems).toHaveLength(3);
    expect(commit?.deletedItems).toEqual([
      {
        namespace: NAMESPACES.libraryProjection.key,
        scopeKey: expect.any(String),
        itemKey: "current",
      },
      {
        namespace: NAMESPACES.searchMaterialization.key,
        scopeKey: expect.any(String),
        itemKey: "current",
      },
    ]);
    expect(
      (commit?.deletedItems ?? []).some((item: { readonly namespace: string }) =>
        [NAMESPACES.vaultRecord.key, NAMESPACES.vaultObject.key].includes(item.namespace as never),
      ),
    ).toBe(false);
  });
});
