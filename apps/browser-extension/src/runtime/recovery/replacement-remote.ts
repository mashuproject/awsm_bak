import type { StoredAccountMetadataV1 } from "../../drivers/indexeddb/schema";
import { type AuthenticatedSession, decodeAuthenticatedSession } from "../account/http";
import { bytesToBase64Url } from "../account/wire";
import type { PreparedVault } from "../vault/contracts";
import {
  type DeviceCertificateV1,
  type DeviceKeyEnvelopeV1,
  deviceCertificateToWire,
  deviceKeyEnvelopeToWire,
} from "./device";
import { type RecoveryKitV1, recoveryKitToWire, sha256 } from "./kit";
import type { PreparedVaultReplacement } from "./replacement-rewrite";

export type ReplacementRemoteGraph = Pick<
  PreparedVaultReplacement,
  "generation" | "head" | "objects" | "events"
>;

interface ReplacementTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  putTransfer(url: string, part: number, bytes: Uint8Array): Promise<void>;
  useDeviceAccessToken(accessToken: string): void;
}

export interface ReplacementSourceFence {
  readonly sourceVaultId: string;
  readonly generationId: string;
  readonly generationNumber: number;
  readonly headCursor: number;
}

export interface ReplacementRemoteIdempotency {
  readonly candidateIdempotencyKey: string;
  readonly generationUploadCompleteIdempotencyKey: string;
  readonly candidateCompleteIdempotencyKey: string;
  readonly activationIdempotencyKey: string;
}

export interface ReplacementCandidateAuthority {
  readonly account: StoredAccountMetadataV1;
  readonly target: PreparedVault;
  readonly keyEpochActivatedAt: string;
  readonly certificate: DeviceCertificateV1;
  readonly envelope: DeviceKeyEnvelopeV1;
  readonly recoveryKit: RecoveryKitV1;
  readonly deviceProofSignature: Uint8Array;
}

export interface StagedVaultReplacement {
  readonly source: ReplacementSourceFence;
  readonly targetVaultId: string;
  readonly targetGenerationId: string;
  readonly targetGenerationNumber: number;
  readonly session: AuthenticatedSession;
  readonly idempotency: ReplacementRemoteIdempotency;
}

export interface ActivatedVaultReplacement {
  readonly sourceVaultId: string;
  readonly targetVaultId: string;
  readonly targetHeadCursor: number;
  readonly purge: {
    readonly purgeId: string;
    readonly state: "Pending" | "Running" | "Succeeded" | "FailedRetryable";
    readonly stage: "Detach" | "Analyze" | "DeleteBytes" | "Tombstone" | "Complete";
    readonly processedBytes: number;
    readonly totalBytes: number;
  };
}

export type ReplacementPurgeStatus = ActivatedVaultReplacement["purge"];

function integrity(message: string): Error {
  return Object.assign(new Error(message), {
    id: "SYNCHRONIZATION_INTEGRITY_FAILED",
  });
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw integrity(message);
  return value as Record<string, unknown>;
}

function counter(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw integrity(message);
  return value;
}

function text(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw integrity(message);
  return value;
}

async function uploadParts(
  transport: ReplacementTransport,
  url: string,
  partSize: number,
  bytes: Uint8Array,
): Promise<void> {
  if (!Number.isSafeInteger(partSize) || partSize <= 0)
    throw integrity("Replacement Generation upload is invalid.");
  for (let part = 0; part * partSize < bytes.byteLength; part += 1) {
    const first = part * partSize;
    await transport.putTransfer(
      url,
      part,
      bytes.subarray(first, Math.min(first + partSize, bytes.byteLength)),
    );
  }
}

export class VaultReplacementRemote {
  constructor(private readonly transport: ReplacementTransport) {}

  useAccessToken(accessToken: string): void {
    if (accessToken.length === 0) throw integrity("Replacement Device authority is invalid.");
    this.transport.useDeviceAccessToken(accessToken);
  }

  useSession(session: AuthenticatedSession): void {
    if (session.scope !== "VaultDevice")
      throw integrity("Replacement Device authority is invalid.");
    this.useAccessToken(session.accessToken);
  }

