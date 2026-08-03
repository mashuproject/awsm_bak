import { sha256 } from "@noble/hashes/sha2.js";

import { type CompactPayloadType, openCompactItem } from "../../crypto/compact";
import { wipe } from "../../crypto/sodium";
import { DEPENDENCY_TYPES, type TypedDependency } from "../../domain/canonical/dependencies";
import { decodeFeatureManifest, featureManifestId } from "../../domain/canonical/features";
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
  verifyVaultEventSignature,
} from "../../domain/canonical/record";
import { exactMap, identifierValue, mapValue, oneOfCodes } from "../../domain/canonical/schema";
import { decodeCanonicalValue } from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import {
  COMPACT_STORAGE_CLASS,
  decodeOpaqueEnvelope,
  PORTABLE_COMPACT_CEILING,
} from "../../storage/opaque-envelope";
import type { CanonicalArtifactStore } from "../artifact/canonical-store";
import { verifyCanonicalArtifactRepresentation } from "../artifact/canonical-verify";
import {
  type CompleteExportKeyInventory,
  type CompleteExportManifest,
  type CompleteExportOpaqueItem,
  decodeCompleteExportKeyInventory,
  decodeCompleteExportManifest,
  encodeCompleteExportKeyInventory,
  encodeCompleteExportManifest,
} from "../complete-export/contracts";
import {
  type CompleteExportReachability,
  collectCompleteExportReachability,
} from "../complete-export/reachability";
import { decodeCanonicalAuthorityCheckpoint } from "../projection/canonical-authority-checkpoint";
import {
  type CanonicalAuthorityFeatureManifest,
  type CanonicalAuthorityKeyEnvelopeSlot,
  CanonicalAuthorityReplay,
  type CanonicalAuthorityState,
} from "../projection/canonical-authority-replay";
import type { CanonicalReplicaState } from "../vault/canonical-local-state";
import {
  baselineVaultLabel,
  initialVaultClientAuthority,
  validateCurrentVaultAuthority,
} from "../vault/canonical-open";

const MAX_COMPACT_ENVELOPE_LENGTH = PORTABLE_COMPACT_CEILING + 4096 + 12;

type VaultRecord = AuthenticatedVaultEvent | VaultBaseline;

export interface CompleteImportPreparedSource {
  readonly openOpaque: (item: CompleteExportOpaqueItem) => Promise<ReadableStream<Uint8Array>>;
}

export interface ValidatedCompleteExportSemantics {
  readonly manifest: CompleteExportManifest;
  readonly keyInventory: CompleteExportKeyInventory;
  readonly reachability: CompleteExportReachability;
  readonly replicaState: CanonicalReplicaState;
  readonly baseline: VaultBaseline;
  readonly genesis: AuthenticatedVaultEvent;
  readonly events: readonly AuthenticatedVaultEvent[];
  readonly vaultLabel: string | null;
  readonly keyEpochs: readonly {
    readonly keyEpochId: Identifier<"KeyEpoch">;
    readonly displayNumber: number;
  }[];
  readonly activeClientCredentials: readonly {
    readonly clientCredentialId: Identifier<"ClientCredential">;
    readonly memberId: Identifier<"Member">;
  }[];
  readonly effectiveRecoveryCredentials: readonly {
    readonly recoveryCredentialId: Identifier<"RecoveryCredential">;
    readonly memberId: Identifier<"Member">;
    readonly revision: number;
    readonly signingPublicKey: Uint8Array;
    readonly wrappingPublicKey: Uint8Array;
  }[];
  readonly keyEnvelopeSlots: readonly CanonicalAuthorityKeyEnvelopeSlot[];
  readonly authority: CanonicalAuthorityState;
}

