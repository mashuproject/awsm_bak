import {
  decodeEncryptedEnvelopeBytes,
  decryptEnvelope,
  encodeEncryptedEnvelope,
  encryptEnvelope,
} from "../../crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import { decodeCanonicalCbor, encodeCanonicalCbor } from "../../domain/cbor";
import { canonicalRecord, literal, timestamp, uuid } from "../../domain/validation";
import type { StoredEvent, StoredVaultNameProjectionV1 } from "../../drivers/indexeddb/schema";
import type { VaultKeyring } from "./keyring";
import { InvalidVaultNameError, normalizeVaultName } from "./name";
import type { VaultNameEventV1, VaultNameProjectionV1 } from "./name-projection";

export interface PrepareVaultNameChangeInput {
  readonly keyring: VaultKeyring;
  readonly eventType: "VaultCreated" | "VaultRenamed";
  readonly vaultId: string;
  readonly deviceId: string;
  readonly eventId: string;
  readonly timestamp: string;
  readonly name: string;
}

async function crypt(
  keyring: VaultKeyring,
  vaultId: string,
  domain: "vault:event:v1" | "vault:projection:v1",
  contextId: string,
  objectType: "Event" | "Projection",
  objectId: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const epoch = keyring.active();
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId,
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

export async function prepareVaultNameChange(input: PrepareVaultNameChangeInput): Promise<{
  readonly event: StoredEvent;
  readonly projection: StoredVaultNameProjectionV1;
}> {
  const normalized = normalizeVaultName(input.name);
  if (normalized !== input.name) {
    throw new InvalidVaultNameError("Vault names must already be canonically normalized.");
  }
  uuid(input.vaultId, "vaultNameEvent.vaultId");
  uuid(input.deviceId, "vaultNameEvent.deviceId");
  uuid(input.eventId, "vaultNameEvent.eventId");
  timestamp(input.timestamp, "vaultNameEvent.timestamp");
  const projection: VaultNameProjectionV1 = {
    version: 1,
    vaultId: input.vaultId,
    name: normalized,
    sourceEventId: input.eventId,
    updatedAt: input.timestamp,
  };
  const eventPlaintext = encodeCanonicalCbor({
    version: 1,
    eventType: input.eventType,
    eventVersion: 1,
    payloadVersion: 1,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    timestamp: input.timestamp,
    protocolVersion: 1,
    name: normalized,
  });
  const [eventEnvelopeBytes, projectionEnvelopeBytes] = await Promise.all([
    crypt(
      input.keyring,
      input.vaultId,
      "vault:event:v1",
      input.eventId,
      "Event",
      input.eventId,
      eventPlaintext,
    ),
    crypt(
      input.keyring,
      input.vaultId,
      "vault:projection:v1",
      `VaultName-v1:${input.vaultId}`,
      "Projection",
      input.vaultId,
      encodeCanonicalCbor(projection),
    ),
  ]);
  return {
    event: {
      version: 1,
      vaultId: input.vaultId,
      eventId: input.eventId,
      referencedObjectIds: [],
      orderingTimestamp: input.timestamp,
      envelopeBytes: eventEnvelopeBytes,
    },
    projection: {
      version: 1,
      vaultId: input.vaultId,
      sourceEventId: input.eventId,
      envelopeBytes: projectionEnvelopeBytes,
    },
  };
}

export async function encryptVaultNameProjection(
  keyring: VaultKeyring,
  projection: VaultNameProjectionV1,
): Promise<StoredVaultNameProjectionV1> {
  const name = normalizeVaultName(projection.name);
  if (name !== projection.name) {
    throw new InvalidVaultNameError("Vault Name Projections require a canonical name.");
  }
  uuid(projection.vaultId, "vaultNameProjection.vaultId");
  uuid(projection.sourceEventId, "vaultNameProjection.sourceEventId");
  timestamp(projection.updatedAt, "vaultNameProjection.updatedAt");
  return {
    version: 1,
    vaultId: projection.vaultId,
    sourceEventId: projection.sourceEventId,
    envelopeBytes: await crypt(
      keyring,
      projection.vaultId,
      "vault:projection:v1",
      `VaultName-v1:${projection.vaultId}`,
      "Projection",
      projection.vaultId,
      encodeCanonicalCbor(projection),
    ),
  };
}

export async function decodeVaultNameEvent(
  keyring: VaultKeyring,
  stored: StoredEvent,
): Promise<VaultNameEventV1> {
  const envelope = decodeEncryptedEnvelopeBytes(stored.envelopeBytes);
  const epoch = keyring.require(envelope.keyEpochId);
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId: stored.vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:event:v1",
    contextId: stored.eventId,
    keyVersion: 1,
  });
  try {
    if (envelope.objectType !== "Event" || envelope.objectId !== stored.eventId)
      throw new Error("Vault name Event envelope mismatch.");
    const input = canonicalRecord(
      decodeCanonicalCbor(await decryptEnvelope(envelope, key, epoch.keyEpochId)),
      "vaultNameEvent",
      [
        "version",
        "eventType",
        "eventVersion",
        "payloadVersion",
        "vaultId",
        "deviceId",
        "timestamp",
        "protocolVersion",
        "name",
      ],
    );
    literal(input.version, 1, "vaultNameEvent.version");
    const eventType = input.eventType;
    if (eventType !== "VaultCreated" && eventType !== "VaultRenamed")
      throw new Error("Not a Vault name Event.");
    literal(input.eventVersion, 1, "vaultNameEvent.eventVersion");
    literal(input.payloadVersion, 1, "vaultNameEvent.payloadVersion");
    literal(input.protocolVersion, 1, "vaultNameEvent.protocolVersion");
    const vaultId = uuid(input.vaultId, "vaultNameEvent.vaultId");
    if (vaultId !== stored.vaultId) throw new Error("Vault name Event belongs to another Vault.");
    const orderingTimestamp = timestamp(input.timestamp, "vaultNameEvent.timestamp");
    if (orderingTimestamp !== stored.orderingTimestamp)
      throw new Error("Vault name Event timestamp mismatch.");
    const name =
      typeof input.name === "string" ? normalizeVaultName(input.name) : normalizeVaultName("");
    if (name !== input.name) throw new Error("Vault name Event is not canonical.");
    return {
      version: 1,
      eventId: stored.eventId,
      eventType,
      vaultId,
      deviceId: uuid(input.deviceId, "vaultNameEvent.deviceId"),
      name,
      orderingTimestamp,
    };
  } finally {
    await wipe(key);
  }
}

