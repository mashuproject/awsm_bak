import { describe, expect, it } from "vitest";
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
});
