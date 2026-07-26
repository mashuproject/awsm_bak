import type {
  StoredEvent,
  StoredObjectV1,
  StoredVaultGenerationV1,
  StoredVaultHeadV1,
} from "../../drivers/indexeddb/schema";
import type { ArtifactStore } from "../artifact";
import type { VaultKeyring } from "../vault/keyring";
import { RemoteReplicaDownloader, verifyPreparedRemoteReplica } from "./download";
import type { ServerSwitchRecoveryProof } from "./server-switch-classifier";

interface RecoveryTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  getTransfer(url: string, expectedByteLength: number): Promise<ReadableStream<Uint8Array>>;
}

export interface AuthoritativeClosure {
  readonly generation: StoredVaultGenerationV1;
  readonly head: StoredVaultHeadV1;
  readonly events: readonly StoredEvent[];
  readonly objects: readonly StoredObjectV1[];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw Object.assign(new Error("Recovery response is invalid"), {
      id: "SYNCHRONIZATION_INTEGRITY_FAILED",
    });
  return value as Record<string, unknown>;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function objectEqual(left: StoredObjectV1, right: StoredObjectV1): boolean {
  if (left.objectId !== right.objectId || left.objectType !== right.objectType) return false;
  if (left.objectType === "BundleDescriptor" && right.objectType === "BundleDescriptor")
    return bytesEqual(left.envelopeBytes, right.envelopeBytes);
  if (left.objectType === "Artifact" && right.objectType === "Artifact")
    return (
      left.keyEpochId === right.keyEpochId &&
      left.envelopeFormat === right.envelopeFormat &&
      left.envelopeByteLength === right.envelopeByteLength &&
      left.envelopeChecksumAlgorithm === right.envelopeChecksumAlgorithm &&
      bytesEqual(left.envelopeChecksum, right.envelopeChecksum)
    );
  return false;
}

export function authoritativeClosuresEqual(
  left: AuthoritativeClosure,
  right: AuthoritativeClosure,
): boolean {
  if (
    left.generation.generationId !== right.generation.generationId ||
    left.generation.generationNumber !== right.generation.generationNumber ||
    left.generation.predecessorGenerationId !== right.generation.predecessorGenerationId ||
    !bytesEqual(left.generation.envelopeBytes, right.generation.envelopeBytes) ||
    left.head.generationId !== right.head.generationId ||
    left.head.generationNumber !== right.head.generationNumber ||
    left.head.appendedObjectIds.join("\n") !== right.head.appendedObjectIds.join("\n") ||
    left.head.appendedEventIds.join("\n") !== right.head.appendedEventIds.join("\n")
  )
    return false;
  const leftEvents = left.events.toSorted((a, b) => a.eventId.localeCompare(b.eventId));
  const rightEvents = right.events.toSorted((a, b) => a.eventId.localeCompare(b.eventId));
  if (leftEvents.length !== rightEvents.length) return false;
  for (let index = 0; index < leftEvents.length; index += 1) {
    const a = leftEvents[index];
    const b = rightEvents[index];
    if (
      a === undefined ||
      b === undefined ||
      a.eventId !== b.eventId ||
      a.vaultId !== b.vaultId ||
      a.orderingTimestamp !== b.orderingTimestamp ||
      a.referencedObjectIds.join("\n") !== b.referencedObjectIds.join("\n") ||
      !bytesEqual(a.envelopeBytes, b.envelopeBytes)
    )
      return false;
  }
  const leftObjects = left.objects.toSorted((a, b) => a.objectId.localeCompare(b.objectId));
  const rightObjects = right.objects.toSorted((a, b) => a.objectId.localeCompare(b.objectId));
  return (
    leftObjects.length === rightObjects.length &&
    leftObjects.every((entry, index) => {
      const other = rightObjects[index];
      return other !== undefined && objectEqual(entry, other);
    })
  );
}

export class ServerSwitchRecoveryProver {
  constructor(
    private readonly transport: RecoveryTransport,
    private readonly artifacts: Pick<ArtifactStore, "prepareEncrypted" | "openEncrypted">,
  ) {}

  async prove(input: {
    readonly vaultId: string;
    readonly expected: AuthoritativeClosure;
    readonly keyring: VaultKeyring;
  }): Promise<ServerSwitchRecoveryProof> {
    try {
      const listed = record(
        (await this.transport.request("GET", `/api/vaults/${input.vaultId}/recoveries`)).body,
      );
      if (!Array.isArray(listed.recoveries)) return { state: "IntegrityFailure" };
      const matches = listed.recoveries.filter(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          Reflect.get(value, "generationId") === input.expected.generation.generationId,
      );
      if (matches.length === 0) return { state: "Unavailable" };
      if (
        matches.length !== 1 ||
        Reflect.get(matches[0], "generationNumber") !== input.expected.generation.generationNumber
      )
        return { state: "IntegrityFailure" };
      const prepared = await new RemoteReplicaDownloader(this.transport, this.artifacts).prepare(
        {
          version: 1,
          jobId: crypto.randomUUID(),
          accountId: crypto.randomUUID(),
          vaultId: input.vaultId,
          generationId: input.expected.generation.generationId,
          generationNumber: input.expected.generation.generationNumber,
          ...(input.expected.generation.predecessorGenerationId === undefined
            ? {}
            : { predecessorGenerationId: input.expected.generation.predecessorGenerationId }),
          state: "Running",
          stage: "DownloadRecords",
          snapshotCursor: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedItems: 0,
          totalItems: 0,
          processedBytes: 0,
          totalBytes: 0,
          retryCount: 0,
          attachIdempotencyKey: crypto.randomUUID(),
        },
        input.keyring,
        {
          generation: input.expected.generation,
          events: input.expected.events,
          objects: input.expected.objects.filter((object) => object.objectType !== "Artifact"),
        },
        { recoveryGenerationId: input.expected.generation.generationId },
      );
      const verified = await verifyPreparedRemoteReplica({
        vaultId: input.vaultId,
        prepared,
        keyring: input.keyring,
        artifacts: this.artifacts,
      });
      return {
        state: authoritativeClosuresEqual(input.expected, verified) ? "Exact" : "Different",
      };
    } catch (error) {
      const id = error instanceof Error && "id" in error ? error.id : undefined;
      if (id === "RECOVERY_NOT_FOUND" || id === "RECOVERY_EXPIRED") return { state: "Unavailable" };
      if (id === "SYNCHRONIZATION_INTEGRITY_FAILED") return { state: "IntegrityFailure" };
      throw error;
    }
  }
}
