import { encodeCanonicalCbor } from "../../domain/cbor";
import { DomainValidationError } from "../../domain/errors";
import {
  boolean,
  bytes,
  canonicalRecord,
  integer,
  literal,
  string,
  timestamp,
  uuid,
} from "../../domain/validation";
import { abortTransaction, openDatabase, requestValue, transactionDone } from "./database";
import { decodeStoredVaultHead } from "./decode";
import { storageError } from "./errors";
import { vaultKey, vaultKeyRange } from "./keys";
import {
  DATABASE_NAME,
  STORES,
  type VaultReplacementCheckpointV1,
  type VaultReplacementJobStage,
  type VaultReplacementJobState,
  type VaultReplacementJobV1,
} from "./schema";

const JOB_STATES: readonly VaultReplacementJobState[] = [
  "Created",
  "Running",
  "WaitingForPhraseConfirmation",
  "WaitingForExportConfirmation",
  "WaitingForNetwork",
  "Conflict",
  "Failed",
  "Succeeded",
  "Aborted",
];
const JOB_STAGES: readonly VaultReplacementJobStage[] = [
  "ExportGate",
  "PrepareAuthority",
  "Rewrite",
  "Validate",
  "StageRemote",
  "Upload",
  "CompleteRemote",
  "ActivateRemote",
  "PromoteLocal",
  "PurgeSource",
  "Terminal",
];

function enumeration<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new DomainValidationError(field, "contains an unsupported value");
  return value as T;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : uuid(value, field);
}

function confirmed(value: unknown, field: string): true {
  if (!boolean(value, field)) throw new DomainValidationError(field, "must be confirmed");
  return true;
}

