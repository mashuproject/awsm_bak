import type { StoredVaultGenerationV1, StoredVaultHeadV1 } from "../../drivers/indexeddb/schema";
import type { ValidatedVaultPackage } from "../export";
import type { ExportedVaultKeyring } from "../export/key-envelope";
import type { VaultRecordsV1 } from "../vault";
import type { PreparedVaultEpochStorage } from "../vault/contracts";
import { createDeviceSlot, createVerifier } from "../vault/slots";

async function importWrappableRootKey(rawRootKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(rawRootKey),
    { name: "HMAC", hash: "SHA-256", length: 256 },
    true,
    ["sign"],
  );
}

export async function prepareVaultEpochStorage(
  vaultId: string,
  keyEpochs: ExportedVaultKeyring["keyEpochs"],
): Promise<PreparedVaultEpochStorage> {
  const wrappingKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
  const epochs = await Promise.all(
    keyEpochs.map(async (epoch) => {
      const carrier = await importWrappableRootKey(epoch.rootKey);
      return {
        version: 1 as const,
        vaultId,
        keyEpochId: epoch.keyEpochId,
        ordinal: epoch.ordinal,
        wrappedRootKey: new Uint8Array(
          await crypto.subtle.wrapKey("raw", carrier, wrappingKey, "AES-KW"),
        ),
      };
    }),
  );
  return { wrappingKey, epochs };
}

export async function prepareImportedVaultCredentials(
  validated: ValidatedVaultPackage,
  rawKeyring: ExportedVaultKeyring,
): Promise<{ readonly records: VaultRecordsV1; readonly epochStorage: PreparedVaultEpochStorage }> {
  const active = rawKeyring.keyEpochs.find(
    (epoch) => epoch.keyEpochId === rawKeyring.activeKeyEpochId,
  );
  if (active === undefined) throw new Error("Imported Vault active key epoch is missing.");
  const records = await prepareReplicaDeviceCredentials({
    vaultId: validated.manifest.originatingVaultId,
    vaultCreatedAt: validated.vaultCreatedAt,
    generation: validated.generation,
    head: validated.head,
    keyEpochId: active.keyEpochId,
    rawRootKey: active.rootKey,
    deviceId: crypto.randomUUID(),
    manuallyLocked: true,
  });
  const epochStorage = await prepareVaultEpochStorage(
    validated.manifest.originatingVaultId,
    rawKeyring.keyEpochs,
  );
  return { records, epochStorage };
}

export async function prepareReplicaDeviceCredentials(input: {
  readonly vaultId: string;
  readonly vaultCreatedAt: string;
  readonly generation: StoredVaultGenerationV1;
  readonly head: StoredVaultHeadV1;
  readonly rawRootKey: Uint8Array;
  readonly keyEpochId: string;
  readonly deviceId: string;
  readonly manuallyLocked: boolean;
}): Promise<VaultRecordsV1> {
  const vaultId = input.vaultId;
  if (input.head.vaultId !== vaultId) {
    throw new Error("Validated Vault Package identity mismatch.");
  }
  const deviceId = input.deviceId;
  const rootKeyCarrier = await importWrappableRootKey(input.rawRootKey);
  const { slot: deviceSlot, deviceKey } = await createDeviceSlot(
    rootKeyCarrier,
    vaultId,
    input.keyEpochId,
    deviceId,
  );
  const verifier = await createVerifier(input.rawRootKey, deviceSlot);
  return {
    metadata: {
      version: 1,
      vaultId,
      activeKeyEpochId: input.keyEpochId,
      deviceId,
      createdAt: input.vaultCreatedAt,
      manuallyLocked: input.manuallyLocked,
      verifier,
    },
    deviceSlot,
    deviceKey,
    generation: input.generation,
    head: input.head,
  };
}
