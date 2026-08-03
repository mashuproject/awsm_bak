import { sha256 } from "@noble/hashes/sha2.js";

import { decodeRecoveryPhrase, deriveRecoveryCredential } from "../../crypto/canonical";
import { openKeyEnvelope } from "../../crypto/key-envelope";
import { wipe } from "../../crypto/sodium";
import { DEPENDENCY_TYPES } from "../../domain/canonical/dependencies";
import { decodeFeatureManifest } from "../../domain/canonical/features";
import type { Identifier } from "../../domain/canonical/identifiers";
import { ARTIFACT_OBJECT, artifactId } from "../../domain/canonical/object";
import type { AuthenticatedVaultEvent, VaultBaseline } from "../../domain/canonical/record";
import { exactMap, identifierValue, mapValue, oneOfCodes } from "../../domain/canonical/schema";
import { bytesEqual } from "../../domain/hash";
import { identifierStorageKey } from "../../drivers/indexeddb/canonical-database";
import { COMPACT_STORAGE_CLASS, decodeOpaqueEnvelope } from "../../storage/opaque-envelope";
import type { CanonicalArtifactStore } from "../artifact/canonical-store";
import { verifyCanonicalArtifactRepresentation } from "../artifact/canonical-verify";
import {
  type CompleteExportManifestInput,
  type CompleteExportOpaqueItem,
  completeExportStateDigest,
  decodeCompleteExportKeyInventory,
  decodeCompleteExportManifest,
  encodeCompleteExportKeyInventory,
  encodeCompleteExportManifest,
} from "../complete-export/contracts";
import { collectCompleteExportReachability } from "../complete-export/reachability";
import {
  type ValidatedCompleteExportSemantics,
  validateCompleteExportSemantics,
} from "../complete-import/semantic";
import { decodeCanonicalAuthorityCheckpoint } from "../projection/canonical-authority-checkpoint";
import { canonicalAuthorityKeyEnvelopeRequirements } from "../projection/canonical-authority-replay";
import type { CanonicalReplicaState, EpochSecretState } from "../vault/canonical-local-state";
import {
  CanonicalHostedReplicaHttp,
  type CanonicalHostedReplicaSummary,
  type CanonicalOpaqueInventoryItem,
} from "./canonical-host-http";
import type { CanonicalHostedRecoveryEnvelopeCandidate } from "./canonical-hosted-recovery-discovery";
import { findHostedReplicaOpaqueReferences } from "./canonical-hosted-replica-locator";
import {
  type CanonicalPulledCompactCandidate,
  classifyPulledCompactCandidate,
} from "./canonical-pull-candidate";

const INVENTORY_PAGE_SIZE = 128;
const MAX_COMPACT_OUTER_BYTES = 16 * 1024 * 1024 + 4_108;

type RecoveryClosureHttp = Pick<CanonicalHostedReplicaHttp, "listReplicas" | "inventory" | "item">;

interface DownloadedCompact {
  readonly item: CanonicalOpaqueInventoryItem;
  readonly bytes: Uint8Array;
}

interface RecoveredEpoch {
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly keyEnvelopeId: Identifier<"KeyEnvelope">;
  readonly key: Uint8Array;
}

function same(left: Uint8Array, right: Uint8Array, field: string): void {
  if (!bytesEqual(left, right)) throw new TypeError(`${field} does not match`);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.byteLength, right.byteLength); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

