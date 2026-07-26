import { describe, expect, it, vi } from "vitest";

import { DeviceAuthorityRefreshService } from "../../src/runtime/recovery/authority-refresh";
import {
  createDeviceCertificate,
  createDeviceIdentity,
  createDeviceKeyEnvelope,
  deviceCertificateToWire,
  deviceKeyEnvelopeToWire,
} from "../../src/runtime/recovery/device";

const id = (suffix: number) => `01900000-0000-7000-8000-${suffix.toString().padStart(12, "0")}`;

describe("remaining Device authority refresh", () => {
  it("uses Account scope only for the Device proof, then installs the renewed active epoch", async () => {
    const accountId = id(501);
    const vaultId = id(502);
    const oldRecoveryId = id(503);
    const oldEpochId = id(504);
    const newRecoveryId = id(505);
    const newEpochId = id(506);
    const identity = await createDeviceIdentity({ deviceId: id(507) });
    const administratorSeed = crypto.getRandomValues(new Uint8Array(32));
    const certificate = await createDeviceCertificate({
      certificateId: id(508),
      vaultId,
      recoveryGenerationId: newRecoveryId,
      identity,
      displayName: "Firefox extension",
      clientKind: "FirefoxExtension",
      issuedAt: "2026-07-25T20:00:00.000Z",
      recoveryAdministratorSeed: administratorSeed,
    });
    const newRootKey = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await createDeviceKeyEnvelope({
      certificate,
      keyEpochId: newEpochId,
      epochRootKey: newRootKey,
      recoveryAdministratorSeed: administratorSeed,
    });
    const saveRenewedDeviceAuthority = vi.fn(async () => undefined);
    const useDeviceAccessToken = vi.fn();
    const service = new DeviceAuthorityRefreshService(
      {
        accountRequest: vi.fn(async (_method, path) => {
          if (path === "/api/device-session-challenges")
            return {
              status: 201,
              body: {
                challenge: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE",
                expiresAt: "2026-07-25T20:01:00.000Z",
              },
            };
          return {
            status: 200,
            body: {
              account: { accountId, email: "owner@example.test" },
              sessionId: id(509),
              scope: "VaultDevice",
              accessToken: "renewed-access",
              accessExpiresAt: "2026-07-25T20:15:00.000Z",
              refreshToken: "renewed-refresh",
              refreshExpiresAt: "2026-08-24T20:00:00.000Z",
            },
          };
        }),
        deviceRequest: vi.fn(async () => ({
          status: 200,
          body: {
            vaultId,
            activeRecoveryGenerationId: newRecoveryId,
            activeKeyEpochId: newEpochId,
            keyEpochOrdinal: 1,
            deviceCertificate: deviceCertificateToWire(certificate),
            deviceKeyEnvelope: deviceKeyEnvelopeToWire(envelope),
          },
        })),
        useDeviceAccessToken,
      },
      {
        loadDeviceAuthority: vi.fn(async () => ({
          accountId,
          vaultId,
          recoveryGenerationId: oldRecoveryId,
          identity,
          certificate,
          envelopes: [],
          keyEpochs: [{ keyEpochId: oldEpochId, ordinal: 0, rootKey: new Uint8Array(32).fill(4) }],
        })),
        saveRenewedDeviceAuthority,
      } as never,
    );

    await expect(
      service.refresh({
        account: {
          version: 1,
          accountId,
          sessionId: id(510),
          email: "owner@example.test",
          scope: "Account",
        },
        registration: {
          version: 1,
          accountId,
          vaultId,
          activeRecoveryGenerationId: newRecoveryId,
          activeKeyEpochId: newEpochId,
          remoteGenerationId: id(512),
          remoteGenerationNumber: 1,
          deliveryCursor: 8,
        },
      }),
    ).resolves.toBe("renewed-access");

    expect(useDeviceAccessToken).toHaveBeenCalledWith("renewed-access");
    expect(saveRenewedDeviceAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        vaultId,
        recoveryGenerationId: newRecoveryId,
        keyEpoch: expect.objectContaining({ keyEpochId: newEpochId, ordinal: 1 }),
      }),
    );
  });
});
