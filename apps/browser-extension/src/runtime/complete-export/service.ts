import type { Identifier } from "../../domain/canonical/identifiers";
import {
  ARTIFACT_OBJECT,
  artifactId,
  decodeVaultObject,
  type VaultObject,
} from "../../domain/canonical/object";
import {
  type AuthenticatedVaultEvent,
  decodeVaultBaseline,
  decodeVaultEvent,
  type VaultBaseline,
} from "../../domain/canonical/record";
import { decodeCanonicalValue } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import { identifierStorageKey } from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import { decodeOpaqueEnvelope } from "../../storage/opaque-envelope";
import type { CanonicalArtifactStore } from "../artifact/canonical-store";
import { verifyCanonicalArtifactRepresentation } from "../artifact/canonical-verify";
import type { CanonicalReplayService } from "../projection/canonical-replay";
import type { PersistedOpenedCanonicalVault } from "../vault/canonical-service";
import {
  type CompleteExportEntry,
  prepareCompleteExportEntry,
  sealCompleteExportStream,
  sequenceCompleteExportEntries,
} from "./container";
import {
  type CompleteExportManifest,
  type CompleteExportOpaqueItem,
  completeExportStateDigest,
  decodeCompleteExportManifest,
  encodeCompleteExportKeyInventory,
  encodeCompleteExportManifest,
} from "./contracts";
import { collectCompleteExportReachability } from "./reachability";

interface ResolvedRecord {
  readonly value: AuthenticatedVaultEvent | VaultBaseline;
  readonly bytes: Uint8Array;
  readonly keyEpochId: Identifier<"KeyEpoch">;
}

interface ResolvedObject {
  readonly value: VaultObject;
  readonly bytes: Uint8Array;
  readonly keyEpochId: Identifier<"KeyEpoch">;
}

interface PreparedOpaqueEntry {
  readonly inventory: CompleteExportOpaqueItem;
  readonly entry: CompleteExportEntry;
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function decodeRecord(bytes: Uint8Array): AuthenticatedVaultEvent | VaultBaseline {
  const value = decodeCanonicalValue(bytes);
  if (!(value instanceof Map)) throw new TypeError("Complete Export Record is not a map");
  const kind = value.get(6);
  if (kind === 1) return decodeVaultEvent(bytes);
  if (kind === 2) return decodeVaultBaseline(bytes);
  throw new TypeError("Complete Export Record kind is unsupported");
}

function preparedCompactEntry(input: {
  readonly namespace: CompleteExportOpaqueItem["namespace"];
  readonly logicalId: Uint8Array;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly bytes: Uint8Array;
  readonly expectedStorageItemId?: Identifier<"StorageItem">;
}): PreparedOpaqueEntry {
  const entry = prepareCompleteExportEntry(2, input.bytes);
  const storageItemId = decodeOpaqueEnvelope(input.bytes).storageItemId;
  same(entry.header.entryId, storageItemId, "Complete Export Opaque Entry ID");
  if (input.expectedStorageItemId !== undefined) {
    same(storageItemId, input.expectedStorageItemId, "Complete Export resolution Storage Item ID");
  }
  return {
    inventory: {
      namespace: input.namespace,
      logicalId: Uint8Array.from(input.logicalId),
      storageItemId,
      keyEpochId: input.keyEpochId,
      byteLength: entry.header.byteLength,
      byteDigest: entry.header.byteDigest,
    },
    entry,
  };
}

async function* readable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
        throw new TypeError("Complete Export Artifact source chunks must contain bytes");
      }
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

export class CanonicalCompleteExportService {
  constructor(
    readonly replays: CanonicalReplayService,
    readonly artifacts: CanonicalArtifactStore,
  ) {}