async function readCompactEnvelope(
  stream: ReadableStream<Uint8Array>,
  byteLength: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_COMPACT_OUTER_BYTES) {
    throw new TypeError("Recovery closure Compact item exceeds the accepted outer-envelope bound");
  }
  const bytes = new Uint8Array(byteLength);
  const reader = stream.getReader();
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
        throw new TypeError("Recovery closure Compact item chunks must contain bytes");
      }
      if (offset + next.value.byteLength > bytes.byteLength) {
        throw new TypeError("Recovery closure Compact item exceeds its declared length");
      }
      bytes.set(next.value, offset);
      offset += next.value.byteLength;
    }
    if (offset !== bytes.byteLength) {
      throw new TypeError("Recovery closure Compact item ended before its declared length");
    }
    return bytes;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function verifyCompactEnvelope(item: CanonicalOpaqueInventoryItem, bytes: Uint8Array): void {
  const envelope = decodeOpaqueEnvelope(bytes);
  if (
    envelope.storageClass !== COMPACT_STORAGE_CLASS ||
    !bytesEqual(envelope.storageItemId, item.storageItemId) ||
    envelope.bytes.byteLength !== item.byteLength ||
    !bytesEqual(envelope.ciphertextDigest, item.ciphertextDigest)
  ) {
    throw new TypeError("Recovery closure opaque bytes disagree with Host inventory metadata");
  }
}

function nextFrontier(
  events: readonly AuthenticatedVaultEvent[],
  parent: (event: AuthenticatedVaultEvent) => readonly Identifier<"VaultRecord">[],
): readonly Identifier<"VaultRecord">[] {
  const parentIds = new Set(events.flatMap(parent).map(identifierStorageKey));
  const frontier = events
    .map(({ recordId }) => recordId)
    .filter((recordId) => !parentIds.has(identifierStorageKey(recordId)))
    .toSorted(compareBytes);
  if (frontier.length === 0) throw new TypeError("Recovery closure has no observed frontier");
  return frontier;
}

function uniqueCandidate<T>(values: readonly T[], error: string): T {
  if (values.length !== 1 || values[0] === undefined) throw new TypeError(error);
  return values[0];
}

function selectedBaselineClosure(input: {
  readonly records: ReadonlyMap<
    string,
    Extract<CanonicalPulledCompactCandidate, { kind: "VaultRecord" }>
  >;
}): {
  readonly baseline: VaultBaseline;
  readonly frontier: readonly Identifier<"VaultRecord">[];
  readonly authorityFrontier: readonly Identifier<"VaultRecord">[];
} {
  const records = [...input.records.values()].map(({ record }) => record);
  const baselines = records.filter((record): record is VaultBaseline => !("family" in record));
  const events = records.filter((record): record is AuthenticatedVaultEvent => "family" in record);
  const vacuumBySuccessorBaseline = new Map<string, AuthenticatedVaultEvent>();
  const vacuumPredecessorGenerations = new Set<string>();
  for (const event of events) {
    if (event.family !== 3 || event.type !== 1) continue;
    const body = exactMap(event.body, [...Array(7).keys()], "Recovery closure Vacuum Event body");
    const successorBaselineId = identifierValue(
      mapValue(body, 3),
      "VaultRecord",
      "Recovery closure successor Baseline ID",
    );
    if (
      !event.dependencies.some(
        ({ type, id }) =>
          type === DEPENDENCY_TYPES.VaultBaseline && bytesEqual(id, successorBaselineId),
      )
    ) {
      throw new TypeError("Recovery closure Vacuum does not commit to its successor Baseline");
    }
    const successorKey = identifierStorageKey(successorBaselineId);
    if (vacuumBySuccessorBaseline.has(successorKey)) {
      throw new TypeError("Recovery closure has multiple Vacuum anchors for one Baseline");
    }
    vacuumBySuccessorBaseline.set(successorKey, event);
    vacuumPredecessorGenerations.add(identifierStorageKey(event.generationId));
  }
  const baseline = uniqueCandidate(
    baselines.filter(
      (candidate) =>
        !vacuumPredecessorGenerations.has(identifierStorageKey(candidate.generationId)),
    ),
    "Recovery closure requires exactly one current observed Baseline",
  );
  const currentEvents = events.filter(({ generationId }) =>
    bytesEqual(generationId, baseline.generationId),
  );
  const currentAuthorityEvents = currentEvents.filter(({ family }) => family !== 2);
  const anchor = vacuumBySuccessorBaseline.get(identifierStorageKey(baseline.recordId));
  if (currentEvents.length === 0) {
    if (anchor === undefined) {
      throw new TypeError("Recovery closure current Baseline has no Genesis or Vacuum anchor");
    }
    return {
      baseline,
      frontier: [baseline.recordId],
      authorityFrontier: [anchor.recordId],
    };
  }
  if (currentAuthorityEvents.length === 0) {
    if (anchor === undefined) {
      throw new TypeError("Recovery closure content Frontier has no Authority anchor");
    }
    return {
      baseline,
      frontier: nextFrontier(currentEvents, ({ parentRecordIds }) => parentRecordIds),
      authorityFrontier: [anchor.recordId],
    };
  }
  return {
    baseline,
    frontier: nextFrontier(currentEvents, ({ parentRecordIds }) => parentRecordIds),
    authorityFrontier: nextFrontier(
      currentAuthorityEvents,
      ({ authorityParentRecordIds }) => authorityParentRecordIds,
    ),
  };
}

