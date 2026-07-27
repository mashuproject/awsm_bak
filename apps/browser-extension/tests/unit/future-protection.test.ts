import { describe, expect, it, vi } from "vitest";

import {
  createDeviceCertificate,
  createDeviceIdentity,
  deviceCertificateToWire,
} from "../../src/runtime/recovery/device";
import { FutureProtectionService } from "../../src/runtime/recovery/future-protection";

const ids = Array.from(
  { length: 20 },
  (_, index) => `01900000-0000-7000-8000-${(index + 401).toString().padStart(12, "0")}`,
);
function id(index: number): string {
  const value = ids[index];
  if (value === undefined) throw new Error(`Missing test UUID ${String(index)}.`);
  return value;
}
const vaultId = id(0);
const oldRecoveryId = id(1);
const oldEpochId = id(2);
const accountId = id(3);
const accountSessionId = id(4);

describe("Future Protection ceremony", () => {
  it("reveals before mutation, rotates once after full re-entry, reauthenticates, and installs authority", async () => {
    const current = await createDeviceIdentity({ deviceId: id(5) });
    const target = await createDeviceIdentity({ deviceId: id(6) });
    const oldAdministratorSeed = crypto.getRandomValues(new Uint8Array(32));
    const currentCertificate = await createDeviceCertificate({
      certificateId: id(7),
      vaultId,
      recoveryGenerationId: oldRecoveryId,
      identity: current,
      displayName: "Current Firefox",
      clientKind: "FirefoxExtension",
      issuedAt: "2026-07-25T20:00:00.000Z",
      recoveryAdministratorSeed: oldAdministratorSeed,
    });
    const targetCertificate = await createDeviceCertificate({
      certificateId: id(8),
      vaultId,
      recoveryGenerationId: oldRecoveryId,
      identity: target,
      displayName: "Lost Chrome",
      clientKind: "ChromeExtension",
      issuedAt: "2026-07-25T20:00:00.000Z",
      recoveryAdministratorSeed: oldAdministratorSeed,
    });
    let submitted: Record<string, unknown> | undefined;
    const deviceRequest = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path === `/api/vaults/${vaultId}`)
        return {
          status: 200,
          body: {
            vaultId,
            state: "Active",
            generationId: ids[9],
            generationNumber: 3,
            headCursor: 10,
            activeKeyEpochId: oldEpochId,
          },
        };
      if (method === "GET" && path.endsWith("/devices"))
        return {
          status: 200,
          body: {
            devices: [
              {
                deviceId: current.deviceId,
                certificateId: currentCertificate.content.certificateId,
                displayName: "Current Firefox",
                clientKind: "FirefoxExtension",
                recoveryGenerationId: oldRecoveryId,
                deviceCertificate: deviceCertificateToWire(currentCertificate),
                enrolledAt: "2026-07-25T20:00:00.000Z",
                current: true,
              },
              {
                deviceId: target.deviceId,
                certificateId: targetCertificate.content.certificateId,
                displayName: "Lost Chrome",
                clientKind: "ChromeExtension",
                recoveryGenerationId: oldRecoveryId,
                deviceCertificate: deviceCertificateToWire(targetCertificate),
                enrolledAt: "2026-07-25T20:00:00.000Z",
                current: false,
              },
            ],
          },
        };
      if (method === "POST" && path.endsWith("/future-protections")) {
        submitted = body as Record<string, unknown>;
        const keyEpoch = submitted.keyEpoch as { keyEpochId: string };
        return {
          status: 200,
          body: {
            vaultId,
            state: "Active",
            generationId: ids[9],
            generationNumber: 3,
            headCursor: 11,
            activeKeyEpochId: keyEpoch.keyEpochId,
          },
        };
      }
      if (method === "GET" && path.endsWith("/device-authority")) {
        if (submitted === undefined) throw new Error("Future Protection was not submitted.");
        const remaining = submitted.remainingDevices as {
          deviceCertificate: unknown;
          deviceKeyEnvelope: unknown;
        }[];
        const recovery = submitted.recoveryGeneration as {
          recoveryGenerationId: string;
        };
        const keyEpoch = submitted.keyEpoch as {
          keyEpochId: string;
          ordinal: number;
        };
        return {
          status: 200,
          body: {
            vaultId,
            activeRecoveryGenerationId: recovery.recoveryGenerationId,
            activeKeyEpochId: keyEpoch.keyEpochId,
            keyEpochOrdinal: keyEpoch.ordinal,
            ...remaining[0],
          },
        };
      }
      throw new Error(`Unexpected Device request ${method} ${path}`);
    });
    const accountRequest = vi.fn(async (method: string, path: string) => {
      if (path === "/api/device-session-challenges")
        return {
          status: 201,
          body: {
            challenge: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE",
            expiresAt: "2026-07-25T20:01:00.000Z",
          },
        };
      if (path === "/api/device-sessions")
        return {
          status: 200,
          body: {
            account: {
              accountId,
              username: "owner_test",
              inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
            },
            sessionId: ids[10],
            scope: "VaultDevice",
            accessToken: "renewed-device-access",
            accessExpiresAt: "2026-07-25T20:15:00.000Z",
            refreshToken: "renewed-device-refresh",
            refreshExpiresAt: "2026-08-24T20:00:00.000Z",
          },
        };
      throw new Error(`Unexpected Account request ${method} ${path}`);
    });
    let savedAuthority: unknown;
    const saveFutureProtectedDevice = vi.fn(async (authority: unknown) => {
      savedAuthority = authority;
    });
    const generated = ids.slice(11);
    const service = new FutureProtectionService(
      {
        deviceRequest,
        accountRequest,
        useDeviceAccessToken: vi.fn(),
      },
      {
        loadDeviceAuthority: vi.fn(async () => ({
          accountId,
          vaultId,
          recoveryGenerationId: oldRecoveryId,
          identity: current,
          certificate: currentCertificate,
          envelopes: [{ keyEpochId: oldEpochId } as never],
          keyEpochs: [{ keyEpochId: oldEpochId, ordinal: 0, rootKey: new Uint8Array(32).fill(7) }],
        })),
        saveFutureProtectedDevice,
      },
      () => {
        const value = generated.shift();
        if (value === undefined) throw new Error("The test UUID sequence is exhausted.");
        return value;
      },
      () => "2026-07-25T20:00:30.000Z",
    );

    const prepared = await service.prepare({
      account: {
        version: 1,
        accountId,
        sessionId: accountSessionId,
        username: "owner_test",
        inactiveDeletionAt: "2027-07-27T12:00:00.000Z",
        scope: "Account",
      },
      registration: {
        version: 1,
        accountId,
        vaultId,
        activeRecoveryGenerationId: oldRecoveryId,
        activeKeyEpochId: oldEpochId,
        remoteGenerationId: id(9),
        remoteGenerationNumber: 3,
        deliveryCursor: 10,
      },
      targetDeviceId: target.deviceId,
    });

    expect(prepared.phrase.split(" ")).toHaveLength(12);
    expect(prepared.recoveryFile.byteLength).toBeGreaterThan(0);
    expect(deviceRequest).toHaveBeenCalledTimes(2);
    expect(submitted).toBeUndefined();

    await expect(service.protect(prepared.protectionId, prepared.phrase)).resolves.toBe(
      "renewed-device-access",
    );
    expect(submitted).toMatchObject({
      expectedRecoveryGenerationId: oldRecoveryId,
      expectedKeyEpochId: oldEpochId,
      targetDeviceId: target.deviceId,
      keyEpoch: { ordinal: 1 },
    });
    expect(submitted?.remainingDevices as unknown[]).toHaveLength(1);
    expect(accountRequest).toHaveBeenCalledTimes(2);
    expect(saveFutureProtectedDevice).toHaveBeenCalledOnce();
    expect(savedAuthority).toMatchObject({
      accountId,
      vaultId,
      session: { scope: "VaultDevice", accessToken: "renewed-device-access" },
      remoteGenerationId: ids[9],
      remoteGenerationNumber: 3,
      envelopes: [{ keyEpochId: oldEpochId }, expect.any(Object)],
      keyEpochs: [{ keyEpochId: oldEpochId }, { ordinal: 1 }],
    });
  });
});
