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

const HOSTED_USERNAME = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$/u;

const REMOTE_TRANSPORT_HOSTED_HTTP = 1 as const;
const PULL_STAGES = [1, 2, 3] as const;
const PULL_STATES = [1, 2, 3, 4] as const;
const MATERIALIZATION_STATES = [1, 2] as const;

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

export type CanonicalRemoteCredential =
  | {
      readonly remoteId: string;
      readonly kind: "Bearer";
      readonly bearerToken: string;
    }
  | {
      readonly remoteId: string;
      readonly kind: "HostedSession";
      readonly username: string;
      readonly sessionId: string;
      readonly accessToken: string;
      readonly accessExpiresAt: number;
      readonly refreshToken: string;
      readonly refreshExpiresAt: number;
    };

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

/**
 * One local destination representation for one protected logical item at one Remote.
 * This is local Execution State, never a portable Vault fact or a Host-visible request shape.
 */
export interface CanonicalRemoteMaterializationLedgerEntry {
  readonly vaultId: Identifier<"Vault">;
  readonly remoteId: string;
  readonly logicalNamespace: 1 | 2 | 3 | 4 | 5;
  readonly logicalId: Uint8Array;
  readonly keyEpochId: Identifier<"KeyEpoch">;
  readonly locator: Uint8Array;
  readonly storageItemId: Identifier<"StorageItem">;
  readonly byteLength: number;
  readonly byteDigest: Uint8Array;
  readonly state: "Prepared" | "Confirmed";
}

function uuid(value: CanonicalValue, field: string): string {
  const parsed = textValue(value, field, { maxUtf8Bytes: 64 });
  if (!UUID.test(parsed)) throw new TypeError(`${field} must be a lowercase UUID`);
  return parsed;
}

function hostedUsername(value: CanonicalValue, field: string): string {
  const parsed = textValue(value, field, { maxUtf8Bytes: 32 });
  if (parsed.length < 3 || !HOSTED_USERNAME.test(parsed)) {
    throw new TypeError(`${field} must be a canonical username`);
  }
  return parsed;
}

function materializationStateCode(
  state: CanonicalRemoteMaterializationLedgerEntry["state"],
): 1 | 2 {
  if (state === "Prepared") return 1;
  if (state === "Confirmed") return 2;
  throw new TypeError("Remote materialization state is invalid");
}

