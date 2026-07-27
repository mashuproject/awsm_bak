import { wipe } from "../../crypto/sodium";
import { canonicalRecord, integer, uuid } from "../../domain/validation";
import type {
  IndexedDbDeviceRepository,
  LoadedDetachedVaultAuthority,
  LoadedDeviceAuthority,
} from "../../drivers/indexeddb/device-repository";
import type {
  StoredAccountMetadataV1,
  StoredAccountVaultV1,
  StoredRecoveryKitV1,
} from "../../drivers/indexeddb/schema";
import { establishDeviceSession } from "../account/device-session";
import {
  deviceCertificateFromWire,
  deviceKeyEnvelopeFromWire,
  openDeviceKeyEnvelope,
  verifyDeviceCertificate,
} from "./device";

interface AuthorityRefreshTransport {
  accountRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  deviceRequest(
    method: string,
    path: string,
    accessToken: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  useDeviceAccessToken(accessToken: string): void;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

async function wipeAuthority(
  authority: LoadedDeviceAuthority | LoadedDetachedVaultAuthority,
): Promise<void> {
  await Promise.all([
    wipe(authority.identity.signingSecretKey),
    wipe(authority.identity.wrappingSecretKey),
    ...authority.keyEpochs.map((epoch) => wipe(epoch.rootKey)),
  ]);
}

export class DeviceAuthorityRefreshService {
  constructor(
    private readonly transport: AuthorityRefreshTransport,
    private readonly repository: IndexedDbDeviceRepository,
  ) {}

  async refresh(input: {
    readonly account: StoredAccountMetadataV1;
    readonly registration: StoredAccountVaultV1;
    readonly recoveryKit?: StoredRecoveryKitV1;
  }): Promise<string | undefined> {
    if (
      input.account.scope !== "Account" ||
      input.registration.accountId !== input.account.accountId
    )
      throw integrity("Account authority is incomplete");
    const boundAuthority = await this.repository.loadDeviceAuthority(input.registration.vaultId);
    const detachedAuthority =
      boundAuthority === undefined
        ? await this.repository.loadDetachedVaultAuthority(input.registration.vaultId)
        : undefined;
    const authority = boundAuthority ?? detachedAuthority;
    if (authority === undefined) return undefined;
    let rootKey: Uint8Array | undefined;
    try {
      if (
        (boundAuthority !== undefined && boundAuthority.accountId !== input.account.accountId) ||
        authority.vaultId !== input.registration.vaultId
      )
        throw integrity("Local Device authority changed");
      const session = await establishDeviceSession({
        transport: { request: this.transport.accountRequest.bind(this.transport) },
        accountId: input.account.accountId,
        accountSessionId: input.account.sessionId,
        vaultId: authority.vaultId,
        deviceId: authority.identity.deviceId,
        deviceSigningSecretKey: authority.identity.signingSecretKey,
      });
      this.transport.useDeviceAccessToken(session.accessToken);
      const renewed = canonicalRecord(
        (
          await this.transport.deviceRequest(
            "GET",
            `/api/vaults/${authority.vaultId}/device-authority`,
            session.accessToken,
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
      if (renewed.vaultId !== authority.vaultId)
        throw integrity("Remote Device authority changed Vault");
      const certificate = deviceCertificateFromWire(renewed.deviceCertificate);
      const envelope = deviceKeyEnvelopeFromWire(renewed.deviceKeyEnvelope);
      await verifyDeviceCertificate(certificate);
      if (
        certificate.content.deviceId !== authority.identity.deviceId ||
        !sameBytes(certificate.content.signingPublicKey, authority.identity.signingPublicKey) ||
        !sameBytes(certificate.content.wrappingPublicKey, authority.identity.wrappingPublicKey) ||
        certificate.content.recoveryGenerationId !== renewed.activeRecoveryGenerationId ||
        envelope.metadata.keyEpochId !== renewed.activeKeyEpochId
      )
        throw integrity("Renewed Device public facts changed");
      rootKey = await openDeviceKeyEnvelope({
        envelope,
        certificate,
        deviceWrappingSecretKey: authority.identity.wrappingSecretKey,
      });
      const ordinal = integer(renewed.keyEpochOrdinal, "currentDeviceAuthority.keyEpochOrdinal");
      const existing = authority.keyEpochs.find(
        (epoch) => epoch.keyEpochId === envelope.metadata.keyEpochId,
      );
      if (
        (existing !== undefined &&
          (existing.ordinal !== ordinal || !sameBytes(existing.rootKey, rootKey))) ||
        (existing === undefined && ordinal !== authority.keyEpochs.length)
      )
        throw integrity("Renewed epoch sequence changed");
      const installedRoot = rootKey;
      if (detachedAuthority === undefined) {
        await this.repository.saveRenewedDeviceAuthority({
          accountId: input.account.accountId,
          vaultId: authority.vaultId,
          recoveryGenerationId: certificate.content.recoveryGenerationId,
          certificate,
          envelope,
          keyEpoch: {
            keyEpochId: envelope.metadata.keyEpochId,
            ordinal,
            rootKey: installedRoot,
          },
          session,
        });
      } else {
        if (
          input.recoveryKit === undefined ||
          input.recoveryKit.vaultId !== authority.vaultId ||
          input.recoveryKit.recoveryGenerationId !== certificate.content.recoveryGenerationId ||
          detachedAuthority.recoveryGenerationId !== certificate.content.recoveryGenerationId
        )
          throw integrity("Detached Vault Recovery authority changed");
        const remote = canonicalRecord(
          (
            await this.transport.deviceRequest(
              "GET",
              `/api/vaults/${authority.vaultId}`,
              session.accessToken,
            )
          ).body,
          "detachedRemoteVault",
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
          remote.state !== "Active" ||
          uuid(remote.vaultId, "detachedRemoteVault.vaultId") !== authority.vaultId ||
          uuid(remote.activeKeyEpochId, "detachedRemoteVault.activeKeyEpochId") !==
            envelope.metadata.keyEpochId
        )
          throw integrity("Detached remote Vault authority changed");
        const keyEpochs = authority.keyEpochs.map((epoch) =>
          epoch.keyEpochId === envelope.metadata.keyEpochId
            ? { ...epoch, rootKey: Uint8Array.from(installedRoot) }
            : epoch,
        );
        if (existing === undefined)
          keyEpochs.push({
            keyEpochId: envelope.metadata.keyEpochId,
            ordinal,
            rootKey: Uint8Array.from(installedRoot),
          });
        const envelopes = authority.keyEpochs.map((epoch) => {
          if (epoch.keyEpochId === envelope.metadata.keyEpochId) return envelope;
          const retained = authority.envelopes.find(
            (candidate) => candidate.metadata.keyEpochId === epoch.keyEpochId,
          );
          if (retained === undefined) throw integrity("Detached Vault Key Epoch envelope changed");
          return retained;
        });
        if (existing === undefined) envelopes.push(envelope);
        await this.repository.saveReattachedDevice({
          accountId: input.account.accountId,
          vaultId: authority.vaultId,
          recoveryGenerationId: certificate.content.recoveryGenerationId,
          identity: authority.identity,
          certificate,
          envelopes,
          keyEpochs,
          recoveryKit: {
            metadata: input.recoveryKit.metadata,
            ciphertext: input.recoveryKit.ciphertext,
          },
          remoteGenerationId: uuid(remote.generationId, "detachedRemoteVault.generationId"),
          remoteGenerationNumber: integer(
            remote.generationNumber,
            "detachedRemoteVault.generationNumber",
          ),
          remoteHeadCursor: integer(remote.headCursor, "detachedRemoteVault.headCursor"),
          session,
        });
      }
      return session.accessToken;
    } finally {
      if (rootKey !== undefined) await wipe(rootKey);
      await wipeAuthority(authority);
    }
  }
}