export function decodeVaultReplacementJob(value: unknown): VaultReplacementJobV1 {
  const input = canonicalRecord(value, "vaultReplacementJob", [
    "version",
    "jobId",
    "accountId",
    "sourceVaultId",
    "sourceHead",
    "sourceHeadCursor",
    "verifiedExportJobId",
    "safelyStoredConfirmed",
    "candidateIdempotencyKey",
    "generationUploadCompleteIdempotencyKey",
    "candidateCompleteIdempotencyKey",
    "activationIdempotencyKey",
    "state",
    "stage",
    "createdAt",
    "updatedAt",
    "targetVaultId",
    "targetDeviceId",
    "targetRecoveryGenerationId",
    "targetKeyEpochId",
    "targetGenerationId",
    "targetGenerationNumber",
    "targetHeadCursor",
    "completedItems",
    "totalItems",
    "processedBytes",
    "totalBytes",
    "retryCount",
    "errorId",
    "purgeId",
  ]);
  const targetVaultId = optionalUuid(input.targetVaultId, "vaultReplacementJob.targetVaultId");
  const targetDeviceId = optionalUuid(input.targetDeviceId, "vaultReplacementJob.targetDeviceId");
  const targetRecoveryGenerationId = optionalUuid(
    input.targetRecoveryGenerationId,
    "vaultReplacementJob.targetRecoveryGenerationId",
  );
  const targetKeyEpochId = optionalUuid(
    input.targetKeyEpochId,
    "vaultReplacementJob.targetKeyEpochId",
  );
  const targetGenerationId = optionalUuid(
    input.targetGenerationId,
    "vaultReplacementJob.targetGenerationId",
  );
  const targetGenerationNumber =
    input.targetGenerationNumber === undefined
      ? undefined
      : integer(input.targetGenerationNumber, "vaultReplacementJob.targetGenerationNumber");
  const targetHeadCursor =
    input.targetHeadCursor === undefined
      ? undefined
      : integer(input.targetHeadCursor, "vaultReplacementJob.targetHeadCursor");
  const errorId =
    input.errorId === undefined ? undefined : string(input.errorId, "vaultReplacementJob.errorId");
  const purgeId = optionalUuid(input.purgeId, "vaultReplacementJob.purgeId");
  const state = enumeration(input.state, JOB_STATES, "vaultReplacementJob.state");
  const stage = enumeration(input.stage, JOB_STAGES, "vaultReplacementJob.stage");
  const hasTarget =
    targetVaultId !== undefined &&
    targetDeviceId !== undefined &&
    targetRecoveryGenerationId !== undefined &&
    targetKeyEpochId !== undefined &&
    targetGenerationId !== undefined &&
    targetGenerationNumber !== undefined;
  if (
    [
      targetVaultId,
      targetDeviceId,
      targetRecoveryGenerationId,
      targetKeyEpochId,
      targetGenerationId,
      targetGenerationNumber,
    ].some((entry) => entry !== undefined) !== hasTarget ||
    (stage === "ExportGate" && hasTarget) ||
    (targetHeadCursor !== undefined && !hasTarget)
  )
    throw new DomainValidationError(
      "vaultReplacementJob.target",
      "contains incomplete or premature target authority",
    );
  return {
    version: literal(input.version, 1, "vaultReplacementJob.version"),
    jobId: uuid(input.jobId, "vaultReplacementJob.jobId"),
    accountId: uuid(input.accountId, "vaultReplacementJob.accountId"),
    sourceVaultId: uuid(input.sourceVaultId, "vaultReplacementJob.sourceVaultId"),
    sourceHead: decodeStoredVaultHead(input.sourceHead),
    sourceHeadCursor: integer(input.sourceHeadCursor, "vaultReplacementJob.sourceHeadCursor"),
    verifiedExportJobId: uuid(input.verifiedExportJobId, "vaultReplacementJob.verifiedExportJobId"),
    safelyStoredConfirmed: confirmed(
      input.safelyStoredConfirmed,
      "vaultReplacementJob.safelyStoredConfirmed",
    ),
    candidateIdempotencyKey: uuid(
      input.candidateIdempotencyKey,
      "vaultReplacementJob.candidateIdempotencyKey",
    ),
    generationUploadCompleteIdempotencyKey: uuid(
      input.generationUploadCompleteIdempotencyKey,
      "vaultReplacementJob.generationUploadCompleteIdempotencyKey",
    ),
    candidateCompleteIdempotencyKey: uuid(
      input.candidateCompleteIdempotencyKey,
      "vaultReplacementJob.candidateCompleteIdempotencyKey",
    ),
    activationIdempotencyKey: uuid(
      input.activationIdempotencyKey,
      "vaultReplacementJob.activationIdempotencyKey",
    ),
    state,
    stage,
    createdAt: timestamp(input.createdAt, "vaultReplacementJob.createdAt"),
    updatedAt: timestamp(input.updatedAt, "vaultReplacementJob.updatedAt"),
    ...(hasTarget
      ? {
          targetVaultId,
          targetDeviceId,
          targetRecoveryGenerationId,
          targetKeyEpochId,
          targetGenerationId,
          targetGenerationNumber,
        }
      : {}),
    ...(targetHeadCursor === undefined ? {} : { targetHeadCursor }),
    completedItems: integer(input.completedItems, "vaultReplacementJob.completedItems"),
    totalItems: integer(input.totalItems, "vaultReplacementJob.totalItems"),
    processedBytes: integer(input.processedBytes, "vaultReplacementJob.processedBytes"),
    totalBytes: integer(input.totalBytes, "vaultReplacementJob.totalBytes"),
    retryCount: integer(input.retryCount, "vaultReplacementJob.retryCount"),
    ...(errorId === undefined ? {} : { errorId }),
    ...(purgeId === undefined ? {} : { purgeId }),
  };
}

function decodeCheckpoint(value: unknown): VaultReplacementCheckpointV1 {
  const input = canonicalRecord(value, "vaultReplacementCheckpoint", [
    "version",
    "jobId",
    "sourceVaultId",
    "targetVaultId",
    "nonce",
    "ciphertext",
    "updatedAt",
  ]);
  return {
    version: literal(input.version, 1, "vaultReplacementCheckpoint.version"),
    jobId: uuid(input.jobId, "vaultReplacementCheckpoint.jobId"),
    sourceVaultId: uuid(input.sourceVaultId, "vaultReplacementCheckpoint.sourceVaultId"),
    targetVaultId: uuid(input.targetVaultId, "vaultReplacementCheckpoint.targetVaultId"),
    nonce: bytes(input.nonce, 12, "vaultReplacementCheckpoint.nonce"),
    ciphertext: bytes(input.ciphertext, undefined, "vaultReplacementCheckpoint.ciphertext"),
    updatedAt: timestamp(input.updatedAt, "vaultReplacementCheckpoint.updatedAt"),
  };
}

function keyId(jobId: string): string {
  return `vault-replacement:${jobId}`;
}

function aad(jobId: string, sourceVaultId: string, targetVaultId: string) {
  return encodeCanonicalCbor([
    "vault:replacement-checkpoint:v1",
    jobId,
    sourceVaultId,
    targetVaultId,
  ]);
}

