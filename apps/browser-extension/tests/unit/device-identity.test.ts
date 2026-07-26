import { describe, expect, it } from "vitest";

import {
  createDeviceCertificate,
  createDeviceEnrollmentProof,
  createDeviceIdentity,
  createDeviceKeyEnvelope,
  openDeviceKeyEnvelope,
  verifyDeviceCertificate,
  verifyDeviceEnrollmentProof,
} from "../../src/runtime/recovery/device";

describe("certified Device identity", () => {
  const vaultId = "01900000-0000-7000-8000-000000000011";
  const recoveryGenerationId = "01900000-0000-7000-8000-000000000012";
  const keyEpochId = "01900000-0000-7000-8000-000000000013";
  const deviceId = "01900000-0000-7000-8000-000000000014";
  const certificateId = "01900000-0000-7000-8000-000000000015";
  const accountSessionId = "01900000-0000-7000-8000-000000000016";
  const administratorSeed = new Uint8Array(32).fill(0x21);

  it("certifies a Device and proves possession of its signing key", async () => {
    const identity = await createDeviceIdentity({
      deviceId,
      signingSeed: new Uint8Array(32).fill(0x31),
      wrappingSecretKey: new Uint8Array(32).fill(0x41),
    });
    const certificate = await createDeviceCertificate({
      certificateId,
      vaultId,
      recoveryGenerationId,
      identity,
      displayName: "Firefox extension",
      clientKind: "FirefoxExtension",
      issuedAt: "2026-07-25T17:00:00.000Z",
      recoveryAdministratorSeed: administratorSeed,
    });

    await expect(verifyDeviceCertificate(certificate)).resolves.toBeUndefined();
    const proof = await createDeviceEnrollmentProof({
      certificate,
      accountSessionId,
      deviceSigningSecretKey: identity.signingSecretKey,
    });
    await expect(
      verifyDeviceEnrollmentProof({ certificate, accountSessionId, proof }),
    ).resolves.toBeUndefined();

    await expect(
      verifyDeviceCertificate({
        ...certificate,
        content: { ...certificate.content, displayName: "substituted" },
      }),
    ).rejects.toThrow();
    await expect(
      verifyDeviceEnrollmentProof({
        certificate,
        accountSessionId: crypto.randomUUID(),
        proof,
      }),
    ).rejects.toThrow();
  });

  it("wraps an epoch root key only for the certified Device", async () => {
    const identity = await createDeviceIdentity({
      deviceId,
      signingSeed: new Uint8Array(32).fill(0x31),
      wrappingSecretKey: new Uint8Array(32).fill(0x41),
    });
    const certificate = await createDeviceCertificate({
      certificateId,
      vaultId,
      recoveryGenerationId,
      identity,
      displayName: "Chrome extension",
      clientKind: "ChromeExtension",
      issuedAt: "2026-07-25T17:00:00.000Z",
      recoveryAdministratorSeed: administratorSeed,
    });
    const envelope = await createDeviceKeyEnvelope({
      certificate,
      keyEpochId,
      epochRootKey: new Uint8Array(32).fill(0x51),
      recoveryAdministratorSeed: administratorSeed,
      ephemeralSecretKey: new Uint8Array(32).fill(0x61),
      nonce: new Uint8Array(24).fill(0x71),
    });

    await expect(
      openDeviceKeyEnvelope({
        envelope,
        certificate,
        deviceWrappingSecretKey: identity.wrappingSecretKey,
      }),
    ).resolves.toEqual(new Uint8Array(32).fill(0x51));

    const other = await createDeviceIdentity({ deviceId: crypto.randomUUID() });
    await expect(
      openDeviceKeyEnvelope({
        envelope,
        certificate,
        deviceWrappingSecretKey: other.wrappingSecretKey,
      }),
    ).rejects.toThrow();
    await expect(
      openDeviceKeyEnvelope({
        envelope: {
          ...envelope,
          metadata: { ...envelope.metadata, keyEpochId: crypto.randomUUID() },
        },
        certificate,
        deviceWrappingSecretKey: identity.wrappingSecretKey,
      }),
    ).rejects.toThrow();
  });
});