function materializationState(
  value: CanonicalValue,
): CanonicalRemoteMaterializationLedgerEntry["state"] {
  const code = oneOfCodes(value, MATERIALIZATION_STATES, "Remote materialization state");
  return code === 1 ? "Prepared" : "Confirmed";
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

export function encodeCanonicalRemoteMaterializationLedgerEntry(
  value: CanonicalRemoteMaterializationLedgerEntry,
): Uint8Array {
  identifierValue(value.vaultId, "Vault", "Remote materialization Vault ID");
  uuid(value.remoteId, "Remote materialization Remote ID");
  const logicalNamespace = oneOfCodes(
    value.logicalNamespace,
    [1, 2, 3, 4, 5] as const,
    "Remote materialization logical namespace",
  );
  const logicalId = byteString(value.logicalId, 32, "Remote materialization logical ID");
  const keyEpochId = identifierValue(
    value.keyEpochId,
    "KeyEpoch",
    "Remote materialization Key Epoch ID",
  );
  const locator = byteString(value.locator, 32, "Remote materialization opaque locator");
  const storageItemId = identifierValue(
    value.storageItemId,
    "StorageItem",
    "Remote materialization Storage Item ID",
  );
  const byteLength = nonnegativeInteger(value.byteLength, "Remote materialization byte length");
  if (byteLength < 1) throw new TypeError("Remote materialization byte length must be positive");
  const byteDigest = byteString(value.byteDigest, 32, "Remote materialization byte digest");
  return encodeCanonicalValue(
    canonicalMap([
      [0, SYNCHRONIZATION_STATE_FORMAT],
      [1, value.vaultId],
      [2, value.remoteId],
      [3, logicalNamespace],
      [4, logicalId],
      [5, keyEpochId],
      [6, locator],
      [7, storageItemId],
      [8, byteLength],
      [9, byteDigest],
      [10, materializationStateCode(value.state)],
    ]),
  );
}

export function decodeCanonicalRemoteMaterializationLedgerEntry(
  bytes: Uint8Array,
): CanonicalRemoteMaterializationLedgerEntry {
  const map = exactMap(
    decodeCanonicalValue(bytes),
    [...Array(11).keys()],
    "Remote materialization ledger entry",
  );
  exactCode(mapValue(map, 0), SYNCHRONIZATION_STATE_FORMAT, "Remote materialization format");
  const value: CanonicalRemoteMaterializationLedgerEntry = {
    vaultId: identifierValue(mapValue(map, 1), "Vault", "Remote materialization Vault ID"),
    remoteId: uuid(mapValue(map, 2), "Remote materialization Remote ID"),
    logicalNamespace: oneOfCodes(
      mapValue(map, 3),
      [1, 2, 3, 4, 5] as const,
      "Remote materialization logical namespace",
    ),
    logicalId: byteString(mapValue(map, 4), 32, "Remote materialization logical ID"),
    keyEpochId: identifierValue(
      mapValue(map, 5),
      "KeyEpoch",
      "Remote materialization Key Epoch ID",
    ),
    locator: byteString(mapValue(map, 6), 32, "Remote materialization opaque locator"),
    storageItemId: identifierValue(
      mapValue(map, 7),
      "StorageItem",
      "Remote materialization Storage Item ID",
    ),
    byteLength: nonnegativeInteger(mapValue(map, 8), "Remote materialization byte length"),
    byteDigest: byteString(mapValue(map, 9), 32, "Remote materialization byte digest"),
    state: materializationState(mapValue(map, 10)),
  };
  if (value.byteLength < 1) {
    throw new TypeError("Remote materialization byte length must be positive");
  }
  if (!bytesEqual(encodeCanonicalRemoteMaterializationLedgerEntry(value), bytes)) {
    throw new TypeError("Remote materialization ledger entry bytes are not canonical");
  }
  return value;
}

export function encodeCanonicalRemoteCredential(value: CanonicalRemoteCredential): Uint8Array {
  uuid(value.remoteId, "Replica Remote credential Remote ID");
  if (value.kind === "HostedSession" && value.refreshExpiresAt < value.accessExpiresAt) {
    throw new TypeError("Replica Remote refresh expiry precedes its access expiry");
  }
  const credential =
    value.kind === "Bearer"
      ? canonicalMap([
          [0, 1],
          [1, textValue(value.bearerToken, "Replica Remote bearer token", { maxUtf8Bytes: 8192 })],
        ])
      : canonicalMap([
          [0, 2],
          [1, hostedUsername(value.username, "Replica Remote session username")],
          [2, uuid(value.sessionId, "Replica Remote session ID")],
          [3, textValue(value.accessToken, "Replica Remote access token", { maxUtf8Bytes: 8192 })],
          [4, nonnegativeInteger(value.accessExpiresAt, "Replica Remote access expiry")],
          [
            5,
            textValue(value.refreshToken, "Replica Remote refresh token", { maxUtf8Bytes: 8192 }),
          ],
          [6, nonnegativeInteger(value.refreshExpiresAt, "Replica Remote refresh expiry")],
        ]);
  return encodeCanonicalValue(
    canonicalMap([
      [0, SYNCHRONIZATION_STATE_FORMAT],
      [1, value.remoteId],
      [2, credential],
    ]),
  );
}

export function decodeCanonicalRemoteCredential(bytes: Uint8Array): CanonicalRemoteCredential {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1, 2], "Replica Remote credential");
  exactCode(mapValue(map, 0), SYNCHRONIZATION_STATE_FORMAT, "Replica Remote credential format");
  const remoteId = uuid(mapValue(map, 1), "Replica Remote credential Remote ID");
  const credentialValue = mapValue(map, 2);
  if (!(credentialValue instanceof Map)) {
    throw new TypeError("Replica Remote credential payload must be a map");
  }
  const kindValue = credentialValue.get(0);
  if (kindValue === undefined) throw new TypeError("Replica Remote credential kind is missing");
  const kind = oneOfCodes(kindValue, [1, 2] as const, "Replica Remote credential kind");
  const value: CanonicalRemoteCredential =
    kind === 1
      ? (() => {
          const bearer = exactMap(credentialValue, [0, 1], "Replica Remote bearer credential");
          return {
            remoteId,
            kind: "Bearer" as const,
            bearerToken: textValue(mapValue(bearer, 1), "Replica Remote bearer token", {
              maxUtf8Bytes: 8192,
            }),
          };
        })()
      : (() => {
          const session = exactMap(
            credentialValue,
            [0, 1, 2, 3, 4, 5, 6],
            "Replica Remote hosted session credential",
          );
          if (
            oneOfCodes(mapValue(session, 0), [2] as const, "Replica Remote credential kind") !== 2
          ) {
            throw new TypeError("Replica Remote hosted session kind is invalid");
          }
          const accessExpiresAt = nonnegativeInteger(
            mapValue(session, 4),
            "Replica Remote access expiry",
          );
          const refreshExpiresAt = nonnegativeInteger(
            mapValue(session, 6),
            "Replica Remote refresh expiry",
          );
          if (refreshExpiresAt < accessExpiresAt) {
            throw new TypeError("Replica Remote refresh expiry precedes its access expiry");
          }
          return {
            remoteId,
            kind: "HostedSession" as const,
            username: hostedUsername(mapValue(session, 1), "Replica Remote session username"),
            sessionId: uuid(mapValue(session, 2), "Replica Remote session ID"),
            accessToken: textValue(mapValue(session, 3), "Replica Remote access token", {
              maxUtf8Bytes: 8192,
            }),
            accessExpiresAt,
            refreshToken: textValue(mapValue(session, 5), "Replica Remote refresh token", {
              maxUtf8Bytes: 8192,
            }),
            refreshExpiresAt,
          };
        })();
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