  async export(input: {
    readonly vaultId: Identifier<"Vault">;
    readonly passphrase: string;
    readonly salt: Uint8Array;
    readonly nonce: Uint8Array;
    readonly write: (bytes: Uint8Array) => Promise<void>;
  }): Promise<{
    readonly manifest: CompleteExportManifest;
    readonly opaqueItemCount: number;
    readonly frameCount: number;
  }> {
    const replay = await this.replays.replay(input.vaultId);
    const vault = replay.vault;
    same(vault.replicaState.vaultId, input.vaultId, "Complete Export Vault ID");
    const recordCache = new Map<string, ResolvedRecord>();
    const objectCache = new Map<string, ResolvedObject>();
    const featureCache = new Map<
      string,
      {
        readonly payloadBytes: Uint8Array;
        readonly bytes: Uint8Array;
        readonly keyEpochId: Identifier<"KeyEpoch">;
      }
    >();
    const loadRecord = async (
      id: Identifier<"VaultRecord">,
    ): Promise<AuthenticatedVaultEvent | VaultBaseline | undefined> => {
      const itemKey = key(id);
      const cached = recordCache.get(itemKey);
      if (cached !== undefined) return cached.value;
      const opened = await this.replays.vaults.openResolvedCompactItem({
        vault,
        kind: 1,
        logicalId: id,
        namespace: NAMESPACES.vaultRecord.key,
        payloadType: 1,
      });
      const value = decodeRecord(opened.payloadBytes);
      same(value.recordId, id, "Complete Export Record ID");
      recordCache.set(itemKey, {
        value,
        bytes: opened.envelope.bytes,
        keyEpochId: opened.keyEpochId,
      });
      return value;
    };
    const loadObject = async (id: Identifier<"VaultObject">): Promise<VaultObject | undefined> => {
      const itemKey = key(id);
      const cached = objectCache.get(itemKey);
      if (cached !== undefined) return cached.value;
      const opened = await this.replays.vaults.openResolvedCompactItem({
        vault,
        kind: 3,
        logicalId: id,
        namespace: NAMESPACES.vaultObject.key,
        payloadType: 2,
      });
      const value = decodeVaultObject(opened.payloadBytes);
      same(value.objectId, id, "Complete Export Vault Object ID");
      objectCache.set(itemKey, {
        value,
        bytes: opened.envelope.bytes,
        keyEpochId: opened.keyEpochId,
      });
      return value;
    };
    const loadFeatureManifest = async (
      id: Identifier<"FeatureManifest">,
    ): Promise<Uint8Array | undefined> => {
      const itemKey = key(id);
      const cached = featureCache.get(itemKey);
      if (cached !== undefined) return cached.payloadBytes;
      const opened = await this.replays.vaults.openResolvedCompactItem({
        vault,
        kind: 4,
        logicalId: id,
        namespace: NAMESPACES.featureManifest.key,
        payloadType: 3,
      });
      featureCache.set(itemKey, {
        payloadBytes: opened.payloadBytes,
        bytes: opened.envelope.bytes,
        keyEpochId: opened.keyEpochId,
      });
      return opened.payloadBytes;
    };
    const reachability = await collectCompleteExportReachability({
      vaultId: vault.replicaState.vaultId,
      generationId: vault.replicaState.generationId,
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      baselineId: vault.replicaState.baselineId,
      causalFrontier: vault.replicaState.causalFrontier,
      authorityFrontier: vault.replicaState.authorityFrontier,
      loadRecord,
      loadObject,
      loadFeatureManifest,
    });
    const opaqueEntries: PreparedOpaqueEntry[] = [];
    for (const id of reachability.recordIds) {
      const resolved = recordCache.get(key(id));
      if (resolved === undefined) throw new TypeError("Reachable Record cache is incomplete");
      opaqueEntries.push(preparedCompactEntry({ namespace: 1, logicalId: id, ...resolved }));
    }
    for (const id of reachability.vaultObjectIds) {
      const resolved = objectCache.get(key(id));
      if (resolved === undefined) throw new TypeError("Reachable Object cache is incomplete");
      opaqueEntries.push(preparedCompactEntry({ namespace: 3, logicalId: id, ...resolved }));
    }
    for (const id of reachability.featureManifestIds) {
      const resolved = featureCache.get(key(id));
      if (resolved === undefined) throw new TypeError("Reachable Feature cache is incomplete");
      opaqueEntries.push(preparedCompactEntry({ namespace: 4, logicalId: id, ...resolved }));
    }
    for (const id of reachability.keyEnvelopeIds) {
      opaqueEntries.push(await this.prepareKeyEnvelope(vault, id));
    }
    for (const id of reachability.artifactIds) {
      const sourceObject = [...objectCache.values()].find(
        ({ value }) => value.objectType === ARTIFACT_OBJECT && bytesEqual(artifactId(value), id),
      );
      if (sourceObject === undefined) {
        throw new TypeError("Reachable Artifact Object cache is incomplete");
      }
      opaqueEntries.push(await this.prepareArtifact(vault, id, sourceObject.value));
    }
    opaqueEntries.sort((left, right) =>
      compareBytes(left.inventory.storageItemId, right.inventory.storageItemId),
    );
    const manifestInput = {
      vaultId: vault.replicaState.vaultId,
      generationId: vault.replicaState.generationId,
      frontier: vault.replicaState.causalFrontier,
      requiredFeatureSetId: vault.replicaState.requiredFeatureSetId,
      typedLogicalRoots: reachability.typedLogicalRoots,
      opaqueItemInventory: opaqueEntries.map(({ inventory }) => inventory),
      continuityProofRoots: vault.replicaState.authorityFrontier,
    } as const;
    const preparedManifest: CompleteExportManifest = {
      format: 1,
      ...manifestInput,
      stateDigest: completeExportStateDigest(manifestInput),
    };
    const manifestBytes = encodeCompleteExportManifest(preparedManifest);
    const manifest = decodeCompleteExportManifest(manifestBytes);
    const manifestEntry = prepareCompleteExportEntry(1, manifestBytes);
    const keyInventoryEntry = prepareCompleteExportEntry(
      3,
      encodeCompleteExportKeyInventory({
        vaultId: vault.replicaState.vaultId,
        generationId: vault.replicaState.generationId,
        entries: [
          {
            keyEpochId: vault.epochSecret.keyEpochId,
            keyEpochKey: vault.epochSecret.key,
          },
        ],
      }),
    );
    const encrypted = await sealCompleteExportStream({
      passphrase: input.passphrase,
      salt: input.salt,
      nonce: input.nonce,
      plaintext: sequenceCompleteExportEntries([
        manifestEntry,
        ...opaqueEntries.map(({ entry }) => entry),
        keyInventoryEntry,
      ]),
      write: input.write,
    });
    return {
      manifest,
      opaqueItemCount: opaqueEntries.length,
      frameCount: encrypted.frameCount,
    };
  }

