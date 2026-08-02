import { describe, expect, it } from "vitest";

import { sealCompactItem } from "../../src/crypto/compact";
import {
  EMPTY_REQUIRED_FEATURE_SET_ID,
  encodeFeatureManifest,
  featureManifestId,
} from "../../src/domain/canonical/features";
import { keyEpochId } from "../../src/domain/canonical/identifiers";
import { encodeVaultObject, NOTE_CONTENT_OBJECT } from "../../src/domain/canonical/object";
import { canonicalMap } from "../../src/domain/canonical/value";
import {
  deriveHostedReplicaOpaqueLocator,
  HOSTED_REPLICA_LOGICAL_NAMESPACE,
} from "../../src/runtime/synchronization/canonical-hosted-replica-locator";
import { classifyPulledCompactCandidate } from "../../src/runtime/synchronization/canonical-pull-candidate";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";

const LOCATOR_SALT = new Uint8Array(32).fill(91);

describe("canonical pulled Compact candidate", () => {
  it("rejects an opened logical item whose Host-provided opaque locator is not derived for this Remote", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Sync", assertedAt: 1 });
    const envelope = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      payloadType: 1,
      payloadBytes: creation.genesis.bytes,
      protectionParameters: new Uint8Array(64).fill(72),
    });

    await expect(
      classifyPulledCompactCandidate({
        vaultId: creation.ids.vaultId,
        epochSecrets: [
          {
            vaultId: creation.ids.vaultId,
            keyEpochId: creation.secrets.keyEpoch.id,
            displayNumber: 1,
            key: creation.secrets.keyEpoch.key,
          },
        ],
        envelopeBytes: envelope.bytes,
        locatorSalt: LOCATOR_SALT,
        locator: new Uint8Array(32).fill(74),
      }),
    ).rejects.toThrow(/Host locator/u);
  });

  it("opens an authenticated Record through a retained Epoch and derives its protected logical identity", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Sync", assertedAt: 1 });
    const historicalKey = new Uint8Array(32).fill(71);
    const historicalEpochId = keyEpochId(creation.ids.vaultId, historicalKey);
    const envelope = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: historicalEpochId,
      keyEpochKey: historicalKey,
      payloadType: 1,
      payloadBytes: creation.genesis.bytes,
      protectionParameters: new Uint8Array(64).fill(72),
    });

    await expect(
      classifyPulledCompactCandidate({
        vaultId: creation.ids.vaultId,
        epochSecrets: [
          {
            vaultId: creation.ids.vaultId,
            keyEpochId: creation.secrets.keyEpoch.id,
            displayNumber: 1,
            key: creation.secrets.keyEpoch.key,
          },
          {
            vaultId: creation.ids.vaultId,
            keyEpochId: historicalEpochId,
            displayNumber: 0,
            key: historicalKey,
          },
        ],
        envelopeBytes: envelope.bytes,
        locatorSalt: LOCATOR_SALT,
        locator: await deriveHostedReplicaOpaqueLocator({
          locatorSalt: LOCATOR_SALT,
          logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.VaultRecord,
          logicalId: creation.genesis.recordId,
        }),
      }),
    ).resolves.toMatchObject({
      kind: "VaultRecord",
      logicalId: creation.genesis.recordId,
      keyEpochId: historicalEpochId,
      storageItemId: envelope.storageItemId,
    });
  });

  it("classifies canonical Vault Objects and Feature Manifests by their authenticated IDs", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Sync", assertedAt: 1 });
    const object = encodeVaultObject({
      vaultId: creation.ids.vaultId,
      objectType: NOTE_CONTENT_OBJECT,
      requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
      body: canonicalMap([
        [0, 1],
        [1, "A note"],
        [2, "A body"],
        [3, "awsm.note.commonmark"],
      ]),
      extensions: new Map(),
    });
    const manifestBytes = encodeFeatureManifest({
      featureKey: "org.example.sync",
      revision: 1,
      parameters: new Uint8Array([1, 2]),
      requiredManifestIds: [],
      incompatibleKeys: [],
    });
    const objectEnvelope = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      payloadType: 2,
      payloadBytes: object.bytes,
      protectionParameters: new Uint8Array(64).fill(73),
    });
    const manifestEnvelope = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      payloadType: 3,
      payloadBytes: manifestBytes,
      protectionParameters: new Uint8Array(64).fill(74),
    });
    const epochSecrets = [
      {
        vaultId: creation.ids.vaultId,
        keyEpochId: creation.secrets.keyEpoch.id,
        displayNumber: 1,
        key: creation.secrets.keyEpoch.key,
      },
    ];

    await expect(
      classifyPulledCompactCandidate({
        vaultId: creation.ids.vaultId,
        epochSecrets,
        envelopeBytes: objectEnvelope.bytes,
        locatorSalt: LOCATOR_SALT,
        locator: await deriveHostedReplicaOpaqueLocator({
          locatorSalt: LOCATOR_SALT,
          logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.VaultObject,
          logicalId: object.objectId,
        }),
      }),
    ).resolves.toMatchObject({
      kind: "VaultObject",
      logicalId: object.objectId,
      storageItemId: objectEnvelope.storageItemId,
    });
    await expect(
      classifyPulledCompactCandidate({
        vaultId: creation.ids.vaultId,
        epochSecrets,
        envelopeBytes: manifestEnvelope.bytes,
        locatorSalt: LOCATOR_SALT,
        locator: await deriveHostedReplicaOpaqueLocator({
          locatorSalt: LOCATOR_SALT,
          logicalNamespace: HOSTED_REPLICA_LOGICAL_NAMESPACE.FeatureManifest,
          logicalId: featureManifestId(manifestBytes),
        }),
      }),
    ).resolves.toMatchObject({
      kind: "FeatureManifest",
      logicalId: featureManifestId(manifestBytes),
      storageItemId: manifestEnvelope.storageItemId,
    });
  });

  it("retains unactionable ciphertext as an unclassified candidate and rejects a decrypted foreign Vault Object", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Sync", assertedAt: 1 });
    const unknownEpochKey = new Uint8Array(32).fill(81);
    const unknownEnvelope = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: keyEpochId(creation.ids.vaultId, unknownEpochKey),
      keyEpochKey: unknownEpochKey,
      payloadType: 1,
      payloadBytes: creation.genesis.bytes,
      protectionParameters: new Uint8Array(64).fill(82),
    });
    const foreignVaultId = new Uint8Array(32).fill(83) as typeof creation.ids.vaultId;
    const foreignObject = encodeVaultObject({
      vaultId: foreignVaultId,
      objectType: NOTE_CONTENT_OBJECT,
      requiredFeatureSetId: EMPTY_REQUIRED_FEATURE_SET_ID,
      body: canonicalMap([
        [0, 1],
        [1, null],
        [2, "Foreign"],
        [3, "awsm.note.commonmark"],
      ]),
      extensions: new Map(),
    });
    const foreignEnvelope = await sealCompactItem({
      vaultId: creation.ids.vaultId,
      keyEpochId: creation.secrets.keyEpoch.id,
      keyEpochKey: creation.secrets.keyEpoch.key,
      payloadType: 2,
      payloadBytes: foreignObject.bytes,
      protectionParameters: new Uint8Array(64).fill(84),
    });
    const input = {
      vaultId: creation.ids.vaultId,
      epochSecrets: [
        {
          vaultId: creation.ids.vaultId,
          keyEpochId: creation.secrets.keyEpoch.id,
          displayNumber: 1,
          key: creation.secrets.keyEpoch.key,
        },
      ],
    };

    await expect(
      classifyPulledCompactCandidate({
        ...input,
        envelopeBytes: unknownEnvelope.bytes,
        locatorSalt: LOCATOR_SALT,
        locator: new Uint8Array(32).fill(92),
      }),
    ).resolves.toBeNull();
    await expect(
      classifyPulledCompactCandidate({
        ...input,
        envelopeBytes: foreignEnvelope.bytes,
        locatorSalt: LOCATOR_SALT,
        locator: new Uint8Array(32).fill(93),
      }),
    ).rejects.toThrow(/Vault Object Vault ID/u);
  });
});
