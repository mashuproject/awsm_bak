import { wipe } from "../../crypto/sodium";
import { canonicalRecord, integer, uuid } from "../../domain/validation";
import type { LoadedDeviceAuthority } from "../../drivers/indexeddb/device-repository";
import type { StoredAccountMetadataV1, StoredAccountVaultV1 } from "../../drivers/indexeddb/schema";
import { establishDeviceSession } from "../account/device-session";
import type { AuthenticatedSession } from "../account/http";
import {
  createDeviceCertificate,
  createDeviceKeyEnvelope,
  type DeviceCertificateV1,
  type DeviceIdentity,
  type DeviceKeyEnvelopeV1,
  deviceCertificateFromWire,
  deviceCertificateToWire,
  deviceKeyEnvelopeFromWire,
  deviceKeyEnvelopeToWire,
  openDeviceKeyEnvelope,
  verifyDeviceCertificate,
} from "./device";
import { createRecoveryKit, type RecoveryKitV1, recoveryKitToWire } from "./kit";
import { decodeRecoveryPhrase, deriveRecoveryKeys, encodeRecoveryPhrase } from "./phrase";
import { encodeRecoveryFile } from "./recovery-file";

interface FutureProtectionTransport {
  deviceRequest(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  accountRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  useDeviceAccessToken(accessToken: string): void;
}

interface FutureProtectionStore {
  loadDeviceAuthority(vaultId: string): Promise<LoadedDeviceAuthority | undefined>;
  saveFutureProtectedDevice(authority: FutureProtectedDeviceAuthority): Promise<void>;
}

export interface FutureProtectedDeviceAuthority {
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

interface ListedDevice {
  readonly deviceId: string;
  readonly current: boolean;
  readonly revoked: boolean;
  readonly certificate: DeviceCertificateV1;
}

interface PreparedFutureProtection {
  readonly protectionId: string;
  readonly account: StoredAccountMetadataV1;
  readonly registration: StoredAccountVaultV1;
  readonly targetDeviceId: string;
  readonly authority: LoadedDeviceAuthority;
  readonly devices: readonly ListedDevice[];
  readonly entropy: Uint8Array;
  readonly wrappingKey: Uint8Array;
  readonly administratorSeed: Uint8Array;
  readonly newRootKey: Uint8Array;
  readonly recoveryGenerationId: string;
  readonly keyEpochId: string;
  readonly keyEpochOrdinal: number;
  readonly recoveryKit: RecoveryKitV1;
  readonly certificates: readonly DeviceCertificateV1[];
  readonly envelopes: readonly DeviceKeyEnvelopeV1[];
  readonly idempotencyKey: string;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
}

function phraseMismatch(): Error {
  return Object.assign(new Error("The full Recovery Phrase does not match."), {
    id: "RECOVERY_PHRASE_INVALID",
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

async function wipePrepared(prepared: PreparedFutureProtection): Promise<void> {
  await Promise.all([
    wipe(prepared.entropy),
    wipe(prepared.wrappingKey),
    wipe(prepared.administratorSeed),
    wipe(prepared.newRootKey),
    wipe(prepared.authority.identity.signingSecretKey),
    wipe(prepared.authority.identity.wrappingSecretKey),
    ...prepared.authority.keyEpochs.map((epoch) => wipe(epoch.rootKey)),
  ]);
}

function decodeDeviceList(value: unknown): ListedDevice[] {
  const response = canonicalRecord(value, "deviceList", ["devices"]);
  if (!Array.isArray(response.devices)) throw integrity("Device list is invalid");
  return response.devices.map((value) => {
    const item = canonicalRecord(value, "listedDevice", [
      "deviceId",
      "certificateId",
      "displayName",
      "clientKind",
      "recoveryGenerationId",
      "deviceCertificate",
      "enrolledAt",
      "revokedAt",
      "revocationReason",
      "current",
    ]);
    return {
      deviceId: uuid(item.deviceId, "listedDevice.deviceId"),
      current: item.current === true,
      revoked: item.revokedAt !== undefined,
      certificate: deviceCertificateFromWire(item.deviceCertificate),
    };
  });
}

export class FutureProtectionService {
  private readonly preparations = new Map<string, PreparedFutureProtection>();

  constructor(
    private readonly transport: FutureProtectionTransport,
    private readonly store: FutureProtectionStore,
    private readonly randomUuid: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async listDevices(vaultId: string): Promise<
    readonly {
      readonly deviceId: string;
      readonly displayName: string;
      readonly clientKind: string;
      readonly current: boolean;
      readonly revoked: boolean;
    }[]
  > {
    const devices = decodeDeviceList(
      (await this.transport.deviceRequest("GET", `/api/vaults/${vaultId}/devices`)).body,
    );
    await Promise.all(devices.map((device) => verifyDeviceCertificate(device.certificate)));
    return devices.map((device) => ({
      deviceId: device.deviceId,
      displayName: device.certificate.content.displayName,
      clientKind: device.certificate.content.clientKind,
      current: device.current,
      revoked: device.revoked,
    }));
  }

  async prepare(input: {
    readonly account: StoredAccountMetadataV1;
    readonly registration: StoredAccountVaultV1;
    readonly targetDeviceId: string;
  }): Promise<{
    readonly protectionId: string;
    readonly phrase: string;
    readonly recoveryFile: Uint8Array;
  }> {
    if (
      input.account.scope !== "Account" ||
      input.registration.accountId !== input.account.accountId ||
      input.registration.activeRecoveryGenerationId === undefined ||
      input.registration.activeKeyEpochId === undefined
    )
      throw integrity("Future Protection Account authority is incomplete");
    const authority = await this.store.loadDeviceAuthority(input.registration.vaultId);
    if (
      authority === undefined ||
      authority.accountId !== input.account.accountId ||
      authority.recoveryGenerationId !== input.registration.activeRecoveryGenerationId ||
      authority.keyEpochs.at(-1)?.keyEpochId !== input.registration.activeKeyEpochId
    )
      throw integrity("Future Protection Device authority is stale");
    const remoteVault = canonicalRecord(
      (await this.transport.deviceRequest("GET", `/api/vaults/${input.registration.vaultId}`)).body,
      "futureProtectionVault",
      [
        "vaultId",
        "state",
        "generationId",
        "generationNumber",
        "headCursor",
        "activeKeyEpochId",
        "predecessorGenerationId",
      ],
    );
    if (
      remoteVault.vaultId !== input.registration.vaultId ||
      remoteVault.activeKeyEpochId !== input.registration.activeKeyEpochId
    )
      throw integrity("Future Protection remote authority changed");
    const devices = decodeDeviceList(
      (
        await this.transport.deviceRequest(
          "GET",
          `/api/vaults/${input.registration.vaultId}/devices`,
        )
      ).body,
    );
    await Promise.all(devices.map((device) => verifyDeviceCertificate(device.certificate)));
    const active = devices.filter((device) => !device.revoked);
    const current = active.find((device) => device.current);
    const target = active.find((device) => device.deviceId === input.targetDeviceId);
    if (
      current?.deviceId !== authority.identity.deviceId ||
      target === undefined ||
      target.current ||
      active.length < 2 ||
      active.some(
        (device) =>
          device.certificate.content.recoveryGenerationId !==
          input.registration.activeRecoveryGenerationId,
      )
    )
      throw integrity("Future Protection Device set changed");

    const entropy = crypto.getRandomValues(new Uint8Array(16));
    let wrappingKey: Uint8Array | undefined;
    let administratorSeed: Uint8Array | undefined;
    const newRootKey = crypto.getRandomValues(new Uint8Array(32));
    try {
      const recoveryKeys = await deriveRecoveryKeys({
        entropy,
        vaultId: input.registration.vaultId,
      });
      wrappingKey = recoveryKeys.recoveryKitWrappingKey;
      administratorSeed = recoveryKeys.recoveryAdministratorSeed;
      const recoveryGenerationId = this.randomUuid();
      const keyEpochId = this.randomUuid();
      const keyEpochOrdinal = authority.keyEpochs.length;
      const keyEpochs = [
        ...authority.keyEpochs.map((epoch) => ({
          keyEpochId: epoch.keyEpochId,
          ordinal: epoch.ordinal,
          rootKey: Uint8Array.from(epoch.rootKey),
        })),
        { keyEpochId, ordinal: keyEpochOrdinal, rootKey: newRootKey },
      ];
      const recoveryKit = await createRecoveryKit({
        keyring: {
          version: 1,
          vaultId: input.registration.vaultId,
          recoveryGenerationId,
          activeKeyEpochId: keyEpochId,
          keyEpochs,
        },
        recoveryKitWrappingKey: wrappingKey,
        recoveryAdministratorSeed: administratorSeed,
      });
      const remaining = active.filter((device) => device.deviceId !== target.deviceId);
      const certificates = await Promise.all(
        remaining.map((device) =>
          createDeviceCertificate({
            certificateId: this.randomUuid(),
            vaultId: input.registration.vaultId,
            recoveryGenerationId,
            identity: device.certificate.content,
            displayName: device.certificate.content.displayName,
            clientKind: device.certificate.content.clientKind,
            issuedAt: this.now(),
            recoveryAdministratorSeed: recoveryKeys.recoveryAdministratorSeed,
          }),
        ),
      );
      const envelopes = await Promise.all(
        certificates.map((certificate) =>
          createDeviceKeyEnvelope({
            certificate,
            keyEpochId,
            epochRootKey: newRootKey,
            recoveryAdministratorSeed: recoveryKeys.recoveryAdministratorSeed,
          }),
        ),
      );
      const prepared: PreparedFutureProtection = {
        protectionId: this.randomUuid(),
        account: input.account,
        registration: input.registration,
        targetDeviceId: target.deviceId,
        authority,
        devices,
        entropy,
        wrappingKey,
        administratorSeed,
        newRootKey,
        recoveryGenerationId,
        keyEpochId,
        keyEpochOrdinal,
        recoveryKit,
        certificates,
        envelopes,
        idempotencyKey: this.randomUuid(),
      };
      this.preparations.set(prepared.protectionId, prepared);
      return {
        protectionId: prepared.protectionId,
        phrase: encodeRecoveryPhrase(entropy),
        recoveryFile: encodeRecoveryFile(recoveryKit),
      };
    } catch (error) {
      await Promise.all([
        wipe(entropy),
        wipe(newRootKey),
        wipe(authority.identity.signingSecretKey),
        wipe(authority.identity.wrappingSecretKey),
        ...authority.keyEpochs.map((epoch) => wipe(epoch.rootKey)),
        ...(wrappingKey === undefined ? [] : [wipe(wrappingKey)]),
        ...(administratorSeed === undefined ? [] : [wipe(administratorSeed)]),
      ]);
      throw error;
    }
  }

  async protect(protectionId: string, confirmationPhrase: string): Promise<string> {
    const prepared = this.preparations.get(protectionId);
    if (prepared === undefined) throw integrity("Future Protection preparation is unavailable");
    let confirmationEntropy: Uint8Array | undefined;
    let installedRoot: Uint8Array | undefined;
    try {
      try {
        confirmationEntropy = decodeRecoveryPhrase(confirmationPhrase);
      } catch {
        throw phraseMismatch();
      }
      if (!sameBytes(confirmationEntropy, prepared.entropy)) throw phraseMismatch();
      const remainingDevices = prepared.certificates.map((certificate, index) => {
        const envelope = prepared.envelopes[index];
        if (envelope === undefined) throw integrity("Future Protection envelope set changed");
        return {
          deviceCertificate: deviceCertificateToWire(certificate),
          deviceKeyEnvelope: deviceKeyEnvelopeToWire(envelope),
        };
      });
      const rotated = canonicalRecord(
        (
          await this.transport.deviceRequest(
            "POST",
            `/api/vaults/${prepared.registration.vaultId}/future-protections`,
            {
              expectedRecoveryGenerationId: prepared.registration.activeRecoveryGenerationId,
              expectedKeyEpochId: prepared.registration.activeKeyEpochId,
              targetDeviceId: prepared.targetDeviceId,
              recoveryGeneration: recoveryKitToWire(prepared.recoveryKit),
              keyEpoch: {
                keyEpochId: prepared.keyEpochId,
                ordinal: prepared.keyEpochOrdinal,
              },
              remainingDevices,
            },
            prepared.idempotencyKey,
          )
        ).body,
        "futureProtectionResult",
        [
          "vaultId",
          "state",
          "generationId",
          "generationNumber",
          "headCursor",
          "activeKeyEpochId",
          "predecessorGenerationId",
        ],
      );
      if (
        rotated.vaultId !== prepared.registration.vaultId ||
        rotated.activeKeyEpochId !== prepared.keyEpochId
      )
        throw integrity("Future Protection result changed");
      const session = await establishDeviceSession({
        transport: { request: this.transport.accountRequest.bind(this.transport) },
        accountId: prepared.account.accountId,
        accountSessionId: prepared.account.sessionId,
        vaultId: prepared.registration.vaultId,
        deviceId: prepared.authority.identity.deviceId,
        deviceSigningSecretKey: prepared.authority.identity.signingSecretKey,
      });
      this.transport.useDeviceAccessToken(session.accessToken);
      const renewed = canonicalRecord(
        (
          await this.transport.deviceRequest(
            "GET",
            `/api/vaults/${prepared.registration.vaultId}/device-authority`,
          )
        ).body,
        "currentDeviceAuthority",
        [
          "vaultId",
          "activeRecoveryGenerationId",
          "activeKeyEpochId",
          "keyEpochOrdinal",
          "deviceCertificate",
          "deviceKeyEnvelope",
        ],
      );
      if (
        renewed.vaultId !== prepared.registration.vaultId ||
        renewed.activeRecoveryGenerationId !== prepared.recoveryGenerationId ||
        renewed.activeKeyEpochId !== prepared.keyEpochId ||
        integer(renewed.keyEpochOrdinal, "currentDeviceAuthority.keyEpochOrdinal") !==
          prepared.keyEpochOrdinal
      )
        throw integrity("Renewed Device authority changed");
      const certificate = deviceCertificateFromWire(renewed.deviceCertificate);
      const envelope = deviceKeyEnvelopeFromWire(renewed.deviceKeyEnvelope);
      await verifyDeviceCertificate(certificate);
      if (
        certificate.content.deviceId !== prepared.authority.identity.deviceId ||
        !sameBytes(
          certificate.content.signingPublicKey,
          prepared.authority.identity.signingPublicKey,
        ) ||
        !sameBytes(
          certificate.content.wrappingPublicKey,
          prepared.authority.identity.wrappingPublicKey,
        )
      )
        throw integrity("Renewed Device identity changed");
      installedRoot = await openDeviceKeyEnvelope({
        envelope,
        certificate,
        deviceWrappingSecretKey: prepared.authority.identity.wrappingSecretKey,
      });
      if (!sameBytes(installedRoot, prepared.newRootKey))
        throw integrity("Renewed epoch key changed");
      await this.store.saveFutureProtectedDevice({
        accountId: prepared.account.accountId,
        vaultId: prepared.registration.vaultId,
        recoveryGenerationId: prepared.recoveryGenerationId,
        identity: prepared.authority.identity,
        certificate,
        envelopes: [...prepared.authority.envelopes, envelope],
        keyEpochs: [
          ...prepared.authority.keyEpochs,
          {
            keyEpochId: prepared.keyEpochId,
            ordinal: prepared.keyEpochOrdinal,
            rootKey: installedRoot,
          },
        ],
        recoveryKit: prepared.recoveryKit,
        remoteGenerationId: uuid(rotated.generationId, "futureProtectionResult.generationId"),
        remoteGenerationNumber: integer(
          rotated.generationNumber,
          "futureProtectionResult.generationNumber",
        ),
        remoteHeadCursor: integer(rotated.headCursor, "futureProtectionResult.headCursor"),
        session,
      });
      return session.accessToken;
    } finally {
      this.preparations.delete(protectionId);
      if (confirmationEntropy !== undefined) await wipe(confirmationEntropy);
      if (installedRoot !== undefined) await wipe(installedRoot);
      await wipePrepared(prepared);
    }
  }

  async cancel(protectionId: string): Promise<void> {
    const prepared = this.preparations.get(protectionId);
    if (prepared === undefined) return;
    this.preparations.delete(protectionId);
    await wipePrepared(prepared);
  }
}
