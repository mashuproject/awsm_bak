import { wipe } from "../../crypto/sodium";
import type { Identifier, IdentifierKind } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import {
  identifierFromStorageKey,
  identifierStorageKey,
} from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import {
  decodeLogicalResolution,
  type LogicalResolution,
  openWrappedLocalState,
} from "../vault/canonical-local-state";
import type {
  CanonicalVaultService,
  PersistedOpenedCanonicalVault,
} from "../vault/canonical-service";
import type { GarbageCollectionCompactItem } from "./garbage-collection-plan";

export interface ReplicaGarbageCollectionInventory {
  readonly resolutions: readonly LogicalResolution[];
  readonly compactItems: readonly GarbageCollectionCompactItem[];
  readonly epochSecretIds: readonly Identifier<"KeyEpoch">[];
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < shared; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

const COMPACT_NAMESPACES = [
  { namespace: NAMESPACES.vaultRecord.key, kind: 1 as const, identifierKind: "VaultRecord" },
  { namespace: NAMESPACES.keyEnvelope.key, kind: 2 as const, identifierKind: "KeyEnvelope" },
  { namespace: NAMESPACES.vaultObject.key, kind: 3 as const, identifierKind: "VaultObject" },
  {
    namespace: NAMESPACES.featureManifest.key,
    kind: 4 as const,
    identifierKind: "FeatureManifest",
  },
] as const satisfies readonly {
  readonly namespace: string;
  readonly kind: GarbageCollectionCompactItem["kind"];
  readonly identifierKind: IdentifierKind;
}[];

export async function loadReplicaGarbageCollectionInventory(
  vaults: CanonicalVaultService,
  vault: PersistedOpenedCanonicalVault,
): Promise<ReplicaGarbageCollectionInventory> {
  const vaultId = vault.replicaState.vaultId;
  const vaultKey = identifierStorageKey(vaultId);
  const storedResolutions = await vaults.storage.listBytes(
    vaults.realm,
    NAMESPACES.logicalResolution.key,
    vaultKey,
  );
  const resolutions: LogicalResolution[] = [];
  for (const item of storedResolutions) {
    const match = /^(?<kind>[1-5]):(?<logicalId>[0-9a-f]{64})$/u.exec(item.itemKey);
    if (match?.groups === undefined) {
      throw new TypeError("Logical Resolution storage key is invalid");
    }
    const kind = Number(match.groups.kind) as LogicalResolution["kind"];
    const logicalId = identifierFromStorageKey("VaultRecord", match.groups.logicalId as string);
    const plaintext = await openWrappedLocalState({
      wrappingKey: vault.installationWrappingKey,
      domain: "awsm.local.logical-resolution",
      vaultId,
      identity: logicalId,
      wrappedBytes: item.bytes,
    });
    try {
      const resolution = decodeLogicalResolution(plaintext);
      same(resolution.vaultId, vaultId, "Logical Resolution Vault ID");
      if (resolution.kind !== kind) {
        throw new TypeError("Logical Resolution kind does not match its storage key");
      }
      same(resolution.logicalId, logicalId, "Logical Resolution identity");
      resolutions.push(resolution);
    } finally {
      await wipe(plaintext);
    }
  }

  const compactItems: GarbageCollectionCompactItem[] = [];
  for (const descriptor of COMPACT_NAMESPACES) {
    const items = await vaults.storage.listBytes(vaults.realm, descriptor.namespace, vaultKey);
    for (const item of items) {
      compactItems.push({
        kind: descriptor.kind,
        logicalId: identifierFromStorageKey(descriptor.identifierKind, item.itemKey),
      });
    }
  }
  const epochSecretIds = (
    await vaults.storage.listBytes(vaults.realm, NAMESPACES.epochSecret.key, vaultKey)
  ).map(({ itemKey }) => identifierFromStorageKey("KeyEpoch", itemKey));

  return {
    resolutions: resolutions.toSorted(
      (left, right) => left.kind - right.kind || compareBytes(left.logicalId, right.logicalId),
    ),
    compactItems: compactItems.toSorted(
      (left, right) => left.kind - right.kind || compareBytes(left.logicalId, right.logicalId),
    ),
    epochSecretIds: epochSecretIds.toSorted(compareBytes),
  };
}
