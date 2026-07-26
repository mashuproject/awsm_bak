import { DomainValidationError } from "../../domain/errors";
import {
  boolean,
  canonicalRecord,
  httpUrl,
  integer,
  literal,
  string,
  timestamp,
  uuid,
} from "../../domain/validation";
import { openDatabase, requestValue, transactionDone } from "./database";
import { decodeStoredVaultHead } from "./decode";
import type {
  ServerSwitchCheckpointV1,
  ServerSwitchDirection,
  ServerSwitchJobState,
  ServerSwitchJobV1,
  ServerSwitchStage,
} from "./schema";
import { DATABASE_NAME, STORES } from "./schema";

function enumeration<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new DomainValidationError(field, "contains an unsupported value");
  return value as T;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : uuid(value, field);
}

function optionalInteger(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : integer(value, field);
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : timestamp(value, field);
}

export function decodeServerSwitchJob(value: unknown): ServerSwitchJobV1 {
  const input = canonicalRecord(value, "serverSwitchJob", [
    "version",
    "jobId",
    "sourceOrigin",
    "candidateOrigin",
    "candidateRegistration",
    "vaultId",
    "state",
    "stage",
    "direction",
    "expectedLocalHead",
    "candidateGenerationId",
    "candidateGenerationNumber",
    "candidatePredecessorGenerationId",
    "candidateHeadCursor",
    "createdAt",
    "updatedAt",
    "completedItems",
    "totalItems",
    "processedBytes",
    "totalBytes",
    "retryCount",
    "retryAt",
    "candidateAuthorityChanged",
    "errorId",
    "conflictReason",
    "attachIdempotencyKey",
    "candidateIdempotencyKey",
  ]);
  const optional = <T>(candidate: T | undefined, key: string): Record<string, T> =>
    candidate === undefined ? {} : { [key]: candidate };
  const registration = canonicalRecord(
    input.candidateRegistration,
    "serverSwitchJob.candidateRegistration",
    ["enabled", "signUpUrl"],
  );
  const candidateOrigin = httpUrl(input.candidateOrigin, "serverSwitchJob.candidateOrigin");
  const candidateRegistration =
    registration.enabled === false && registration.signUpUrl === undefined
      ? ({ enabled: false } as const)
      : registration.enabled === true && typeof registration.signUpUrl === "string"
        ? ({
            enabled: true,
            signUpUrl: httpUrl(
              registration.signUpUrl,
              "serverSwitchJob.candidateRegistration.signUpUrl",
            ),
          } as const)
        : undefined;
  if (
    candidateRegistration === undefined ||
    (candidateRegistration.enabled &&
      (new URL(candidateRegistration.signUpUrl).origin !== candidateOrigin ||
        new URL(candidateRegistration.signUpUrl).pathname !== "/sign_up"))
  )
    throw new DomainValidationError("serverSwitchJob.candidateRegistration", "is invalid");
  return {
    version: literal(input.version, 1, "serverSwitchJob.version"),
    jobId: uuid(input.jobId, "serverSwitchJob.jobId"),
    sourceOrigin: httpUrl(input.sourceOrigin, "serverSwitchJob.sourceOrigin"),
    candidateOrigin,
    candidateRegistration,
    vaultId: uuid(input.vaultId, "serverSwitchJob.vaultId"),
    state: enumeration<ServerSwitchJobState>(
      input.state,
      ["AuthenticationRequired", "WaitingForUnlock", "Running", "Conflict", "Failed", "Succeeded"],
      "serverSwitchJob.state",
    ),
    stage: enumeration<ServerSwitchStage>(
      input.stage,
      [
        "AuthenticateCandidate",
        "Compare",
        "PrepareRemote",
        "ActivateRemote",
        "PrepareLocal",
        "ActivateLocal",
        "PromoteContext",
        "RevokePriorSession",
        "Terminal",
      ],
      "serverSwitchJob.stage",
    ),
    ...optional(
      input.direction === undefined
        ? undefined
        : enumeration<ServerSwitchDirection>(
            input.direction,
            ["PublishLocal", "FastForwardCandidate", "FastForwardLocal", "Union"],
            "serverSwitchJob.direction",
          ),
      "direction",
    ),
    expectedLocalHead: decodeStoredVaultHead(input.expectedLocalHead),
    ...optional(
      optionalUuid(input.candidateGenerationId, "serverSwitchJob.candidateGenerationId"),
      "candidateGenerationId",
    ),
    ...optional(
      optionalInteger(input.candidateGenerationNumber, "serverSwitchJob.candidateGenerationNumber"),
      "candidateGenerationNumber",
    ),
    ...optional(
      optionalUuid(
        input.candidatePredecessorGenerationId,
        "serverSwitchJob.candidatePredecessorGenerationId",
      ),
      "candidatePredecessorGenerationId",
    ),
    ...optional(
      optionalInteger(input.candidateHeadCursor, "serverSwitchJob.candidateHeadCursor"),
      "candidateHeadCursor",
    ),
    createdAt: timestamp(input.createdAt, "serverSwitchJob.createdAt"),
    updatedAt: timestamp(input.updatedAt, "serverSwitchJob.updatedAt"),
    completedItems: integer(input.completedItems, "serverSwitchJob.completedItems"),
    totalItems: integer(input.totalItems, "serverSwitchJob.totalItems"),
    processedBytes: integer(input.processedBytes, "serverSwitchJob.processedBytes"),
    totalBytes: integer(input.totalBytes, "serverSwitchJob.totalBytes"),
    retryCount: integer(input.retryCount, "serverSwitchJob.retryCount"),
    ...optional(optionalTimestamp(input.retryAt, "serverSwitchJob.retryAt"), "retryAt"),
    candidateAuthorityChanged: boolean(
      input.candidateAuthorityChanged,
      "serverSwitchJob.candidateAuthorityChanged",
    ),
    ...optional(
      input.errorId === undefined ? undefined : string(input.errorId, "serverSwitchJob.errorId"),
      "errorId",
    ),
    ...optional(
      input.conflictReason === undefined
        ? undefined
        : enumeration(
            input.conflictReason,
            ["AncestryUnavailable", "DivergedGeneration"],
            "serverSwitchJob.conflictReason",
          ),
      "conflictReason",
    ),
    attachIdempotencyKey: uuid(input.attachIdempotencyKey, "serverSwitchJob.attachIdempotencyKey"),
    candidateIdempotencyKey: uuid(
      input.candidateIdempotencyKey,
      "serverSwitchJob.candidateIdempotencyKey",
    ),
  };
}

