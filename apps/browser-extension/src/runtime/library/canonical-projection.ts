import type { Identifier } from "../../domain/canonical/identifiers";
import { artifactId, decodeVaultObject, type VaultObject } from "../../domain/canonical/object";
import {
  arrayValue,
  booleanValue,
  canonicalSetValue,
  exactCode,
  exactMap,
  identifierValue,
  mapValue,
  nullable,
  oneOfCodes,
  signedInteger,
  textValue,
} from "../../domain/canonical/schema";
import {
  type CanonicalValue,
  canonicalMap,
  canonicalSet,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import { identifierStorageKey } from "../../drivers/indexeddb/canonical-database";
import { NAMESPACES } from "../../drivers/indexeddb/canonical-schema";
import type { CanonicalArtifactStore } from "../artifact/canonical-store";
import {
  CanonicalReplayService,
  type ReplayedCanonicalVault,
} from "../projection/canonical-replay";
import {
  canonicalLocalStorageContext,
  openWrappedLocalState,
  prepareWrappedLocalStateItem,
} from "../vault/canonical-local-state";
import type {
  CanonicalVaultService,
  PersistedOpenedCanonicalVault,
} from "../vault/canonical-service";

const LIBRARY_PROJECTION_FORMAT = 1 as const;

export interface CanonicalLibraryCapture {
  readonly bundleId: Identifier<"Bundle">;
  readonly descriptorObjectId: Identifier<"VaultObject">;
  readonly assignedCollectionId: Identifier<"Collection">;
  readonly registrationRecordId: Identifier<"VaultRecord">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly assertedAt: number | bigint;
  readonly capturedAt: number | bigint;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly title: string | null;
  readonly profile: string;
  readonly adapter: string;
  readonly artifactObjectId: Identifier<"VaultObject">;
  readonly artifactId: Identifier<"Artifact">;
  readonly artifactStorageItemId: Identifier<"StorageItem">;
  readonly artifactAvailableLocally: boolean;
  readonly lifecycle: 1 | 2;
}

export interface CanonicalCaptureIdentityConflict {
  readonly bundleId: Identifier<"Bundle">;
  readonly registrationRecordIds: readonly Identifier<"VaultRecord">[];
}

export interface CanonicalLibraryProjection {
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly frontier: readonly Identifier<"VaultRecord">[];
  readonly captures: readonly CanonicalLibraryCapture[];
  readonly conflicts: readonly CanonicalCaptureIdentityConflict[];
}

interface RegistrationFact {
  readonly bundleId: Identifier<"Bundle">;
  readonly descriptorObjectId: Identifier<"VaultObject">;
  readonly assignedCollectionId: Identifier<"Collection">;
  readonly registrationRecordId: Identifier<"VaultRecord">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly assertedAt: number | bigint;
  readonly lifecycle: 1 | 2;
}

function key(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function indexedMap(...values: readonly CanonicalValue[]) {
  return canonicalMap(values.map((value, index) => [index, value] as const));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return key(left).localeCompare(key(right));
}

function compareInteger(left: number | bigint, right: number | bigint): number {
  const a = typeof left === "bigint" ? left : BigInt(left);
  const b = typeof right === "bigint" ? right : BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function baselineRegistrations(vault: PersistedOpenedCanonicalVault): readonly RegistrationFact[] {
  const body = exactMap(vault.baseline.body, [0, 1, 2, 3, 4, 5], "Vault Baseline body");
  const content = exactMap(mapValue(body, 2), [...Array(10).keys()], "Content checkpoint");
  return arrayValue(mapValue(content, 3), "Checkpointed Captures").map((entry, index) => {
    const capture = exactMap(entry, [...Array(8).keys()], `Checkpointed Capture ${index}`);
    const attribution = exactMap(
      mapValue(capture, 7),
      [0, 1, 2, 3],
      `Checkpointed Capture ${index} attribution`,
    );
    return {
      bundleId: identifierValue(mapValue(capture, 0), "Bundle"),
      descriptorObjectId: identifierValue(mapValue(capture, 1), "VaultObject"),
      assignedCollectionId: identifierValue(mapValue(capture, 2), "Collection"),
      registrationRecordId: identifierValue(mapValue(capture, 6), "VaultRecord"),
      memberId: identifierValue(mapValue(attribution, 1), "Member"),
      clientCredentialId: identifierValue(mapValue(attribution, 2), "ClientCredential"),
      assertedAt: signedInteger(mapValue(attribution, 3), "Capture attribution assertedAt"),
      lifecycle: oneOfCodes(mapValue(capture, 4), [1, 2] as const, "Capture lifecycle"),
    };
  });
}

function eventRegistrations(replay: ReplayedCanonicalVault): readonly RegistrationFact[] {
  return replay.events.flatMap((event) => {
    if (event.family !== 2 || event.type !== 3) return [];
    const body = exactMap(event.body, [0, 1, 2], "Bundle Registered body");
    return [
      {
        bundleId: identifierValue(mapValue(body, 0), "Bundle"),
        descriptorObjectId: identifierValue(mapValue(body, 1), "VaultObject"),
        assignedCollectionId: identifierValue(mapValue(body, 2), "Collection"),
        registrationRecordId: event.recordId,
        memberId: replay.vault.clientSecret.memberId,
        clientCredentialId: event.signerCredentialId,
        assertedAt: event.assertedAt,
        lifecycle: 1 as const,
      },
    ];
  });
}

function selectRegistrations(facts: readonly RegistrationFact[]): {
  readonly accepted: readonly RegistrationFact[];
  readonly conflicts: readonly CanonicalCaptureIdentityConflict[];
} {
  const grouped = new Map<string, RegistrationFact[]>();
  for (const fact of facts)
    grouped.set(key(fact.bundleId), [...(grouped.get(key(fact.bundleId)) ?? []), fact]);
  const accepted: RegistrationFact[] = [];
  const conflicts: CanonicalCaptureIdentityConflict[] = [];
  for (const candidates of grouped.values()) {
    const first = candidates[0] as RegistrationFact;
    if (
      candidates.every(
        (candidate) =>
          bytesEqual(candidate.descriptorObjectId, first.descriptorObjectId) &&
          bytesEqual(candidate.assignedCollectionId, first.assignedCollectionId),
      )
    ) {
      accepted.push(
        [...candidates].sort((left, right) =>
          compareBytes(left.registrationRecordId, right.registrationRecordId),
        )[0] as RegistrationFact,
      );
    } else {
      conflicts.push({
        bundleId: first.bundleId,
        registrationRecordIds: canonicalSet(
          candidates.map(({ registrationRecordId }) => registrationRecordId),
        ),
      });
    }
  }
  return {
    accepted: accepted.toSorted((left, right) => compareBytes(left.bundleId, right.bundleId)),
    conflicts: conflicts.toSorted((left, right) => compareBytes(left.bundleId, right.bundleId)),
  };
}

function descriptorFields(object: VaultObject): {
  readonly bundleId: Identifier<"Bundle">;
  readonly capturedAt: number | bigint;
  readonly originalUrl: string;
  readonly finalUrl: string;
  readonly title: string | null;
  readonly profile: string;
  readonly adapter: string;
  readonly primaryArtifactObjectId: Identifier<"VaultObject">;
} {
  if (object.objectType !== 1) throw new TypeError("Bundle dependency is not a Descriptor Object");
  const body = exactMap(object.body, [...Array(12).keys()], "Bundle Descriptor body");
  const references = arrayValue(mapValue(body, 9), "Artifact references").map((entry, index) => {
    const reference = exactMap(entry, [0, 1], `Artifact reference ${index}`);
    return {
      objectId: identifierValue(mapValue(reference, 0), "VaultObject"),
      role: textValue(mapValue(reference, 1), `Artifact reference ${index} role`),
    };
  });
  const primary = references.find(({ role }) => role === "awsm.artifact.primary");
  if (primary === undefined) throw new TypeError("Bundle Descriptor has no primary Artifact");
  return {
    bundleId: identifierValue(mapValue(body, 1), "Bundle"),
    capturedAt: signedInteger(mapValue(body, 2), "Capture capturedAt"),
    originalUrl: textValue(mapValue(body, 3), "Capture original URL"),
    finalUrl: textValue(mapValue(body, 4), "Capture final URL"),
    profile: textValue(mapValue(body, 5), "Capture profile"),
    adapter: textValue(mapValue(body, 6), "Capture adapter"),
    title: nullable(mapValue(body, 8), (value) => textValue(value, "Capture title")),
    primaryArtifactObjectId: primary.objectId,
  };
}

export class CanonicalLibraryProjectionService {
  readonly replay: CanonicalReplayService;

  constructor(
    readonly vaults: CanonicalVaultService,
    readonly artifacts: CanonicalArtifactStore,
  ) {
    this.replay = new CanonicalReplayService(vaults);
  }

  async load(vaultId: Identifier<"Vault">): Promise<CanonicalLibraryProjection> {
    const vault = await this.vaults.openVault(vaultId);
    const cached = await this.readCache(vault);
    if (cached !== undefined) return cached;
    const projection = await this.rebuildOpened(vault);
    await this.writeCache(vault, projection);
    return projection;
  }

  async rebuildOpened(vault: PersistedOpenedCanonicalVault): Promise<CanonicalLibraryProjection> {
    const replay = await this.replay.replayOpened(vault);
    const selected = selectRegistrations([
      ...baselineRegistrations(vault),
      ...eventRegistrations(replay),
    ]);
    const objectCache = new Map<string, VaultObject>();
    const loadObject = async (objectId: Identifier<"VaultObject">): Promise<VaultObject> => {
      const objectKey = key(objectId);
      const cached = objectCache.get(objectKey);
      if (cached !== undefined) return cached;
      const object = decodeVaultObject(
        (
          await this.vaults.openResolvedCompactItem({
            vault,
            kind: 3,
            logicalId: objectId,
            namespace: NAMESPACES.vaultObject.key,
            payloadType: 2,
          })
        ).payloadBytes,
      );
      if (
        !bytesEqual(object.objectId, objectId) ||
        !bytesEqual(object.vaultId, vault.replicaState.vaultId) ||
        !bytesEqual(object.requiredFeatureSetId, vault.replicaState.requiredFeatureSetId)
      ) {
        throw new TypeError("Resolved Vault Object belongs to another authoritative context");
      }
      objectCache.set(objectKey, object);
      for (const referencedId of object.referencedObjectIds) await loadObject(referencedId);
      return object;
    };
    const captures = await Promise.all(
      selected.accepted.map(async (registration): Promise<CanonicalLibraryCapture> => {
        const descriptor = await loadObject(registration.descriptorObjectId);
        const fields = descriptorFields(descriptor);
        if (!bytesEqual(fields.bundleId, registration.bundleId)) {
          throw new TypeError("Bundle registration and Descriptor IDs do not match");
        }
        const artifactObject = await loadObject(fields.primaryArtifactObjectId);
        const logicalArtifactId = artifactId(artifactObject);
        const resolution = await this.vaults.readLogicalResolution({
          vault,
          kind: 5,
          logicalId: logicalArtifactId,
        });
        const available =
          resolution.availability === 1 && (await this.artifacts.has(resolution.storageItemId));
        return {
          ...registration,
          capturedAt: fields.capturedAt,
          originalUrl: fields.originalUrl,
          finalUrl: fields.finalUrl,
          title: fields.title,
          profile: fields.profile,
          adapter: fields.adapter,
          artifactObjectId: artifactObject.objectId,
          artifactId: logicalArtifactId,
          artifactStorageItemId: resolution.storageItemId,
          artifactAvailableLocally: available,
        };
      }),
    );
    captures.sort((left, right) => {
      if (replay.graph.isAncestor(left.registrationRecordId, right.registrationRecordId)) return -1;
      if (replay.graph.isAncestor(right.registrationRecordId, left.registrationRecordId)) return 1;
      return (
        compareInteger(left.capturedAt, right.capturedAt) ||
        compareBytes(left.registrationRecordId, right.registrationRecordId)
      );
    });
    return {
      vaultId: vault.replicaState.vaultId,
      generationId: vault.replicaState.generationId,
      frontier: vault.replicaState.causalFrontier,
      captures,
      conflicts: selected.conflicts,
    };
  }

  private async readCache(
    vault: PersistedOpenedCanonicalVault,
  ): Promise<CanonicalLibraryProjection | undefined> {
    const bytes = await this.vaults.storage.getBytes(this.vaults.realm, {
      namespace: NAMESPACES.libraryProjection.key,
      scopeKey: identifierStorageKey(vault.replicaState.vaultId),
      itemKey: "current",
    });
    if (bytes === undefined) return undefined;
    try {
      const projection = decodeCanonicalLibraryProjection(
        await openWrappedLocalState({
          wrappingKey: vault.installationWrappingKey,
          domain: "awsm.local.library-projection",
          vaultId: vault.replicaState.vaultId,
          identity: vault.replicaState.generationId,
          wrappedBytes: bytes,
        }),
      );
      return bytesEqual(projection.vaultId, vault.replicaState.vaultId) &&
        bytesEqual(projection.generationId, vault.replicaState.generationId) &&
        sameIdSet(projection.frontier, vault.replicaState.causalFrontier)
        ? projection
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeCache(
    vault: PersistedOpenedCanonicalVault,
    projection: CanonicalLibraryProjection,
  ): Promise<void> {
    await this.vaults.storage.putMutable(
      this.vaults.realm,
      await prepareWrappedLocalStateItem({
        namespace: NAMESPACES.libraryProjection.key,
        scopeKey: identifierStorageKey(vault.replicaState.vaultId),
        itemKey: "current",
        wrappingKey: vault.installationWrappingKey,
        domain: "awsm.local.library-projection",
        context: canonicalLocalStorageContext(
          vault.replicaState.vaultId,
          vault.replicaState.generationId,
        ),
        bytes: encodeCanonicalLibraryProjection(projection),
      }),
    );
  }
}

function sameIdSet(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  return (
    left.length === right.length &&
    new Set(left.map(key)).size === left.length &&
    right.every((id) => left.some((candidate) => bytesEqual(candidate, id)))
  );
}

export function encodeCanonicalLibraryProjection(value: CanonicalLibraryProjection): Uint8Array {
  return encodeCanonicalValue(
    indexedMap(
      LIBRARY_PROJECTION_FORMAT,
      value.vaultId,
      value.generationId,
      canonicalSet(value.frontier),
      value.captures.map((capture) =>
        indexedMap(
          capture.bundleId,
          capture.descriptorObjectId,
          capture.assignedCollectionId,
          capture.registrationRecordId,
          capture.memberId,
          capture.clientCredentialId,
          capture.assertedAt,
          capture.capturedAt,
          capture.originalUrl,
          capture.finalUrl,
          capture.title,
          capture.profile,
          capture.adapter,
          capture.artifactObjectId,
          capture.artifactId,
          capture.artifactStorageItemId,
          capture.artifactAvailableLocally,
          capture.lifecycle,
        ),
      ),
      value.conflicts.map((conflict) =>
        indexedMap(conflict.bundleId, canonicalSet(conflict.registrationRecordIds)),
      ),
    ),
  );
}

export function decodeCanonicalLibraryProjection(bytes: Uint8Array): CanonicalLibraryProjection {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1, 2, 3, 4, 5], "Library Projection");
  exactCode(mapValue(map, 0), LIBRARY_PROJECTION_FORMAT, "Library Projection format");
  const capturesValue = mapValue(map, 4);
  if (!Array.isArray(capturesValue)) throw new TypeError("Library captures must be an array");
  const captures = capturesValue.map((entry, index): CanonicalLibraryCapture => {
    const capture = exactMap(entry, [...Array(18).keys()], `Library Capture ${index}`);
    return {
      bundleId: identifierValue(mapValue(capture, 0), "Bundle"),
      descriptorObjectId: identifierValue(mapValue(capture, 1), "VaultObject"),
      assignedCollectionId: identifierValue(mapValue(capture, 2), "Collection"),
      registrationRecordId: identifierValue(mapValue(capture, 3), "VaultRecord"),
      memberId: identifierValue(mapValue(capture, 4), "Member"),
      clientCredentialId: identifierValue(mapValue(capture, 5), "ClientCredential"),
      assertedAt: signedInteger(mapValue(capture, 6), "Registration assertedAt"),
      capturedAt: signedInteger(mapValue(capture, 7), "Capture capturedAt"),
      originalUrl: textValue(mapValue(capture, 8), "Capture original URL"),
      finalUrl: textValue(mapValue(capture, 9), "Capture final URL"),
      title: nullable(mapValue(capture, 10), (value) => textValue(value, "Capture title")),
      profile: textValue(mapValue(capture, 11), "Capture profile"),
      adapter: textValue(mapValue(capture, 12), "Capture adapter"),
      artifactObjectId: identifierValue(mapValue(capture, 13), "VaultObject"),
      artifactId: identifierValue(mapValue(capture, 14), "Artifact"),
      artifactStorageItemId: identifierValue(mapValue(capture, 15), "StorageItem"),
      artifactAvailableLocally: booleanValue(mapValue(capture, 16), "Artifact availability"),
      lifecycle: oneOfCodes(mapValue(capture, 17), [1, 2] as const, "Capture lifecycle"),
    };
  });
  const conflictsValue = mapValue(map, 5);
  if (!Array.isArray(conflictsValue)) throw new TypeError("Library conflicts must be an array");
  const value: CanonicalLibraryProjection = {
    vaultId: identifierValue(mapValue(map, 1), "Vault"),
    generationId: identifierValue(mapValue(map, 2), "Generation"),
    frontier: canonicalSetValue(mapValue(map, 3), "Projection Frontier", (id) =>
      identifierValue(id, "VaultRecord"),
    ),
    captures,
    conflicts: conflictsValue.map((entry, index) => {
      const conflict = exactMap(entry, [0, 1], `Capture identity conflict ${index}`);
      return {
        bundleId: identifierValue(mapValue(conflict, 0), "Bundle"),
        registrationRecordIds: canonicalSetValue(
          mapValue(conflict, 1),
          "Conflicting registration IDs",
          (id) => identifierValue(id, "VaultRecord"),
          { nonempty: true },
        ),
      };
    }),
  };
  if (!bytesEqual(encodeCanonicalLibraryProjection(value), bytes)) {
    throw new TypeError("Library Projection bytes are not canonical");
  }
  return value;
}