function key(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

export async function readCompleteImportCompactBytes(
  source: CompleteImportPreparedSource,
  item: CompleteExportOpaqueItem,
): Promise<Uint8Array> {
  if (item.byteLength > MAX_COMPACT_ENVELOPE_LENGTH) {
    throw new TypeError("Complete Import Compact item exceeds the portable bound");
  }
  const reader = (await source.openOpaque(item)).getReader();
  const result = new Uint8Array(item.byteLength);
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
        throw new TypeError("Prepared Opaque chunks must contain bytes");
      }
      if (offset + next.value.byteLength > result.byteLength) {
        throw new TypeError("Prepared Opaque item exceeds its declared length");
      }
      result.set(next.value, offset);
      offset += next.value.byteLength;
    }
    if (offset !== result.byteLength) {
      throw new TypeError("Prepared Opaque item ended before its declared length");
    }
    return result;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function decodeRecord(bytes: Uint8Array): VaultRecord {
  const value = decodeCanonicalValue(bytes);
  if (!(value instanceof Map)) throw new TypeError("Complete Import Record is not a map");
  if (value.get(6) === 1) return decodeVaultEvent(bytes);
  if (value.get(6) === 2) return decodeVaultBaseline(bytes);
  throw new TypeError("Complete Import Record kind is unsupported");
}

function expectedPayloadType(namespace: 1 | 3 | 4): CompactPayloadType {
  return namespace === 1 ? 1 : namespace === 3 ? 2 : 3;
}

function dependencyKey(value: TypedDependency): string {
  return `${value.type}:${key(value.id)}`;
}

function requireExactDependencies(
  actual: readonly TypedDependency[],
  expected: readonly TypedDependency[],
): void {
  const actualKeys = new Set(actual.map(dependencyKey));
  const expectedKeys = new Set(expected.map(dependencyKey));
  if (
    actualKeys.size !== expectedKeys.size ||
    [...actualKeys].some((candidate) => !expectedKeys.has(candidate))
  ) {
    throw new TypeError("Complete Export logical roots disagree with reachable state");
  }
}

function reachableInventoryKeys(reachability: CompleteExportReachability): Set<string> {
  return new Set([
    ...reachability.recordIds.map((id) => `1:${key(id)}`),
    ...reachability.keyEnvelopeIds.map((id) => `2:${key(id)}`),
    ...reachability.vaultObjectIds.map((id) => `3:${key(id)}`),
    ...reachability.featureManifestIds.map((id) => `4:${key(id)}`),
    ...reachability.artifactIds.map((id) => `5:${key(id)}`),
  ]);
}