  async stage(input: {
    readonly source: ReplacementSourceFence;
    readonly authority: ReplacementCandidateAuthority;
    readonly replacement: ReplacementRemoteGraph;
    readonly idempotency: ReplacementRemoteIdempotency;
  }): Promise<StagedVaultReplacement> {
    const { source, authority, replacement } = input;
    const targetVaultId = authority.target.records.metadata.vaultId;
    const targetDeviceId = authority.target.records.metadata.deviceId;
    const targetKeyEpochId = authority.target.records.metadata.activeKeyEpochId;
    if (
      authority.account.scope !== "Account" ||
      replacement.head.vaultId !== targetVaultId ||
      replacement.generation.generationId !== replacement.head.generationId ||
      replacement.generation.generationNumber !== replacement.head.generationNumber ||
      replacement.generation.generationNumber !== 0 ||
      authority.certificate.content.vaultId !== targetVaultId ||
      authority.certificate.content.deviceId !== targetDeviceId ||
      authority.envelope.metadata.keyEpochId !== targetKeyEpochId ||
      authority.recoveryKit.metadata.vaultId !== targetVaultId
    )
      throw integrity("Replacement authority and graph do not match.");

    const generationBytes = replacement.generation.envelopeBytes;
    const response = record(
      (
        await this.transport.request(
          "POST",
          `/api/vaults/${source.sourceVaultId}/replacement-candidates`,
          {
            accountSessionId: authority.account.sessionId,
            expectedSourceGenerationId: source.generationId,
            expectedSourceGenerationNumber: source.generationNumber,
            expectedSourceHeadCursor: source.headCursor,
            replacement: {
              vaultId: targetVaultId,
              generationId: replacement.generation.generationId,
              generationNumber: replacement.generation.generationNumber,
              recoveryGeneration: recoveryKitToWire(authority.recoveryKit),
              keyEpochs: [
                {
                  keyEpochId: targetKeyEpochId,
                  ordinal: 0,
                  activatedAt: authority.keyEpochActivatedAt,
                },
              ],
              activeKeyEpochId: targetKeyEpochId,
              deviceCertificate: deviceCertificateToWire(authority.certificate),
              deviceKeyEnvelopes: [deviceKeyEnvelopeToWire(authority.envelope)],
              deviceProofSignature: bytesToBase64Url(authority.deviceProofSignature),
              generationObject: {
                objectId: replacement.generation.generationId,
                objectType: "VaultGeneration",
                keyEpochId: targetKeyEpochId,
                byteLength: generationBytes.byteLength,
                sha256: bytesToBase64Url(await sha256(generationBytes)),
              },
            },
          },
          input.idempotency.candidateIdempotencyKey,
        )
      ).body,
      "Replacement candidate response is invalid.",
    );
    const vault = record(response.vault, "Replacement candidate Vault is invalid.");
    const upload = record(response.upload, "Replacement Generation upload is invalid.");
    const ticket = record(response.ticket, "Replacement Generation ticket is invalid.");
    const session = decodeAuthenticatedSession(response.session);
    if (
      vault.vaultId !== targetVaultId ||
      vault.state !== "Provisional" ||
      vault.generationId !== replacement.generation.generationId ||
      vault.generationNumber !== replacement.generation.generationNumber ||
      upload.objectId !== replacement.generation.generationId ||
      session.scope !== "VaultDevice" ||
      session.account.accountId !== authority.account.accountId
    )
      throw integrity("Replacement candidate authority changed.");

    await uploadParts(
      this.transport,
      text(ticket.url, "Replacement Generation ticket is invalid."),
      counter(upload.partSizeBytes, "Replacement Generation upload is invalid."),
      generationBytes,
    );
    this.useSession(session);
    const uploadId = text(upload.uploadId, "Replacement Generation upload is invalid.");
    await this.transport.request(
      "POST",
      `/api/vaults/${targetVaultId}/uploads/${uploadId}/complete`,
      undefined,
      input.idempotency.generationUploadCompleteIdempotencyKey,
    );
    const completed = record(
      (
        await this.transport.request(
          "POST",
          `/api/vaults/${targetVaultId}/complete`,
          { generationId: replacement.generation.generationId },
          input.idempotency.candidateCompleteIdempotencyKey,
        )
      ).body,
      "Completed replacement Vault is invalid.",
    );
    if (
      completed.vaultId !== targetVaultId ||
      completed.state !== "Provisional" ||
      completed.generationId !== replacement.generation.generationId ||
      completed.generationNumber !== replacement.generation.generationNumber
    )
      throw integrity("Completed replacement Vault authority changed.");
    return {
      source,
      targetVaultId,
      targetGenerationId: replacement.generation.generationId,
      targetGenerationNumber: replacement.generation.generationNumber,
      session,
      idempotency: input.idempotency,
    };
  }