export function decodeServerSwitchCheckpoint(value: unknown): ServerSwitchCheckpointV1 {
  const input = canonicalRecord(value, "serverSwitchCheckpoint", [
    "version",
    "jobId",
    "kind",
    "entityId",
    "state",
    "createIdempotencyKey",
    "completeIdempotencyKey",
    "commitIdempotencyKey",
    "uploadId",
    "receivedParts",
  ]);
  if (!Array.isArray(input.receivedParts))
    throw new DomainValidationError("serverSwitchCheckpoint.receivedParts", "must be an array");
  const receivedParts = input.receivedParts.map((part) =>
    integer(part, "serverSwitchCheckpoint.receivedParts"),
  );
  if (
    receivedParts.length !== new Set(receivedParts).size ||
    receivedParts.some((part, index) => index > 0 && part <= (receivedParts[index - 1] ?? -1))
  )
    throw new DomainValidationError(
      "serverSwitchCheckpoint.receivedParts",
      "must be sorted and unique",
    );
  return {
    version: literal(input.version, 1, "serverSwitchCheckpoint.version"),
    jobId: uuid(input.jobId, "serverSwitchCheckpoint.jobId"),
    kind: enumeration(
      input.kind,
      ["Object", "Event", "Generation", "Recovery"],
      "serverSwitchCheckpoint.kind",
    ),
    entityId: uuid(input.entityId, "serverSwitchCheckpoint.entityId"),
    state: enumeration(
      input.state,
      ["Prepared", "Uploading", "Durable", "Committed"],
      "serverSwitchCheckpoint.state",
    ),
    createIdempotencyKey: uuid(
      input.createIdempotencyKey,
      "serverSwitchCheckpoint.createIdempotencyKey",
    ),
    completeIdempotencyKey: uuid(
      input.completeIdempotencyKey,
      "serverSwitchCheckpoint.completeIdempotencyKey",
    ),
    ...(input.commitIdempotencyKey === undefined
      ? {}
      : {
          commitIdempotencyKey: uuid(
            input.commitIdempotencyKey,
            "serverSwitchCheckpoint.commitIdempotencyKey",
          ),
        }),
    ...(input.uploadId === undefined
      ? {}
      : { uploadId: uuid(input.uploadId, "serverSwitchCheckpoint.uploadId") }),
    receivedParts,
  };
}

