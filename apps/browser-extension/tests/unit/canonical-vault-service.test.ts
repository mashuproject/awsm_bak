import { describe, expect, it, vi } from "vitest";

import { sealCompactItem } from "../../src/crypto/compact";
import { keyEpochId, randomIdentifier } from "../../src/domain/canonical/identifiers";
import {
  type CanonicalIndexedDb,
  identifierStorageKey,
} from "../../src/drivers/indexeddb/canonical-database";
import { NAMESPACES, NORMAL_STORAGE_REALM } from "../../src/drivers/indexeddb/canonical-schema";
import { prepareCanonicalVaultCreation } from "../../src/runtime/vault/canonical-create";
import {
  canonicalLocalStorageContext,
  decodeInstallationSelection,
  encodeEpochSecretState,
  encodeLogicalResolution,
  prepareWrappedLocalStateItem,
} from "../../src/runtime/vault/canonical-local-state";
import {
  CanonicalVaultCreationCeremony,
  CanonicalVaultService,
} from "../../src/runtime/vault/canonical-service";
import { COMPACT_STORAGE_CLASS, encodeOpaqueEnvelope } from "../../src/storage/opaque-envelope";

function isWiped(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

describe("canonical Vault creation ceremony", () => {
  it("retains Prepared Data after a mismatched confirmation but persists nothing", async () => {
    const prepared = await prepareCanonicalVaultCreation({ label: "Vault", assertedAt: 1 });
    const storage = {
      getOrCreateInstallationWrappingKey: () => {
        throw new Error("storage must not be reached");
      },
    } as unknown as CanonicalIndexedDb;
    const ceremony = new CanonicalVaultCreationCeremony(
      storage,
      NORMAL_STORAGE_REALM,
      "Vault",
      prepared,
    );

    await expect(ceremony.confirm("not the recovery phrase")).rejects.toMatchObject({
      id: "RECOVERY_PHRASE_MISMATCH",
    });
    expect(isWiped(prepared.secrets.keyEpoch.key)).toBe(false);
    await ceremony.cancel();
  });

  it("wipes every retained private or plaintext Epoch copy when cancelled", async () => {
    const prepared = await prepareCanonicalVaultCreation({ label: null, assertedAt: 1 });
    const ceremony = new CanonicalVaultCreationCeremony(
      {} as CanonicalIndexedDb,
      NORMAL_STORAGE_REALM,
      null,
      prepared,
    );
    await ceremony.cancel();

    expect(
      [
        prepared.secrets.client.signingSeed,
        prepared.secrets.client.signingSecretKey,
        prepared.secrets.client.wrappingPrivateKey,
        prepared.secrets.recovery.signingSeed,
        prepared.secrets.recovery.signingSecretKey,
        prepared.secrets.recovery.wrappingPrivateKey,
        prepared.secrets.keyEpoch.key,
        prepared.clientKeyEnvelope.keyEpochKey,
        prepared.clientKeyEnvelope.bytes,
        prepared.recoveryKeyEnvelope.keyEpochKey,
        prepared.recoveryKeyEnvelope.bytes,
      ].every(isWiped),
    ).toBe(true);
    await expect(ceremony.confirm(ceremony.recoveryPhrase)).rejects.toThrow(/no longer active/u);
  });

  it("rehydrates an installation-wrapped creation after restart and consumes it atomically", async () => {
    const setupId = "019fa62e-a653-7f63-b2bf-94e7ed5e46ca";
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    let pending:
      | {
          readonly namespace: string;
          readonly scopeKey: string;
          readonly itemKey: string;
          readonly bytes: Uint8Array;
        }
      | undefined;
    const storage = {
      getOrCreateInstallationWrappingKey: vi.fn(async () => wrappingKey),
      getBytes: vi.fn(async () =>
        pending === undefined ? undefined : Uint8Array.from(pending.bytes),
      ),
      listBytes: vi.fn(async () => (pending === undefined ? [] : [pending])),
      commitExecutionMutation: vi.fn(
        async (input: {
          readonly mutableItems?: readonly (typeof pending extends infer Item ? Item : never)[];
          readonly deletedItems?: readonly { readonly itemKey: string }[];
        }) => {
          const mutable = input.mutableItems?.[0];
          if (mutable !== undefined)
            pending = { ...mutable, bytes: Uint8Array.from(mutable.bytes) };
          if (input.deletedItems?.some(({ itemKey }) => itemKey === setupId)) pending = undefined;
        },
      ),
      commitInitialVault: vi.fn(async () => undefined),
    } as unknown as CanonicalIndexedDb;
    const service = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);

    const begun = await service.beginCreate({
      setupId,
      expectedVaultId: null,
      label: "Restart-safe",
      assertedAt: 123,
    });
    expect(pending).toMatchObject({ itemKey: setupId });
    await expect(service.pendingCreation()).resolves.toEqual({ setupId, expectedVaultId: null });
    await expect(
      service.resumeCreate({ setupId, recoveryPhrase: "not a recovery phrase" }),
    ).rejects.toMatchObject({ id: "RECOVERY_PHRASE_MISMATCH" });

    const resumed = await service.resumeCreate({
      setupId,
      recoveryPhrase: begun.recoveryPhrase,
    });
    await resumed.confirm(begun.recoveryPhrase);

    expect(storage.commitInitialVault).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedMutableItems: [expect.objectContaining({ itemKey: setupId })],
        deletedItems: [expect.objectContaining({ itemKey: setupId })],
      }),
    );
  });
});

