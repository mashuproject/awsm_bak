import { describe, expect, it } from "vitest";
import {
  createSearchModelReferenceKey,
  deriveSearchModelVaultReference,
} from "../../src/runtime/search/model-reference";

describe("local Search model references", () => {
  it("derives stable opaque per-Vault references with a non-exportable device key", async () => {
    const key = await createSearchModelReferenceKey();
    const first = await deriveSearchModelVaultReference(
      key,
      "00000000-0000-4000-8000-000000000001",
    );
    const repeated = await deriveSearchModelVaultReference(
      key,
      "00000000-0000-4000-8000-000000000001",
    );
    const other = await deriveSearchModelVaultReference(
      key,
      "00000000-0000-4000-8000-000000000002",
    );

    expect(key.extractable).toBe(false);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(repeated).toBe(first);
    expect(other).not.toBe(first);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("rejects an exportable or incorrectly purposed key", async () => {
    const exportable = await crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256", length: 256 },
      true,
      ["sign"],
    );
    const wrongPurpose = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
    ]);

    await expect(
      deriveSearchModelVaultReference(exportable, "00000000-0000-4000-8000-000000000001"),
    ).rejects.toThrow();
    await expect(
      deriveSearchModelVaultReference(wrongPurpose, "00000000-0000-4000-8000-000000000001"),
    ).rejects.toThrow();
  });
});
