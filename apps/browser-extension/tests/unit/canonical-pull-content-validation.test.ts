import { describe, expect, it } from "vitest";
import { sealCompactItem } from "../../src/crypto/compact";
import { DEPENDENCY_TYPES } from "../../src/domain/canonical/dependencies";
import { identifier } from "../../src/domain/canonical/identifiers";
import { encodeVaultObject, NOTE_CONTENT_OBJECT } from "../../src/domain/canonical/object";
import { canonicalMap, canonicalSet } from "../../src/domain/canonical/value";
import { prepareCanonicalContentEvent } from "../../src/runtime/content/canonical-prepare";
import { CanonicalReplayService } from "../../src/runtime/projection/canonical-replay";
import type { CanonicalPulledCompactCandidate } from "../../src/runtime/synchronization/canonical-pull-candidate";
import { CanonicalPullContentValidationService } from "../../src/runtime/synchronization/canonical-pull-content-validation";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import type { CanonicalReplicaState } from "../../src/runtime/vault/canonical-local-state";
import type { PersistedOpenedCanonicalVault } from "../../src/runtime/vault/canonical-service";

const REMOTE_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";

async function openedInitialVault() {
  const creation = await prepareCanonicalVaultCreation({ label: "Sync", assertedAt: 1 });
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
      label: "Sync",
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
    installationWrappingKey: await crypto.subtle.generateKey(
      { name: "AES-KW", length: 256 },
      false,
      ["wrapKey", "unwrapKey"],
    ),
    replicaStateStorageBytes: new Uint8Array([1]),
  } satisfies PersistedOpenedCanonicalVault;
  const local = {
    openResolvedCompactItem: async ({ logicalId }: { readonly logicalId: Uint8Array }) => {
      if (logicalId.toString() === creation.baseline.recordId.toString()) {
        return {
          keyEpochId: creation.secrets.keyEpoch.id,
          payloadType: 1 as const,
          payloadBytes: creation.baseline.bytes,
          envelope: creation.baselineEnvelope,
        };
      }
      if (logicalId.toString() === creation.genesis.recordId.toString()) {
        return {
          keyEpochId: creation.secrets.keyEpoch.id,
          payloadType: 1 as const,
          payloadBytes: creation.genesis.bytes,
          envelope: creation.genesisEnvelope,
        };
      }
      throw new TypeError("unexpected local Compact item");
    },
    readResolvedOpaqueItem: async () => {
      throw new TypeError("unexpected local opaque dependency");
    },
  };
  return { creation, vault, local };
}

describe("canonical pull Content validation", () => {
  it("accepts one complete signed Content branch without changing accepted Authority state", async () => {
    const { creation, vault, local } = await openedInitialVault();
    const prepared = await prepareCanonicalContentEvent({
      vault,
      type: 4,
      assertedAt: 2,
      body: canonicalMap([[0, canonicalSet([new Uint8Array(32).fill(8)])]]),
      protectionParameters: new Uint8Array(64).fill(9),
    });
    const candidate: CanonicalPulledCompactCandidate = {
      kind: "VaultRecord",
      logicalId: prepared.event.recordId,
      record: prepared.event,
      keyEpochId: creation.secrets.keyEpoch.id,
      storageItemId: prepared.eventEnvelope.storageItemId,
    };
    const service = new CanonicalPullContentValidationService(
      new CanonicalReplayService(local as never),
      {
        readQuarantine: async ({ storageItemId }) =>
          storageItemId.toString() === prepared.eventEnvelope.storageItemId.toString()
            ? prepared.eventEnvelope.bytes
            : undefined,
      },
    );

    await expect(
      service.validate({
        remoteId: REMOTE_ID,
        vault,
        candidates: [candidate],
        rootRecordIds: [prepared.event.recordId],
      }),
    ).resolves.toEqual({
      nextReplicaState: expect.objectContaining({
        causalFrontier: [prepared.event.recordId],
        authorityFrontier: [creation.genesis.recordId],
        continuityRecordIds: [creation.genesis.recordId],
      }),
      acceptedCandidates: [candidate],
    });
  });

  it("does not classify an already accepted Record representation as a new promotion", async () => {
    const { creation, vault, local } = await openedInitialVault();
    const candidate: CanonicalPulledCompactCandidate = {
      kind: "VaultRecord",
      logicalId: creation.genesis.recordId,
      record: creation.genesis,
      keyEpochId: creation.secrets.keyEpoch.id,
      storageItemId: creation.genesisEnvelope.storageItemId,
    };
    const service = new CanonicalPullContentValidationService(
      new CanonicalReplayService(local as never),
      { readQuarantine: async () => creation.genesisEnvelope.bytes },
    );

    await expect(
      service.validate({
        remoteId: REMOTE_ID,
        vault,
        candidates: [candidate],
        rootRecordIds: [creation.genesis.recordId],
      }),
    ).resolves.toMatchObject({ acceptedCandidates: [] });
  });

  it("accepts and selects a newly required Note Content Object with its Content Record", async () => {
    const { creation, vault, local } = await openedInitialVault();
    const object = encodeVaultObject({
      vaultId: creation.ids.vaultId,
      objectType: NOTE_CONTENT_OBJECT,
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      body: canonicalMap([
        [0, 1],
        [1, "Pulled note"],
        [2, "The Note Content Object arrives with its Event."],
        [3, "awsm.note.commonmark"],
      ]),
      extensions: new Map(),
    });
    const objectEnvelope = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      payloadType: 2,
      payloadBytes: object.bytes,
      protectionParameters: new Uint8Array(64).fill(10),
    });
    const prepared = await prepareCanonicalContentEvent({
      vault,
      type: 27,
      assertedAt: 2,
      body: canonicalMap([
        [0, identifier("Note", new Uint8Array(32).fill(3))],
        [
          1,
          canonicalMap([
            [0, 1],
            [1, identifier("Collection", new Uint8Array(32).fill(4))],
          ]),
        ],
        [2, object.objectId],
      ]),
      dependencies: [{ type: DEPENDENCY_TYPES.NoteContentObject, id: object.objectId }],
      protectionParameters: new Uint8Array(64).fill(9),
    });
    const recordCandidate: CanonicalPulledCompactCandidate = {
      kind: "VaultRecord",
      logicalId: prepared.event.recordId,
      record: prepared.event,
      keyEpochId: creation.secrets.keyEpoch.id,
      storageItemId: prepared.eventEnvelope.storageItemId,
    };
    const objectCandidate: CanonicalPulledCompactCandidate = {
      kind: "VaultObject",
      logicalId: object.objectId,
      object,
      keyEpochId: creation.secrets.keyEpoch.id,
      storageItemId: objectEnvelope.storageItemId,
    };
    const service = new CanonicalPullContentValidationService(
      new CanonicalReplayService({
        ...local,
        hasVerifiedCompactLogicalItem: async () => false,
      } as never),
      {
        readQuarantine: async ({ storageItemId }) => {
          if (storageItemId.toString() === prepared.eventEnvelope.storageItemId.toString()) {
            return prepared.eventEnvelope.bytes;
          }
          if (storageItemId.toString() === objectEnvelope.storageItemId.toString()) {
            return objectEnvelope.bytes;
          }
          return undefined;
        },
      },
    );

    await expect(
      service.validate({
        remoteId: REMOTE_ID,
        vault,
        candidates: [recordCandidate, objectCandidate],
        rootRecordIds: [prepared.event.recordId],
      }),
    ).resolves.toMatchObject({ acceptedCandidates: [recordCandidate, objectCandidate] });
  });
});