export async function decryptVaultNameProjection(
  keyring: VaultKeyring,
  stored: StoredVaultNameProjectionV1,
): Promise<VaultNameProjectionV1> {
  const envelope = decodeEncryptedEnvelopeBytes(stored.envelopeBytes);
  const epoch = keyring.require(envelope.keyEpochId);
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId: stored.vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:projection:v1",
    contextId: `VaultName-v1:${stored.vaultId}`,
    keyVersion: 1,
  });
  try {
    if (envelope.objectType !== "Projection" || envelope.objectId !== stored.vaultId)
      throw new Error("Vault Name Projection envelope mismatch.");
    const input = canonicalRecord(
      decodeCanonicalCbor(await decryptEnvelope(envelope, key, epoch.keyEpochId)),
      "vaultNameProjection",
      ["version", "vaultId", "name", "sourceEventId", "updatedAt"],
    );
    const result: VaultNameProjectionV1 = {
      version: literal(input.version, 1, "vaultNameProjection.version"),
      vaultId: uuid(input.vaultId, "vaultNameProjection.vaultId"),
      name:
        typeof input.name === "string" ? normalizeVaultName(input.name) : normalizeVaultName(""),
      sourceEventId: uuid(input.sourceEventId, "vaultNameProjection.sourceEventId"),
      updatedAt: timestamp(input.updatedAt, "vaultNameProjection.updatedAt"),
    };
    if (result.vaultId !== stored.vaultId || result.sourceEventId !== stored.sourceEventId)
      throw new Error("Vault Name Projection metadata mismatch.");
    return result;
  } finally {
    await wipe(key);
  }
}