  private async prepareKeyEnvelope(
    vault: PersistedOpenedCanonicalVault,
    id: Identifier<"KeyEnvelope">,
  ): Promise<PreparedOpaqueEntry> {
    const resolution = await this.replays.vaults.readLogicalResolution({
      vault,
      kind: 2,
      logicalId: id,
    });
    if (resolution.availability !== 1) {
      throw new TypeError("Complete Export Key Envelope is not verified locally");
    }
    same(resolution.keyEpochId, vault.epochSecret.keyEpochId, "Key Envelope readable Epoch");
    const bytes = await this.replays.vaults.storage.getBytes(this.replays.vaults.realm, {
      namespace: NAMESPACES.keyEnvelope.key,
      scopeKey: identifierStorageKey(vault.replicaState.vaultId),
      itemKey: identifierStorageKey(id),
    });
    if (bytes === undefined) throw new TypeError("A reachable Key Envelope is unavailable");
    return preparedCompactEntry({
      namespace: 2,
      logicalId: id,
      keyEpochId: resolution.keyEpochId,
      bytes,
      expectedStorageItemId: resolution.storageItemId,
    });
  }

  private async prepareArtifact(
    vault: PersistedOpenedCanonicalVault,
    id: Identifier<"Artifact">,
    object: VaultObject,
  ): Promise<PreparedOpaqueEntry> {
    const resolution = await this.replays.vaults.readLogicalResolution({
      vault,
      kind: 5,
      logicalId: id,
    });
    if (resolution.availability !== 1) {
      throw new TypeError("Complete Export Artifact wrapper is not verified locally");
    }
    same(resolution.keyEpochId, vault.epochSecret.keyEpochId, "Artifact readable Epoch");
    const verified = await verifyCanonicalArtifactRepresentation({
      store: this.artifacts,
      storageItemId: resolution.storageItemId,
      object,
      keyEpochId: resolution.keyEpochId,
      keyEpochKey: vault.epochSecret.key,
      writePlaintext: async () => undefined,
    });
    const artifactStore = this.artifacts;
    return {
      inventory: {
        namespace: 5,
        logicalId: id,
        storageItemId: resolution.storageItemId,
        keyEpochId: resolution.keyEpochId,
        byteLength: verified.byteLength,
        byteDigest: verified.byteDigest,
      },
      entry: {
        header: {
          kind: 2,
          entryId: resolution.storageItemId,
          byteLength: verified.byteLength,
          byteDigest: verified.byteDigest,
        },
        bytes: {
          async *[Symbol.asyncIterator]() {
            yield* readable(await artifactStore.open(resolution.storageItemId));
          },
        },
      },
    };
  }
}
