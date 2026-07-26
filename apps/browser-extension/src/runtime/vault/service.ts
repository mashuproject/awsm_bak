import { wipe } from "../../crypto/sodium";
import { createExportKeyEnvelope, type ExportKeyEnvelopeV1 } from "../export";
import type {
  PreparedVault,
  PrepareVaultInput,
  VaultEpochRepository,
  VaultRecordsV1,
  VaultRepository,
} from "./contracts";
import { VaultServiceError } from "./errors";
import { prepareVaultGeneration } from "./generation";
import { importVaultKeyring, importVaultRootKey, VaultKeyring } from "./keyring";
import { normalizeVaultName } from "./name";
import { createDeviceSlot, createVerifier, unwrapDeviceSlot, verifyRootKey } from "./slots";

async function importWrappableRootKey(rawRootKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(rawRootKey),
    { name: "HMAC", hash: "SHA-256", length: 256 },
    true,
    ["sign"],
  );
}

export class VaultService {
  private keyring: VaultKeyring | undefined;
  readonly repository: VaultRepository;
  readonly vaultId: string | undefined;

  constructor(
    repository: VaultRepository,
    vaultId?: string,
    private readonly epochRepository?: VaultEpochRepository,
  ) {
    this.repository = repository;
    this.vaultId = vaultId;
  }

  isUnlocked(): boolean {
    return this.keyring !== undefined;
  }

  requireRootKey(): CryptoKey {
    return this.requireKeyring().active().rootKey;
  }

  requireKeyring(): VaultKeyring {
    if (this.keyring === undefined)
      throw new VaultServiceError("VAULT_LOCKED", "Unlock the Vault to continue.");
    return this.keyring;
  }

  requireActiveKeyEpochId(): string {
    return this.requireKeyring().activeKeyEpochId;
  }

  async prepareCreate(input: PrepareVaultInput): Promise<PreparedVault> {
    const name = normalizeVaultName(input.name);
    const rawRootKey = crypto.getRandomValues(new Uint8Array(32));
    const vaultId = crypto.randomUUID();
    const keyEpochId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    try {
      const wrappableRootKey = await importWrappableRootKey(rawRootKey);
      const { slot: deviceSlot, deviceKey } = await createDeviceSlot(
        wrappableRootKey,
        vaultId,
        keyEpochId,
        deviceId,
      );
      const verifier = await createVerifier(rawRootKey, deviceSlot);
      const rootKey = await importVaultRootKey(rawRootKey);
      const initialGeneration = await prepareVaultGeneration({
        rootKey,
        vaultId,
        keyEpochId,
        deviceId,
        generationId: crypto.randomUUID(),
        generationNumber: 0,
        createdAt: input.createdAt,
        reason: "Initial",
        retainedObjectIds: [],
        retainedEventIds: [],
      });
      const records: VaultRecordsV1 = {
        metadata: {
          version: 1,
          vaultId,
          activeKeyEpochId: keyEpochId,
          deviceId,
          createdAt: input.createdAt,
          manuallyLocked: false,
          verifier,
        },
        deviceSlot,
        deviceKey,
        ...initialGeneration,
      };
      return {
        records,
        keyring: new VaultKeyring(keyEpochId, [{ keyEpochId, ordinal: 0, rootKey }]),
        name,
      };
    } catch (error) {
      if (error instanceof VaultServiceError) throw error;
      throw new VaultServiceError(
        "CRYPTO_AUTHENTICATION_FAILED",
        "The local Vault encryption could not be initialized.",
      );
    } finally {
      await wipe(rawRootKey);
    }
  }

  activatePrepared(prepared: PreparedVault): void {
    this.keyring = prepared.keyring;
  }

  async lock(): Promise<void> {
    const vaultId = this.requireVaultId();
    await this.repository.setManualLock(vaultId, true);
    this.keyring = undefined;
  }

  async autoUnlock(): Promise<boolean> {
    const records = await this.repository.load(this.requireVaultId());
    if (records === undefined || records.metadata.manuallyLocked) {
      return false;
    }
    await this.unlockDeviceRecords(records);
    return true;
  }

  async unlockWithDevice(): Promise<void> {
    const records = await this.requireRecords();
    const keyring = await this.prepareDeviceKeyring(records);
    await this.repository.setManualLock(this.requireVaultId(), false);
    this.keyring = keyring;
  }

