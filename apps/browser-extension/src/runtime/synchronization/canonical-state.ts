import type { Identifier } from "../../domain/canonical/identifiers";
import {
  byteString,
  exactCode,
  exactMap,
  identifierValue,
  mapValue,
  nonnegativeInteger,
  nullable,
  oneOfCodes,
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
import {
  type StorageRealm,
  type StorageRealmKind,
  storageRealmKey,
} from "../../drivers/indexeddb/canonical-schema";

const SYNCHRONIZATION_STATE_FORMAT = 1 as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const REMOTE_TRANSPORT_HOSTED_HTTP = 1 as const;
const PULL_STAGES = [1, 2, 3] as const;
const PULL_STATES = [1, 2, 3, 4] as const;

export const MAX_AUTOMATIC_PULL_RETRY_ATTEMPTS = 8;

export interface CanonicalReplicaRemote {
  readonly remoteId: string;
  readonly vaultId: Identifier<"Vault">;
  readonly name: string;
  readonly endpoint: string;
  readonly hostedReplicaHandle: string;
  readonly locatorSalt: Uint8Array;
  readonly enabled: boolean;
  readonly inventoryPageSize: number;
}

export interface CanonicalRemoteCredential {
  readonly remoteId: string;
  readonly bearerToken: string;
}

export interface CanonicalQuarantineReference {
  readonly storageItemId: Identifier<"StorageItem">;
  readonly locator: Uint8Array;
}

export interface CanonicalPullSynchronizationJob {
  readonly jobId: string;
  readonly vaultId: Identifier<"Vault">;
  readonly remoteId: string;
  readonly realm: StorageRealm;
  readonly stage: (typeof PULL_STAGES)[number];
  readonly state: (typeof PULL_STATES)[number];
  readonly snapshotCursor: number | null;
  readonly nextPosition: Identifier<"StorageItem"> | null;
  readonly attempt: number;
  readonly retryAfterMs: number | null;
  readonly quarantineReferences: readonly CanonicalQuarantineReference[];
  readonly progress: {
    readonly discoveredItemCount: number;
    readonly downloadedItemCount: number;
    readonly promotedItemCount: number;
    readonly rejectedItemCount: number;
  };
}

function uuid(value: CanonicalValue, field: string): string {
  const parsed = textValue(value, field, { maxUtf8Bytes: 64 });
  if (!UUID.test(parsed)) throw new TypeError(`${field} must be a lowercase UUID`);
  return parsed;
}

function endpoint(value: CanonicalValue): string {
  const parsed = textValue(value, "Replica Remote endpoint", { maxUtf8Bytes: 2048 });
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new TypeError("Replica Remote endpoint must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw new TypeError(
      "Replica Remote endpoint must be an HTTPS origin or path without credentials",
    );
  }
  if (url.href !== parsed) {
    throw new TypeError("Replica Remote endpoint must use its canonical URL spelling");
  }
  return parsed;
}

function realmKindCode(kind: StorageRealmKind): number {
  switch (kind) {
    case "Normal":
      return 1;
    case "Private":
      return 2;
    case "Temporary":
      return 3;
    case "Test":
      return 4;
  }
}

function realmKind(code: number): StorageRealmKind {
  switch (code) {
    case 1:
      return "Normal";
    case 2:
      return "Private";
    case 3:
      return "Temporary";
    case 4:
      return "Test";
    default:
      throw new TypeError("Synchronization Job Storage Realm kind is unknown");
  }
}

function realmValue(value: StorageRealm): ReadonlyMap<number, CanonicalValue> {
  storageRealmKey(value);
  return canonicalMap([
    [0, realmKindCode(value.kind)],
    [1, value.id],
  ]);
}

function decodeRealm(value: CanonicalValue): StorageRealm {
  const map = exactMap(value, [0, 1], "Synchronization Job Storage Realm");
  const realm: StorageRealm = {
    kind: realmKind(oneOfCodes(mapValue(map, 0), [1, 2, 3, 4] as const, "Storage Realm kind")),
    id: textValue(mapValue(map, 1), "Storage Realm ID", { maxUtf8Bytes: 128 }),
  };
  storageRealmKey(realm);
  return realm;
}

