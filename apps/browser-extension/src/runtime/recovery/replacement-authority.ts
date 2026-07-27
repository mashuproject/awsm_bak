import { wipe } from "../../crypto/sodium";
import type { StoredAccountMetadataV1 } from "../../drivers/indexeddb/schema";
import type { PreparedVault } from "../vault/contracts";
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
} from "./device";
import { createRecoveryKit, type RecoveryKitV1 } from "./kit";
import { decodeRecoveryPhrase, deriveRecoveryKeys, encodeRecoveryPhrase } from "./phrase";
import { encodeRecoveryFile } from "./recovery-file";

export interface PreparedReplacementAuthority {
  readonly account: StoredAccountMetadataV1;
  readonly target: PreparedVault;
  readonly recoveryGenerationId: string;
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
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), {
    id: "SYNCHRONIZATION_INTEGRITY_FAILED",
  });
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

export async function prepareReplacementAuthority(input: {
  readonly account: StoredAccountMetadataV1;
  readonly target: PreparedVault;
  readonly displayName: string;
  readonly clientKind: DeviceClientKind;
  readonly randomUuid?: () => string;
  readonly now?: () => string;
}): Promise<{
  readonly prepared: PreparedReplacementAuthority;
  readonly phrase: string;
  readonly recoveryFile: Uint8Array;
}> {
  if (input.account.scope !== "Account") throw integrity("Replacement requires Account authority.");
  const randomUuid = input.randomUuid ?? (() => crypto.randomUUID());
  const now = input.now ?? (() => new Date().toISOString());
  const entropy = crypto.getRandomValues(new Uint8Array(16));
  let wrappingKey: Uint8Array | undefined;
  let administratorSeed: Uint8Array | undefined;
  let rootKey: Uint8Array | undefined;
  let identity: DeviceIdentity | undefined;
  try {
    ({ recoveryKitWrappingKey: wrappingKey, recoveryAdministratorSeed: administratorSeed } =
      await deriveRecoveryKeys({
        entropy,
        vaultId: input.target.records.metadata.vaultId,
      }));
    rootKey = await unwrapDeviceSlot(
      input.target.records.deviceSlot,
      input.target.records.deviceKey,
    );
    await verifyRootKey(
      input.target.keyring.active().rootKey,
      input.target.records.deviceSlot,
      input.target.records.metadata.verifier,
    );
    const recoveryGenerationId = randomUuid();
    const recoveryKit = await createRecoveryKit({
      keyring: {
        version: 1,
        vaultId: input.target.records.metadata.vaultId,
        recoveryGenerationId,
        activeKeyEpochId: input.target.records.metadata.activeKeyEpochId,
        keyEpochs: [
          {
            keyEpochId: input.target.records.metadata.activeKeyEpochId,
            ordinal: 0,
            rootKey,
          },
        ],
      },
      recoveryKitWrappingKey: wrappingKey,
      recoveryAdministratorSeed: administratorSeed,
    });
    identity = await createDeviceIdentity({
      deviceId: input.target.records.metadata.deviceId,
    });
    const certificate = await createDeviceCertificate({
      certificateId: randomUuid(),
      vaultId: input.target.records.metadata.vaultId,
      recoveryGenerationId,
      identity,
      displayName: input.displayName,
      clientKind: input.clientKind,
      issuedAt: now(),
      recoveryAdministratorSeed: administratorSeed,
    });
    const envelope = await createDeviceKeyEnvelope({
      certificate,
      keyEpochId: input.target.records.metadata.activeKeyEpochId,
      epochRootKey: rootKey,
      recoveryAdministratorSeed: administratorSeed,
    });
    const deviceProofSignature = await createDeviceEnrollmentProof({
      certificate,
      accountSessionId: input.account.sessionId,
      deviceSigningSecretKey: identity.signingSecretKey,
    });
    const prepared = {
      account: input.account,
      target: input.target,
      recoveryGenerationId,
      keyEpochActivatedAt: input.target.records.metadata.createdAt,
      entropy,
      wrappingKey,
      administratorSeed,
      rootKey,
      identity,
      certificate,
      envelope,
      recoveryKit,
      deviceProofSignature,
    };
    return {
      prepared,
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

export async function confirmReplacementPhrase(
  prepared: PreparedReplacementAuthority,
  phrase: string,
): Promise<void> {
  let confirmation: Uint8Array | undefined;
  try {
    try {
      confirmation = decodeRecoveryPhrase(phrase);
    } catch {
      throw phraseMismatch();
    }
    if (!sameBytes(confirmation, prepared.entropy)) throw phraseMismatch();
  } finally {
    if (confirmation !== undefined) await wipe(confirmation);
  }
}

export async function wipeReplacementAuthority(
  prepared: PreparedReplacementAuthority,
): Promise<void> {
  await Promise.all([
    wipe(prepared.entropy),
    wipe(prepared.wrappingKey),
    wipe(prepared.administratorSeed),
    wipe(prepared.rootKey),
    wipe(prepared.identity.signingSecretKey),
    wipe(prepared.identity.wrappingSecretKey),
  ]);
}