  async createExportKeyEnvelope(input: {
    readonly packageId: string;
    readonly manifestBytes: Uint8Array;
    readonly passphrase: string;
    readonly salt: Uint8Array;
    readonly nonce: Uint8Array;
  }): Promise<ExportKeyEnvelopeV1> {
    const records = await this.requireRecords();
    let rawEpochs:
      | {
          readonly keyEpochId: string;
          readonly ordinal: number;
          readonly rootKey: Uint8Array;
        }[]
      | undefined;
    try {
      const storedEpochs = await this.epochRepository?.loadEpochKeys(records.metadata.vaultId);
      if (storedEpochs === undefined) {
        const rawRootKey = await unwrapDeviceSlot(records.deviceSlot, records.deviceKey);
        rawEpochs = [
          {
            keyEpochId: records.metadata.activeKeyEpochId,
            ordinal: 0,
            rootKey: rawRootKey,
          },
        ];
      } else {
        rawEpochs = [...storedEpochs];
      }
      const active = rawEpochs.find(
        (epoch) => epoch.keyEpochId === records.metadata.activeKeyEpochId,
      );
      if (active === undefined) throw new Error("The active Vault key epoch is unavailable.");
      const rootKey = await importVaultRootKey(active.rootKey);
      await verifyRootKey(rootKey, records.deviceSlot, records.metadata.verifier);
      return await createExportKeyEnvelope({
        packageId: input.packageId,
        originatingVaultId: records.metadata.vaultId,
        manifestBytes: input.manifestBytes,
        passphrase: input.passphrase,
        keyring: {
          version: 1,
          vaultId: records.metadata.vaultId,
          activeKeyEpochId: records.metadata.activeKeyEpochId,
          keyEpochs: rawEpochs,
        },
        salt: input.salt,
        nonce: input.nonce,
      });
    } catch (error) {
      if (error instanceof VaultServiceError) throw error;
      throw new VaultServiceError(
        "CRYPTO_AUTHENTICATION_FAILED",
        "The local device slot could not be authenticated.",
      );
    } finally {
      if (rawEpochs !== undefined)
        await Promise.all(rawEpochs.map(async (epoch) => wipe(epoch.rootKey)));
    }
  }

  private async requireRecords(): Promise<VaultRecordsV1> {
    const records = await this.repository.load(this.requireVaultId());
    if (records === undefined) {
      throw new VaultServiceError("VAULT_LOCKED", "The scoped Vault records are unavailable.");
    }
    return records;
  }

  releaseRootKey(): void {
    this.keyring = undefined;
  }

  private requireVaultId(): string {
    if (this.vaultId === undefined) {
      throw new VaultServiceError("VAULT_LOCKED", "No Vault context is selected.");
    }
    return this.vaultId;
  }

  private async unlockDeviceRecords(records: VaultRecordsV1): Promise<void> {
    this.keyring = await this.prepareDeviceKeyring(records);
  }

  private async prepareDeviceKeyring(records: VaultRecordsV1): Promise<VaultKeyring> {
    let rawRootKey: Uint8Array | undefined;
    try {
      rawRootKey = await unwrapDeviceSlot(records.deviceSlot, records.deviceKey);
      if (
        records.deviceSlot.keyEpochId !== records.metadata.activeKeyEpochId ||
        records.deviceSlot.vaultId !== records.metadata.vaultId
      )
        throw new Error("The local Device slot does not match active Vault authority.");
      const rootKey = await importVaultRootKey(rawRootKey);
      await verifyRootKey(rootKey, records.deviceSlot, records.metadata.verifier);
      const storedEpochs = await this.epochRepository?.loadEpochKeys(records.metadata.vaultId);
      if (storedEpochs === undefined) {
        return new VaultKeyring(records.metadata.activeKeyEpochId, [
          {
            keyEpochId: records.metadata.activeKeyEpochId,
            ordinal: 0,
            rootKey,
          },
        ]);
      }
      const active = storedEpochs.find(
        (epoch) => epoch.keyEpochId === records.metadata.activeKeyEpochId,
      );
      if (active === undefined) throw new Error("The active Device epoch is unavailable.");
      const activeImported = await importVaultRootKey(active.rootKey);
      await verifyRootKey(activeImported, records.deviceSlot, records.metadata.verifier);
      return await importVaultKeyring(records.metadata.activeKeyEpochId, storedEpochs);
    } catch {
      throw new VaultServiceError(
        "CRYPTO_AUTHENTICATION_FAILED",
        "The local device slot could not be authenticated.",
      );
    } finally {
      if (rawRootKey !== undefined) {
        await wipe(rawRootKey);
      }
    }
  }
}
