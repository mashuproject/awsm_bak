import { DomainValidationError } from "../../domain/errors";
import {
  boolean,
  bytes,
  canonicalRecord,
  integer,
  literal,
  timestamp,
  uuid,
} from "../../domain/validation";
import type { DeviceKeySlotV1, VaultMetadataV1, VaultRecordsV1 } from "./contracts";

export function decodeVaultMetadata(value: unknown): VaultMetadataV1 {
  const input = canonicalRecord(value, "vaultMetadata", [
    "version",
    "vaultId",
    "activeKeyEpochId",
    "deviceId",
    "createdAt",
    "manuallyLocked",
    "verifier",
  ]);
  const verifier = canonicalRecord(input.verifier, "vaultMetadata.verifier", [
    "version",
    "nonce",
    "ciphertext",
  ]);
  return {
    version: literal(input.version, 1, "vaultMetadata.version"),
    vaultId: uuid(input.vaultId, "vaultMetadata.vaultId"),
    activeKeyEpochId: uuid(input.activeKeyEpochId, "vaultMetadata.activeKeyEpochId"),
    deviceId: uuid(input.deviceId, "vaultMetadata.deviceId"),
    createdAt: timestamp(input.createdAt, "vaultMetadata.createdAt"),
    manuallyLocked: boolean(input.manuallyLocked, "vaultMetadata.manuallyLocked"),
    verifier: {
      version: literal(verifier.version, 1, "vaultMetadata.verifier.version"),
      nonce: bytes(verifier.nonce, 24, "vaultMetadata.verifier.nonce"),
      ciphertext: bytes(verifier.ciphertext, undefined, "vaultMetadata.verifier.ciphertext"),
    },
  };
}

export function decodeDeviceSlot(value: unknown): DeviceKeySlotV1 {
  const input = canonicalRecord(value, "deviceSlot", [
    "version",
    "slotId",
    "vaultId",
    "keyEpochId",
    "deviceId",
    "algorithm",
    "wrappedRootKey",
  ]);
  return {
    version: literal(input.version, 1, "deviceSlot.version"),
    slotId: uuid(input.slotId, "deviceSlot.slotId"),
    vaultId: uuid(input.vaultId, "deviceSlot.vaultId"),
    keyEpochId: uuid(input.keyEpochId, "deviceSlot.keyEpochId"),
    deviceId: uuid(input.deviceId, "deviceSlot.deviceId"),
    algorithm: literal(input.algorithm, "wrap:aes-kw-256:device:v1", "deviceSlot.algorithm"),
    wrappedRootKey: bytes(input.wrappedRootKey, 40, "deviceSlot.wrappedRootKey"),
  };
}

export function decodeVaultRecords(input: {
  readonly metadata: unknown;
  readonly deviceSlot: unknown;
  readonly deviceKey: unknown;
  readonly generations: unknown;
  readonly head: unknown;
}): VaultRecordsV1 {
  if (!(input.deviceKey instanceof CryptoKey) || input.deviceKey.extractable) {
    throw new DomainValidationError("deviceKey", "must be a non-exportable Web Crypto key");
  }
  const metadata = decodeVaultMetadata(input.metadata);
  const deviceSlot = decodeDeviceSlot(input.deviceSlot);
  if (metadata.vaultId !== deviceSlot.vaultId || metadata.deviceId !== deviceSlot.deviceId) {
    throw new DomainValidationError("deviceSlot", "does not belong to the active Vault and Device");
  }
  if (!Array.isArray(input.generations)) {
    throw new DomainValidationError("vaultGenerations", "must be an array");
  }
  const headInput = canonicalRecord(input.head, "vaultHead", [
    "version",
    "vaultId",
    "generationId",
    "generationNumber",
    "appendedObjectIds",
    "appendedEventIds",
  ]);
  const head = {
    version: literal(headInput.version, 1, "vaultHead.version"),
    vaultId: uuid(headInput.vaultId, "vaultHead.vaultId"),
    generationId: uuid(headInput.generationId, "vaultHead.generationId"),
    generationNumber: integer(headInput.generationNumber, "vaultHead.generationNumber"),
    appendedObjectIds: uuidArray(headInput.appendedObjectIds, "vaultHead.appendedObjectIds"),
    appendedEventIds: uuidArray(headInput.appendedEventIds, "vaultHead.appendedEventIds"),
  } as const;
  if (head.vaultId !== metadata.vaultId) {
    throw new DomainValidationError("vaultHead", "does not belong to the active Vault");
  }
  const generationValue = input.generations.find((value) => {
    const candidate = canonicalRecord(value, "vaultGeneration", [
      "version",
      "generationId",
      "generationNumber",
      "predecessorGenerationId",
      "envelopeBytes",
    ]);
    return candidate.generationId === head.generationId;
  });
  if (generationValue === undefined) {
    throw new DomainValidationError("vaultGeneration", "active generation is missing");
  }
  const generationInput = canonicalRecord(generationValue, "vaultGeneration", [
    "version",
    "generationId",
    "generationNumber",
    "predecessorGenerationId",
    "envelopeBytes",
  ]);
  const generation = {
    version: literal(generationInput.version, 1, "vaultGeneration.version"),
    generationId: uuid(generationInput.generationId, "vaultGeneration.generationId"),
    generationNumber: integer(generationInput.generationNumber, "vaultGeneration.generationNumber"),
    ...(generationInput.predecessorGenerationId === undefined
      ? {}
      : {
          predecessorGenerationId: uuid(
            generationInput.predecessorGenerationId,
            "vaultGeneration.predecessorGenerationId",
          ),
        }),
    envelopeBytes: bytes(generationInput.envelopeBytes, undefined, "vaultGeneration.envelopeBytes"),
  };
  if (generation.generationNumber !== head.generationNumber) {
    throw new DomainValidationError("vaultGeneration", "does not match the active generation");
  }
  return {
    metadata,
    deviceSlot,
    deviceKey: input.deviceKey,
    generation,
    head,
  };
}

function uuidArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new DomainValidationError(field, "must be an array");
  const result = value.map((entry, index) => uuid(entry, `${field}.${String(index)}`));
  if (
    new Set(result).size !== result.length ||
    result.join("\n") !== [...result].toSorted().join("\n")
  ) {
    throw new DomainValidationError(field, "must contain unique canonical sorted identifiers");
  }
  return result;
}