function keyEnvelopeEpochAssignments(input: {
  readonly vaultId: Identifier<"Vault">;
  readonly baseline: VaultBaseline;
  readonly records: ReadonlyMap<
    string,
    Extract<CanonicalPulledCompactCandidate, { kind: "VaultRecord" }>
  >;
  readonly features: ReadonlyMap<
    string,
    Extract<CanonicalPulledCompactCandidate, { kind: "FeatureManifest" }>
  >;
}): ReadonlyMap<string, Identifier<"KeyEpoch">> {
  const assignments = new Map<string, Identifier<"KeyEpoch">>();
  const assign = (keyEnvelopeId: Identifier<"KeyEnvelope">, keyEpochId: Identifier<"KeyEpoch">) => {
    const id = identifierStorageKey(keyEnvelopeId);
    const existing = assignments.get(id);
    if (existing !== undefined) {
      same(existing, keyEpochId, "Recovery closure Key Envelope Epoch assignment");
      return;
    }
    assignments.set(id, keyEpochId);
  };
  for (const { record } of input.records.values()) {
    if (!("family" in record)) continue;
    for (const requirement of canonicalAuthorityKeyEnvelopeRequirements(record)) {
      assign(requirement.keyEnvelopeId, requirement.keyEpochId);
    }
  }
  const baselineBody = exactMap(
    input.baseline.body,
    [0, 1, 2, 3, 4, 5],
    "Recovery closure Baseline body",
  );
  const lifecycle = oneOfCodes(
    mapValue(exactMap(mapValue(baselineBody, 4), [0], "Recovery closure Baseline lifecycle"), 0),
    [1, 2] as const,
    "Recovery closure Baseline lifecycle",
  );
  const featureManifests = input.baseline.dependencies
    .filter(({ type }) => type === DEPENDENCY_TYPES.FeatureManifest)
    .map(({ id }) => {
      const featureId = id as Identifier<"FeatureManifest">;
      const feature = input.features.get(identifierStorageKey(featureId));
      if (feature === undefined) {
        throw new TypeError("Recovery closure Baseline Feature Manifest is unavailable");
      }
      return {
        id: featureId,
        bytes: feature.bytes,
        manifest: decodeFeatureManifest(feature.bytes),
      };
    });
  const authority = decodeCanonicalAuthorityCheckpoint({
    vaultId: input.vaultId,
    checkpoint: mapValue(baselineBody, 3),
    requiredFeatureSetId: input.baseline.requiredFeatureSetId,
    featureManifests,
    lifecycle,
  });
  for (const { keyEnvelopeId, keyEpochId } of authority.keyEnvelopeSlots) {
    assign(keyEnvelopeId, keyEpochId);
  }
  return assignments;
}

/**
 * An in-memory phrase-authenticated closure. It carries epoch secrets only until the caller either
 * enrolls a new Client atomically or explicitly wipes it with `wipeHostedRecoveryClosure`.
 */
