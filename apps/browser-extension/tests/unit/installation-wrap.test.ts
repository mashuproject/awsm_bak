import { describe, expect, it } from "vitest";

import { unwrapInstallationBytes, wrapInstallationBytes } from "../../src/crypto/installation-wrap";

async function wrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
}

describe("installation-wrapped values", () => {
  it("round-trips arbitrary bytes with exact domain and context binding", async () => {
    const key = await wrappingKey();
    const context = new Uint8Array(32).fill(1);
    const bytes = Uint8Array.from({ length: 37 }, (_, index) => index);
    const wrapped = await wrapInstallationBytes({
      wrappingKey: key,
      domain: "awsm.local.client-secret",
      context,
      bytes,
    });

    await expect(
      unwrapInstallationBytes({
        wrappingKey: key,
        domain: "awsm.local.client-secret",
        context,
        wrappedBytes: wrapped,
      }),
    ).resolves.toEqual(bytes);
    await expect(
      unwrapInstallationBytes({
        wrappingKey: key,
        domain: "awsm.local.epoch-secret",
        context,
        wrappedBytes: wrapped,
      }),
    ).rejects.toThrow(/another context/u);
    await expect(
      unwrapInstallationBytes({
        wrappingKey: key,
        domain: "awsm.local.client-secret",
        context: new Uint8Array(32).fill(2),
        wrappedBytes: wrapped,
      }),
    ).rejects.toThrow(/another context/u);
  });

  it("fails closed on corruption and an exportable wrapping key", async () => {
    const key = await wrappingKey();
    const wrapped = await wrapInstallationBytes({
      wrappingKey: key,
      domain: "awsm.local.replica-state",
      context: new Uint8Array(32),
      bytes: Uint8Array.of(1),
    });
    const corrupted = Uint8Array.from(wrapped);
    corrupted[corrupted.length - 1] = (corrupted.at(-1) ?? 0) ^ 1;
    await expect(
      unwrapInstallationBytes({
        wrappingKey: key,
        domain: "awsm.local.replica-state",
        context: new Uint8Array(32),
        wrappedBytes: corrupted,
      }),
    ).rejects.toThrow();

    const exportable = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, true, [
      "wrapKey",
      "unwrapKey",
    ]);
    await expect(
      wrapInstallationBytes({
        wrappingKey: exportable,
        domain: "awsm.local.replica-state",
        context: new Uint8Array(32),
        bytes: Uint8Array.of(1),
      }),
    ).rejects.toThrow(/non-exportable/u);
  });
});
