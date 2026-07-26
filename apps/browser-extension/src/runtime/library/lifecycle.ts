import { encodeEncryptedEnvelope, encryptEnvelope } from "../../crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import { encodeCanonicalCbor } from "../../domain/cbor";
import type { LibraryItemV1 } from "../../domain/contracts";
import type { StoredEvent, StoredProjectionV1 } from "../../drivers/indexeddb/schema";
import type { VaultKeyring } from "../vault/keyring";

export interface PrepareLibraryStateChangeInput {
  readonly keyring: VaultKeyring;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly eventId: string;
  readonly timestamp: string;
  readonly operation: "Delete" | "Restore";
  readonly items: readonly LibraryItemV1[];
}

export interface PreparedLibraryStateChange {
  readonly event: StoredEvent;
  readonly projections: readonly StoredProjectionV1[];
}

export function selectLibraryItems(
  items: readonly LibraryItemV1[],
  bundleIds: readonly string[],
  expected: "Active" | "Deleted",
): readonly LibraryItemV1[] {
  const uniqueIds = [...new Set(bundleIds)].toSorted();
  if (uniqueIds.length === 0) throw new Error("A Library state change must name a capture.");
  if (uniqueIds.length !== bundleIds.length) throw new Error("Capture identifiers must be unique.");
  return uniqueIds.map((bundleId) => {
    const item = items.find((candidate) => candidate.bundleId === bundleId);
    if (item === undefined) throw new Error("A selected capture does not exist.");
    if (item.status !== expected) throw new Error(`Every capture must be ${expected}.`);
    return item;
  });
}

async function encryptBytes(
  input: PrepareLibraryStateChangeInput,
  domain: "vault:event:v1" | "vault:projection:v1",
  contextId: string,
  objectType: "Event" | "Projection",
  objectId: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const epoch = input.keyring.active();
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId: input.vaultId,
    keyEpochId: epoch.keyEpochId,
    domain,
    contextId,
    keyVersion: 1,
  });
  try {
    return encodeEncryptedEnvelope(
      await encryptEnvelope({
        objectType,
        objectId,
        keyEpochId: epoch.keyEpochId,
        plaintext,
        key,
      }),
    );
  } finally {
    await wipe(key);
  }
}

export async function prepareLibraryStateChange(
  input: PrepareLibraryStateChangeInput,
): Promise<PreparedLibraryStateChange> {
  if (input.items.length === 0) throw new Error("A Library state change must name a capture.");
  const expected = input.operation === "Delete" ? "Active" : "Deleted";
  const status = input.operation === "Delete" ? "Deleted" : "Active";
  const byId = new Map(input.items.map((item) => [item.bundleId, item]));
  if (byId.size !== input.items.length) throw new Error("Capture identifiers must be unique.");
  const items = [...byId.values()].toSorted((left, right) =>
    left.bundleId.localeCompare(right.bundleId),
  );
  if (items.some((item) => item.status !== expected)) {
    throw new Error(`Every capture must be ${expected} before ${input.operation}.`);
  }
  const eventType = input.operation === "Delete" ? "CapturesDeleted" : "CapturesRestored";
  const eventPlaintext = encodeCanonicalCbor({
    version: 1,
    eventType,
    eventVersion: 1,
    payloadVersion: 1,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    timestamp: input.timestamp,
    bundleIds: items.map((item) => item.bundleId),
  });
  const eventEnvelopeBytes = await encryptBytes(
    input,
    "vault:event:v1",
    input.eventId,
    "Event",
    input.eventId,
    eventPlaintext,
  );
  const projections = await Promise.all(
    items.map(async (item) => ({
      version: 1 as const,
      bundleId: item.bundleId,
      envelopeBytes: await encryptBytes(
        input,
        "vault:projection:v1",
        `LibraryItem-v1:${item.bundleId}`,
        "Projection",
        item.bundleId,
        encodeCanonicalCbor({ ...item, status }),
      ),
    })),
  );
  const objectId = items[0]?.descriptorObjectId;
  if (objectId === undefined) throw new Error("A Library state change must name an Object.");
  return {
    event: {
      version: 1,
      vaultId: input.vaultId,
      eventId: input.eventId,
      referencedObjectIds: items.map((item) => item.descriptorObjectId).toSorted(),
      orderingTimestamp: input.timestamp,
      envelopeBytes: eventEnvelopeBytes,
    },
    projections,
  };
}
