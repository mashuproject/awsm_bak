import { decodeEncryptedEnvelopeBytes, decryptEnvelope } from "../../crypto/envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import { type BundleDescriptorV1, decodeBundleDescriptor } from "../../domain/artifact-graph";
import { decodeCanonicalCbor } from "../../domain/cbor";
import { record } from "../../domain/validation";
import type {
  StoredArtifactObjectV1,
  StoredEvent,
  StoredObjectV1,
} from "../../drivers/indexeddb/schema";
import { decodeBundleRegisteredPayload, validateArtifactWarnings } from "../capture/contracts";
import type { VaultKeyring } from "../vault/keyring";
import { storageReliefError } from "./contracts";

interface CandidateRepository {
  listStoredEvents(): Promise<readonly StoredEvent[]>;
  getStoredObject(objectId: string): Promise<StoredObjectV1 | undefined>;
}

interface CandidateArtifactStore {
  has(vaultId: string, objectId: string): Promise<boolean>;
}

interface CandidateAvailability {
  isArtifactRemoteOnly(vaultId: string, artifactObjectId: string): Promise<boolean>;
}

export interface StorageReliefCandidate {
  readonly object: StoredArtifactObjectV1;
  readonly descriptorObjectId: string;
  readonly registrationEventId: string;
  readonly dependencyObjectIds: readonly string[];
}

export interface StorageReliefEstimate {
  readonly candidateArtifacts: number;
  readonly candidateBytes: number;
  readonly candidates: readonly StorageReliefCandidate[];
}

async function decryptEvent(
  event: StoredEvent,
  vaultId: string,
  keyring: VaultKeyring,
): Promise<Record<string, unknown>> {
  const envelope = decodeEncryptedEnvelopeBytes(event.envelopeBytes);
  const epoch = keyring.require(envelope.keyEpochId);
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:event:v1",
    contextId: event.eventId,
    keyVersion: 1,
  });
  try {
    if (envelope.objectId !== event.eventId || envelope.objectType !== "Event")
      throw new Error("Event envelope identity differs.");
    return record(
      decodeCanonicalCbor(await decryptEnvelope(envelope, key, epoch.keyEpochId)),
      "event",
    );
  } finally {
    await wipe(key);
  }
}

async function decryptDescriptor(
  object: Extract<StoredObjectV1, { objectType: "BundleDescriptor" }>,
  bundleId: string,
  vaultId: string,
  keyring: VaultKeyring,
): Promise<BundleDescriptorV1> {
  const envelope = decodeEncryptedEnvelopeBytes(object.envelopeBytes);
  const epoch = keyring.require(envelope.keyEpochId);
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:bundle-descriptor:v1",
    contextId: bundleId,
    keyVersion: 1,
  });
  try {
    if (envelope.objectId !== object.objectId || envelope.objectType !== "BundleDescriptor")
      throw new Error("Bundle Descriptor envelope identity differs.");
    return decodeBundleDescriptor(await decryptEnvelope(envelope, key, epoch.keyEpochId));
  } finally {
    await wipe(key);
  }
}

function addSafe(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value))
    throw storageReliefError("BUNDLE_INVALID", "Storage-relief byte total is unsafe.");
  return value;
}

export class StorageReliefCandidateEnumerator {
  constructor(
    private readonly repository: CandidateRepository,
    private readonly artifacts: CandidateArtifactStore,
    private readonly availability: CandidateAvailability,
  ) {}

  async enumerate(vaultId: string, keyring: VaultKeyring): Promise<StorageReliefEstimate> {
    try {
      const candidates: StorageReliefCandidate[] = [];
      let candidateBytes = 0;
      for (const event of await this.repository.listStoredEvents()) {
        if (event.vaultId !== vaultId) throw new Error("Event belongs to another Vault.");
        const payload = await decryptEvent(event, vaultId, keyring);
        if (payload.eventType !== "BundleRegistered") continue;
        const registration = decodeBundleRegisteredPayload(payload, event.referencedObjectIds);
        if (registration.vaultId !== vaultId) throw new Error("Registration belongs elsewhere.");
        const storedDescriptor = await this.repository.getStoredObject(
          registration.descriptorObjectId,
        );
        if (storedDescriptor?.objectType !== "BundleDescriptor")
          throw new Error("Bundle Descriptor is missing.");
        const descriptor = await decryptDescriptor(
          storedDescriptor,
          registration.bundleId,
          vaultId,
          keyring,
        );
        if (
          descriptor.bundleId !== registration.bundleId ||
          descriptor.artifacts.map((value) => value.artifactObjectId).join("\n") !==
            registration.artifactObjectIds.join("\n")
        )
          throw new Error("Bundle Descriptor closure differs from registration.");
        validateArtifactWarnings(
          descriptor.artifacts.map((value) => value.role),
          registration.warnings,
        );
        for (const reference of descriptor.artifacts) {
          if (reference.role !== "PRIMARY" && reference.role !== "SCREENSHOT_FULL") continue;
          const object = await this.repository.getStoredObject(reference.artifactObjectId);
          if (object?.objectType !== "Artifact") throw new Error("Artifact Object is missing.");
          if (await this.availability.isArtifactRemoteOnly(vaultId, object.objectId)) continue;
          if (!(await this.artifacts.has(vaultId, object.objectId)))
            throw new Error("Local Artifact wrapper is missing without availability state.");
          candidateBytes = addSafe(candidateBytes, object.envelopeByteLength);
          candidates.push({
            object,
            descriptorObjectId: storedDescriptor.objectId,
            registrationEventId: event.eventId,
            dependencyObjectIds: event.referencedObjectIds,
          });
        }
      }
      const ordered = candidates.toSorted((left, right) =>
        left.object.objectId.localeCompare(right.object.objectId),
      );
      return {
        candidateArtifacts: ordered.length,
        candidateBytes,
        candidates: ordered,
      };
    } catch (error) {
      if (error instanceof Error && "id" in error) throw error;
      throw storageReliefError(
        "BUNDLE_INVALID",
        "Storage-relief candidates could not be authenticated.",
      );
    }
  }
}
