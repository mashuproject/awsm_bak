import { describe, expect, it, vi } from "vitest";
import { InitialVaultAttachmentService } from "../../src/runtime/recovery/initial-attachment";
import { decodeRecoveryFile } from "../../src/runtime/recovery/recovery-file";
import { VaultService } from "../../src/runtime/vault";

const uuids = Array.from(
  { length: 32 },
  (_, index) => `01900000-0000-7000-8000-${(index + 1).toString().padStart(12, "0")}`,
);

function uuid(index: number): string {
  const value = uuids[index];
  if (value === undefined) throw new Error(`Missing test UUID ${String(index)}.`);
  return value;
}

async function records() {
  return (
    await new VaultService({
      load: async () => undefined,
      setManualLock: async () => undefined,
    }).prepareCreate({
      name: "Amber Archive",
      createdAt: "2026-07-25T18:00:00.000Z",
    })
  ).records;
}

describe("initial Vault attachment", () => {
  it("requires full phrase confirmation before sending and stores Device authority after activation", async () => {
    const local = await records();
    const accountId = uuid(0);
    const accountSessionId = uuid(1);
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 201,
        body: {
          upload: { uploadId: uuids[2], partSizeBytes: 4 },
          ticket: { url: "/api/transfers/initial/{partNumber}" },
          session: {
            account: { accountId, email: "owner@example.test" },
            sessionId: uuids[3],
            scope: "VaultDevice",
            accessToken: "device-access",
            accessExpiresAt: "2026-07-25T19:00:00.000Z",
            refreshToken: "device-refresh",
            refreshExpiresAt: "2026-08-24T18:00:00.000Z",
          },
        },
      })
      .mockResolvedValue({ status: 200, body: {} });
    const putTransfer = vi.fn(async () => undefined);
    const useDeviceAccessToken = vi.fn();
    const saveInitialDevice = vi.fn(async (authority) => {
      expect(authority.vaultId).toBe(local.metadata.vaultId);
      expect(authority.keyEpochs).toHaveLength(1);
      expect(authority.keyEpochs[0].rootKey).not.toEqual(new Uint8Array(32));
      expect(authority.session.scope).toBe("VaultDevice");
    });
    let uuidIndex = 4;
    const service = new InitialVaultAttachmentService(
      { request, putTransfer, useDeviceAccessToken },
      { saveInitialDevice },
      () => uuid(uuidIndex++),
      () => "2026-07-25T18:05:00.000Z",
    );
    const prepared = await service.prepare({
      metadata: {
        version: 1,
        accountId,
        sessionId: accountSessionId,
        email: "owner@example.test",
        scope: "Account",
      },
      records: local,
      displayName: "Firefox on laptop",
      clientKind: "FirefoxExtension",
    });

    expect(prepared.phrase.split(" ")).toHaveLength(12);
    const recoveryFile = await decodeRecoveryFile(prepared.recoveryFile);
    expect(recoveryFile.metadata.vaultId).toBe(local.metadata.vaultId);
    expect(request).not.toHaveBeenCalled();

    await expect(
      service.attach(prepared.setupId, `${"abandon ".repeat(11)}about`),
    ).rejects.toMatchObject({
      id: "RECOVERY_PHRASE_INVALID",
    });
    expect(request).not.toHaveBeenCalled();

    const retry = await service.prepare({
      metadata: {
        version: 1,
        accountId,
        sessionId: accountSessionId,
        email: "owner@example.test",
        scope: "Account",
      },
      records: local,
      displayName: "Firefox on laptop",
      clientKind: "FirefoxExtension",
    });
    await expect(service.attach(retry.setupId, retry.phrase)).resolves.toBe("device-access");

    expect(request.mock.calls.map(([method, path]) => [method, path])).toEqual([
      ["POST", "/api/vaults"],
      ["POST", `/api/vaults/${local.metadata.vaultId}/uploads/${uuids[2]}/complete`],
      ["POST", `/api/vaults/${local.metadata.vaultId}/complete`],
    ]);
    expect(saveInitialDevice).toHaveBeenCalledOnce();
    expect(useDeviceAccessToken).toHaveBeenCalledWith("device-access");
    expect(putTransfer).toHaveBeenCalled();
  });
});
