import type { ArtifactReferenceV1 } from "../../domain/artifact-graph";
import type { StoredArtifactObjectV1 } from "../../drivers/indexeddb/schema";
import type { VaultKeyring } from "../vault/keyring";
import { transientPlaintextStream } from "./resolver-plaintext";
import { verifiedArtifactStream } from "./resolver-stream";
import { decodeArtifactDownload } from "./resolver-wire";
import type { ArtifactStore } from "./store";

export type RemoteArtifactScope =
  | { readonly type: "ActiveGeneration"; readonly generationId: string }
  | { readonly type: "RecoveryGeneration"; readonly generationId: string };

export interface ArtifactResolution {
  readonly retention: "Local" | "Transient";
  readonly stream: ReadableStream<Uint8Array>;
}

interface ArtifactAvailability {
  isArtifactRemoteOnly(vaultId: string, artifactObjectId: string): Promise<boolean>;
  clearArtifactRemoteOnly(vaultId: string, artifactObjectId: string): Promise<void>;
}

interface RemoteArtifactTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  getTransfer(url: string, expectedByteLength: number): Promise<ReadableStream<Uint8Array>>;
}

interface Connectivity {
  online(): boolean;
}

export interface ArtifactRetrievalFaults {
  afterPartialLocalWrite(): Promise<void>;
  afterLocalVerify(): Promise<void>;
  beforeAvailabilityClear(): Promise<void>;
}

const noArtifactRetrievalFaults: ArtifactRetrievalFaults = {
  afterPartialLocalWrite: () => Promise.resolve(),
  afterLocalVerify: () => Promise.resolve(),
  beforeAvailabilityClear: () => Promise.resolve(),
};

export interface OpenEncryptedArtifactInput {
  readonly vaultId: string;
  readonly serverOrigin: string;
  readonly object: StoredArtifactObjectV1;
  readonly scope: RemoteArtifactScope;
  readonly retention: "RestoreLocal" | "Transient";
  readonly signal?: AbortSignal;
}

export interface OpenPlaintextArtifactInput extends OpenEncryptedArtifactInput {
  readonly reference: ArtifactReferenceV1;
  readonly keyring: VaultKeyring;
}

function runtimeError(id: string, message: string): Error {
  return Object.assign(new Error(message), { id });
}

function isErrorId(error: unknown, id: string): boolean {
  return error instanceof Error && "id" in error && error.id === id;
}

export class ArtifactResolver {
  constructor(
    private readonly artifacts: Pick<
      ArtifactStore,
      "has" | "verifyEncrypted" | "openEncrypted" | "openPlaintext" | "prepareEncrypted"
    >,
    private readonly availability: ArtifactAvailability,
    private readonly remote: RemoteArtifactTransport,
    private readonly connectivity: Connectivity,
    private readonly invalidate: () => void = () => undefined,
    private readonly faults: ArtifactRetrievalFaults = noArtifactRetrievalFaults,
  ) {}

