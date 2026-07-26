import { wipe } from "../../crypto/sodium";
import type { StoredRecoveryKitV1 } from "../../drivers/indexeddb/schema";
import { type AuthenticatedSession, decodeAuthenticatedSession } from "../account/http";
import { bytesToBase64Url } from "../account/wire";
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
import { openRecoveryKit, type RecoveryKeyEpochV1 } from "./kit";
import { decodeRecoveryPhrase, deriveRecoveryKeys, normalizeRecoveryPhrase } from "./phrase";

interface EnrollmentTransport {
  request(
    method: string,
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
}

export interface RecoveredDeviceAuthority {
  readonly accountId: string;
  readonly vaultId: string;
  readonly recoveryGenerationId: string;
  readonly identity: DeviceIdentity;
  readonly certificate: DeviceCertificateV1;
  readonly envelopes: readonly DeviceKeyEnvelopeV1[];
  readonly keyEpochs: readonly RecoveryKeyEpochV1[];
  readonly session: AuthenticatedSession;
}

interface RecoveredDeviceStore {
  saveRecoveredDevice(authority: RecoveredDeviceAuthority): Promise<void>;
}

function recoveryFailure(): Error {
  return Object.assign(
    new Error("That Recovery Phrase is not valid. Check all 12 words and try again."),
    {
      id: "RECOVERY_PHRASE_INVALID",
    },
  );
}

export class RecoveredDeviceEnrollmentService {
  constructor(
    private readonly transport: EnrollmentTransport,
    private readonly store: RecoveredDeviceStore,
    private readonly randomUuid: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async enroll(input: {
    readonly accountId: string;
    readonly accountSessionId: string;
    readonly recoveryKit: StoredRecoveryKitV1;
    readonly phrase: string;
    readonly confirmationPhrase: string;
    readonly displayName: string;
    readonly clientKind: DeviceClientKind;
  }): Promise<string> {
    let entropy: Uint8Array | undefined;
    let wrappingKey: Uint8Array | undefined;
    let administratorSeed: Uint8Array | undefined;
    let identity: DeviceIdentity | undefined;
    let keyEpochs: readonly RecoveryKeyEpochV1[] = [];
    try {
      if (
        normalizeRecoveryPhrase(input.phrase) !== normalizeRecoveryPhrase(input.confirmationPhrase)
      )
        throw recoveryFailure();
      entropy = decodeRecoveryPhrase(input.phrase);
      const keys = await deriveRecoveryKeys({
        entropy,
        vaultId: input.recoveryKit.vaultId,
      });
      wrappingKey = keys.recoveryKitWrappingKey;
      administratorSeed = keys.recoveryAdministratorSeed;
      const keyring = await openRecoveryKit(
        {
          metadata: input.recoveryKit.metadata,
          ciphertext: input.recoveryKit.ciphertext,
        },
        wrappingKey,
      );
      if (
        keyring.vaultId !== input.recoveryKit.vaultId ||
        keyring.recoveryGenerationId !== input.recoveryKit.recoveryGenerationId
      )
        throw recoveryFailure();
      keyEpochs = keyring.keyEpochs;
      identity = await createDeviceIdentity({ deviceId: this.randomUuid() });
      const recoveryAdministratorSeed = administratorSeed;
      const certificate = await createDeviceCertificate({
        certificateId: this.randomUuid(),
        vaultId: keyring.vaultId,
        recoveryGenerationId: keyring.recoveryGenerationId,
        identity,
        displayName: input.displayName,
        clientKind: input.clientKind,
        issuedAt: this.now(),
        recoveryAdministratorSeed,
      });
      const envelopes = await Promise.all(
        keyEpochs.map((epoch) =>
          createDeviceKeyEnvelope({
            certificate,
            keyEpochId: epoch.keyEpochId,
            epochRootKey: epoch.rootKey,
            recoveryAdministratorSeed,
          }),
        ),
      );
      const deviceProofSignature = await createDeviceEnrollmentProof({
        certificate,
        accountSessionId: input.accountSessionId,
        deviceSigningSecretKey: identity.signingSecretKey,
      });
      const response = await this.transport.request(
        "POST",
        `/api/vaults/${keyring.vaultId}/devices`,
        {
          deviceCertificate: deviceCertificateToWire(certificate),
          deviceKeyEnvelopes: envelopes.map(deviceKeyEnvelopeToWire),
          deviceProofSignature: bytesToBase64Url(deviceProofSignature),
        },
        this.randomUuid(),
      );
      const session = decodeAuthenticatedSession(response.body);
      if (session.scope !== "VaultDevice" || session.account.accountId !== input.accountId)
        throw Object.assign(new Error("Device session identity changed"), {
          id: "SYNCHRONIZATION_INTEGRITY_FAILED",
        });
      await this.store.saveRecoveredDevice({
        accountId: input.accountId,
        vaultId: keyring.vaultId,
        recoveryGenerationId: keyring.recoveryGenerationId,
        identity,
        certificate,
        envelopes,
        keyEpochs,
        session,
      });
      return session.accessToken;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "id" in error &&
        error.id === "CRYPTO_AUTHENTICATION_FAILED"
      )
        throw recoveryFailure();
      if (
        typeof error === "object" &&
        error !== null &&
        "id" in error &&
        typeof error.id === "string"
      )
        throw error;
      throw recoveryFailure();
    } finally {
      await Promise.all([
        ...(entropy === undefined ? [] : [wipe(entropy)]),
        ...(wrappingKey === undefined ? [] : [wipe(wrappingKey)]),
        ...(administratorSeed === undefined ? [] : [wipe(administratorSeed)]),
        ...(identity === undefined
          ? []
          : [wipe(identity.signingSecretKey), wipe(identity.wrappingSecretKey)]),
        ...keyEpochs.map((epoch) => wipe(epoch.rootKey)),
      ]);
    }
  }
}
