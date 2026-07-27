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
              account: {
                accountId,
                username: "owner_test",
                inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
              },
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
          username: "owner_test",
          inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
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

  it("reattaches detached authority to the original Account without a Recovery Phrase", async () => {
    const accountId = id(520);
    const vaultId = id(521);
    const recoveryGenerationId = id(522);
    const keyEpochId = id(523);
    const generationId = id(524);
    const identity = await createDeviceIdentity({ deviceId: id(525) });
    const administratorSeed = crypto.getRandomValues(new Uint8Array(32));
    const certificate = await createDeviceCertificate({
      certificateId: id(526),
      vaultId,
      recoveryGenerationId,
      identity,
      displayName: "Firefox extension",
      clientKind: "FirefoxExtension",
      issuedAt: "2026-07-27T20:00:00.000Z",
      recoveryAdministratorSeed: administratorSeed,
    });
    const rootKey = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await createDeviceKeyEnvelope({
      certificate,
      keyEpochId,
      epochRootKey: rootKey,
      recoveryAdministratorSeed: administratorSeed,
    });
    const recoveryKit = {
      version: 1 as const,
      vaultId,
      recoveryGenerationId,
      metadata: {
        vaultId,
        recoveryGenerationId,
      } as never,
      ciphertext: new Uint8Array([1, 2, 3]),
    };
    const saveReattachedDevice = vi.fn(async () => undefined);
    const useDeviceAccessToken = vi.fn();
    let deviceRequestCount = 0;
    const service = new DeviceAuthorityRefreshService(
      {
        accountRequest: vi.fn(async (_method, path) => {
          if (path === "/api/device-session-challenges")
            return {
              status: 201,
              body: {
                challenge: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE",
                expiresAt: "2026-07-27T20:01:00.000Z",
              },
            };
          return {
            status: 200,
            body: {
              account: {
                accountId,
                username: "owner_test",
                inactiveDeletionAt: "2027-07-27T20:00:00.000Z",
              },
              sessionId: id(527),
              scope: "VaultDevice",
              accessToken: "returning-access",
              accessExpiresAt: "2026-07-27T20:15:00.000Z",
              refreshToken: "returning-refresh",
              refreshExpiresAt: "2026-08-27T20:00:00.000Z",
            },
          };
        }),
        deviceRequest: vi.fn(async () => {
          deviceRequestCount += 1;
          return deviceRequestCount === 1
            ? {
                status: 200,
                body: {
                  vaultId,
                  activeRecoveryGenerationId: recoveryGenerationId,
                  activeKeyEpochId: keyEpochId,
                  keyEpochOrdinal: 0,
                  deviceCertificate: deviceCertificateToWire(certificate),
                  deviceKeyEnvelope: deviceKeyEnvelopeToWire(envelope),
                },
              }
            : {
                status: 200,
                body: {
                  vaultId,
                  state: "Active",
                  generationId,
                  generationNumber: 2,
                  headCursor: 14,
                  activeKeyEpochId: keyEpochId,
                },
              };
        }),
        useDeviceAccessToken,
      },
      {
        loadDeviceAuthority: vi.fn(async () => undefined),
        loadDetachedVaultAuthority: vi.fn(async () => ({
          vaultId,
          recoveryGenerationId,
          identity,
          certificate,
          envelopes: [envelope],
          keyEpochs: [{ keyEpochId, ordinal: 0, rootKey }],
          recoveryKit,
        })),
        saveReattachedDevice,
      } as never,
    );

    await expect(
      service.refresh({
        account: {
          version: 1,
          accountId,
          sessionId: id(528),
          username: "owner_test",
          inactiveDeletionAt: "2027-07-27T20:00:00.000Z",
          scope: "Account",
        },
        registration: {
          version: 1,
          accountId,
          vaultId,
          activeRecoveryGenerationId: recoveryGenerationId,
          deliveryCursor: 0,
        },
        recoveryKit,
      }),
    ).resolves.toBe("returning-access");

    expect(saveReattachedDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        vaultId,
        remoteGenerationId: generationId,
        remoteGenerationNumber: 2,
        remoteHeadCursor: 14,
      }),
    );
    expect(useDeviceAccessToken).toHaveBeenCalledWith("returning-access");
  });
});
