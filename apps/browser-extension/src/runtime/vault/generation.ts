import {
  decodeEncryptedEnvelopeBytes,
  decryptEnvelope,
  encodeEncryptedEnvelope,
  encryptEnvelope,
} from "../../crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { bytesEqual, sha256 } from "../../domain/hash";
import {
  bytes,
  canonicalRecord,
  integer,
  literal,
  string,
  timestamp,
  uuid,
} from "../../domain/validation";
import type { StoredVaultGenerationV1, StoredVaultHeadV1 } from "../../drivers/indexeddb/schema";
import type { VaultKeyring } from "./keyring";

export interface PrepareVaultGenerationInput {
  readonly rootKey: CryptoKey;
  readonly vaultId: string;
  readonly keyEpochId: string;
  readonly deviceId: string;
  readonly generationId: string;
  readonly generationNumber: number;
  readonly predecessorGenerationId?: string;
  readonly createdAt: string;
  readonly reason: "Initial" | "Vacuum";
  readonly retainedObjectIds: readonly string[];
  readonly retainedEventIds: readonly string[];
}

export async function prepareVaultGeneration(input: PrepareVaultGenerationInput): Promise<{
  readonly generation: StoredVaultGenerationV1;
  readonly head: StoredVaultHeadV1;
}> {
  const reachability = {
    retainedObjectIds: [...input.retainedObjectIds].toSorted(),
    retainedEventIds: [...input.retainedEventIds].toSorted(),
  };
  const checksum = await sha256(encodeCanonicalCbor(reachability));
  const plaintext = encodeCanonicalCbor({
    version: 1,
    vaultId: input.vaultId,
    generationId: input.generationId,
    generationNumber: input.generationNumber,
    ...(input.predecessorGenerationId === undefined
      ? {}
      : { predecessorGenerationId: input.predecessorGenerationId }),
    createdAt: input.createdAt,
    initiatingDeviceId: input.deviceId,
    reason: input.reason,
    ...reachability,
    integrity: { algorithm: "hash:sha256:v1", checksum },
  });
  const key = await deriveContextKeyFromCryptoKey(input.rootKey, {
    vaultId: input.vaultId,
    keyEpochId: input.keyEpochId,
    domain: "vault:generation:v1",
    contextId: input.generationId,
    keyVersion: 1,
  });
  let envelopeBytes: Uint8Array;
  try {
    envelopeBytes = encodeEncryptedEnvelope(
      await encryptEnvelope({
        objectType: "VaultGeneration",
        objectId: input.generationId,
        keyEpochId: input.keyEpochId,
        plaintext,
        key,
      }),
    );
  } finally {
    await wipe(key);
  }
  return {
    generation: {
      version: 1,
      generationId: input.generationId,
      generationNumber: input.generationNumber,
      ...(input.predecessorGenerationId === undefined
        ? {}
        : { predecessorGenerationId: input.predecessorGenerationId }),
      envelopeBytes,
    },
    head: {
      version: 1,
      vaultId: input.vaultId,
      generationId: input.generationId,
      generationNumber: input.generationNumber,
      appendedObjectIds: [],
      appendedEventIds: [],
    },
  };
}

export async function verifyVaultGeneration(
  keyring: VaultKeyring,
  vaultId: string,
  stored: StoredVaultGenerationV1,
): Promise<{
  readonly retainedObjectIds: readonly string[];
  readonly retainedEventIds: readonly string[];
}> {
  const envelope = decodeEncryptedEnvelopeBytes(stored.envelopeBytes);
  const epoch = keyring.require(envelope.keyEpochId);
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:generation:v1",
    contextId: stored.generationId,
    keyVersion: 1,
  });
  try {
    if (envelope.objectType !== "VaultGeneration" || envelope.objectId !== stored.generationId) {
      throw new Error("Vault Generation envelope mismatch");
    }
    const manifest = canonicalRecord(
      decodeCanonicalCbor(await decryptEnvelope(envelope, key, epoch.keyEpochId)),
      "generation",
      [
        "version",
        "vaultId",
        "generationId",
        "generationNumber",
        "predecessorGenerationId",
        "createdAt",
        "initiatingDeviceId",
        "reason",
        "retainedObjectIds",
        "retainedEventIds",
        "integrity",
      ],
    );
    literal(manifest.version, 1, "generation.version");
    if (uuid(manifest.vaultId, "generation.vaultId") !== vaultId)
      throw new Error("Vault Generation belongs to another Vault");
    if (uuid(manifest.generationId, "generation.generationId") !== stored.generationId)
      throw new Error("Vault Generation identifier mismatch");
    if (
      integer(manifest.generationNumber, "generation.generationNumber") !== stored.generationNumber
    )
      throw new Error("Vault Generation number mismatch");
    const predecessorGenerationId =
      manifest.predecessorGenerationId === undefined
        ? undefined
        : uuid(manifest.predecessorGenerationId, "generation.predecessorGenerationId");
    if (predecessorGenerationId !== stored.predecessorGenerationId) {
      throw new Error("Vault Generation predecessor mismatch");
    }
    timestamp(manifest.createdAt, "generation.createdAt");
    uuid(manifest.initiatingDeviceId, "generation.initiatingDeviceId");
    if (manifest.reason !== "Initial" && manifest.reason !== "Vacuum") {
      throw new Error("Vault Generation reason is invalid");
    }
    const objectIds = stringArray(manifest.retainedObjectIds, "generation.retainedObjectIds");
    const eventIds = stringArray(manifest.retainedEventIds, "generation.retainedEventIds");
    const integrity = canonicalRecord(manifest.integrity, "generation.integrity", [
      "algorithm",
      "checksum",
    ]);
    literal(integrity.algorithm, "hash:sha256:v1", "generation.integrity.algorithm");
    const expected = await sha256(
      encodeCanonicalCbor({ retainedObjectIds: objectIds, retainedEventIds: eventIds }),
    );
    if (!bytesEqual(bytes(integrity.checksum, 32, "generation.integrity.checksum"), expected)) {
      throw new Error("Vault Generation reachability checksum mismatch");
    }
    return { retainedObjectIds: objectIds, retainedEventIds: eventIds };
  } finally {
    await wipe(key);
  }
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const result = value.map((entry, index) => string(entry, `${field}.${String(index)}`));
  if (result.join("\n") !== [...result].toSorted().join("\n"))
    throw new Error(`${field} must be sorted`);
  return result;
}