describe("canonical Vault selection", () => {
  it("opens the destination before replacing the Installation selection", async () => {
    const vaultId = randomIdentifier("Vault");
    const writes: unknown[] = [];
    const storage = {
      putMutable: vi.fn(async (_realm, item) => {
        writes.push(item);
      }),
    } as unknown as CanonicalIndexedDb;
    const service = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);
    const open = vi.spyOn(service, "openVault").mockResolvedValue({} as never);

    await service.selectVault(vaultId);

    expect(open).toHaveBeenCalledWith(vaultId);
    expect(writes).toHaveLength(1);
    const selection = writes[0] as {
      readonly namespace: string;
      readonly scopeKey: string;
      readonly itemKey: string;
      readonly bytes: Uint8Array;
    };
    expect(selection).toMatchObject({
      namespace: NAMESPACES.installationSelection.key,
      scopeKey: "installation",
      itemKey: "current",
    });
    expect(decodeInstallationSelection(selection.bytes).vaultId).toEqual(vaultId);
  });
});

describe("canonical opaque dependency resolution", () => {
  it("finds a local Compact representation only through a matching verified logical resolution", async () => {
    const vaultId = randomIdentifier("Vault");
    const recordId = randomIdentifier("VaultRecord");
    const keyEpochId = randomIdentifier("KeyEpoch");
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const envelope = encodeOpaqueEnvelope({
      storageClass: COMPACT_STORAGE_CLASS,
      protectionParameters: new Uint8Array(64).fill(1),
      payload: new Uint8Array(16).fill(2),
    });
    const resolution = await prepareWrappedLocalStateItem({
      namespace: NAMESPACES.logicalResolution.key,
      scopeKey: identifierStorageKey(vaultId),
      itemKey: `1:${identifierStorageKey(recordId)}`,
      wrappingKey,
      domain: "awsm.local.logical-resolution",
      context: canonicalLocalStorageContext(vaultId, recordId),
      bytes: encodeLogicalResolution({
        vaultId,
        kind: 1,
        logicalId: recordId,
        storageItemId: envelope.storageItemId,
        keyEpochId,
        availability: 1,
      }),
    });
    const storage = {
      getOrCreateInstallationWrappingKey: async () => wrappingKey,
      listBytes: async () => [resolution],
      getBytes: async () => envelope.bytes,
    } as unknown as CanonicalIndexedDb;
    const service = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);

    await expect(
      service.hasVerifiedCompactStorageItem({ vaultId, storageItemId: envelope.storageItemId }),
    ).resolves.toBe(true);
  });

  it("returns only a locally verified Key Envelope with the resolved outer identity", async () => {
    const vaultId = randomIdentifier("Vault");
    const keyEpochId = randomIdentifier("KeyEpoch");
    const keyEnvelopeId = randomIdentifier("KeyEnvelope");
    const envelope = encodeOpaqueEnvelope({
      storageClass: COMPACT_STORAGE_CLASS,
      protectionParameters: new Uint8Array(64).fill(1),
      payload: new Uint8Array(16).fill(2),
    });
    const storage = {
      getBytes: vi.fn(async () => envelope.bytes),
    } as unknown as CanonicalIndexedDb;
    const service = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);
    const readResolution = vi.spyOn(service, "readLogicalResolution").mockResolvedValue({
      vaultId,
      kind: 2,
      logicalId: keyEnvelopeId,
      storageItemId: envelope.storageItemId,
      keyEpochId,
      availability: 1,
    });
    const vault = { replicaState: { vaultId } } as never;

    await expect(
      service.readResolvedOpaqueItem({
        vault,
        kind: 2,
        logicalId: keyEnvelopeId,
        expectedKeyEpochId: keyEpochId,
        namespace: NAMESPACES.keyEnvelope.key,
      }),
    ).resolves.toEqual(envelope.bytes);
    expect(readResolution).toHaveBeenCalledWith({
      vault,
      kind: 2,
      logicalId: keyEnvelopeId,
      expectedKeyEpochId: keyEpochId,
      namespace: NAMESPACES.keyEnvelope.key,
    });

    readResolution.mockResolvedValue({
      vaultId,
      kind: 2,
      logicalId: keyEnvelopeId,
      storageItemId: randomIdentifier("StorageItem"),
      keyEpochId,
      availability: 1,
    });
    await expect(
      service.readResolvedOpaqueItem({
        vault,
        kind: 2,
        logicalId: keyEnvelopeId,
        expectedKeyEpochId: keyEpochId,
        namespace: NAMESPACES.keyEnvelope.key,
      }),
    ).rejects.toThrow("Resolution Storage Item ID does not match");
  });

  it("opens a retained Compact item with its exact historical Epoch Secret", async () => {
    const vaultId = randomIdentifier("Vault");
    const logicalId = randomIdentifier("FeatureManifest");
    const currentKey = new Uint8Array(32).fill(1);
    const historicalKey = new Uint8Array(32).fill(2);
    const currentEpochId = keyEpochId(vaultId, currentKey);
    const historicalEpochId = keyEpochId(vaultId, historicalKey);
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    const payloadBytes = new Uint8Array([4, 3, 2, 1]);
    const envelope = await sealCompactItem({
      vaultId,
      keyEpochId: historicalEpochId,
      keyEpochKey: historicalKey,
      payloadType: 3,
      payloadBytes,
    });
    const wrappedHistoricalSecret = await prepareWrappedLocalStateItem({
      namespace: NAMESPACES.epochSecret.key,
      scopeKey: identifierStorageKey(vaultId),
      itemKey: identifierStorageKey(historicalEpochId),
      wrappingKey,
      domain: "awsm.local.epoch-secret",
      context: canonicalLocalStorageContext(vaultId, historicalEpochId),
      bytes: encodeEpochSecretState({
        vaultId,
        keyEpochId: historicalEpochId,
        displayNumber: 0,
        key: historicalKey,
      }),
    });
    const storage = {
      getBytes: vi.fn(async (_realm, item: { readonly namespace: string }) =>
        item.namespace === NAMESPACES.epochSecret.key
          ? wrappedHistoricalSecret.bytes
          : envelope.bytes,
      ),
    } as unknown as CanonicalIndexedDb;
    const service = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);
    vi.spyOn(service, "readLogicalResolution").mockResolvedValue({
      vaultId,
      kind: 4,
      logicalId,
      storageItemId: envelope.storageItemId,
      keyEpochId: historicalEpochId,
      availability: 1,
    });
    const vault = {
      replicaState: { vaultId },
      installationWrappingKey: wrappingKey,
      epochSecret: {
        vaultId,
        keyEpochId: currentEpochId,
        displayNumber: 1,
        key: currentKey,
      },
    } as never;

    await expect(
      service.openResolvedCompactItem({
        vault,
        kind: 4,
        logicalId,
        namespace: NAMESPACES.featureManifest.key,
        payloadType: 3,
      }),
    ).resolves.toMatchObject({ keyEpochId: historicalEpochId, payloadBytes });
  });
});
