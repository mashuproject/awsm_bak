import { type CompactPayloadType, openCompactItem } from "../../crypto/compact";
import { CryptoOperationError } from "../../crypto/errors";
import { decodeFeatureManifest, featureManifestId } from "../../domain/canonical/features";
import { type Identifier, keyEpochId } from "../../domain/canonical/identifiers";
import { decodeVaultObject, type VaultObject } from "../../domain/canonical/object";
import {
  type AuthenticatedVaultEvent,
  decodeVaultBaseline,
  decodeVaultEvent,
  type VaultBaseline,
} from "../../domain/canonical/record";
import { decodeCanonicalValue } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import type { EpochSecretState } from "../vault/canonical-local-state";

export type CanonicalPulledCompactCandidate =
  | {
      readonly kind: "VaultRecord";
      readonly logicalId: Identifier<"VaultRecord">;
      readonly record: AuthenticatedVaultEvent | VaultBaseline;
      readonly keyEpochId: Identifier<"KeyEpoch">;
      readonly storageItemId: Identifier<"StorageItem">;
    }
  | {
      readonly kind: "VaultObject";
      readonly logicalId: Identifier<"VaultObject">;
      readonly object: VaultObject;
      readonly keyEpochId: Identifier<"KeyEpoch">;
      readonly storageItemId: Identifier<"StorageItem">;
    }
  | {
      readonly kind: "FeatureManifest";
      readonly logicalId: Identifier<"FeatureManifest">;
      readonly bytes: Uint8Array;
      readonly keyEpochId: Identifier<"KeyEpoch">;
      readonly storageItemId: Identifier<"StorageItem">;
    };

function storageKey(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function assertEpochSecrets(
  vaultId: Identifier<"Vault">,
  epochSecrets: readonly EpochSecretState[],
): void {
  const seen = new Set<string>();
  for (const secret of epochSecrets) {
    same(secret.vaultId, vaultId, "Pulled candidate Epoch Secret Vault ID");
    same(
      keyEpochId(vaultId, secret.key),
      secret.keyEpochId,
      "Pulled candidate Epoch Secret identity",
    );
    const id = storageKey(secret.keyEpochId);
    if (seen.has(id)) throw new TypeError("Pulled candidate repeats a Key Epoch Secret");
    seen.add(id);
  }
}

function decodeRecord(bytes: Uint8Array): AuthenticatedVaultEvent | VaultBaseline {
  const value = decodeCanonicalValue(bytes);
  if (!(value instanceof Map)) throw new TypeError("Pulled Compact Record is not a map");
  if (value.get(6) === 1) return decodeVaultEvent(bytes);
  if (value.get(6) === 2) return decodeVaultBaseline(bytes);
  throw new TypeError("Pulled Compact Record kind is unsupported");
}

function candidateForOpened(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly payloadType: CompactPayloadType;
  readonly payloadBytes: Uint8Array;
  readonly storageItemId: Identifier<"StorageItem">;
}): CanonicalPulledCompactCandidate {
  switch (input.payloadType) {
    case 1: {
      const record = decodeRecord(input.payloadBytes);
      same(record.vaultId, input.vaultId, "Pulled Compact Record Vault ID");
      return {
        kind: "VaultRecord",
        logicalId: record.recordId,
        record,
        keyEpochId: input.keyEpochId,
        storageItemId: input.storageItemId,
      };
    }
    case 2: {
      const object = decodeVaultObject(input.payloadBytes);
      same(object.vaultId, input.vaultId, "Pulled Compact Vault Object Vault ID");
      return {
        kind: "VaultObject",
        logicalId: object.objectId,
        object,
        keyEpochId: input.keyEpochId,
        storageItemId: input.storageItemId,
      };
    }
    case 3: {
      decodeFeatureManifest(input.payloadBytes);
      return {
        kind: "FeatureManifest",
        logicalId: featureManifestId(input.payloadBytes),
        bytes: Uint8Array.from(input.payloadBytes),
        keyEpochId: input.keyEpochId,
        storageItemId: input.storageItemId,
      };
    }
    case 4:
      throw new TypeError("A local Bootstrap Catalog cannot be synchronized as a Vault item");
  }
}

/**
 * Opens one outer-verified Compact item privately against the caller's bounded retained Epoch set.
 * A result is only an authenticated candidate: complete DAG, Authority, dependency, and feature
 * validation must still succeed before the item can enter accepted Replica state.
 */
export async function classifyPulledCompactCandidate(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly epochSecrets: readonly EpochSecretState[];
  readonly envelopeBytes: Uint8Array;
}): Promise<CanonicalPulledCompactCandidate | null> {
  assertEpochSecrets(input.vaultId, input.epochSecrets);
  let opened:
    | {
        readonly keyEpochId: Identifier<"KeyEpoch">;
        readonly payloadType: CompactPayloadType;
        readonly payloadBytes: Uint8Array;
        readonly storageItemId: Identifier<"StorageItem">;
      }
    | undefined;
  for (const secret of input.epochSecrets) {
    try {
      const candidate = await openCompactItem({
        vaultId: input.vaultId,
        keyEpochId: secret.keyEpochId,
        keyEpochKey: secret.key,
        envelopeBytes: input.envelopeBytes,
      });
      if (opened !== undefined) {
        throw new TypeError("Pulled Compact item opened under more than one Key Epoch");
      }
      opened = {
        keyEpochId: candidate.keyEpochId,
        payloadType: candidate.payloadType,
        payloadBytes: candidate.payloadBytes,
        storageItemId: candidate.envelope.storageItemId,
      };
    } catch (error) {
      if (error instanceof CryptoOperationError) continue;
      throw error;
    }
  }
  if (opened === undefined) return null;
  return candidateForOpened({ vaultId: input.vaultId, ...opened });
}
