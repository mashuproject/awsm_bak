import { describe, expect, it, vi } from "vitest";
import type { RecoveredDeviceAuthority } from "../../src/runtime/recovery/enrollment";
import { RecoveredDeviceEnrollmentService } from "../../src/runtime/recovery/enrollment";
import { createRecoveryKit } from "../../src/runtime/recovery/kit";
import { deriveRecoveryKeys, encodeRecoveryPhrase } from "../../src/runtime/recovery/phrase";

describe("fresh Device recovery enrollment", () => {
  const accountId = "01900000-0000-7000-8000-000000000071";
  const accountSessionId = "01900000-0000-7000-8000-000000000072";
  const vaultId = "01900000-0000-7000-8000-000000000073";
  const recoveryGenerationId = "01900000-0000-7000-8000-000000000074";
  const firstEpochId = "01900000-0000-7000-8000-000000000075";
  const secondEpochId = "01900000-0000-7000-8000-000000000076";
  const phrase = encodeRecoveryPhrase(new Uint8Array(16));

  async function storedKit() {
    const keys = await deriveRecoveryKeys({ entropy: new Uint8Array(16), vaultId });
    const kit = await createRecoveryKit({
      keyring: {
        version: 1,
        vaultId,
        recoveryGenerationId,
        activeKeyEpochId: secondEpochId,
        keyEpochs: [
          { keyEpochId: firstEpochId, ordinal: 0, rootKey: new Uint8Array(32).fill(0x41) },
          { keyEpochId: secondEpochId, ordinal: 1, rootKey: new Uint8Array(32).fill(0x42) },
        ],
      },
      recoveryKitWrappingKey: keys.recoveryKitWrappingKey,
      recoveryAdministratorSeed: keys.recoveryAdministratorSeed,
      nonce: new Uint8Array(24).fill(0x31),
    });
    return {
      version: 1 as const,
      vaultId,
      recoveryGenerationId,
      metadata: kit.metadata,
      ciphertext: kit.ciphertext,
    };
  }

  it("requires a full second phrase entry and enrolls one envelope per historical epoch", async () => {
    const saved: {
      deviceId?: string;
      epochIds?: readonly string[];
      signingSecret?: Uint8Array;
    } = {};
    const saveRecoveredDevice = vi.fn(async (authority: RecoveredDeviceAuthority) => {
      saved.deviceId = authority.identity.deviceId;
      saved.epochIds = authority.keyEpochs.map((epoch) => epoch.keyEpochId);
      saved.signingSecret = Uint8Array.from(authority.identity.signingSecretKey);
    });
    const request = vi.fn(async (_method, _path, body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        deviceKeyEnvelopes: expect.arrayContaining([expect.any(Object), expect.any(Object)]),
        deviceProofSignature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/u),
      });
      return {
        status: 201,
        body: {
          account: { accountId, email: "reader@example.test" },
          sessionId: "01900000-0000-7000-8000-000000000079",
          scope: "VaultDevice",
          accessToken: "device-access",
          accessExpiresAt: "2026-07-25T19:00:00.000Z",
          refreshToken: "device-refresh",
          refreshExpiresAt: "2026-08-25T19:00:00.000Z",
        },
      };
    });
    const ids = [
      "01900000-0000-7000-8000-000000000077",
      "01900000-0000-7000-8000-000000000078",
      "01900000-0000-7000-8000-000000000080",
    ];
    const service = new RecoveredDeviceEnrollmentService(
      { request },
      { saveRecoveredDevice },
      () => ids.shift() ?? crypto.randomUUID(),
      () => "2026-07-25T18:30:00.000Z",
    );

    await expect(
      service.enroll({
        accountId,
        accountSessionId,
        recoveryKit: await storedKit(),
        phrase,
        confirmationPhrase: phrase.toUpperCase(),
        displayName: "Firefox extension",
        clientKind: "FirefoxExtension",
      }),
    ).resolves.toBe("device-access");

    expect(request).toHaveBeenCalledWith(
      "POST",
      `/api/vaults/${vaultId}/devices`,
      expect.any(Object),
      expect.any(String),
    );
    expect(saved).toMatchObject({
      deviceId: "01900000-0000-7000-8000-000000000077",
      epochIds: [firstEpochId, secondEpochId],
    });
    expect(saved.signingSecret).toHaveLength(64);
  });

  it("does not decrypt or contact the server when the second phrase entry differs", async () => {
    const request = vi.fn();
    const saveRecoveredDevice = vi.fn();
    const service = new RecoveredDeviceEnrollmentService({ request }, { saveRecoveredDevice });

    await expect(
      service.enroll({
        accountId,
        accountSessionId,
        recoveryKit: await storedKit(),
        phrase,
        confirmationPhrase: phrase.replace(/about$/u, "zoo"),
        displayName: "Chrome extension",
        clientKind: "ChromeExtension",
      }),
    ).rejects.toMatchObject({ id: "RECOVERY_PHRASE_INVALID" });
    expect(request).not.toHaveBeenCalled();
    expect(saveRecoveredDevice).not.toHaveBeenCalled();
  });

  it("maps a valid but wrong phrase to the same generic recovery failure", async () => {
    const request = vi.fn();
    const saveRecoveredDevice = vi.fn();
    const service = new RecoveredDeviceEnrollmentService({ request }, { saveRecoveredDevice });
    const wrongPhrase = encodeRecoveryPhrase(new Uint8Array(16).fill(1));

    await expect(
      service.enroll({
        accountId,
        accountSessionId,
        recoveryKit: await storedKit(),
        phrase: wrongPhrase,
        confirmationPhrase: wrongPhrase,
        displayName: "Firefox extension",
        clientKind: "FirefoxExtension",
      }),
    ).rejects.toMatchObject({ id: "RECOVERY_PHRASE_INVALID" });
    expect(request).not.toHaveBeenCalled();
    expect(saveRecoveredDevice).not.toHaveBeenCalled();
  });
});