function quarantineReferenceValue(
  value: CanonicalQuarantineReference,
): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap([
    [0, identifierValue(value.storageItemId, "StorageItem", "Quarantine Storage Item ID")],
    [1, byteString(value.locator, 32, "Quarantine opaque locator")],
  ]);
}

function decodeQuarantineReference(value: CanonicalValue): CanonicalQuarantineReference {
  const map = exactMap(value, [0, 1], "Synchronization Job Quarantine reference");
  return {
    storageItemId: identifierValue(mapValue(map, 0), "StorageItem", "Quarantine Storage Item ID"),
    locator: byteString(mapValue(map, 1), 32, "Quarantine opaque locator"),
  };
}

function quarantineReferences(
  values: readonly CanonicalQuarantineReference[],
): readonly CanonicalQuarantineReference[] {
  const storageItemIds: Identifier<"StorageItem">[] = [];
  for (const value of values) {
    const reference = decodeQuarantineReference(quarantineReferenceValue(value));
    if (
      storageItemIds.some((storageItemId) => bytesEqual(storageItemId, reference.storageItemId))
    ) {
      throw new TypeError("Synchronization Job Quarantine repeats an opaque Storage Item");
    }
    storageItemIds.push(reference.storageItemId);
  }
  return canonicalSet(values.map(quarantineReferenceValue)).map(decodeQuarantineReference);
}

function progressValue(
  progress: CanonicalPullSynchronizationJob["progress"],
): ReadonlyMap<number, CanonicalValue> {
  return canonicalMap([
    [0, nonnegativeInteger(progress.discoveredItemCount, "Discovered item count")],
    [1, nonnegativeInteger(progress.downloadedItemCount, "Downloaded item count")],
    [2, nonnegativeInteger(progress.promotedItemCount, "Promoted item count")],
    [3, nonnegativeInteger(progress.rejectedItemCount, "Rejected item count")],
  ]);
}

function decodeProgress(value: CanonicalValue): CanonicalPullSynchronizationJob["progress"] {
  const map = exactMap(value, [0, 1, 2, 3], "Synchronization Job progress");
  return {
    discoveredItemCount: nonnegativeInteger(mapValue(map, 0), "Discovered item count"),
    downloadedItemCount: nonnegativeInteger(mapValue(map, 1), "Downloaded item count"),
    promotedItemCount: nonnegativeInteger(mapValue(map, 2), "Promoted item count"),
    rejectedItemCount: nonnegativeInteger(mapValue(map, 3), "Rejected item count"),
  };
}

function validatePullJob(job: CanonicalPullSynchronizationJob): CanonicalPullSynchronizationJob {
  uuid(job.jobId, "Synchronization Job ID");
  identifierValue(job.vaultId, "Vault", "Synchronization Job Vault ID");
  uuid(job.remoteId, "Synchronization Job Remote ID");
  storageRealmKey(job.realm);
  oneOfCodes(job.stage, PULL_STAGES, "Synchronization Job stage");
  oneOfCodes(job.state, PULL_STATES, "Synchronization Job state");
  if (job.snapshotCursor !== null) {
    nonnegativeInteger(job.snapshotCursor, "Synchronization snapshot cursor");
  }
  if (job.nextPosition !== null) {
    identifierValue(job.nextPosition, "StorageItem", "Synchronization page position");
  }
  if (job.snapshotCursor === null && job.nextPosition !== null) {
    throw new TypeError("Synchronization page position requires an inventory snapshot");
  }
  if (job.stage !== 1 && job.snapshotCursor === null) {
    throw new TypeError("Download or validation requires an inventory snapshot");
  }
  nonnegativeInteger(job.attempt, "Synchronization retry attempt");
  if (job.retryAfterMs !== null) {
    nonnegativeInteger(job.retryAfterMs, "Synchronization retry time");
  }
  if (job.state === 2 && (job.attempt < 1 || job.retryAfterMs === null)) {
    throw new TypeError("A retryable Synchronization Job requires a retry attempt and time");
  }
  if (
    job.state === 4 &&
    (job.attempt !== MAX_AUTOMATIC_PULL_RETRY_ATTEMPTS ||
      job.retryAfterMs !== null ||
      job.stage === 3)
  ) {
    throw new TypeError("A failed Synchronization Job must retain its exhausted retry state");
  }
  const quarantine = quarantineReferences(job.quarantineReferences);
  const progress = progressValue(job.progress);
  if (
    job.progress.downloadedItemCount > job.progress.discoveredItemCount ||
    job.progress.promotedItemCount + job.progress.rejectedItemCount >
      job.progress.downloadedItemCount ||
    quarantine.length > job.progress.downloadedItemCount
  ) {
    throw new TypeError("Synchronization Job progress does not match its downloaded Quarantine");
  }
  if (
    job.state === 3 &&
    (job.stage !== 3 ||
      job.nextPosition !== null ||
      job.retryAfterMs !== null ||
      quarantine.length !== 0 ||
      job.progress.downloadedItemCount !==
        job.progress.promotedItemCount + job.progress.rejectedItemCount)
  ) {
    throw new TypeError(
      "A completed Synchronization Job cannot retain pending inventory or Quarantine",
    );
  }
  if (job.state !== 2 && job.retryAfterMs !== null) {
    throw new TypeError("Only a retryable Synchronization Job may retain a retry time");
  }
  return {
    ...job,
    quarantineReferences: quarantine,
    progress: decodeProgress(progress),
  };
}

