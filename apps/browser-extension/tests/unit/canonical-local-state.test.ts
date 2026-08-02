import { describe, expect, it } from "vitest";
import { encodeFeatureManifest, featureManifestId } from "../../src/domain/canonical/features";
import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { canonicalSet } from "../../src/domain/canonical/value";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import {
  decodeCanonicalReplicaState,
  decodeClientSecretState,
  decodeEpochSecretState,
  decodeLogicalResolution,
  decodeVaultDirectoryEntry,
  encodeCanonicalReplicaState,
  encodeVaultDirectoryEntry,
  openWrappedLocalState,
  prepareCanonicalVaultStorage,
} from "../../src/runtime/vault/canonical-local-state";

async function wrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
}

describe("canonical local Vault state", () => {
  it("prepares the complete encrypted initialization transaction without storing Recovery", async () => {
    const key = await wrappingKey();
    const creation = await prepareCanonicalVaultCreation({
      label: "Private research",
      assertedAt: 123,
    });
    const prepared = await prepareCanonicalVaultStorage({
      creation,
      label: "Private research",
      realm: NORMAL_STORAGE_REALM,
      wrappingKey: key,
    });

    expect(prepared.commit.immutableItems).toHaveLength(4);
    expect(prepared.commit.replicaSafetyItems).toHaveLength(4);
    expect(prepared.commit.trustedSecrets.map(({ namespace }) => namespace).toSorted()).toEqual(
      [NAMESPACES.clientSecret.key, NAMESPACES.epochSecret.key].toSorted(),
    );
    expect(prepared.commit.vaultDirectoryEntry.scopeKey).toBe("installation");
    expect(prepared.commit.vaultDirectoryEntry.itemKey).toBe(prepared.commit.vaultKey);
    expect(
      [
        ...prepared.commit.immutableItems,
        ...(prepared.commit.replicaSafetyItems ?? []),
        prepared.commit.replicaState,
        prepared.commit.vaultDirectoryEntry,
        ...prepared.commit.trustedSecrets,
      ].some(({ bytes }) => new TextDecoder().decode(bytes).includes(creation.recoveryPhrase)),
    ).toBe(false);
  });

  it("opens and validates every protected initial local namespace", async () => {
    const key = await wrappingKey();
    const creation = await prepareCanonicalVaultCreation({ label: "Vault A", assertedAt: 1 });
    const prepared = await prepareCanonicalVaultStorage({
      creation,
      label: "Vault A",
      realm: NORMAL_STORAGE_REALM,
      wrappingKey: key,
    });
    const replicaBytes = await openWrappedLocalState({
      wrappingKey: key,
      domain: "awsm.local.replica-state",
      vaultId: creation.ids.vaultId,
      identity: creation.ids.generationId,
      wrappedBytes: prepared.commit.replicaState.bytes,
    });
    const replica = decodeCanonicalReplicaState(replicaBytes);
    expect(replica).toMatchObject({
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      causalFrontier: [creation.genesis.recordId],
      authorityFrontier: [creation.genesis.recordId],
      continuityRecordIds: [creation.genesis.recordId],
      currentKeyEpochId: creation.secrets.keyEpoch.id,
      lifecycle: 1,
    });

    const clientItem = prepared.commit.trustedSecrets.find(
      ({ namespace }) => namespace === NAMESPACES.clientSecret.key,
    );
    const epochItem = prepared.commit.trustedSecrets.find(
      ({ namespace }) => namespace === NAMESPACES.epochSecret.key,
    );
    if (clientItem === undefined || epochItem === undefined) throw new Error("Missing secrets");
    const client = await decodeClientSecretState(
      await openWrappedLocalState({
        wrappingKey: key,
        domain: "awsm.local.client-secret",
        vaultId: creation.ids.vaultId,
        identity: creation.ids.clientCredentialId,
        wrappedBytes: clientItem.bytes,
      }),
    );
    const epoch = decodeEpochSecretState(
      await openWrappedLocalState({
        wrappingKey: key,
        domain: "awsm.local.epoch-secret",
        vaultId: creation.ids.vaultId,
        identity: creation.secrets.keyEpoch.id,
        wrappedBytes: epochItem.bytes,
      }),
    );
    expect(client.signingSecretKey).toEqual(creation.secrets.client.signingSecretKey);
    expect(client.wrappingPrivateKey).toEqual(creation.secrets.client.wrappingPrivateKey);
    expect(epoch.key).toEqual(creation.secrets.keyEpoch.key);

    const directory = decodeVaultDirectoryEntry(
      await openWrappedLocalState({
        wrappingKey: key,
        domain: "awsm.local.vault-directory",
        vaultId: creation.ids.vaultId,
        identity: creation.ids.vaultId,
        wrappedBytes: prepared.commit.vaultDirectoryEntry.bytes,
      }),
    );
    expect(directory.label).toBe("Vault A");

    const resolutions = await Promise.all(
      (prepared.commit.replicaSafetyItems ?? []).map(async (item, index) =>
        decodeLogicalResolution(
          await openWrappedLocalState({
            wrappingKey: key,
            domain: "awsm.local.logical-resolution",
            vaultId: creation.ids.vaultId,
            identity: prepared.logicalResolutions[index]?.logicalId ?? new Uint8Array(),
            wrappedBytes: item.bytes,
          }),
        ),
      ),
    );
    expect(resolutions).toEqual(prepared.logicalResolutions);
    expect(resolutions.every(({ availability }) => availability === 1)).toBe(true);
  });

  it("commits initial Feature Manifests and their verified resolutions atomically", async () => {
    const manifest = {
      featureKey: "awsm.test-local-state",
      revision: 1,
      parameters: new Uint8Array(),
      requiredManifestIds: [],
      incompatibleKeys: [],
    } as const;
    const manifestId = featureManifestId(encodeFeatureManifest(manifest));
    const creation = await prepareCanonicalVaultCreation({
      label: "Feature Vault",
      assertedAt: 1,
      featureManifests: [manifest],
    });
    const prepared = await prepareCanonicalVaultStorage({
      creation,
      label: "Feature Vault",
      realm: NORMAL_STORAGE_REALM,
      wrappingKey: await wrappingKey(),
    });

    expect(prepared.commit.immutableItems).toContainEqual(
      expect.objectContaining({ namespace: NAMESPACES.featureManifest.key }),
    );
    expect(prepared.logicalResolutions).toContainEqual(
      expect.objectContaining({ kind: 4, logicalId: manifestId, availability: 1 }),
    );
  });

  it("includes prepared Fork Objects and resolutions in the one initial transaction", async () => {
    const key = await wrappingKey();
    const creation = await prepareCanonicalVaultCreation({ label: "Fork", assertedAt: 1 });
    const objectId = randomIdentifier("VaultObject");
    const storageItemId = randomIdentifier("StorageItem");
    const vaultKey = Array.from(creation.ids.vaultId, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const resolution = {
      vaultId: creation.ids.vaultId,
      kind: 3 as const,
      logicalId: objectId,
      storageItemId,
      keyEpochId: creation.secrets.keyEpoch.id,
      availability: 1 as const,
    };
    const prepared = await prepareCanonicalVaultStorage({
      creation,
      label: "Fork",
      realm: NORMAL_STORAGE_REALM,
      wrappingKey: key,
      additionalImmutableItems: [
        {
          namespace: NAMESPACES.vaultObject.key,
          scopeKey: vaultKey,
          itemKey: Array.from(objectId, (byte) => byte.toString(16).padStart(2, "0")).join(""),
          bytes: new Uint8Array([1]),
        },
      ],
      additionalLogicalResolutions: [resolution],
    });

    expect(prepared.commit.immutableItems).toHaveLength(5);
    expect(prepared.logicalResolutions).toContainEqual(resolution);
    expect(prepared.commit.replicaSafetyItems).toHaveLength(5);
  });

  it("round-trips the exact latest Vacuum Adoption boundary", async () => {
    const key = await wrappingKey();
    const creation = await prepareCanonicalVaultCreation({ label: "Vault A", assertedAt: 1 });
    const prepared = await prepareCanonicalVaultStorage({
      creation,
      label: "Vault A",
      realm: NORMAL_STORAGE_REALM,
      wrappingKey: key,
    });
    const vacuumEventRecordId = randomIdentifier("VaultRecord");
    const successorBaselineId = randomIdentifier("VaultRecord");
    const adopted = {
      ...prepared.replicaState,
      generationId: randomIdentifier("Generation"),
      causalFrontier: [successorBaselineId],
      authorityFrontier: [vacuumEventRecordId],
      continuityRecordIds: canonicalSet([creation.genesis.recordId, vacuumEventRecordId]),
      baselineId: successorBaselineId,
      adoption: { vacuumEventRecordId },
    };

    expect(
      decodeCanonicalReplicaState(
        encodeCanonicalReplicaState(adopted as unknown as typeof prepared.replicaState),
      ),
    ).toEqual(adopted);
  });

  it("round-trips a readable Replica with no local authoring Credential", async () => {
    const creation = await prepareCanonicalVaultCreation({ label: "Imported", assertedAt: 1 });
    const prepared = await prepareCanonicalVaultStorage({
      creation,
      label: "Imported",
      realm: NORMAL_STORAGE_REALM,
      wrappingKey: await wrappingKey(),
    });
    const replicaState = {
      ...prepared.replicaState,
      authoringClientCredentialId: null,
      memberId: null,
    };
    const directory = {
      vaultId: creation.ids.vaultId,
      generationId: creation.ids.generationId,
      label: "Imported",
      selectedClientCredentialId: null,
    };

    expect(
      decodeCanonicalReplicaState(
        encodeCanonicalReplicaState(replicaState as unknown as typeof prepared.replicaState),
      ),
    ).toEqual(replicaState);
    expect(
      decodeVaultDirectoryEntry(
        encodeVaultDirectoryEntry(
          directory as unknown as Parameters<typeof encodeVaultDirectoryEntry>[0],
        ),
      ),
    ).toEqual(directory);
  });
});