  async openPlaintext(input: OpenPlaintextArtifactInput): Promise<ArtifactResolution> {
    const encrypted = await this.openEncrypted(input);
    if (encrypted.retention === "Local") {
      await encrypted.stream.cancel();
      return {
        retention: "Local",
        stream: await this.artifacts.openPlaintext({
          vaultId: input.vaultId,
          object: input.object,
          reference: input.reference,
          keyring: input.keyring,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      };
    }
    return {
      retention: "Transient",
      stream: await transientPlaintextStream({
        vaultId: input.vaultId,
        object: input.object,
        reference: input.reference,
        keyring: input.keyring,
        encrypted: encrypted.stream,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    };
  }

  async openEncrypted(input: OpenEncryptedArtifactInput): Promise<ArtifactResolution> {
    input.signal?.throwIfAborted();
    if (await this.artifacts.has(input.vaultId, input.object.objectId)) {
      if (!(await this.artifacts.verifyEncrypted(input.vaultId, input.object)))
        throw runtimeError("BUNDLE_INVALID", "The local Artifact wrapper is corrupt.");
      if (await this.availability.isArtifactRemoteOnly(input.vaultId, input.object.objectId)) {
        await this.availability.clearArtifactRemoteOnly(input.vaultId, input.object.objectId);
        this.invalidate();
      }
      return {
        retention: "Local",
        stream: await this.artifacts.openEncrypted(input.vaultId, input.object.objectId),
      };
    }
    if (!(await this.availability.isArtifactRemoteOnly(input.vaultId, input.object.objectId)))
      throw runtimeError("BUNDLE_INVALID", "The local Artifact wrapper is missing.");
    if (input.retention === "Transient") return this.openTransient(input);
    try {
      const encrypted = await verifiedArtifactStream(
        await this.download(input),
        input.object,
        input.signal,
      );
      await this.artifacts.prepareEncrypted({
        vaultId: input.vaultId,
        object: input.object,
        encrypted,
        afterFirstWrite: () => this.faults.afterPartialLocalWrite(),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (isErrorId(error, "STORAGE_QUOTA_EXCEEDED")) return this.openTransient(input);
      throw error;
    }
    if (!(await this.artifacts.verifyEncrypted(input.vaultId, input.object)))
      throw runtimeError(
        "REMOTE_ARTIFACT_INTEGRITY_FAILED",
        "Restored Artifact verification failed.",
      );
    await this.faults.afterLocalVerify();
    await this.faults.beforeAvailabilityClear();
    await this.availability.clearArtifactRemoteOnly(input.vaultId, input.object.objectId);
    this.invalidate();
    return {
      retention: "Local",
      stream: await this.artifacts.openEncrypted(input.vaultId, input.object.objectId),
    };
  }

  async openRemoteEncrypted(
    input: OpenEncryptedArtifactInput,
  ): Promise<ReadableStream<Uint8Array>> {
    input.signal?.throwIfAborted();
    return verifiedArtifactStream(await this.download(input), input.object, input.signal);
  }

  private async openTransient(input: OpenEncryptedArtifactInput): Promise<ArtifactResolution> {
    return {
      retention: "Transient",
      stream: await verifiedArtifactStream(await this.download(input), input.object, input.signal),
    };
  }

  private async download(input: OpenEncryptedArtifactInput): Promise<ReadableStream<Uint8Array>> {
    if (!this.connectivity.online())
      throw runtimeError("REMOTE_ARTIFACT_OFFLINE", "The Artifact is unavailable while offline.");
    const path =
      input.scope.type === "ActiveGeneration"
        ? `/api/vaults/${input.vaultId}/records/${input.object.objectId}/downloads`
        : `/api/vaults/${input.vaultId}/recoveries/${input.scope.generationId}/records/${input.object.objectId}/downloads`;
    try {
      const response = await this.remote.request("POST", path, undefined, crypto.randomUUID());
      if (response.status !== 200)
        throw runtimeError("REMOTE_ARTIFACT_UNAVAILABLE", "The Artifact server is unavailable.");
      const url = decodeArtifactDownload(response.body, input.object, input.serverOrigin);
      return await this.remote.getTransfer(url, input.object.envelopeByteLength);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (isErrorId(error, "REMOTE_ARTIFACT_INTEGRITY_FAILED")) throw error;
      if (isErrorId(error, "SYNCHRONIZATION_AUTHENTICATION_REQUIRED"))
        throw runtimeError(
          "REMOTE_ARTIFACT_AUTHENTICATION_REQUIRED",
          "Sign in to retrieve this Artifact.",
        );
      if (
        error instanceof Error &&
        "status" in error &&
        (error.status === 404 || error.status === 410)
      )
        throw runtimeError("REMOTE_ARTIFACT_NOT_FOUND", "The remote Artifact was not found.");
      throw runtimeError("REMOTE_ARTIFACT_UNAVAILABLE", "The Artifact server is unavailable.");
    }
  }
}