async function validateSelectedEventAuthority(input: {
  readonly manifest: CompleteExportManifest;
  readonly baseline: VaultBaseline;
  readonly genesis: AuthenticatedVaultEvent;
  readonly records: ReadonlyMap<string, VaultRecord>;
  readonly features: ReadonlyMap<string, Uint8Array>;
  readonly epochKeys: ReadonlyMap<string, Uint8Array>;
  readonly keyEnvelopes: ReadonlyMap<
    string,
    { readonly item: CompleteExportOpaqueItem; readonly bytes: Uint8Array }
  >;
}): Promise<{
  readonly replicaState: CanonicalReplicaState;
  readonly keyEpochs: readonly {
    readonly keyEpochId: Identifier<"KeyEpoch">;
    readonly displayNumber: number;
  }[];
  readonly activeClientCredentials: readonly {
    readonly clientCredentialId: Identifier<"ClientCredential">;
    readonly memberId: Identifier<"Member">;
  }[];
  readonly effectiveRecoveryCredentials: readonly {
    readonly recoveryCredentialId: Identifier<"RecoveryCredential">;
    readonly memberId: Identifier<"Member">;
    readonly revision: number;
    readonly signingPublicKey: Uint8Array;
    readonly wrappingPublicKey: Uint8Array;
  }[];
  readonly keyEnvelopeSlots: readonly CanonicalAuthorityKeyEnvelopeSlot[];
  readonly authority: CanonicalAuthorityState;
}> {
  const baselineBody = exactMap(
    input.baseline.body,
    [0, 1, 2, 3, 4, 5],
    "Complete Import Baseline body",
  );
  const baselineKind = oneOfCodes(
    mapValue(baselineBody, 1),
    [1, 2] as const,
    "Complete Import Baseline kind",
  );
  const lifecycleBody = exactMap(
    mapValue(baselineBody, 4),
    [0],
    "Complete Import Baseline lifecycle checkpoint",
  );
  const lifecycle = oneOfCodes(
    mapValue(lifecycleBody, 0),
    [1, 2] as const,
    "Complete Import Baseline lifecycle",
  );
  const featureManifests: CanonicalAuthorityFeatureManifest[] = input.baseline.dependencies
    .filter(({ type }) => type === DEPENDENCY_TYPES.FeatureManifest)
    .map(({ id }) => {
      const bytes = input.features.get(key(id));
      if (bytes === undefined) {
        throw new TypeError("Complete Import Baseline Feature Manifest is unavailable");
      }
      return {
        id: id as Identifier<"FeatureManifest">,
        bytes,
        manifest: decodeFeatureManifest(bytes),
      };
    });
  const anchorAuthority = decodeCanonicalAuthorityCheckpoint({
    vaultId: input.manifest.vaultId,
    checkpoint: mapValue(baselineBody, 3),
    requiredFeatureSetId: input.baseline.requiredFeatureSetId,
    featureManifests,
    lifecycle,
  });
  let anchorRecordId = input.genesis.recordId;
  if (baselineKind === 2) {
    const candidates = [...input.records.values()].filter(
      (record): record is AuthenticatedVaultEvent => {
        if (!("family" in record) || record.family !== 3 || record.type !== 1) return false;
        const body = exactMap(record.body, [...Array(7).keys()], "Complete Import Vacuum body");
        return bytesEqual(
          identifierValue(
            mapValue(body, 3),
            "VaultRecord",
            "Complete Import Vacuum successor Baseline ID",
          ),
          input.baseline.recordId,
        );
      },
    );
    if (candidates.length !== 1 || candidates[0] === undefined) {
      throw new TypeError("Complete Import successor Baseline has no unique Vacuum anchor");
    }
    anchorRecordId = candidates[0].recordId;
  }
  const replay = new CanonicalAuthorityReplay(
    input.genesis,
    anchorRecordId,
    anchorAuthority,
    [...input.features.values()].map(featureManifestId),
  );
  const accepted = new Set([key(anchorRecordId)]);
  if (baselineKind === 2) accepted.add(key(input.baseline.recordId));
  const visiting = new Set<string>();
  const visit = async (recordId: Identifier<"VaultRecord">): Promise<void> => {
    const recordKey = key(recordId);
    if (accepted.has(recordKey)) return;
    if (visiting.has(recordKey)) throw new TypeError("Complete Import Event DAG contains a cycle");
    const record = input.records.get(recordKey);
    if (record === undefined || !("family" in record)) {
      throw new TypeError("Complete Import Event DAG references a non-Event Record");
    }
    if (
      !bytesEqual(record.vaultId, input.manifest.vaultId) ||
      !bytesEqual(record.generationId, input.manifest.generationId)
    ) {
      throw new TypeError("Complete Import Event belongs to another selected context");
    }
    visiting.add(recordKey);
    for (const parentId of record.parentRecordIds) await visit(parentId);
    if (record.family === 1 && record.type === 1) {
      if (!bytesEqual(record.recordId, input.genesis.recordId)) {
        throw new TypeError("Complete Import Event DAG contains another Genesis");
      }
    } else {
      await replay.validateAndAccept(record);
    }
    visiting.delete(recordKey);
    accepted.add(recordKey);
  };
  for (const recordId of input.manifest.frontier) await visit(recordId);
  for (const recordId of input.manifest.continuityProofRoots) await visit(recordId);
  const authority = replay.stateAt(input.manifest.continuityProofRoots);
  same(
    authority.requiredFeatureSetId,
    input.manifest.requiredFeatureSetId,
    "Complete Import Required Feature Set",
  );
  const currentEpoch = authority.keyEpochs.find(({ current }) => current);
  if (currentEpoch === undefined) {
    throw new TypeError("Complete Import authority has no current Key Epoch");
  }
  const currentEpochKey = input.epochKeys.get(key(currentEpoch.keyEpochId));
  if (currentEpochKey === undefined) {
    throw new TypeError("Complete Import omits a current Key Epoch Key");
  }
  const keyEpochs = [...input.epochKeys.keys()].map((epochKey) => {
    const authenticated = authority.keyEpochs.find(
      ({ keyEpochId }) => key(keyEpochId) === epochKey,
    );
    if (authenticated === undefined) {
      throw new TypeError("Complete Import Key Epoch is not authenticated by Authority State");
    }
    return {
      keyEpochId: authenticated.keyEpochId,
      displayNumber: authenticated.displayNumber,
    };
  });
  const continuityEvents = new Map<string, AuthenticatedVaultEvent>();
  const continuityVisiting = new Set<string>();
  const visitContinuity = (recordId: Identifier<"VaultRecord">): void => {
    const recordKey = key(recordId);
    if (continuityEvents.has(recordKey)) return;
    if (continuityVisiting.has(recordKey)) {
      throw new TypeError("Complete Import Continuity Proof contains a cycle");
    }
    const record = input.records.get(recordKey);
    if (record === undefined || !("family" in record)) {
      throw new TypeError("Complete Import Continuity Proof references a non-Event Record");
    }
    continuityVisiting.add(recordKey);
    for (const parentId of record.authorityParentRecordIds) visitContinuity(parentId);
    continuityVisiting.delete(recordKey);
    continuityEvents.set(recordKey, record);
  };
  for (const recordId of input.manifest.continuityProofRoots) visitContinuity(recordId);
  const replicaState: CanonicalReplicaState = {
    vaultId: input.manifest.vaultId,
    generationId: input.manifest.generationId,
    causalFrontier: input.manifest.frontier,
    authorityFrontier: input.manifest.continuityProofRoots,
    continuityRecordIds: [...continuityEvents.values()].map(({ recordId }) => recordId),
    baselineId: input.baseline.recordId,
    currentKeyEpochId: currentEpoch.keyEpochId,
    requiredFeatureSetId: authority.requiredFeatureSetId,
    authoringClientCredentialId: null,
    memberId: null,
    lifecycle: authority.lifecycle,
    preservationRoots: [],
    garbageCollectionFences: [],
    adoption: baselineKind === 1 ? null : { vacuumEventRecordId: anchorRecordId },
  };
  await validateCurrentVaultAuthority({
    baseline: input.baseline,
    genesis: input.genesis,
    continuityEvents: [...continuityEvents.values()],
    replicaState,
    clientSecret: null,
    epochSecret: {
      vaultId: input.manifest.vaultId,
      keyEpochId: currentEpoch.keyEpochId,
      displayNumber: currentEpoch.displayNumber,
      key: currentEpochKey,
    },
    dependencyResolver: {
      resolveKeyEnvelope: async ({ keyEnvelopeId, keyEpochId }) => {
        const resolved = input.keyEnvelopes.get(key(keyEnvelopeId));
        if (resolved === undefined) {
          throw new TypeError("Complete Import Key Envelope dependency is unavailable");
        }
        same(resolved.item.keyEpochId, keyEpochId, "Complete Import Key Envelope Epoch");
        return resolved.bytes;
      },
      resolveFeatureManifest: async ({ featureManifestId: id }) => {
        const bytes = input.features.get(key(id));
        if (bytes === undefined) {
          throw new TypeError("Complete Import Feature Manifest dependency is unavailable");
        }
        return bytes;
      },
    },
  });
  return {
    replicaState,
    keyEpochs,
    activeClientCredentials: [...authority.clientCredentials.values()]
      .filter(({ active }) => active)
      .map(({ clientCredentialId, memberId }) => ({ clientCredentialId, memberId })),
    effectiveRecoveryCredentials: authority.recoveryCredentials
      .filter(({ effective }) => effective)
      .map(({ recoveryCredentialId, memberId, revision, signingPublicKey, wrappingPublicKey }) => ({
        recoveryCredentialId,
        memberId,
        revision,
        signingPublicKey: Uint8Array.from(signingPublicKey),
        wrappingPublicKey: Uint8Array.from(wrappingPublicKey),
      })),
    keyEnvelopeSlots: authority.keyEnvelopeSlots,
    authority,
  };
}

