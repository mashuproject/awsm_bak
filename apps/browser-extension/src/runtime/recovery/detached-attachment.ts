import { wipe } from "../../crypto/sodium";
import type { LoadedDetachedVaultAuthority } from "../../drivers/indexeddb/device-repository";
import type { StoredAccountMetadataV1 } from "../../drivers/indexeddb/schema";
import { type AuthenticatedSession, decodeAuthenticatedSession } from "../account/http";
import { bytesToBase64Url } from "../account/wire";
import type { VaultRecordsV1 } from "../vault/contracts";
import {
  createDeviceEnrollmentProof,
  deviceCertificateToWire,
  deviceKeyEnvelopeToWire,
} from "./device";
import type { InitialDeviceAuthority } from "./initial-attachment";
import { recoveryKitToWire, sha256 } from "./kit";

interface DetachedAttachmentTransport {
  request(
    method: string,
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  putTransfer(url: string, part: number, bytes: Uint8Array): Promise<void>;
  useDeviceAccessToken(accessToken: string): void;
}

interface DetachedAttachmentStore {
  saveReattachedDevice(authority: InitialDeviceAuthority): Promise<void>;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw integrity(message);
  return value as Record<string, unknown>;
}

async function derivedUuid(namespace: string, label: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${namespace}\n${label}`)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class DetachedVaultAttachmentService {
  constructor(
    private readonly transport: DetachedAttachmentTransport,
    private readonly store: DetachedAttachmentStore,
  ) {}

  async attach(input: {
    readonly account: StoredAccountMetadataV1;
    readonly records: VaultRecordsV1;
    readonly authority: LoadedDetachedVaultAuthority;
  }): Promise<AuthenticatedSession> {
    const { account, records, authority } = input;
    const vaultId = records.metadata.vaultId;
    const activeKeyEpochId = records.metadata.activeKeyEpochId;
    if (
      account.scope !== "Account" ||
      authority.vaultId !== vaultId ||
      authority.certificate.content.vaultId !== vaultId ||
      authority.recoveryKit.vaultId !== vaultId ||
      authority.recoveryKit.recoveryGenerationId !== authority.recoveryGenerationId ||
      authority.keyEpochs.length === 0 ||
      authority.envelopes.length !== authority.keyEpochs.length ||
      authority.keyEpochs.some((epoch, ordinal) => epoch.ordinal !== ordinal) ||
      authority.keyEpochs.at(-1)?.keyEpochId !== activeKeyEpochId
    )
      throw integrity("Detached Vault authority does not match the active Vault.");

    const envelopes = authority.keyEpochs.map((epoch) => {
      const envelope = authority.envelopes.find(
        (candidate) => candidate.metadata.keyEpochId === epoch.keyEpochId,
      );
      if (envelope === undefined)
        throw integrity("Detached Vault authority is missing a Key Epoch envelope.");
      return envelope;
    });
    const firstActivation = Date.parse(records.metadata.createdAt);
    if (!Number.isFinite(firstActivation))
      throw integrity("Detached Vault activation timestamp is invalid.");
    const generationBytes = records.generation.envelopeBytes;
    const namespace = `${account.accountId}\n${vaultId}`;
    let session: AuthenticatedSession | undefined;
    try {
      const proof = await createDeviceEnrollmentProof({
        certificate: authority.certificate,
        accountSessionId: account.sessionId,
        deviceSigningSecretKey: authority.identity.signingSecretKey,
      });
      const attached = record(
        (
          await this.transport.request(
            "POST",
            "/api/vaults",
            {
              vaultId,
              generationId: records.generation.generationId,
              generationNumber: records.generation.generationNumber,
              recoveryGeneration: recoveryKitToWire(authority.recoveryKit),
              keyEpochs: authority.keyEpochs.map((epoch) => ({
                keyEpochId: epoch.keyEpochId,
                ordinal: epoch.ordinal,
                activatedAt: new Date(firstActivation + epoch.ordinal).toISOString(),
              })),
              activeKeyEpochId,
              deviceCertificate: deviceCertificateToWire(authority.certificate),
              deviceKeyEnvelopes: envelopes.map(deviceKeyEnvelopeToWire),
              deviceProofSignature: bytesToBase64Url(proof),
              generationObject: {
                objectId: records.generation.generationId,
                objectType: "VaultGeneration",
                keyEpochId: activeKeyEpochId,
                byteLength: generationBytes.byteLength,
                sha256: bytesToBase64Url(await sha256(generationBytes)),
              },
            },
            await derivedUuid(namespace, "attach"),
          )
        ).body,
        "Detached Vault attachment response is invalid.",
      );
      const upload = record(attached.upload, "Detached Vault upload is invalid.");
      const ticket = record(attached.ticket, "Detached Vault upload ticket is invalid.");
      if (
        typeof upload.uploadId !== "string" ||
        typeof upload.partSizeBytes !== "number" ||
        !Number.isSafeInteger(upload.partSizeBytes) ||
        upload.partSizeBytes <= 0 ||
        typeof ticket.url !== "string"
      )
        throw integrity("Detached Vault upload is invalid.");
      for (let part = 0; part * upload.partSizeBytes < generationBytes.byteLength; part += 1) {
        const first = part * upload.partSizeBytes;
        await this.transport.putTransfer(
          ticket.url,
          part,
          generationBytes.subarray(
            first,
            Math.min(first + upload.partSizeBytes, generationBytes.byteLength),
          ),
        );
      }
      session = decodeAuthenticatedSession(attached.session);
      if (session.scope !== "VaultDevice" || session.account.accountId !== account.accountId)
        throw integrity("Detached Vault Device session identity changed.");
      this.transport.useDeviceAccessToken(session.accessToken);
      await this.transport.request(
        "POST",
        `/api/vaults/${vaultId}/uploads/${upload.uploadId}/complete`,
        {},
        await derivedUuid(namespace, "upload-complete"),
      );
      await this.transport.request(
        "POST",
        `/api/vaults/${vaultId}/complete`,
        { generationId: records.generation.generationId },
        await derivedUuid(namespace, "vault-complete"),
      );
      await this.store.saveReattachedDevice({
        accountId: account.accountId,
        vaultId,
        recoveryGenerationId: authority.recoveryGenerationId,
        identity: authority.identity,
        certificate: authority.certificate,
        envelopes,
        keyEpochs: authority.keyEpochs,
        recoveryKit: {
          metadata: authority.recoveryKit.metadata,
          ciphertext: authority.recoveryKit.ciphertext,
        },
        remoteGenerationId: records.generation.generationId,
        remoteGenerationNumber: records.generation.generationNumber,
        remoteHeadCursor: 1,
        session,
      });
      return session;
    } finally {
      await Promise.all([
        wipe(authority.identity.signingSecretKey),
        wipe(authority.identity.wrappingSecretKey),
        ...authority.keyEpochs.map((epoch) => wipe(epoch.rootKey)),
      ]);
    }
  }
}