function checkpointKey(value: unknown): CryptoKey {
  if (
    !(value instanceof CryptoKey) ||
    value.extractable ||
    value.algorithm.name !== "AES-GCM" ||
    !value.usages.includes("encrypt") ||
    !value.usages.includes("decrypt")
  )
    throw new DomainValidationError("vaultReplacementCheckpointKey", "is invalid");
  return value;
}

export class IndexedDbVaultReplacementRepository {
  private readonly databasePromise: Promise<IDBDatabase>;

  constructor(readonly databaseName = DATABASE_NAME) {
    this.databasePromise = openDatabase(databaseName);
  }

  async create(job: VaultReplacementJobV1): Promise<void> {
    const decoded = decodeVaultReplacementJob(job);
    if (
      decoded.state !== "Created" ||
      decoded.stage !== "ExportGate" ||
      decoded.targetVaultId !== undefined
    )
      throw new DomainValidationError("vaultReplacementJob", "must begin at the Export gate");
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultReplacementJobs, STORES.deviceLocalKeys],
      "readwrite",
    );
    try {
      const existing = await requestValue(
        transaction
          .objectStore(STORES.vaultReplacementJobs)
          .getAll(vaultKeyRange(decoded.sourceVaultId)),
      );
      if (
        existing
          .map(decodeVaultReplacementJob)
          .some(
            (candidate) =>
              candidate.state !== "Succeeded" &&
              candidate.state !== "Aborted" &&
              candidate.state !== "Failed",
          )
      )
        throw Object.assign(new Error("A Vault replacement is already active."), {
          id: "VAULT_BUSY",
        });
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      transaction
        .objectStore(STORES.deviceLocalKeys)
        .add(key, vaultKey(decoded.sourceVaultId, keyId(decoded.jobId)));
      transaction
        .objectStore(STORES.vaultReplacementJobs)
        .add(decoded, vaultKey(decoded.sourceVaultId, decoded.jobId));
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async save(job: VaultReplacementJobV1, expectedUpdatedAt: string): Promise<void> {
    const decoded = decodeVaultReplacementJob(job);
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultReplacementJobs, "readwrite");
    try {
      const store = transaction.objectStore(STORES.vaultReplacementJobs);
      const key = vaultKey(decoded.sourceVaultId, decoded.jobId);
      const currentValue = await requestValue(store.get(key));
      if (currentValue === undefined) throw new Error("Vault Replacement Job is missing.");
      const current = decodeVaultReplacementJob(currentValue);
      if (current.updatedAt !== expectedUpdatedAt)
        throw Object.assign(new Error("Vault Replacement Job changed concurrently."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      store.put(decoded, key);
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async latest(sourceVaultId: string): Promise<VaultReplacementJobV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultReplacementJobs, "readonly");
    const values = await requestValue(
      transaction.objectStore(STORES.vaultReplacementJobs).getAll(vaultKeyRange(sourceVaultId)),
    );
    await transactionDone(transaction);
    return values
      .map(decodeVaultReplacementJob)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async latestForVault(vaultId: string): Promise<VaultReplacementJobV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultReplacementJobs, "readonly");
    const values = await requestValue(
      transaction.objectStore(STORES.vaultReplacementJobs).getAll(),
    );
    await transactionDone(transaction);
    return values
      .map(decodeVaultReplacementJob)
      .filter((job) => job.sourceVaultId === vaultId || job.targetVaultId === vaultId)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async find(jobId: string): Promise<VaultReplacementJobV1 | undefined> {
    const database = await this.databasePromise;
    const transaction = database.transaction(STORES.vaultReplacementJobs, "readonly");
    const values = await requestValue(
      transaction.objectStore(STORES.vaultReplacementJobs).getAll(),
    );
    await transactionDone(transaction);
    const matches = values.map(decodeVaultReplacementJob).filter((job) => job.jobId === jobId);
    if (matches.length > 1)
      throw new DomainValidationError("vaultReplacementJob.jobId", "is not unique");
    return matches[0];
  }

  async sealCheckpoint(input: {
    readonly job: VaultReplacementJobV1;
    readonly targetVaultId: string;
    readonly plaintext: Uint8Array;
    readonly updatedAt: string;
  }): Promise<void> {
    const job = decodeVaultReplacementJob(input.job);
    if (job.targetVaultId !== input.targetVaultId)
      throw new DomainValidationError(
        "vaultReplacementCheckpoint.targetVaultId",
        "differs from the Job",
      );
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultReplacementJobs, STORES.vaultReplacementCheckpoints, STORES.deviceLocalKeys],
      "readwrite",
    );
    try {
      const storedJob = await requestValue(
        transaction
          .objectStore(STORES.vaultReplacementJobs)
          .get(vaultKey(job.sourceVaultId, job.jobId)),
      );
      if (
        storedJob === undefined ||
        decodeVaultReplacementJob(storedJob).updatedAt !== job.updatedAt
      )
        throw Object.assign(new Error("Vault Replacement Job changed."), {
          id: "VAULT_CONTEXT_CHANGED",
        });
      const rawKey = await requestValue(
        transaction
          .objectStore(STORES.deviceLocalKeys)
          .get(vaultKey(job.sourceVaultId, keyId(job.jobId))),
      );
      const key = checkpointKey(rawKey);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const checkpoint: VaultReplacementCheckpointV1 = {
        version: 1,
        jobId: job.jobId,
        sourceVaultId: job.sourceVaultId,
        targetVaultId: input.targetVaultId,
        nonce,
        ciphertext: new Uint8Array(
          await crypto.subtle.encrypt(
            {
              name: "AES-GCM",
              iv: nonce,
              additionalData: Uint8Array.from(
                aad(job.jobId, job.sourceVaultId, input.targetVaultId),
              ),
              tagLength: 128,
            },
            key,
            Uint8Array.from(input.plaintext),
          ),
        ),
        updatedAt: input.updatedAt,
      };
      transaction
        .objectStore(STORES.vaultReplacementCheckpoints)
        .put(checkpoint, vaultKey(job.sourceVaultId, job.jobId));
      await transactionDone(transaction);
    } catch (error) {
      abortTransaction(transaction);
      throw storageError(error);
    }
  }

  async openCheckpoint(job: VaultReplacementJobV1): Promise<Uint8Array | undefined> {
    const decodedJob = decodeVaultReplacementJob(job);
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultReplacementCheckpoints, STORES.deviceLocalKeys],
      "readonly",
    );
    const [storedCheckpoint, rawKey] = await Promise.all([
      requestValue(
        transaction
          .objectStore(STORES.vaultReplacementCheckpoints)
          .get(vaultKey(decodedJob.sourceVaultId, decodedJob.jobId)),
      ),
      requestValue(
        transaction
          .objectStore(STORES.deviceLocalKeys)
          .get(vaultKey(decodedJob.sourceVaultId, keyId(decodedJob.jobId))),
      ),
    ]);
    await transactionDone(transaction);
    if (storedCheckpoint === undefined) return undefined;
    const checkpoint = decodeCheckpoint(storedCheckpoint);
    if (
      checkpoint.jobId !== decodedJob.jobId ||
      checkpoint.sourceVaultId !== decodedJob.sourceVaultId ||
      checkpoint.targetVaultId !== decodedJob.targetVaultId
    )
      throw new DomainValidationError("vaultReplacementCheckpoint", "differs from the Job");
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: Uint8Array.from(checkpoint.nonce),
            additionalData: Uint8Array.from(
              aad(checkpoint.jobId, checkpoint.sourceVaultId, checkpoint.targetVaultId),
            ),
            tagLength: 128,
          },
          checkpointKey(rawKey),
          Uint8Array.from(checkpoint.ciphertext),
        ),
      );
    } catch {
      throw Object.assign(new Error("Vault Replacement checkpoint authentication failed."), {
        id: "CRYPTO_AUTHENTICATION_FAILED",
      });
    }
  }

  async clearSensitive(job: VaultReplacementJobV1): Promise<void> {
    const decoded = decodeVaultReplacementJob(job);
    const database = await this.databasePromise;
    const transaction = database.transaction(
      [STORES.vaultReplacementCheckpoints, STORES.deviceLocalKeys],
      "readwrite",
    );
    transaction
      .objectStore(STORES.vaultReplacementCheckpoints)
      .delete(vaultKey(decoded.sourceVaultId, decoded.jobId));
    transaction
      .objectStore(STORES.deviceLocalKeys)
      .delete(vaultKey(decoded.sourceVaultId, keyId(decoded.jobId)));
    await transactionDone(transaction);
  }

  async close(): Promise<void> {
    (await this.databasePromise).close();
  }
}
