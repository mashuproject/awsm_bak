import { describe, expect, it } from "vitest";

import { unwrapInstallationBytes } from "../../src/crypto/installation-wrap";
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
        validation: { nextReplicaState: replicaState, acceptedCandidates: [candidate] },
        readQuarantine: async () => creation.genesisEnvelope.bytes,
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
  });
});