export interface CanonicalHostedRecoveryClosure {
  readonly replicaHandle: string;
  readonly replicaState: CanonicalReplicaState;
  readonly validated: ValidatedCompleteExportSemantics;
}

export async function wipeHostedRecoveryClosure(
  closure: CanonicalHostedRecoveryClosure,
): Promise<void> {
  await Promise.all(
    closure.validated.keyInventory.entries.map(({ keyEpochKey }) => wipe(keyEpochKey)),
  );
}

/**
 * Authenticates an observed opaque Hosted Replica before a phrase may create local Vault state.
 */
export class CanonicalHostedRecoveryClosureService {
  constructor(
    private readonly dependencies: {
      readonly createHttp?: (input: {
        readonly endpoint: string;
        readonly bearerToken: string;
      }) => RecoveryClosureHttp;
    } = {},
  ) {}

  async authenticate(input: {
    readonly endpoint: string;
    readonly bearerToken: string;
    readonly recoveryPhrase: string;
    readonly candidate: CanonicalHostedRecoveryEnvelopeCandidate;
  }): Promise<CanonicalHostedRecoveryClosure> {
    const entropy = decodeRecoveryPhrase(input.recoveryPhrase);
    const recovery = await deriveRecoveryCredential(entropy);
    const downloaded: DownloadedCompact[] = [];
    const recoveredEpochs: RecoveredEpoch[] = [];
    let result: CanonicalHostedRecoveryClosure | undefined;
    try {
      const http =
        this.dependencies.createHttp?.({
          endpoint: input.endpoint,
          bearerToken: input.bearerToken,
        }) ??
        new CanonicalHostedReplicaHttp({
          endpoint: input.endpoint,
          bearerToken: input.bearerToken,
        });
      const replica = uniqueCandidate(
        (await http.listReplicas()).filter(
          ({ replicaHandle }) => replicaHandle === input.candidate.replicaHandle,
        ),
        "Recovery closure source Hosted Replica is unavailable",
      );
      const inventory = await this.readInventory({ http, replica });
      downloaded.push(...inventory.compact.values());
      const candidateStorageKey = identifierStorageKey(input.candidate.storageItemId);
      const candidateEnvelope = inventory.compact.get(candidateStorageKey);
      if (candidateEnvelope === undefined) {
        throw new TypeError("Recovery closure candidate envelope is unavailable");
      }
      same(
        candidateEnvelope.bytes,
        input.candidate.envelopeBytes,
        "Recovery closure candidate bytes",
      );

      const openedEnvelopes: {
        readonly storageItemId: Identifier<"StorageItem">;
        readonly opened: Awaited<ReturnType<typeof openKeyEnvelope>>;
      }[] = [];
      try {
        for (const compact of inventory.compact.values()) {
          try {
            const opened = await openKeyEnvelope({
              targetKind: 1,
              recipientWrappingPrivateKey: recovery.wrappingPrivateKey,
              envelopeBytes: compact.bytes,
            });
            openedEnvelopes.push({ storageItemId: compact.item.storageItemId, opened });
            if (
              opened.targetKind !== 1 ||
              opened.targetRevision === null ||
              !bytesEqual(opened.vaultId, input.candidate.vaultId) ||
              !bytesEqual(opened.targetCredentialId, input.candidate.recoveryCredentialId) ||
              opened.targetRevision !== input.candidate.recoveryCredentialRevision
            ) {
              continue;
            }
            const existing = recoveredEpochs.find(({ keyEnvelopeId }) =>
              bytesEqual(keyEnvelopeId, opened.id),
            );
            if (existing !== undefined) {
              same(existing.key, opened.keyEpochKey, "Recovery closure duplicate Epoch Key");
            } else {
              recoveredEpochs.push({
                keyEpochId: opened.keyEpochId,
                keyEnvelopeId: opened.id,
                key: Uint8Array.from(opened.keyEpochKey),
              });
            }
          } catch {
            // Opaque Compact bytes do not become phrase-owned Recovery Envelopes on parse failure.
          }
        }
        const candidateOpened = uniqueCandidate(
          openedEnvelopes
            .filter(({ storageItemId }) => bytesEqual(storageItemId, input.candidate.storageItemId))
            .map(({ opened }) => opened)
            .filter(
              (opened) =>
                bytesEqual(opened.vaultId, input.candidate.vaultId) &&
                bytesEqual(opened.keyEpochId, input.candidate.keyEpochId) &&
                bytesEqual(opened.keyEpochKey, input.candidate.keyEpochKey) &&
                opened.targetKind === 1 &&
                bytesEqual(opened.targetCredentialId, input.candidate.recoveryCredentialId) &&
                opened.targetRevision === input.candidate.recoveryCredentialRevision,
            ),
          "Recovery closure candidate cannot be opened by the supplied phrase",
        );
        void candidateOpened;
      } finally {
        await Promise.all(
          openedEnvelopes.map(async ({ opened }) => {
            await Promise.all([wipe(opened.keyEpochKey), wipe(opened.bytes)]);
          }),
        );
      }

      const epochSecrets: EpochSecretState[] = [];
      for (const recovered of recoveredEpochs) {
        const existing = epochSecrets.find(({ keyEpochId }) =>
          bytesEqual(keyEpochId, recovered.keyEpochId),
        );
        if (existing !== undefined) {
          same(existing.key, recovered.key, "Recovery closure duplicate Epoch Key");
          continue;
        }
        epochSecrets.push({
          vaultId: input.candidate.vaultId,
          keyEpochId: recovered.keyEpochId,
          displayNumber: 0,
          key: recovered.key,
        });
      }
      const records = new Map<
        string,
        Extract<CanonicalPulledCompactCandidate, { kind: "VaultRecord" }>
      >();
      const objects = new Map<
        string,
        Extract<CanonicalPulledCompactCandidate, { kind: "VaultObject" }>
      >();
      const features = new Map<
        string,
        Extract<CanonicalPulledCompactCandidate, { kind: "FeatureManifest" }>
      >();
      for (const compact of inventory.compact.values()) {
        const classified = await classifyPulledCompactCandidate({
          vaultId: input.candidate.vaultId,
          epochSecrets,
          envelopeBytes: compact.bytes,
          locatorSalt: replica.locatorSalt,
          locator: compact.item.locator,
        });
        if (classified === null) continue;
        const collection =
          classified.kind === "VaultRecord"
            ? records
            : classified.kind === "VaultObject"
              ? objects
              : features;
        const logicalKey = identifierStorageKey(classified.logicalId);
        if (collection.has(logicalKey)) {
          throw new TypeError(
            "Recovery closure has multiple opaque representations for one logical item",
          );
        }
        collection.set(logicalKey, classified as never);
      }

      const { baseline, frontier, authorityFrontier } = selectedBaselineClosure({ records });
      const reachability = await collectCompleteExportReachability({
        vaultId: input.candidate.vaultId,
        generationId: baseline.generationId,
        requiredFeatureSetId: baseline.requiredFeatureSetId,
        baselineId: baseline.recordId,
        causalFrontier: frontier,
        authorityFrontier,
        loadRecord: async (id) => records.get(identifierStorageKey(id))?.record,
        loadObject: async (id) => objects.get(identifierStorageKey(id))?.object,
        loadFeatureManifest: async (id) => features.get(identifierStorageKey(id))?.bytes,
      });
      const opaqueItemInventory = await this.inventoryForReachability({
        inventory,
        replica,
        reachability,
        records,
        objects,
        features,
        epochSecrets,
        http,
        keyEnvelopeEpochs: keyEnvelopeEpochAssignments({
          vaultId: input.candidate.vaultId,
          baseline,
          records,
          features,
        }),
      });
      const manifestInput: CompleteExportManifestInput = {
        vaultId: input.candidate.vaultId,
        generationId: baseline.generationId,
        frontier,
        requiredFeatureSetId: baseline.requiredFeatureSetId,
        typedLogicalRoots: reachability.typedLogicalRoots,
        opaqueItemInventory,
        continuityProofRoots: authorityFrontier,
      };
      const manifest = decodeCompleteExportManifest(
        encodeCompleteExportManifest({
          format: 1,
          ...manifestInput,
          stateDigest: completeExportStateDigest(manifestInput),
        }),
      );
      const keyInventory = decodeCompleteExportKeyInventory(
        encodeCompleteExportKeyInventory({
          vaultId: input.candidate.vaultId,
          generationId: baseline.generationId,
          entries: epochSecrets.map(({ keyEpochId, key: epochKey }) => ({
            keyEpochId,
            keyEpochKey: Uint8Array.from(epochKey),
          })),
        }),
      );
      try {
        const validated = await validateCompleteExportSemantics({
          manifest,
          keyInventory,
          source: {
            openOpaque: async (item) => {
              const downloaded = inventory.compact.get(identifierStorageKey(item.storageItemId));
              if (downloaded !== undefined)
                return new Blob([Uint8Array.from(downloaded.bytes)]).stream();
              const streamable = inventory.items.get(identifierStorageKey(item.storageItemId));
              if (streamable === undefined)
                throw new TypeError("Recovery closure reachable item is unavailable");
              return http.item({
                replicaHandle: replica.replicaHandle,
                storageItemId: streamable.storageItemId,
                byteLength: streamable.byteLength,
              });
            },
          },
        });
        uniqueCandidate(
          validated.effectiveRecoveryCredentials.filter(
            ({ recoveryCredentialId, revision, signingPublicKey, wrappingPublicKey }) =>
              bytesEqual(recoveryCredentialId, input.candidate.recoveryCredentialId) &&
              revision === input.candidate.recoveryCredentialRevision &&
              bytesEqual(signingPublicKey, recovery.signingPublicKey) &&
              bytesEqual(wrappingPublicKey, recovery.wrappingPublicKey),
          ),
          "Recovery closure phrase does not match an effective Recovery Credential",
        );
        const expectedRecoverySlots = validated.keyEnvelopeSlots.filter(
          ({ targetKind, targetCredentialId, targetRevision }) =>
            targetKind === 1 &&
            bytesEqual(targetCredentialId, input.candidate.recoveryCredentialId) &&
            targetRevision === input.candidate.recoveryCredentialRevision,
        );
        if (
          expectedRecoverySlots.length !== recoveredEpochs.length ||
          expectedRecoverySlots.some(
            ({ keyEpochId, keyEnvelopeId }) =>
              !recoveredEpochs.some(
                (recovered) =>
                  bytesEqual(recovered.keyEpochId, keyEpochId) &&
                  bytesEqual(recovered.keyEnvelopeId, keyEnvelopeId),
              ),
          )
        ) {
          throw new TypeError(
            "Recovery closure does not contain every authenticated Recovery Envelope",
          );
        }
        result = {
          replicaHandle: replica.replicaHandle,
          replicaState: validated.replicaState,
          validated,
        };
        return result;
      } finally {
        if (result === undefined) {
          await Promise.all(keyInventory.entries.map(({ keyEpochKey }) => wipe(keyEpochKey)));
        }
      }
    } finally {
      await Promise.all([
        wipe(entropy),
        wipe(recovery.signingSeed),
        wipe(recovery.signingSecretKey),
        wipe(recovery.wrappingPrivateKey),
        ...downloaded.map(({ bytes }) => wipe(bytes)),
        ...recoveredEpochs.map(({ key: epochKey }) => wipe(epochKey)),
      ]);
    }
  }

