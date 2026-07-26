import { base64UrlToBytes } from "../account/wire";
import type { StorageReliefCandidate } from "./candidates";
import {
  type StorageReliefProof,
  type StorageReliefRemoteRecord,
  storageReliefError,
} from "./contracts";

interface ProofTransport {
  request(
    method: string,
    path: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
}

interface ProofInput {
  readonly vaultId: string;
  readonly generationId: string;
  readonly generationNumber: number;
  readonly candidates: readonly StorageReliefCandidate[];
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw storageReliefError("SYNCHRONIZATION_INTEGRITY_FAILED", `${field} is invalid.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw storageReliefError("SYNCHRONIZATION_INTEGRITY_FAILED", `${field} is invalid.`);
  return value;
}

function counter(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw storageReliefError("SYNCHRONIZATION_INTEGRITY_FAILED", `${field} is invalid.`);
  return value;
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value))
    throw storageReliefError("SYNCHRONIZATION_INTEGRITY_FAILED", `${field} is invalid.`);
  const values = value.map((entry) => string(entry, field));
  if (new Set(values).size !== values.length || values.join("\n") !== values.toSorted().join("\n"))
    throw storageReliefError("SYNCHRONIZATION_INTEGRITY_FAILED", `${field} is not canonical.`);
  return values;
}

function record(value: unknown): readonly [string, StorageReliefRemoteRecord] {
  const input = object(value, "record metadata");
  const objectId = string(input.objectId, "record ID");
  const objectType = input.objectType;
  if (
    input.state !== "Committed" ||
    (objectType !== "VaultGeneration" &&
      objectType !== "Artifact" &&
      objectType !== "BundleDescriptor" &&
      objectType !== "Event")
  )
    throw storageReliefError(
      "SYNCHRONIZATION_INTEGRITY_FAILED",
      "Record is not committed or has the wrong type.",
    );
  const event = objectType === "Event";
  const allowed = new Set([
    "objectId",
    "objectType",
    "keyEpochId",
    "byteLength",
    "sha256",
    "state",
    ...(event ? ["orderingTimestamp", "dependencyObjectIds"] : []),
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw storageReliefError(
      "SYNCHRONIZATION_INTEGRITY_FAILED",
      "Record metadata has unsupported fields.",
    );
  if (event) string(input.orderingTimestamp, "Event ordering timestamp");
  return [
    objectId,
    {
      objectType,
      keyEpochId: string(input.keyEpochId, "record key epoch ID"),
      byteLength: counter(input.byteLength, "record byte length"),
      sha256: base64UrlToBytes(string(input.sha256, "record checksum"), 32),
      ...(event
        ? {
            dependencyObjectIds: strings(input.dependencyObjectIds, "Event dependencies"),
          }
        : {}),
    },
  ];
}

function page(
  value: unknown,
  expectedGenerationId: string,
  expectedGenerationNumber: number,
): {
  readonly records: readonly (readonly [string, StorageReliefRemoteRecord])[];
  readonly hasMore: boolean;
  readonly nextObjectId?: string;
} {
  const input = object(value, "record page");
  const allowed = new Set([
    "generationId",
    "generationNumber",
    "records",
    "hasMore",
    "nextObjectId",
  ]);
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    input.generationId !== expectedGenerationId ||
    input.generationNumber !== expectedGenerationNumber ||
    !Array.isArray(input.records) ||
    typeof input.hasMore !== "boolean"
  )
    throw storageReliefError("SYNCHRONIZATION_CONFLICT", "Active Generation changed.");
  return {
    records: input.records.map(record),
    hasMore: input.hasMore,
    ...(input.hasMore ? { nextObjectId: string(input.nextObjectId, "record cursor") } : {}),
  };
}

export class ActiveGenerationStorageReliefProver {
  constructor(private readonly transport: ProofTransport) {}

  async prove(input: ProofInput): Promise<StorageReliefProof> {
    const records = new Map<string, StorageReliefRemoteRecord>();
    let after: string | undefined;
    for (;;) {
      const path = `/api/vaults/${input.vaultId}/records?limit=100${after === undefined ? "" : `&afterObjectId=${encodeURIComponent(after)}`}`;
      const current = page(
        (await this.transport.request("GET", path)).body,
        input.generationId,
        input.generationNumber,
      );
      for (const entry of current.records) {
        if (records.has(entry[0]) || (after !== undefined && entry[0] <= after))
          throw storageReliefError(
            "SYNCHRONIZATION_INTEGRITY_FAILED",
            "Record pages are not strictly lexical.",
          );
        records.set(entry[0], entry[1]);
        after = entry[0];
      }
      if (!current.hasMore) break;
      if (current.nextObjectId !== after)
        throw storageReliefError("SYNCHRONIZATION_INTEGRITY_FAILED", "Record page cursor differs.");
    }
    page(
      (await this.transport.request("GET", `/api/vaults/${input.vaultId}/records?limit=1`)).body,
      input.generationId,
      input.generationNumber,
    );
    return {
      generationId: input.generationId,
      generationNumber: input.generationNumber,
      records,
      closures: new Map(
        input.candidates.map((candidate) => [
          candidate.object.objectId,
          {
            descriptorObjectId: candidate.descriptorObjectId,
            registrationEventId: candidate.registrationEventId,
            dependencyObjectIds: candidate.dependencyObjectIds,
          },
        ]),
      ),
    };
  }
}
