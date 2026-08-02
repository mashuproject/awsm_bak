import { describe, expect, it } from "vitest";

import { sealCompactItem } from "../../src/crypto/compact";
import { keyEpochId } from "../../src/domain/canonical/identifiers";
import {
  deriveHostedReplicaOpaqueLocator,
  HOSTED_REPLICA_LOGICAL_NAMESPACE,
} from "../../src/runtime/synchronization/canonical-hosted-replica-locator";
import { CanonicalPullValidationRunner } from "../../src/runtime/synchronization/canonical-pull-validation-runner";
import type { CanonicalPullSynchronizationJob } from "../../src/runtime/synchronization/canonical-state";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";

const REMOTE_ID = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";
const LOCATOR_SALT = new Uint8Array(32).fill(91);

function job(input: {
  readonly vaultId: CanonicalPullSynchronizationJob["vaultId"];
  readonly references: CanonicalPullSynchronizationJob["quarantineReferences"];
}): CanonicalPullSynchronizationJob {
  return {
    jobId: "019fa62e-a653-7f63-b2bf-94e7ed5e46cb",
    vaultId: input.vaultId,
    remoteId: REMOTE_ID,
    realm: { kind: "Normal", id: "default" },
    stage: 2,
    state: 1,
    snapshotCursor: 1,
    nextPosition: null,
    attempt: 0,
    retryAfterMs: null,
    quarantineReferences: input.references,
    progress: {
      discoveredItemCount: input.references.length,
      downloadedItemCount: input.references.length,
      promotedItemCount: 0,
      rejectedItemCount: 0,
    },
  };
}

describe("canonical pull validation runner", () => {
  it("opens only retained Quarantine bytes and keeps ciphertext without a local Epoch unclassified", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Sync", assertedAt: 1 });
    const opened = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      payloadType: 1,
      payloadBytes: creation.genesis.bytes,
      protectionParameters: new Uint8Array(64).fill(71),
    });
    const unopenedKey = new Uint8Array(32).fill(74);
    const unopened = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: keyEpochId(creation.ids.vaultId, unopenedKey),
      keyEpochKey: unopenedKey,
      payloadType: 1,
      payloadBytes: creation.genesis.bytes,
      protectionParameters: new Uint8Array(64).fill(75),
    });
    const openedReference = {
      storageItemId: opened.storageItemId,
      locator: await deriveHostedReplicaOpaqueLocator({
        locatorSalt: LOCATOR_SALT,
        logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.VaultRecord,
        logicalId: creation.genesis.recordId,
      }),
    };
    const unopenedReference = {
      storageItemId: unopened.storageItemId,
      locator: new Uint8Array(32).fill(76),
    };
    const stored = new Map([
      [opened.storageItemId.toString(), opened.bytes],
      [unopened.storageItemId.toString(), unopened.bytes],
    ]);
    const runner = new CanonicalPullValidationRunner({
      readQuarantine: async ({ storageItemId }) => stored.get(storageItemId.toString()),
    });

    await expect(
      runner.run({
        remote: { remoteId: REMOTE_ID, locatorSalt: LOCATOR_SALT },
        job: job({
          vaultId: creation.ids.vaultId,
          references: [openedReference, unopenedReference],
        }),
        epochSecrets: [
          {
            vaultId: creation.ids.vaultId,
            keyEpochId: creation.secrets.keyEpoch.id,
            displayNumber: 0,
            key: creation.secrets.keyEpoch.key,
          },
        ],
      }),
    ).resolves.toEqual({
      candidates: [
        expect.objectContaining({
          kind: "VaultRecord",
          logicalId: creation.genesis.recordId,
          storageItemId: opened.storageItemId,
        }),
      ],
      unclassifiedStorageItemIds: [unopened.storageItemId],
    });
  });
});