export class IndexedDbServerSwitchRepository {
  private readonly databasePromise: Promise<IDBDatabase>;

  constructor(databaseName = DATABASE_NAME) {
    this.databasePromise = openDatabase(databaseName);
  }

  async loadJob(): Promise<ServerSwitchJobV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.serverSwitchJobs, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.serverSwitchJobs).get("active"),
    );
    await transactionDone(transaction);
    return value === undefined ? undefined : decodeServerSwitchJob(value);
  }

  async saveJob(job: ServerSwitchJobV1): Promise<void> {
    const decoded = decodeServerSwitchJob(job);
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.serverSwitchJobs, "readwrite");
    transaction.objectStore(STORES.serverSwitchJobs).put(decoded, "active");
    await transactionDone(transaction);
  }

  async deleteJob(jobId: string): Promise<boolean> {
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.serverSwitchJobs, STORES.serverSwitchCheckpoints],
      "readwrite",
    );
    const currentValue = await requestValue(
      transaction.objectStore(STORES.serverSwitchJobs).get("active"),
    );
    const current = currentValue === undefined ? undefined : decodeServerSwitchJob(currentValue);
    if (current?.jobId !== jobId) {
      await transactionDone(transaction);
      return false;
    }
    transaction.objectStore(STORES.serverSwitchJobs).delete("active");
    const checkpoints = transaction.objectStore(STORES.serverSwitchCheckpoints);
    const range = IDBKeyRange.bound([jobId], [jobId, []]);
    checkpoints.delete(range);
    await transactionDone(transaction);
    return true;
  }

  async loadCheckpoint(
    jobId: string,
    kind: ServerSwitchCheckpointV1["kind"],
    entityId: string,
  ): Promise<ServerSwitchCheckpointV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.serverSwitchCheckpoints, "readonly");
    const value = await requestValue(
      transaction.objectStore(STORES.serverSwitchCheckpoints).get([jobId, kind, entityId]),
    );
    await transactionDone(transaction);
    return value === undefined ? undefined : decodeServerSwitchCheckpoint(value);
  }

  async saveCheckpoint(checkpoint: ServerSwitchCheckpointV1): Promise<void> {
    const decoded = decodeServerSwitchCheckpoint(checkpoint);
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.serverSwitchCheckpoints, "readwrite");
    transaction
      .objectStore(STORES.serverSwitchCheckpoints)
      .put(decoded, [decoded.jobId, decoded.kind, decoded.entityId]);
    await transactionDone(transaction);
  }

  async clearCheckpoints(jobId: string): Promise<void> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.serverSwitchCheckpoints, "readwrite");
    transaction
      .objectStore(STORES.serverSwitchCheckpoints)
      .delete(IDBKeyRange.bound([jobId], [jobId, []]));
    await transactionDone(transaction);
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
  }
}