  private async readInventory(input: {
    readonly http: RecoveryClosureHttp;
    readonly replica: CanonicalHostedReplicaSummary;
  }): Promise<{
    readonly items: ReadonlyMap<string, CanonicalOpaqueInventoryItem>;
    readonly compact: ReadonlyMap<string, DownloadedCompact>;
  }> {
    const items = new Map<string, CanonicalOpaqueInventoryItem>();
    const compact = new Map<string, DownloadedCompact>();
    let snapshotCursor: number | undefined;
    let position: Identifier<"StorageItem"> | undefined;
    const positions = new Set<string>();
    for (;;) {
      const page = await input.http.inventory({
        replicaHandle: input.replica.replicaHandle,
        ...(snapshotCursor === undefined ? {} : { snapshotCursor }),
        ...(position === undefined ? {} : { position }),
        limit: INVENTORY_PAGE_SIZE,
      });
      if (snapshotCursor === undefined) snapshotCursor = page.snapshotCursor;
      else if (snapshotCursor !== page.snapshotCursor) {
        throw new TypeError("Recovery closure Host inventory changed its observed snapshot");
      }
      for (const item of page.items) {
        const storageKey = identifierStorageKey(item.storageItemId);
        if (items.has(storageKey))
          throw new TypeError("Recovery closure Host inventory repeats an item");
        items.set(storageKey, item);
        if (item.storageClass !== 1) continue;
        const bytes = await readCompactEnvelope(
          await input.http.item({
            replicaHandle: input.replica.replicaHandle,
            storageItemId: item.storageItemId,
            byteLength: item.byteLength,
          }),
          item.byteLength,
        );
        verifyCompactEnvelope(item, bytes);
        compact.set(storageKey, { item, bytes });
      }
      if (page.nextPosition === null) return { items, compact };
      const nextKey = identifierStorageKey(page.nextPosition);
      if (positions.has(nextKey))
        throw new TypeError("Recovery closure Host inventory repeats a page");
      positions.add(nextKey);
      position = page.nextPosition;
    }
  }

