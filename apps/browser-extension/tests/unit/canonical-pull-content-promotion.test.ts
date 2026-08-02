import { describe, expect, it } from "vitest";

import { sealCompactItem } from "../../src/crypto/compact";
import { unwrapInstallationBytes } from "../../src/crypto/installation-wrap";
import { encodeVaultObject, NOTE_CONTENT_OBJECT } from "../../src/domain/canonical/object";
import { canonicalMap } from "../../src/domain/canonical/value";
import { identifierStorageKey } from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import { CanonicalPullContentPromotionService } from "../../src/runtime/synchronization/canonical-pull-content-promotion";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import {
  type CanonicalReplicaState,
  canonicalLocalStorageContext,
  decodeCanonicalReplicaState,
  decodeLogicalResolution,
} from "../../src/runtime/vault/canonical-local-state";

const REMOTE_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";

describe("canonical pull Content promotion", () => {
  it("atomically consumes one validated Content Record Quarantine item with its Replica state", async () => {
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
      replicaState,
      replicaStateStorageBytes: new Uint8Array([1]),
      installationWrappingKey: await crypto.subtle.generateKey(
        { name: "AES-KW", length: 256 },
        false,
        ["wrapKey", "unwrapKey"],
      ),
    };
    const candidate = {
      kind: "VaultRecord" as const,
      logicalId: creation.genesis.recordId,
      record: creation.genesis,
      keyEpochId: creation.secrets.keyEpoch.id,
      storageItemId: creation.genesisEnvelope.storageItemId,
    };
    const object = encodeVaultObject({
      vaultId: creation.ids.vaultId,
      objectType: NOTE_CONTENT_OBJECT,
      requiredFeatureSetId: creation.genesis.requiredFeatureSetId,
      body: canonicalMap([
        [0, 1],
        [1, "Pulled note"],
        [2, "Body"],
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
      protectionParameters: new Uint8Array(64).fill(4),
    });
    const objectCandidate = {
      kind: "VaultObject" as const,
      logicalId: object.objectId,
      object,
      keyEpochId: creation.secrets.keyEpoch.id,
      storageItemId: objectEnvelope.storageItemId,
    };
    const previous = {
      jobId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
      vaultId: creation.ids.vaultId,
      remoteId: REMOTE_ID,
      realm: NORMAL_STORAGE_REALM,
      stage: 2 as const,
      state: 1 as const,
      snapshotCursor: 1,
      nextPosition: null,
      attempt: 0,
      retryAfterMs: null,
      quarantineReferences: [
        {
          storageItemId: creation.genesisEnvelope.storageItemId,
          locator: new Uint8Array(32).fill(7),
        },
        {
          storageItemId: objectEnvelope.storageItemId,
          locator: new Uint8Array(32).fill(8),
        },
      ],
      progress: {
        discoveredItemCount: 1,
        downloadedItemCount: 1,
        promotedItemCount: 0,
        rejectedItemCount: 0,
      },
    };
    const calls: unknown[] = [];
    const service = new CanonicalPullContentPromotionService({
      promoteValidated: async (input) => {
        calls.push(input);
      },
    });

    await expect(
      service.promote({
        vault,
        previous,
        validation: {
          nextReplicaState: replicaState,
          acceptedCandidates: [candidate, objectCandidate],
        },
        readQuarantine: async ({ storageItemId }) =>
          storageItemId.toString() === creation.genesisEnvelope.storageItemId.toString()
            ? creation.genesisEnvelope.bytes
            : objectEnvelope.bytes,
      }),
    ).resolves.toMatchObject({ stage: 3, state: 3, quarantineReferences: [] });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        expectedReplicaState: vault.replicaStateStorageBytes,
        promotedReferences: previous.quarantineReferences,
        immutableItems: [
          {
            namespace: NAMESPACES.vaultRecord.key,
            scopeKey: identifierStorageKey(creation.ids.vaultId),
            itemKey: identifierStorageKey(creation.genesis.recordId),
            bytes: creation.genesisEnvelope.bytes,
          },
          {
            namespace: NAMESPACES.vaultObject.key,
            scopeKey: identifierStorageKey(creation.ids.vaultId),
            itemKey: identifierStorageKey(object.objectId),
            bytes: objectEnvelope.bytes,
          },
        ],
      }),
    );
    const commit = calls[0] as {
      readonly nextReplicaState: { readonly bytes: Uint8Array };
      readonly resolutionItems: readonly { readonly bytes: Uint8Array }[];
    };
    expect(
      decodeCanonicalReplicaState(
        await unwrapInstallationBytes({
          wrappingKey: vault.installationWrappingKey,
          domain: "awsm.local.replica-state",
          context: canonicalLocalStorageContext(creation.ids.vaultId, creation.ids.generationId),
          wrappedBytes: commit.nextReplicaState.bytes,
        }),
      ),
    ).toEqual(replicaState);
    const resolutionItem = commit.resolutionItems[0];
    if (resolutionItem === undefined)
      throw new TypeError("expected one promoted logical resolution");
    expect(
      decodeLogicalResolution(
        await unwrapInstallationBytes({
          wrappingKey: vault.installationWrappingKey,
          domain: "awsm.local.logical-resolution",
          context: canonicalLocalStorageContext(creation.ids.vaultId, creation.genesis.recordId),
          wrappedBytes: resolutionItem.bytes,
        }),
      ),
    ).toMatchObject({
      vaultId: creation.ids.vaultId,
      kind: 1,
      logicalId: creation.genesis.recordId,
      storageItemId: creation.genesisEnvelope.storageItemId,
      keyEpochId: creation.secrets.keyEpoch.id,
      availability: 1,
    });
    const objectResolutionItem = commit.resolutionItems[1];
    if (objectResolutionItem === undefined)
      throw new TypeError("expected one promoted Object logical resolution");
    expect(
      decodeLogicalResolution(
        await unwrapInstallationBytes({
          wrappingKey: vault.installationWrappingKey,
          domain: "awsm.local.logical-resolution",
          context: canonicalLocalStorageContext(creation.ids.vaultId, object.objectId),
          wrappedBytes: objectResolutionItem.bytes,
        }),
      ),
    ).toMatchObject({
      vaultId: creation.ids.vaultId,
      kind: 3,
      logicalId: object.objectId,
      storageItemId: objectEnvelope.storageItemId,
      keyEpochId: creation.secrets.keyEpoch.id,
      availability: 1,
    });
  });
});