export async function validateCompleteExportSemantics(input: {
  readonly manifest: CompleteExportManifest;
  readonly keyInventory: CompleteExportKeyInventory;
  readonly source: CompleteImportPreparedSource;
}): Promise<ValidatedCompleteExportSemantics> {
  const manifest = decodeCompleteExportManifest(encodeCompleteExportManifest(input.manifest));
  const keyInventory = decodeCompleteExportKeyInventory(
    encodeCompleteExportKeyInventory(input.keyInventory),
  );
  try {
    same(keyInventory.vaultId, manifest.vaultId, "Complete Export Key Inventory Vault ID");
    same(
      keyInventory.generationId,
      manifest.generationId,
      "Complete Export Key Inventory Generation ID",
    );
    const epochKeys = new Map(
      keyInventory.entries.map((entry) => [key(entry.keyEpochId), entry.keyEpochKey]),
    );
    const referencedEpochIds = new Set(
      manifest.opaqueItemInventory.map((item) => key(item.keyEpochId)),
    );
    if (
      epochKeys.size !== referencedEpochIds.size ||
      [...referencedEpochIds].some((epochId) => !epochKeys.has(epochId))
    ) {
      throw new TypeError("Complete Export Key Inventory is not the exact referenced Epoch set");
    }
    const records = new Map<string, VaultRecord>();
    const objects = new Map<string, VaultObject>();
    const features = new Map<string, Uint8Array>();
    const keyEnvelopes = new Map<
      string,
      { readonly item: CompleteExportOpaqueItem; readonly bytes: Uint8Array }
    >();
    const itemsByStorageId = new Map(
      manifest.opaqueItemInventory.map((item) => [key(item.storageItemId), item]),
    );

    for (const item of manifest.opaqueItemInventory) {
      const epochKey = epochKeys.get(key(item.keyEpochId));
      if (epochKey === undefined) {
        throw new TypeError("Complete Export omits a referenced Key Epoch Key");
      }
      if (item.namespace === 5) continue;
      const bytes = await readCompleteImportCompactBytes(input.source, item);
      same(sha256(bytes), item.byteDigest, "Prepared Opaque byte digest");
      const envelope = decodeOpaqueEnvelope(bytes);
      same(envelope.storageItemId, item.storageItemId, "Prepared Opaque Storage Item ID");
      if (envelope.storageClass !== COMPACT_STORAGE_CLASS) {
        throw new TypeError("Complete Import compact inventory item is not Compact");
      }
      if (item.namespace === 2) {
        keyEnvelopes.set(key(item.logicalId), { item, bytes });
        continue;
      }
      const opened = await openCompactItem({
        vaultId: manifest.vaultId,
        keyEpochId: item.keyEpochId,
        keyEpochKey: epochKey,
        envelopeBytes: bytes,
      });
      if (opened.payloadType !== expectedPayloadType(item.namespace)) {
        throw new TypeError("Complete Import Compact payload type disagrees with its namespace");
      }
      const logicalKey = key(item.logicalId);
      if (item.namespace === 1) {
        const record = decodeRecord(opened.payloadBytes);
        same(record.recordId, item.logicalId, "Complete Import Vault Record ID");
        records.set(logicalKey, record);
      } else if (item.namespace === 3) {
        const object = decodeVaultObject(opened.payloadBytes);
        same(object.objectId, item.logicalId, "Complete Import Vault Object ID");
        objects.set(logicalKey, object);
      } else {
        same(
          featureManifestId(opened.payloadBytes),
          item.logicalId,
          "Complete Import Feature Manifest ID",
        );
        features.set(logicalKey, opened.payloadBytes);
      }
    }

    const baselineRoots = manifest.typedLogicalRoots.filter(
      ({ type }) => type === DEPENDENCY_TYPES.VaultBaseline,
    );
    if (baselineRoots.length !== 1) {
      throw new TypeError("Complete Export requires exactly one Baseline logical root");
    }
    const baselineId = baselineRoots[0]?.id as Identifier<"VaultRecord">;
    const reachability = await collectCompleteExportReachability({
      vaultId: manifest.vaultId,
      generationId: manifest.generationId,
      requiredFeatureSetId: manifest.requiredFeatureSetId,
      baselineId,
      causalFrontier: manifest.frontier,
      authorityFrontier: manifest.continuityProofRoots,
      loadRecord: async (id) => records.get(key(id)),
      loadObject: async (id) => objects.get(key(id)),
      loadFeatureManifest: async (id) => features.get(key(id)),
    });
    requireExactDependencies(manifest.typedLogicalRoots, reachability.typedLogicalRoots);
    const expectedInventory = reachableInventoryKeys(reachability);
    const actualInventory = new Set(
      manifest.opaqueItemInventory.map((item) => `${item.namespace}:${key(item.logicalId)}`),
    );
    if (
      expectedInventory.size !== actualInventory.size ||
      [...expectedInventory].some((candidate) => !actualInventory.has(candidate))
    ) {
      throw new TypeError("Complete Export reachable inventory is not exact");
    }
    const genesisCandidates = [...records.values()].filter(
      (record): record is AuthenticatedVaultEvent =>
        "family" in record && record.family === 1 && record.type === 1,
    );
    if (genesisCandidates.length !== 1) {
      throw new TypeError("Complete Export must contain exactly one Genesis Event");
    }
    const genesis = genesisCandidates[0];
    if (genesis === undefined) {
      throw new TypeError("Complete Export must contain exactly one Genesis Event");
    }
    const initialClient = initialVaultClientAuthority(genesis);
    same(
      genesis.signerCredentialId,
      initialClient.clientCredentialId,
      "Genesis signer Credential ID",
    );
    if (!(await verifyVaultEventSignature(genesis, initialClient.signingPublicKey))) {
      throw new TypeError("Vault Event signature is invalid");
    }
    const baseline = records.get(key(baselineId));
    if (baseline === undefined || "family" in baseline) {
      throw new TypeError("Complete Export Baseline root is not a Baseline");
    }
    const authority = await validateSelectedEventAuthority({
      manifest,
      baseline,
      genesis,
      records,
      features,
      epochKeys,
      keyEnvelopes,
    });

    const artifactStore: CanonicalArtifactStore = {
      prepare: async () => {
        throw new TypeError("Complete Import semantic validation never prepares Artifacts");
      },
      open: async (storageItemId) => {
        const item = itemsByStorageId.get(key(storageItemId));
        if (item === undefined) throw new TypeError("Prepared Artifact wrapper is unavailable");
        return input.source.openOpaque(item);
      },
      has: async (storageItemId) => itemsByStorageId.has(key(storageItemId)),
      remove: async () => undefined,
    };
    for (const id of reachability.artifactIds) {
      const object = [...objects.values()].find(
        (candidate) =>
          candidate.objectType === ARTIFACT_OBJECT && bytesEqual(artifactId(candidate), id),
      );
      const item = manifest.opaqueItemInventory.find(
        (candidate) => candidate.namespace === 5 && bytesEqual(candidate.logicalId, id),
      );
      if (object === undefined || item === undefined) {
        throw new TypeError("Complete Export reachable Artifact inventory is incomplete");
      }
      const epochKey = epochKeys.get(key(item.keyEpochId));
      if (epochKey === undefined)
        throw new TypeError("Complete Export omits an Artifact Epoch Key");
      const verified = await verifyCanonicalArtifactRepresentation({
        store: artifactStore,
        storageItemId: item.storageItemId,
        object,
        keyEpochId: item.keyEpochId,
        keyEpochKey: epochKey,
        writePlaintext: async () => undefined,
      });
      if (verified.byteLength !== item.byteLength) {
        throw new TypeError("Complete Import Artifact wrapper length does not match");
      }
      same(verified.byteDigest, item.byteDigest, "Complete Import Artifact wrapper digest");
    }

    return {
      manifest,
      keyInventory,
      reachability,
      replicaState: authority.replicaState,
      baseline,
      genesis,
      events: [...records.values()]
        .filter((record): record is AuthenticatedVaultEvent => "family" in record)
        .sort((left, right) => key(left.recordId).localeCompare(key(right.recordId))),
      vaultLabel: baselineVaultLabel(baseline),
      keyEpochs: authority.keyEpochs,
      activeClientCredentials: authority.activeClientCredentials,
      effectiveRecoveryCredentials: authority.effectiveRecoveryCredentials,
      keyEnvelopeSlots: authority.keyEnvelopeSlots,
      authority: authority.authority,
    };
  } catch (error) {
    for (const entry of keyInventory.entries) await wipe(entry.keyEpochKey);
    throw error;
  }
}
