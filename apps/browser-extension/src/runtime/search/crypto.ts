import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import { encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import type { SearchProjectionType, StoredSearchEnvelopeV1 } from "../../drivers/indexeddb/schema";
import { decodeStoredSearchEnvelope } from "../../drivers/indexeddb/search-decode";
import type { VaultKeyring } from "../vault/keyring";

const ALGORITHM = "AES-256-GCM";

interface SearchProjectionHeader {
  readonly version: 1;
  readonly vaultId: string;
  readonly keyEpochId: string;
  readonly rowId: string;
  readonly projectionType: SearchProjectionType;
  readonly sourceRevision: string;
  readonly algorithm: typeof ALGORITHM;
}

function header(
  value: Omit<StoredSearchEnvelopeV1, "nonce" | "ciphertext">,
): SearchProjectionHeader {
  return {
    version: 1,
    vaultId: value.vaultId,
    keyEpochId: value.keyEpochId,
    rowId: value.rowId,
    projectionType: value.projectionType,
    sourceRevision: value.sourceRevision,
    algorithm: ALGORITHM,
  };
}

async function projectionKey(
  keyring: VaultKeyring,
  value: Pick<StoredSearchEnvelopeV1, "vaultId" | "keyEpochId" | "projectionType" | "rowId">,
): Promise<{ readonly bytes: Uint8Array; readonly key: CryptoKey }> {
  const epoch = keyring.require(value.keyEpochId);
  const keyBytes = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId: value.vaultId,
    keyEpochId: value.keyEpochId,
    domain: "vault:projection:v1",
    contextId: `Search:${value.projectionType}:${value.rowId}`,
    keyVersion: 1,
  });
  try {
    return {
      bytes: keyBytes,
      key: await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(keyBytes),
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
      ),
    };
  } catch (error) {
    await wipe(keyBytes);
    throw error;
  }
}

export async function sealSearchProjectionRow(input: {
  readonly keyring: VaultKeyring;
  readonly vaultId: string;
  readonly rowId: string;
  readonly projectionType: SearchProjectionType;
  readonly sourceRevision: string;
  readonly plaintext: Uint8Array;
  readonly randomBytes?: (length: number) => Uint8Array;
}): Promise<StoredSearchEnvelopeV1> {
  const epoch = input.keyring.active();
  const base = decodeStoredSearchEnvelope({
    version: 1,
    vaultId: input.vaultId,
    keyEpochId: epoch.keyEpochId,
    rowId: input.rowId,
    projectionType: input.projectionType,
    sourceRevision: input.sourceRevision,
    nonce: input.randomBytes?.(12) ?? crypto.getRandomValues(new Uint8Array(12)),
    ciphertext: new Uint8Array(16),
  });
  const derived = await projectionKey(input.keyring, base);
  try {
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(base.nonce),
        additionalData: Uint8Array.from(encodeCanonicalCbor(header(base))),
        tagLength: 128,
      },
      derived.key,
      Uint8Array.from(input.plaintext),
    );
    return { ...base, ciphertext: new Uint8Array(ciphertext) };
  } finally {
    await wipe(derived.bytes);
  }
}

export async function openSearchProjectionRow(input: {
  readonly keyring: VaultKeyring;
  readonly stored: StoredSearchEnvelopeV1;
}): Promise<Uint8Array> {
  const stored = decodeStoredSearchEnvelope(input.stored);
  const derived = await projectionKey(input.keyring, stored);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(stored.nonce),
          additionalData: Uint8Array.from(encodeCanonicalCbor(header(stored))),
          tagLength: 128,
        },
        derived.key,
        Uint8Array.from(stored.ciphertext),
      ),
    );
  } catch {
    throw new DomainValidationError("searchEnvelope", "failed authenticated decryption");
  } finally {
    await wipe(derived.bytes);
  }
}
