import { wipe } from "../../crypto/sodium";
import type { StoredAccountMetadataV1 } from "../../drivers/indexeddb/schema";
import { type AuthenticatedSession, decodeAuthenticatedSession } from "../account/http";
import { bytesToBase64Url } from "../account/wire";
import type { VaultRecordsV1 } from "../vault/contracts";
import { unwrapDeviceSlot, verifyRootKey } from "../vault/slots";
import {
  createDeviceCertificate,
  createDeviceEnrollmentProof,
  createDeviceIdentity,
  createDeviceKeyEnvelope,
  type DeviceCertificateV1,
  type DeviceClientKind,
  type DeviceIdentity,
  type DeviceKeyEnvelopeV1,
  deviceCertificateToWire,
  deviceKeyEnvelopeToWire,
} from "./device";
import { createRecoveryKit, type RecoveryKitV1, recoveryKitToWire, sha256 } from "./kit";
import { decodeRecoveryPhrase, deriveRecoveryKeys, encodeRecoveryPhrase } from "./phrase";
import { encodeRecoveryFile } from "./recovery-file";

interface InitialAttachmentTransport {
  request(
    method: string,
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  putTransfer(url: string, part: number, bytes: Uint8Array): Promise<void>;
  useDeviceAccessToken(accessToken: string): void;
}

export interface InitialDeviceAuthority {
  readonly accountId: string;
  readonly vaultId: string;
  readonly recoveryGenerationId: string;
  readonly identity: DeviceIdentity;
  readonly certificate: DeviceCertificateV1;
  readonly envelopes: readonly DeviceKeyEnvelopeV1[];
  readonly keyEpochs: readonly {
    readonly keyEpochId: string;
    readonly ordinal: number;
    readonly rootKey: Uint8Array;
  }[];
  readonly recoveryKit: RecoveryKitV1;
  readonly remoteGenerationId: string;
  readonly remoteGenerationNumber: number;
  readonly remoteHeadCursor: number;
  readonly session: AuthenticatedSession;
}

interface InitialAttachmentStore {
  saveInitialDevice(authority: InitialDeviceAuthority): Promise<void>;
}

interface PreparedAttachment {
  readonly setupId: string;
  readonly metadata: StoredAccountMetadataV1;
  readonly records: VaultRecordsV1;
  readonly recoveryGenerationId: string;
  readonly keyEpochId: string;
  readonly keyEpochActivatedAt: string;
  readonly entropy: Uint8Array;
  readonly wrappingKey: Uint8Array;
  readonly administratorSeed: Uint8Array;
  readonly rootKey: Uint8Array;
  readonly identity: DeviceIdentity;
  readonly certificate: DeviceCertificateV1;
  readonly envelope: DeviceKeyEnvelopeV1;
  readonly recoveryKit: RecoveryKitV1;
  readonly deviceProofSignature: Uint8Array;
  readonly attachIdempotencyKey: string;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
}

function phraseMismatch(): Error {
  return Object.assign(
    new Error("That Recovery Phrase is not valid. Check all 12 words and try again."),
    { id: "RECOVERY_PHRASE_INVALID" },
  );
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw integrity(field);
  return value as Record<string, unknown>;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

async function wipePreparation(prepared: PreparedAttachment): Promise<void> {
  await Promise.all([
    wipe(prepared.entropy),
    wipe(prepared.wrappingKey),
    wipe(prepared.administratorSeed),
    wipe(prepared.rootKey),
    wipe(prepared.identity.signingSecretKey),
    wipe(prepared.identity.wrappingSecretKey),
  ]);
}

export class InitialVaultAttachmentService {
  private readonly preparations = new Map<string, PreparedAttachment>();

  constructor(
    private readonly transport: InitialAttachmentTransport,
    private readonly store: InitialAttachmentStore,
    private readonly randomUuid: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async prepare(input: {
    readonly metadata: StoredAccountMetadataV1;
    readonly records: VaultRecordsV1;
    readonly displayName: string;
    readonly clientKind: DeviceClientKind;
  }): Promise<{
    readonly setupId: string;
    readonly phrase: string;
    readonly recoveryFile: Uint8Array;
  }> {
    if (input.metadata.scope !== "Account") throw integrity("Account session scope is invalid");
    const setupId = this.randomUuid();
    const recoveryGenerationId = this.randomUuid();
    const keyEpochId = input.records.metadata.activeKeyEpochId;
    const keyEpochActivatedAt = input.records.metadata.createdAt;
    const entropy = crypto.getRandomValues(new Uint8Array(16));
    let wrappingKey: Uint8Array | undefined;
    let administratorSeed: Uint8Array | undefined;
    let rootKey: Uint8Array | undefined;
    let identity: DeviceIdentity | undefined;
    try {
      ({ recoveryKitWrappingKey: wrappingKey, recoveryAdministratorSeed: administratorSeed } =
        await deriveRecoveryKeys({ entropy, vaultId: input.records.metadata.vaultId }));
      rootKey = await unwrapDeviceSlot(input.records.deviceSlot, input.records.deviceKey);
      const importedRootKey = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(rootKey),
        "HKDF",
        false,
        ["deriveBits"],
      );
      await verifyRootKey(
        importedRootKey,
        input.records.deviceSlot,
        input.records.metadata.verifier,
      );
      const recoveryKit = await createRecoveryKit({
        keyring: {
          version: 1,
          vaultId: input.records.metadata.vaultId,
          recoveryGenerationId,
          activeKeyEpochId: keyEpochId,
          keyEpochs: [{ keyEpochId, ordinal: 0, rootKey }],
        },
        recoveryKitWrappingKey: wrappingKey,
        recoveryAdministratorSeed: administratorSeed,
      });
      identity = await createDeviceIdentity({ deviceId: input.records.metadata.deviceId });
      const certificate = await createDeviceCertificate({
        certificateId: this.randomUuid(),
        vaultId: input.records.metadata.vaultId,
        recoveryGenerationId,
        identity,
        displayName: input.displayName,
        clientKind: input.clientKind,
        issuedAt: this.now(),
        recoveryAdministratorSeed: administratorSeed,
      });
      const envelope = await createDeviceKeyEnvelope({
        certificate,
        keyEpochId,
        epochRootKey: rootKey,
        recoveryAdministratorSeed: administratorSeed,
      });
      const deviceProofSignature = await createDeviceEnrollmentProof({
        certificate,
        accountSessionId: input.metadata.sessionId,
        deviceSigningSecretKey: identity.signingSecretKey,
      });
      const prepared: PreparedAttachment = {
        setupId,
        metadata: input.metadata,
        records: input.records,
        recoveryGenerationId,
        keyEpochId,
        keyEpochActivatedAt,
        entropy,
        wrappingKey,
        administratorSeed,
        rootKey,
        identity,
        certificate,
        envelope,
        recoveryKit,
        deviceProofSignature,
        attachIdempotencyKey: this.randomUuid(),
      };
      this.preparations.set(setupId, prepared);
      return {
        setupId,
        phrase: encodeRecoveryPhrase(entropy),
        recoveryFile: encodeRecoveryFile(recoveryKit),
      };
    } catch (error) {
      await Promise.all([
        wipe(entropy),
        ...(wrappingKey === undefined ? [] : [wipe(wrappingKey)]),
        ...(administratorSeed === undefined ? [] : [wipe(administratorSeed)]),
        ...(rootKey === undefined ? [] : [wipe(rootKey)]),
        ...(identity === undefined
          ? []
          : [wipe(identity.signingSecretKey), wipe(identity.wrappingSecretKey)]),
      ]);
      throw error;
    }
  }

  async attach(setupId: string, confirmationPhrase: string): Promise<string> {
    const prepared = this.preparations.get(setupId);
    if (prepared === undefined) throw integrity("Initial attachment preparation is unavailable");
    let confirmationEntropy: Uint8Array | undefined;
    try {
      try {
        confirmationEntropy = decodeRecoveryPhrase(confirmationPhrase);
      } catch {
        throw phraseMismatch();
      }
      if (!sameBytes(confirmationEntropy, prepared.entropy)) throw phraseMismatch();
      const generationBytes = prepared.records.generation.envelopeBytes;
      const digest = await sha256(generationBytes);
      const attached = object(
        (
          await this.transport.request(
            "POST",
            "/api/vaults",
            {
              vaultId: prepared.records.metadata.vaultId,
              generationId: prepared.records.generation.generationId,
              generationNumber: prepared.records.generation.generationNumber,
              recoveryGeneration: recoveryKitToWire(prepared.recoveryKit),
              keyEpochs: [
                {
                  keyEpochId: prepared.keyEpochId,
                  ordinal: 0,
                  activatedAt: prepared.keyEpochActivatedAt,
                },
              ],
              activeKeyEpochId: prepared.keyEpochId,
              deviceCertificate: deviceCertificateToWire(prepared.certificate),
              deviceKeyEnvelopes: [deviceKeyEnvelopeToWire(prepared.envelope)],
              deviceProofSignature: bytesToBase64Url(prepared.deviceProofSignature),
              generationObject: {
                objectId: prepared.records.generation.generationId,
                objectType: "VaultGeneration",
                keyEpochId: prepared.keyEpochId,
                byteLength: generationBytes.byteLength,
                sha256: bytesToBase64Url(digest),
              },
            },
            prepared.attachIdempotencyKey,
          )
        ).body,
        "Vault attachment is invalid",
      );
      const upload = object(attached.upload, "Vault upload is invalid");
      const ticket = object(attached.ticket, "Vault upload ticket is invalid");
      if (
        typeof upload.uploadId !== "string" ||
        typeof upload.partSizeBytes !== "number" ||
        !Number.isSafeInteger(upload.partSizeBytes) ||
        upload.partSizeBytes <= 0 ||
        typeof ticket.url !== "string"
      )
        throw integrity("Vault upload is invalid");
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
      const session = decodeAuthenticatedSession(attached.session);
      if (
        session.scope !== "VaultDevice" ||
        session.account.accountId !== prepared.metadata.accountId
      )
        throw integrity("VaultDevice session identity changed");
      this.transport.useDeviceAccessToken(session.accessToken);
      await this.transport.request(
        "POST",
        `/api/vaults/${prepared.records.metadata.vaultId}/uploads/${upload.uploadId}/complete`,
        {},
        this.randomUuid(),
      );
      await this.transport.request(
        "POST",
        `/api/vaults/${prepared.records.metadata.vaultId}/complete`,
        { generationId: prepared.records.generation.generationId },
        this.randomUuid(),
      );
      await this.store.saveInitialDevice({
        accountId: prepared.metadata.accountId,
        vaultId: prepared.records.metadata.vaultId,
        recoveryGenerationId: prepared.recoveryGenerationId,
        identity: prepared.identity,
        certificate: prepared.certificate,
        envelopes: [prepared.envelope],
        keyEpochs: [
          {
            keyEpochId: prepared.keyEpochId,
            ordinal: 0,
            rootKey: prepared.rootKey,
          },
        ],
        recoveryKit: prepared.recoveryKit,
        remoteGenerationId: prepared.records.generation.generationId,
        remoteGenerationNumber: prepared.records.generation.generationNumber,
        remoteHeadCursor: 1,
        session,
      });
      return session.accessToken;
    } finally {
      this.preparations.delete(setupId);
      if (confirmationEntropy !== undefined) await wipe(confirmationEntropy);
      await wipePreparation(prepared);
    }
  }

  async cancel(setupId: string): Promise<void> {
    const prepared = this.preparations.get(setupId);
    if (prepared === undefined) return;
    this.preparations.delete(setupId);
    await wipePreparation(prepared);
  }
}
