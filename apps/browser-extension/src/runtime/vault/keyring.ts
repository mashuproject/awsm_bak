import { wipe } from "../../crypto/sodium";
import { uuid } from "../../domain/validation";
import { VaultServiceError } from "./errors";

export interface VaultEpochKey {
  readonly keyEpochId: string;
  readonly ordinal: number;
  readonly rootKey: CryptoKey;
}

export class VaultKeyring {
  readonly activeKeyEpochId: string;
  private readonly epochs: ReadonlyMap<string, VaultEpochKey>;

  constructor(activeKeyEpochId: string, epochs: readonly VaultEpochKey[]) {
    this.activeKeyEpochId = uuid(activeKeyEpochId, "keyring.activeKeyEpochId");
    if (epochs.length === 0) throw new Error("A Vault keyring must contain an active epoch.");
    const byId = new Map<string, VaultEpochKey>();
    let previousOrdinal = -1;
    for (const epoch of [...epochs].toSorted((left, right) => left.ordinal - right.ordinal)) {
      const keyEpochId = uuid(epoch.keyEpochId, "keyring.keyEpochId");
      if (
        !Number.isSafeInteger(epoch.ordinal) ||
        epoch.ordinal !== previousOrdinal + 1 ||
        byId.has(keyEpochId) ||
        epoch.rootKey.algorithm.name !== "HKDF"
      )
        throw new Error("The Vault keyring is invalid.");
      byId.set(keyEpochId, { ...epoch, keyEpochId });
      previousOrdinal = epoch.ordinal;
    }
    if (!byId.has(this.activeKeyEpochId))
      throw new Error("The active Vault key epoch is unavailable.");
    if ([...byId.values()].at(-1)?.keyEpochId !== this.activeKeyEpochId)
      throw new Error("The active Vault key epoch must be the newest epoch.");
    this.epochs = byId;
  }

  active(): VaultEpochKey {
    return this.require(this.activeKeyEpochId);
  }

  require(keyEpochId: string): VaultEpochKey {
    const epoch = this.epochs.get(uuid(keyEpochId, "keyring.keyEpochId"));
    if (epoch === undefined) {
      throw new VaultServiceError(
        "CRYPTO_AUTHENTICATION_FAILED",
        "The encryption key epoch required by this Vault record is unavailable.",
      );
    }
    return epoch;
  }

  list(): readonly VaultEpochKey[] {
    return [...this.epochs.values()];
  }
}

export async function importVaultRootKey(rawRootKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", Uint8Array.from(rawRootKey), "HKDF", false, ["deriveBits"]);
}

export async function importVaultKeyring(
  activeKeyEpochId: string,
  epochs: readonly {
    readonly keyEpochId: string;
    readonly ordinal: number;
    readonly rootKey: Uint8Array;
  }[],
): Promise<VaultKeyring> {
  try {
    return new VaultKeyring(
      activeKeyEpochId,
      await Promise.all(
        epochs.map(async (epoch) => ({
          keyEpochId: epoch.keyEpochId,
          ordinal: epoch.ordinal,
          rootKey: await importVaultRootKey(epoch.rootKey),
        })),
      ),
    );
  } finally {
    await Promise.all(epochs.map(async (epoch) => wipe(epoch.rootKey)));
  }
}