  async activate(staged: StagedVaultReplacement): Promise<ActivatedVaultReplacement> {
    const response = record(
      (
        await this.transport.request(
          "POST",
          `/api/vaults/${staged.source.sourceVaultId}/replacement-candidates/${staged.targetVaultId}/activate`,
          {
            expectedSourceGenerationId: staged.source.generationId,
            expectedSourceGenerationNumber: staged.source.generationNumber,
            expectedSourceHeadCursor: staged.source.headCursor,
            replacementGenerationId: staged.targetGenerationId,
            replacementGenerationNumber: staged.targetGenerationNumber,
          },
          staged.idempotency.activationIdempotencyKey,
        )
      ).body,
      "Replacement activation response is invalid.",
    );
    const vault = record(response.vault, "Replacement activation Vault is invalid.");
    const purge = record(response.purge, "Replacement purge response is invalid.");
    const state = text(purge.state, "Replacement purge response is invalid.");
    const stage = text(purge.stage, "Replacement purge response is invalid.");
    if (
      response.sourceVaultId !== staged.source.sourceVaultId ||
      response.sourceState !== "Replaced" ||
      vault.vaultId !== staged.targetVaultId ||
      vault.state !== "Active" ||
      vault.generationId !== staged.targetGenerationId ||
      vault.generationNumber !== staged.targetGenerationNumber ||
      !["Pending", "Running", "Succeeded", "FailedRetryable"].includes(state) ||
      !["Detach", "Analyze", "DeleteBytes", "Tombstone", "Complete"].includes(stage)
    )
      throw integrity("Replacement activation authority changed.");
    return {
      sourceVaultId: staged.source.sourceVaultId,
      targetVaultId: staged.targetVaultId,
      targetHeadCursor: counter(vault.headCursor, "Replacement activation Vault is invalid."),
      purge: {
        purgeId: text(purge.purgeId, "Replacement purge response is invalid."),
        state: state as ActivatedVaultReplacement["purge"]["state"],
        stage: stage as ActivatedVaultReplacement["purge"]["stage"],
        processedBytes: counter(purge.processedBytes, "Replacement purge response is invalid."),
        totalBytes: counter(purge.totalBytes, "Replacement purge response is invalid."),
      },
    };
  }

  async purgeStatus(sourceVaultId: string, purgeId: string): Promise<ReplacementPurgeStatus> {
    const purge = record(
      (await this.transport.request("GET", `/api/vaults/${sourceVaultId}/purges/${purgeId}`)).body,
      "Replacement purge response is invalid.",
    );
    const state = text(purge.state, "Replacement purge response is invalid.");
    const stage = text(purge.stage, "Replacement purge response is invalid.");
    if (
      purge.purgeId !== purgeId ||
      !["Pending", "Running", "Succeeded", "FailedRetryable"].includes(state) ||
      !["Detach", "Analyze", "DeleteBytes", "Tombstone", "Complete"].includes(stage)
    )
      throw integrity("Replacement purge authority changed.");
    return {
      purgeId,
      state: state as ReplacementPurgeStatus["state"],
      stage: stage as ReplacementPurgeStatus["stage"],
      processedBytes: counter(purge.processedBytes, "Replacement purge response is invalid."),
      totalBytes: counter(purge.totalBytes, "Replacement purge response is invalid."),
    };
  }
}