export function encodeCanonicalReplicaRemote(value: CanonicalReplicaRemote): Uint8Array {
  uuid(value.remoteId, "Replica Remote ID");
  identifierValue(value.vaultId, "Vault", "Replica Remote Vault ID");
  textValue(value.name, "Replica Remote name", { maxUtf8Bytes: 256 });
  endpoint(value.endpoint);
  uuid(value.hostedReplicaHandle, "Hosted Replica handle");
  byteString(value.locatorSalt, 32, "Hosted Replica locator salt");
  nonnegativeInteger(value.inventoryPageSize, "Replica Remote inventory page size");
  if (value.inventoryPageSize < 1 || value.inventoryPageSize > 500) {
    throw new RangeError("Replica Remote inventory page size must be between 1 and 500");
  }
  return encodeCanonicalValue(
    canonicalMap([
      [0, SYNCHRONIZATION_STATE_FORMAT],
      [1, REMOTE_TRANSPORT_HOSTED_HTTP],
      [2, value.remoteId],
      [3, value.vaultId],
      [4, value.name],
      [5, value.endpoint],
      [6, value.hostedReplicaHandle],
      [7, value.locatorSalt],
      [8, value.enabled],
      [9, value.inventoryPageSize],
    ]),
  );
}

export function decodeCanonicalReplicaRemote(bytes: Uint8Array): CanonicalReplicaRemote {
  const map = exactMap(decodeCanonicalValue(bytes), [...Array(10).keys()], "Replica Remote");
  exactCode(mapValue(map, 0), SYNCHRONIZATION_STATE_FORMAT, "Replica Remote format");
  exactCode(mapValue(map, 1), REMOTE_TRANSPORT_HOSTED_HTTP, "Replica Remote transport");
  const value: CanonicalReplicaRemote = {
    remoteId: uuid(mapValue(map, 2), "Replica Remote ID"),
    vaultId: identifierValue(mapValue(map, 3), "Vault", "Replica Remote Vault ID"),
    name: textValue(mapValue(map, 4), "Replica Remote name", { maxUtf8Bytes: 256 }),
    endpoint: endpoint(mapValue(map, 5)),
    hostedReplicaHandle: uuid(mapValue(map, 6), "Hosted Replica handle"),
    locatorSalt: byteString(mapValue(map, 7), 32, "Hosted Replica locator salt"),
    enabled: (() => {
      const enabled = mapValue(map, 8);
      if (typeof enabled !== "boolean")
        throw new TypeError("Replica Remote enabled must be boolean");
      return enabled;
    })(),
    inventoryPageSize: nonnegativeInteger(mapValue(map, 9), "Replica Remote inventory page size"),
  };
  if (value.inventoryPageSize < 1 || value.inventoryPageSize > 500) {
    throw new RangeError("Replica Remote inventory page size must be between 1 and 500");
  }
  if (!bytesEqual(encodeCanonicalReplicaRemote(value), bytes)) {
    throw new TypeError("Replica Remote bytes are not canonical");
  }
  return value;
}