  private async inventoryForReachability(input: {
    readonly inventory: {
      readonly items: ReadonlyMap<string, CanonicalOpaqueInventoryItem>;
      readonly compact: ReadonlyMap<string, DownloadedCompact>;
    };
    readonly replica: CanonicalHostedReplicaSummary;
    readonly reachability: Awaited<ReturnType<typeof collectCompleteExportReachability>>;
    readonly records: ReadonlyMap<
      string,
      Extract<CanonicalPulledCompactCandidate, { kind: "VaultRecord" }>
    >;
    readonly objects: ReadonlyMap<
      string,
      Extract<CanonicalPulledCompactCandidate, { kind: "VaultObject" }>
    >;
    readonly features: ReadonlyMap<
      string,
      Extract<CanonicalPulledCompactCandidate, { kind: "FeatureManifest" }>
    >;
    readonly epochSecrets: readonly EpochSecretState[];
    readonly http: RecoveryClosureHttp;
    readonly keyEnvelopeEpochs: ReadonlyMap<string, Identifier<"KeyEpoch">>;
  }): Promise<readonly CompleteExportOpaqueItem[]> {
    const entries: CompleteExportOpaqueItem[] = [];
    const add = async (
      namespace: 1 | 2 | 3 | 4,
      logicalId: Uint8Array,
      keyEpochId: Identifier<"KeyEpoch">,
    ) => {
      const namespaceByCode = {
        1: 1,
        2: 2,
        3: 3,
        4: 4,
      } as const;
      const references = await findHostedReplicaOpaqueReferences({
        locatorSalt: input.replica.locatorSalt,
        logicalNamespace: namespaceByCode[namespace],
        logicalId,
        references: [...input.inventory.items.values()],
      });
      const reference = uniqueCandidate(
        references,
        "Recovery closure reachable item is unavailable",
      );
      if (reference.storageClass !== 1) {
        throw new TypeError("Recovery closure reachable Compact item is not Compact");
      }
      const bytes = input.inventory.compact.get(
        identifierStorageKey(reference.storageItemId),
      )?.bytes;
      if (bytes === undefined) {
        throw new TypeError("Recovery closure reachable Compact bytes are unavailable");
      }
      entries.push({
        namespace,
        logicalId,
        storageItemId: reference.storageItemId,
        keyEpochId,
        byteLength: reference.byteLength,
        byteDigest: sha256(bytes),
      });
    };
    for (const id of input.reachability.recordIds) {
      const record = input.records.get(identifierStorageKey(id));
      if (record === undefined) throw new TypeError("Recovery closure Vault Record is unavailable");
      await add(1, id, record.keyEpochId);
    }
    for (const id of input.reachability.keyEnvelopeIds) {
      const keyEpochId = input.keyEnvelopeEpochs.get(identifierStorageKey(id));
      if (keyEpochId === undefined) {
        throw new TypeError("Recovery closure Key Envelope has no authenticated Epoch assignment");
      }
      await add(2, id, keyEpochId);
    }
    for (const id of input.reachability.vaultObjectIds) {
      const object = input.objects.get(identifierStorageKey(id));
      if (object === undefined) throw new TypeError("Recovery closure Vault Object is unavailable");
      await add(3, id, object.keyEpochId);
    }
    for (const id of input.reachability.featureManifestIds) {
      const feature = input.features.get(identifierStorageKey(id));
      if (feature === undefined) {
        throw new TypeError("Recovery closure Feature Manifest is unavailable");
      }
      await add(4, id, feature.keyEpochId);
    }
    for (const requiredArtifactId of input.reachability.artifactIds) {
      const object = [...input.objects.values()].find(
        (candidate) =>
          candidate.object.objectType === ARTIFACT_OBJECT &&
          bytesEqual(artifactId(candidate.object), requiredArtifactId),
      );
      if (object === undefined) {
        throw new TypeError("Recovery closure Artifact Object is unavailable");
      }
      const epoch = uniqueCandidate(
        input.epochSecrets.filter(({ keyEpochId }) => bytesEqual(keyEpochId, object.keyEpochId)),
        "Recovery closure Artifact Key Epoch is unavailable",
      );
      const references = await findHostedReplicaOpaqueReferences({
        locatorSalt: input.replica.locatorSalt,
        logicalNamespace: 5,
        logicalId: requiredArtifactId,
        references: [...input.inventory.items.values()],
      });
      const reference = uniqueCandidate(
        references,
        "Recovery closure Artifact representation is unavailable",
      );
      if (reference.storageClass !== 2) {
        throw new TypeError("Recovery closure Artifact representation is not Streamable");
      }
      const store: CanonicalArtifactStore = {
        prepare: async () => {
          throw new TypeError("Recovery closure never prepares Artifact representations");
        },
        has: async (storageItemId) => bytesEqual(storageItemId, reference.storageItemId),
        open: async (storageItemId) => {
          same(storageItemId, reference.storageItemId, "Recovery closure Artifact Storage Item ID");
          return input.http.item({
            replicaHandle: input.replica.replicaHandle,
            storageItemId: reference.storageItemId,
            byteLength: reference.byteLength,
          });
        },
        remove: async () => undefined,
      };
      const verified = await verifyCanonicalArtifactRepresentation({
        store,
        storageItemId: reference.storageItemId,
        object: object.object,
        keyEpochId: epoch.keyEpochId,
        keyEpochKey: epoch.key,
        writePlaintext: async () => undefined,
      });
      if (verified.byteLength !== reference.byteLength) {
        throw new TypeError("Recovery closure Artifact length disagrees with Host inventory");
      }
      entries.push({
        namespace: 5,
        logicalId: requiredArtifactId,
        storageItemId: reference.storageItemId,
        keyEpochId: epoch.keyEpochId,
        byteLength: verified.byteLength,
        byteDigest: verified.byteDigest,
      });
    }
    return entries.toSorted(
      (left, right) =>
        left.namespace - right.namespace || compareBytes(left.logicalId, right.logicalId),
    );
  }
}