export function encodeCanonicalRemoteCredential(value: CanonicalRemoteCredential): Uint8Array {
  uuid(value.remoteId, "Replica Remote credential Remote ID");
  textValue(value.bearerToken, "Replica Remote bearer token", { maxUtf8Bytes: 8192 });
  return encodeCanonicalValue(
    canonicalMap([
      [0, SYNCHRONIZATION_STATE_FORMAT],
      [1, value.remoteId],
      [2, value.bearerToken],
    ]),
  );
}

export function decodeCanonicalRemoteCredential(bytes: Uint8Array): CanonicalRemoteCredential {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1, 2], "Replica Remote credential");
  exactCode(mapValue(map, 0), SYNCHRONIZATION_STATE_FORMAT, "Replica Remote credential format");
  const value = {
    remoteId: uuid(mapValue(map, 1), "Replica Remote credential Remote ID"),
    bearerToken: textValue(mapValue(map, 2), "Replica Remote bearer token", { maxUtf8Bytes: 8192 }),
  };
  if (!bytesEqual(encodeCanonicalRemoteCredential(value), bytes)) {
    throw new TypeError("Replica Remote credential bytes are not canonical");
  }
  return value;
}

export function encodeCanonicalPullSynchronizationJob(
  value: CanonicalPullSynchronizationJob,
): Uint8Array {
  const job = validatePullJob(value);
  return encodeCanonicalValue(
    canonicalMap([
      [0, SYNCHRONIZATION_STATE_FORMAT],
      [1, job.jobId],
      [2, job.vaultId],
      [3, job.remoteId],
      [4, realmValue(job.realm)],
      [5, job.stage],
      [6, job.state],
      [7, job.snapshotCursor],
      [8, job.nextPosition],
      [9, job.attempt],
      [10, job.retryAfterMs],
      [
        11,
        canonicalSet(quarantineReferences(job.quarantineReferences).map(quarantineReferenceValue)),
      ],
      [12, progressValue(job.progress)],
    ]),
  );
}

export function decodeCanonicalPullSynchronizationJob(
  bytes: Uint8Array,
): CanonicalPullSynchronizationJob {
  const map = exactMap(decodeCanonicalValue(bytes), [...Array(13).keys()], "Synchronization Job");
  exactCode(mapValue(map, 0), SYNCHRONIZATION_STATE_FORMAT, "Synchronization Job format");
  const quarantine = mapValue(map, 11);
  if (!Array.isArray(quarantine))
    throw new TypeError("Synchronization Job Quarantine must be an array");
  const value: CanonicalPullSynchronizationJob = {
    jobId: uuid(mapValue(map, 1), "Synchronization Job ID"),
    vaultId: identifierValue(mapValue(map, 2), "Vault", "Synchronization Job Vault ID"),
    remoteId: uuid(mapValue(map, 3), "Synchronization Job Remote ID"),
    realm: decodeRealm(mapValue(map, 4)),
    stage: oneOfCodes(mapValue(map, 5), PULL_STAGES, "Synchronization Job stage"),
    state: oneOfCodes(mapValue(map, 6), PULL_STATES, "Synchronization Job state"),
    snapshotCursor: nullable(mapValue(map, 7), (value) =>
      nonnegativeInteger(value, "Synchronization snapshot cursor"),
    ),
    nextPosition: nullable(mapValue(map, 8), (value) =>
      identifierValue(value, "StorageItem", "Synchronization page position"),
    ),
    attempt: nonnegativeInteger(mapValue(map, 9), "Synchronization retry attempt"),
    retryAfterMs: nullable(mapValue(map, 10), (value) =>
      nonnegativeInteger(value, "Synchronization retry time"),
    ),
    quarantineReferences: quarantineReferences(quarantine.map(decodeQuarantineReference)),
    progress: decodeProgress(mapValue(map, 12)),
  };
  const validated = validatePullJob(value);
  if (!bytesEqual(encodeCanonicalPullSynchronizationJob(validated), bytes)) {
    throw new TypeError("Synchronization Job bytes are not canonical");
  }
  return validated;
}
